import type { Config } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import type { AiProvider } from "./provider";

export function createProvider(config: Config): AiProvider {
  return config.ai.provider === "openai"
    ? createOpenAiProvider({ apiKey: config.ai.apiKey, model: config.ai.model })
    : createAnthropicProvider({ apiKey: config.ai.apiKey, model: config.ai.model });
}

export type { AiProvider };
