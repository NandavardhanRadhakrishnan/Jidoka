import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, AgentRunInput, AgentRunResult, AgentToolCall } from "./runner";
import { TOOL_SEPARATOR, splitToolName } from "../mcp/names";

/** The SDK exposes MCP tools as `mcp__<server>__<tool>`. */
const SDK_MCP_PREFIX = `mcp${TOOL_SEPARATOR}`;

/**
 * Narrow shape of the SDK's `query`, so this module doesn't have to import
 * the SDK's full type surface. The real `query` is structurally compatible
 * enough for our purposes but not identical, so it's cast in, not assigned.
 */
export type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface AgentSdkRunnerOptions {
  /** MCP servers this runner may expose, keyed by server name (stdio). */
  mcpServers: Record<string, { command: string; args: string[] }>;
  model?: string;
  maxBudgetUsd?: number;
  /** Injected for tests; defaults to the SDK's real `query`. */
  queryFn?: QueryFn;
}

/** Local, narrow types for the SDK messages this runner actually reads. */
interface SdkContentBlock {
  type: string;
  [key: string]: unknown;
}

interface SdkAssistantMessage {
  type: "assistant";
  message: { content: SdkContentBlock[] };
}

interface SdkResultMessage {
  type: "result";
  subtype: string;
  result?: string;
  is_error: boolean;
}

type CanUseToolResult = { behavior: "allow" } | { behavior: "deny"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAssistantMessage(message: unknown): message is SdkAssistantMessage {
  if (!isRecord(message) || message.type !== "assistant") return false;
  const inner = message.message;
  return isRecord(inner) && Array.isArray(inner.content);
}

function isResultMessage(message: unknown): message is SdkResultMessage {
  return (
    isRecord(message) &&
    message.type === "result" &&
    typeof message.subtype === "string" &&
    typeof message.is_error === "boolean"
  );
}

/** `server__tool` (Jidoka) -> `mcp__server__tool` (SDK). */
function toSdkToolName(jidokaName: string): string {
  const { server, tool } = splitToolName(jidokaName);
  return `${SDK_MCP_PREFIX}${server}${TOOL_SEPARATOR}${tool}`;
}

/** `mcp__server__tool` (SDK) -> `server__tool` (Jidoka), or undefined if not an MCP tool. */
function fromSdkToolName(sdkName: string): string | undefined {
  if (!sdkName.startsWith(SDK_MCP_PREFIX)) return undefined;
  return sdkName.slice(SDK_MCP_PREFIX.length);
}

/**
 * Hands the agent loop for one `agent` pipeline step to the Claude Code CLI via
 * `@anthropic-ai/claude-agent-sdk`. Subscription auth covers the whole run,
 * MCP tool calls included, instead of Jidoka's own AiProvider/API-key path.
 */
export function createAgentSdkRunner(options: AgentSdkRunnerOptions): AgentRunner {
  const query = options.queryFn ?? (sdkQuery as unknown as QueryFn);

  return {
    id: "claude-agent-sdk",

    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const allowedSet = new Set(input.allowedTools);
      const sdkAllowedTools: string[] = [];
      const mcpServers: Record<string, { type: "stdio"; command: string; args: string[] }> = {};
      const missing: string[] = [];

      for (const name of input.allowedTools) {
        const { server } = splitToolName(name);
        const config = options.mcpServers[server];
        if (!config) {
          missing.push(name);
          continue;
        }
        mcpServers[server] = { type: "stdio", command: config.command, args: config.args };
        sdkAllowedTools.push(toSdkToolName(name));
      }
      if (missing.length) throw new Error(`unavailable tools ${missing.join(", ")}`);

      const toolCalls: AgentToolCall[] = [];

      const canUseTool = async (
        toolName: string,
        toolInput: Record<string, unknown>,
      ): Promise<CanUseToolResult> => {
        const jidokaName = fromSdkToolName(toolName);
        if (jidokaName && allowedSet.has(jidokaName)) {
          toolCalls.push({ name: jidokaName, input: toolInput });
          return { behavior: "allow" };
        }
        const recordedName = jidokaName ?? toolName;
        const message = `tool not allowed: ${recordedName}`;
        toolCalls.push({ name: recordedName, input: toolInput, error: message });
        return { behavior: "deny", message };
      };

      // `env` REPLACES the subprocess environment, so start from the host's own
      // and strip the API key: this backend exists so runs bill the CLI's
      // subscription login, never a stray API key.
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const queryOptions: Record<string, unknown> = {
        mcpServers,
        allowedTools: sdkAllowedTools,
        permissionMode: "dontAsk",
        canUseTool,
        maxTurns: input.maxTurns,
        settingSources: [],
        env,
      };
      if (input.systemPrompt) queryOptions.systemPrompt = input.systemPrompt;
      if (options.model) queryOptions.model = options.model;
      if (options.maxBudgetUsd !== undefined) queryOptions.maxBudgetUsd = options.maxBudgetUsd;

      let finalResult: SdkResultMessage | undefined;
      let text = "";

      for await (const message of query({ prompt: input.prompt, options: queryOptions })) {
        if (isAssistantMessage(message)) {
          for (const block of message.message.content) {
            if (block.type === "text" && typeof block.text === "string") text = block.text;
          }
        } else if (isResultMessage(message)) {
          finalResult = message;
        }
      }

      if (!finalResult) {
        throw new Error("claude agent sdk: run ended without a result message");
      }
      if (finalResult.subtype !== "success" || finalResult.is_error) {
        throw new Error(
          `claude agent sdk run failed: ${finalResult.subtype} ${finalResult.result ?? ""}`.trim(),
        );
      }

      return { text: finalResult.result ?? text, toolCalls };
    },
  };
}
