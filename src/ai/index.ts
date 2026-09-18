import type { Config } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import type { AiProvider } from "./provider";

export interface ProviderOverrides {
  /** Per-request bearer token, e.g. one stored by the browser sign-in flow. */
  getAuthToken?: () => Promise<string | null>;
}

export function createProvider(config: Config, overrides: ProviderOverrides = {}): AiProvider {
  // An explicit key or token in the environment always wins over a stored one.
  const useStoredToken = !config.ai.apiKey && !config.ai.authToken ? overrides.getAuthToken : undefined;

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
        getAuthToken: useStoredToken,
        model: config.ai.model,
      });
}

/** How the model calls will authenticate, for the startup log. */
export function describeCredentials(config: Config): string {
  if (config.ai.apiKey) return "API key";
  if (config.ai.authToken) return "OAuth token (ANTHROPIC_AUTH_TOKEN)";
  if (config.oauth[config.ai.provider]) return "browser sign-in (/api/auth)";
  return "resolved by the SDK (env var or `ant auth login` profile)";
}

export type { AiProvider };
