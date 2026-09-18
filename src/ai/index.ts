import type { Config } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import type { AiProvider } from "./provider";

export function createProvider(config: Config): AiProvider {
  return config.ai.provider === "openai"
    ? createOpenAiProvider({
        apiKey: config.ai.apiKey,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
      })
    : createAnthropicProvider({
        apiKey: config.ai.apiKey,
        authToken: config.ai.authToken,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
      });
}

/** How the model calls will authenticate, for the startup log. */
export function describeCredentials(config: Config): string {
  if (config.ai.apiKey) return "API key";
  if (config.ai.authToken) return "OAuth token (ANTHROPIC_AUTH_TOKEN)";
  return "resolved by the SDK (env var or `ant auth login` profile)";
}

export type { AiProvider };
