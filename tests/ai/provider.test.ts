import { test, expect } from "bun:test";
import { z } from "zod";
import { completeJson, type AiProvider, type AiResult } from "../../src/ai/provider";

function stubProvider(replies: string[]): AiProvider & { calls: number } {
  let i = 0;
  return {
    id: "stub",
    calls: 0,
    async complete(): Promise<AiResult> {
      this.calls += 1;
      const text = replies[i++] ?? "";
      return { text, toolCalls: [] };
    },
  };
}

const schema = z.object({ verdict: z.string() });

test("completeJson parses a fenced JSON reply", async () => {
  const provider = stubProvider(['```json\n{"verdict":"human"}\n```']);

  const result = await completeJson(provider, { messages: [{ role: "user", content: "x" }] }, schema);

  expect(result).toEqual({ verdict: "human" });
  expect(provider.calls).toBe(1);
});

test("completeJson retries once when the reply does not match the schema", async () => {
  const provider = stubProvider(['{"wrong":1}', '{"verdict":"ai"}']);

  const result = await completeJson(provider, { messages: [{ role: "user", content: "x" }] }, schema);

  expect(result).toEqual({ verdict: "ai" });
  expect(provider.calls).toBe(2);
});

test("completeJson throws after the retry fails", async () => {
  const provider = stubProvider(["nope", "still nope"]);

  await expect(
    completeJson(provider, { messages: [{ role: "user", content: "x" }] }, schema),
  ).rejects.toThrow(/valid JSON/i);
});
