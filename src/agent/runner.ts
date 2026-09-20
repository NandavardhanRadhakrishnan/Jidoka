import type { AiMessage, AiProvider, AiToolResult, ToolSpec } from "../ai/provider";
import { splitToolName } from "../mcp/names";

export interface AgentToolCall {
  /** Jidoka tool name: `<server>__<tool>`. */
  name: string;
  input: Record<string, unknown>;
  error?: string;
}

export interface AgentRunInput {
  prompt: string;
  systemPrompt?: string;
  /** Tools this run may use, as `<server>__<tool>`. Nothing else is permitted. */
  allowedTools: string[];
  maxTurns: number;
}

export interface AgentRunResult {
  text: string;
  toolCalls: AgentToolCall[];
  /**
   * Set by backends that keep a resumable conversation (the Agent SDK does). A
   * handoff can hand this to a human so they continue that session rather than
   * starting cold.
   */
  sessionId?: string;
}

/**
 * Runs one open-ended agent turn-loop for an `agent` rule step.
 *
 * Two backends implement this: the in-process loop below, which drives an
 * AiProvider and Jidoka's own MCP client (API-key auth), and the Claude Agent SDK
 * backend, which hands the loop to the Claude Code CLI (subscription auth).
 */
export interface AgentRunner {
  readonly id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface InProcessRunnerDeps {
  provider: AiProvider;
  listTools: () => ToolSpec[];
  callTool: (
    server: string,
    tool: string,
    input: Record<string, unknown>,
  ) => Promise<string>;
}

/**
 * The loop Jidoka runs itself: ask the model, execute the tool calls it asks for,
 * feed the results back, stop when it stops calling tools or the turn budget runs
 * out. A tool that fails is reported to the model once; a second failure of the
 * same tool ends the step.
 */
export function createInProcessRunner(deps: InProcessRunnerDeps): AgentRunner {
  return {
    id: "in-process",

    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const catalogue = deps.listTools();
      const specs = catalogue.filter((t) => input.allowedTools.includes(t.name));
      const missing = input.allowedTools.filter((name) => !specs.some((t) => t.name === name));
      if (missing.length) throw new Error(`unavailable tools ${missing.join(", ")}`);

      const messages: AiMessage[] = [{ role: "user", content: input.prompt }];
      const failures = new Map<string, number>();
      const toolCalls: AgentToolCall[] = [];
      let text = "";

      for (let turn = 0; turn < input.maxTurns; turn++) {
        const result = await deps.provider.complete({
          ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
          messages,
          tools: specs,
          maxTokens: 8000,
        });
        if (result.text) text = result.text;
        if (!result.toolCalls.length) break;

        messages.push({ role: "assistant", content: result.text, raw: result.raw });

        const results: AiToolResult[] = [];
        for (const call of result.toolCalls) {
          const { server, tool } = splitToolName(call.name);

          try {
            const output = await deps.callTool(server, tool, call.input);
            results.push({ callId: call.id, content: output });
            toolCalls.push({ name: call.name, input: call.input });
          } catch (error) {
            const count = (failures.get(call.name) ?? 0) + 1;
            failures.set(call.name, count);
            const message = error instanceof Error ? error.message : String(error);
            toolCalls.push({ name: call.name, input: call.input, error: message });
            if (count > 1) throw new Error(`${call.name} failed twice: ${message}`);
            results.push({ callId: call.id, content: message, isError: true });
          }
        }
        messages.push({ role: "tool_results", results });
      }

      return { text, toolCalls };
    },
  };
}
