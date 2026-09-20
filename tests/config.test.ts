import { test, expect } from "bun:test";
import { loadConfig, applySettings } from "../src/config";

test("applySettings overrides a field the settings actually set", () => {
  const base = loadConfig({ JIDOKA_AI_MODEL: "claude-haiku-4-5-20251001" });

  const merged = applySettings(base, { ai: { model: "claude-opus-5" } });

  expect(merged.ai.model).toBe("claude-opus-5");
});

test("applySettings falls through to the base value when settings omit a field", () => {
  const base = loadConfig({ JIDOKA_AI_MODEL: "claude-haiku-4-5-20251001" });

  const merged = applySettings(base, { sampleDir: "./samples" });

  expect(merged.ai.model).toBe("claude-haiku-4-5-20251001");
  expect(merged.sampleDir).toBe("./samples");
});

test("applySettings merges ai/agent one level deep rather than replacing the whole section", () => {
  const base = loadConfig({ ANTHROPIC_API_KEY: "sk-from-env" });

  const merged = applySettings(base, { ai: { model: "claude-opus-5" } });

  expect(merged.ai.apiKey).toBe("sk-from-env");
  expect(merged.ai.model).toBe("claude-opus-5");
});

test("applySettings never touches dbPath or port", () => {
  const base = loadConfig({ JIDOKA_DB: "./real.db", JIDOKA_PORT: "4000" });

  const merged = applySettings(base, {});

  expect(merged.dbPath).toBe("./real.db");
  expect(merged.port).toBe(4000);
});
