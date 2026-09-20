import OpenAI from "openai";
import type { AiProvider, AiResult, CompleteRequest } from "./provider";

export interface OpenAiOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function createOpenAiProvider(options: OpenAiOptions = {}): AiProvider {
  const client = new OpenAI({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
  const model = options.model ?? "gpt-4.1";

  return {
    id: "openai",
    async complete(req: CompleteRequest): Promise<AiResult> {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const m of req.messages) {
        if (m.role === "tool_results") {
          for (const r of m.results) {
            messages.push({ role: "tool", tool_call_id: r.callId, content: r.content });
          }
        } else if (m.role === "assistant" && m.raw) {
          messages.push(m.raw as OpenAI.Chat.ChatCompletionAssistantMessageParam);
        } else {
          messages.push({ role: m.role, content: m.content });
        }
      }

      const response = await client.chat.completions.create({
        model: req.model ?? model,
        max_completion_tokens: req.maxTokens ?? 16000,
        messages,
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                },
              })),
            }
          : {}),
      });

      const choice = response.choices[0];
      const toolCalls = (choice?.message.tool_calls ?? []).flatMap((call) =>
        call.type === "function"
          ? [
              {
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments || "{}") as Record<string, unknown>,
              },
            ]
          : [],
      );

      return { text: choice?.message.content ?? "", toolCalls, raw: choice?.message };
    },
  };
}
