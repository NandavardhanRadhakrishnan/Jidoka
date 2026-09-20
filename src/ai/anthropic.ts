import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider, AiResult, CompleteRequest } from "./provider";

export interface AnthropicOptions {
  apiKey?: string;
  /** OAuth bearer token (ANTHROPIC_AUTH_TOKEN), e.g. from `ant auth login`. */
  authToken?: string;
  /** Point at a gateway or proxy instead of api.anthropic.com. */
  baseUrl?: string;
  /**
   * Supplies a bearer token per request — used by the browser sign-in flow, where
   * the stored token is refreshed behind this call.
   */
  getAuthToken?: () => Promise<string | null>;
  model?: string;
}

export function createAnthropicProvider(options: AnthropicOptions = {}): AiProvider {
  // With neither credential set, the SDK resolves them itself: ANTHROPIC_API_KEY,
  // then ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile on disk.
  const baseOptions = {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.authToken ? { authToken: options.authToken } : {}),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  };
  const staticClient = new Anthropic(baseOptions);
  const model = options.model ?? "claude-opus-5";

  // A signed-in token can be refreshed between calls, so rebuild the client when
  // the token changes; otherwise reuse the one built above.
  let cachedToken: string | null = null;
  let cachedClient: Anthropic | null = null;

  async function clientFor(): Promise<Anthropic> {
    if (!options.getAuthToken) return staticClient;

    const token = await options.getAuthToken();
    if (!token) {
      throw new Error("not signed in — no Anthropic token is stored. Open /api/auth/anthropic/start");
    }
    if (token !== cachedToken || !cachedClient) {
      cachedToken = token;
      cachedClient = new Anthropic({ ...baseOptions, authToken: token });
    }
    return cachedClient;
  }

  return {
    id: "anthropic",
    async complete(req: CompleteRequest): Promise<AiResult> {
      const messages: Anthropic.MessageParam[] = req.messages.map((m) => {
        if (m.role === "tool_results") {
          return {
            role: "user" as const,
            content: m.results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.callId,
              content: r.content,
              is_error: r.isError ?? false,
            })),
          };
        }
        if (m.role === "assistant" && m.raw) {
          return { role: "assistant" as const, content: m.raw as Anthropic.ContentBlockParam[] };
        }
        return { role: m.role, content: m.content };
      });

      const client = await clientFor();
      const response = await client.messages.create({
        model: req.model ?? model,
        max_tokens: req.maxTokens ?? 16000,
        ...(req.system ? { system: req.system } : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
        messages,
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        }));

      return { text, toolCalls, raw: response.content };
    },
  };
}
