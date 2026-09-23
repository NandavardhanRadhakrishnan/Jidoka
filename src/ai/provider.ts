import type { ZodType } from "zod";

export type AiMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; raw?: unknown }
  | { role: "tool_results"; results: AiToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Passed through from the MCP server when it supplies tool annotations; absent when unknown. */
  annotations?: { readOnlyHint?: boolean };
}

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export interface CompleteRequest {
  system?: string;
  messages: AiMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  model?: string;
}

export interface AiResult {
  text: string;
  toolCalls: AiToolCall[];
  /** Provider-native assistant content, echoed back verbatim on the next turn. */
  raw?: unknown;
}

export interface AiProvider {
  readonly id: string;
  complete(req: CompleteRequest): Promise<AiResult>;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error("no JSON found");
  return JSON.parse(candidate.slice(start));
}

export async function completeJson<T>(
  provider: AiProvider,
  req: CompleteRequest,
  schema: ZodType<T>,
): Promise<T> {
  const system = [req.system, "Reply with JSON only. No prose, no explanation."]
    .filter(Boolean)
    .join("\n\n");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages =
      attempt === 0
        ? req.messages
        : [
            ...req.messages,
            {
              role: "user" as const,
              content: `Your previous reply was not valid JSON for the required schema: ${lastError}. Reply with JSON only.`,
            },
          ];
    const result = await provider.complete({ ...req, system, messages });
    try {
      return schema.parse(extractJson(result.text));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Model did not return valid JSON after a retry: ${lastError}`);
}
