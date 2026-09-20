import { test, expect } from "bun:test";
import { modelCatalog } from "../../src/ai/models";

test("anthropic and agent-sdk share the Claude catalog", () => {
  const anthropic = modelCatalog("anthropic");
  const agentSdk = modelCatalog("agent-sdk");

  expect(anthropic).toEqual(agentSdk);
  expect(anthropic.map((m) => m.id)).toEqual([
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
    "claude-opus-5",
  ]);
});

test("openai has its own, smaller catalog", () => {
  const openai = modelCatalog("openai");
  expect(openai.map((m) => m.id)).toEqual(["gpt-4.1-mini", "gpt-4.1"]);
});
