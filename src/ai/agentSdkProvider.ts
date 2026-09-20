import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AiProvider, AiResult, CompleteRequest } from "./provider";

export type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface AgentSdkProviderOptions {
  model?: string;
  maxBudgetUsd?: number;
  /** Injected in tests; defaults to the SDK's real `query`. */
  queryFn?: QueryFn;
}

interface ResultMessage {
  type: "result";
  subtype: string;
  result?: string;
  is_error?: boolean;
  errors?: string[];
}

function isResultMessage(message: unknown): message is ResultMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "result";
}

/** The environment the CLI inherits, minus anything that would bill the API. */
function subscriptionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") continue;
    env[key] = value;
  }
  return env;
}

/**
 * One-shot text completion through the Claude Code CLI.
 *
 * Triage, the rule builder and `ai` steps only need "prompt in, text out", so
 * they can run on whatever the CLI is logged in as — a subscription included —
 * instead of an API key. Tool loops do not belong here: an `agent` step goes
 * through the Agent SDK runner, which lets the CLI drive MCP tools itself.
 */
export function createAgentSdkProvider(options: AgentSdkProviderOptions = {}): AiProvider {
  const run = options.queryFn ?? (query as unknown as QueryFn);

  return {
    id: "agent-sdk",

    async complete(req: CompleteRequest): Promise<AiResult> {
      if (req.tools?.length) {
        throw new Error(
          "the agent-sdk provider does not carry tools; use an agent step, which runs the tool loop in the CLI",
        );
      }

      const prompt = req.messages
        .map((message) => {
          if (message.role === "tool_results") {
            return message.results.map((r) => r.content).join("\n");
          }
          return message.content;
        })
        .filter((part) => part.length > 0)
        .join("\n\n");

      const queryOptions: Record<string, unknown> = {
        allowedTools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        maxTurns: 1,
        env: subscriptionEnv(),
      };
      if (req.system) queryOptions.systemPrompt = req.system;
      const model = req.model ?? options.model;
      if (model) queryOptions.model = model;
      if (options.maxBudgetUsd) queryOptions.maxBudgetUsd = options.maxBudgetUsd;

      let result: ResultMessage | null = null;
      for await (const message of run({ prompt, options: queryOptions })) {
        if (isResultMessage(message)) result = message;
      }

      if (!result) throw new Error("the CLI produced no result message");
      if (result.subtype !== "success" || result.is_error) {
        const detail = result.errors?.join("; ") ?? result.result ?? "";
        throw new Error(`claude CLI run failed (${result.subtype})${detail ? `: ${detail}` : ""}`);
      }

      return { text: result.result ?? "", toolCalls: [] };
    },
  };
}
