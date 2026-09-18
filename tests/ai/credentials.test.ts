import { test, expect } from "bun:test";
import { loadConfig } from "../../src/config";
import { describeCredentials } from "../../src/ai";

test("an API key is picked up for the chosen provider", () => {
  const config = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });

  expect(config.ai).toMatchObject({ provider: "anthropic", apiKey: "sk-ant-test" });
  expect(config.ai.authToken).toBeUndefined();
  expect(describeCredentials(config)).toBe("API key");
});

test("an OAuth token is used when no API key is set", () => {
  const config = loadConfig({ ANTHROPIC_AUTH_TOKEN: "oauth-token" });

  expect(config.ai.apiKey).toBeUndefined();
  expect(config.ai.authToken).toBe("oauth-token");
  expect(describeCredentials(config)).toContain("OAuth token");
});

test("with neither credential the SDK is left to resolve one", () => {
  const config = loadConfig({});

  expect(describeCredentials(config)).toContain("resolved by the SDK");
});

test("OpenAI ignores the Anthropic token and takes its own key", () => {
  const config = loadConfig({
    JIDOKA_AI_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_AUTH_TOKEN: "oauth-token",
  });

  expect(config.ai).toMatchObject({ provider: "openai", apiKey: "sk-openai" });
  expect(config.ai.authToken).toBeUndefined();
});

test("a base URL can point at a gateway", () => {
  expect(loadConfig({ JIDOKA_AI_BASE_URL: "https://gateway.internal/v1" }).ai.baseUrl).toBe(
    "https://gateway.internal/v1",
  );
  expect(loadConfig({ ANTHROPIC_BASE_URL: "https://proxy.internal" }).ai.baseUrl).toBe(
    "https://proxy.internal",
  );
});
