import { test, expect } from "bun:test";
import { createAgentSdkProvider, type QueryFn } from "../../src/ai/agentSdkProvider";

function fakeQuery(
  messages: unknown[],
  seen: { prompt?: string; options?: Record<string, unknown> } = {},
): QueryFn {
  return ({ prompt, options }) => {
    seen.prompt = prompt;
    seen.options = options;
    return (async function* () {
      for (const message of messages) yield message;
    })();
  };
}

const success = { type: "result", subtype: "success", result: '{"ok":true}', is_error: false };

test("the result message becomes the completion text", async () => {
  const provider = createAgentSdkProvider({ queryFn: fakeQuery([{ type: "assistant" }, success]) });

  const result = await provider.complete({ messages: [{ role: "user", content: "classify this" }] });

  expect(result).toEqual({ text: '{"ok":true}', toolCalls: [] });
  expect(provider.id).toBe("agent-sdk");
});

test("the system prompt and model are passed, tools are locked off", async () => {
  const seen: { prompt?: string; options?: Record<string, unknown> } = {};
  const provider = createAgentSdkProvider({
    model: "sonnet",
    maxBudgetUsd: 2,
    queryFn: fakeQuery([success], seen),
  });

  await provider.complete({
    system: "You triage tasks",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ],
  });

  expect(seen.prompt).toBe("first\n\nsecond");
  expect(seen.options).toMatchObject({
    systemPrompt: "You triage tasks",
    model: "sonnet",
    maxBudgetUsd: 2,
    allowedTools: [],
    permissionMode: "dontAsk",
    settingSources: [],
    maxTurns: 1,
  });
});

test("API credentials are kept out of the CLI environment", async () => {
  const seen: { options?: Record<string, unknown> } = {};
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
  process.env.JIDOKA_TEST_MARKER = "kept";

  try {
    await createAgentSdkProvider({ queryFn: fakeQuery([success], seen) }).complete({
      messages: [{ role: "user", content: "x" }],
    });

    const env = seen.options?.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.JIDOKA_TEST_MARKER).toBe("kept");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.JIDOKA_TEST_MARKER;
  }
});

test("asking for tools is refused with a pointer to agent steps", async () => {
  const provider = createAgentSdkProvider({ queryFn: fakeQuery([success]) });

  await expect(
    provider.complete({
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "a__b", description: "d", inputSchema: { type: "object" } }],
    }),
  ).rejects.toThrow(/agent step/);
});

test("an error result and a missing result both throw", async () => {
  const failing = createAgentSdkProvider({
    queryFn: fakeQuery([
      { type: "result", subtype: "error_max_turns", is_error: true, errors: ["ran out of turns"] },
    ]),
  });
  await expect(failing.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
    /error_max_turns\): ran out of turns/,
  );

  const silent = createAgentSdkProvider({ queryFn: fakeQuery([{ type: "assistant" }]) });
  await expect(silent.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
    /no result message/,
  );
});
