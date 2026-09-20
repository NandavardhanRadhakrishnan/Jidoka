import { test, expect, afterEach } from "bun:test";
import { createAgentSdkRunner } from "../../src/agent/claudeAgentSdk";
import type { QueryFn } from "../../src/agent/claudeAgentSdk";
import type { AgentRunInput } from "../../src/agent/runner";

type CapturedParams = { prompt: string; options?: Record<string, unknown> };

function baseInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: "do the thing", allowedTools: [], maxTurns: 3, ...overrides };
}

function successResult(text: string) {
  return { type: "result", subtype: "success", result: text, is_error: false };
}

function errorResult(subtype: string, text: string) {
  return { type: "result", subtype, result: text, is_error: true };
}

/** A queryFn that captures the params it was called with and yields the given messages. */
function capturingQuery(
  messages: unknown[],
  capture: (params: CapturedParams) => void,
): QueryFn {
  return (params) => {
    capture(params);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  };
}

const originalApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

test("maps Jidoka tool names to SDK names and passes only referenced servers", async () => {
  let captured: CapturedParams | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {
      notes: { command: "notes-server", args: ["--stdio"] },
      other: { command: "other-server", args: [] },
    },
    queryFn: capturingQuery([successResult("done")], (params) => {
      captured = params;
    }),
  });

  await runner.run(baseInput({ allowedTools: ["notes__list", "notes__create"] }));

  expect(captured?.options?.allowedTools).toEqual(["mcp__notes__list", "mcp__notes__create"]);
  expect(captured?.options?.mcpServers).toEqual({
    notes: { type: "stdio", command: "notes-server", args: ["--stdio"] },
  });
});

test("an allowed tool referencing an unconfigured server throws before any run", async () => {
  let ran = false;
  const runner = createAgentSdkRunner({
    mcpServers: { notes: { command: "notes-server", args: [] } },
    queryFn: () => {
      ran = true;
      return (async function* () {})();
    },
  });

  await expect(
    runner.run(baseInput({ allowedTools: ["notes__list", "ghost__act"] })),
  ).rejects.toThrow("unavailable tools ghost__act");
  expect(ran).toBe(false);
});

test("canUseTool allows an allowed tool and denies one outside the allowlist", async () => {
  let captured: CapturedParams | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {
      notes: { command: "notes-server", args: [] },
      other: { command: "other-server", args: [] },
    },
    queryFn: (params) => {
      captured = params;
      return (async function* () {
        const canUseTool = params.options?.canUseTool as (
          name: string,
          input: Record<string, unknown>,
        ) => Promise<{ behavior: string; message?: string }>;

        const allowed = await canUseTool("mcp__notes__list", { q: 1 });
        expect(allowed).toEqual({ behavior: "allow" });

        const denied = await canUseTool("mcp__other__act", { x: 2 });
        expect(denied.behavior).toBe("deny");
        expect(typeof denied.message).toBe("string");

        yield successResult("done");
      })();
    },
  });

  const result = await runner.run(baseInput({ allowedTools: ["notes__list"] }));

  expect(captured).toBeDefined();
  expect(result.toolCalls).toEqual([
    { name: "notes__list", input: { q: 1 } },
    { name: "other__act", input: { x: 2 }, error: expect.any(String) },
  ]);
});

test("denied calls are recorded in toolCalls with an error message", async () => {
  const runner = createAgentSdkRunner({
    mcpServers: { notes: { command: "notes-server", args: [] } },
    queryFn: (params) => {
      return (async function* () {
        const canUseTool = params.options?.canUseTool as (
          name: string,
          input: Record<string, unknown>,
        ) => Promise<{ behavior: string; message?: string }>;
        await canUseTool("mcp__notes__delete-everything", {});
        yield successResult("done");
      })();
    },
  });

  const result = await runner.run(baseInput({ allowedTools: ["notes__list"] }));

  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0]?.name).toBe("notes__delete-everything");
  expect(result.toolCalls[0]?.error).toBeDefined();
});

test("text comes from the result message", async () => {
  const runner = createAgentSdkRunner({
    mcpServers: {},
    queryFn: capturingQuery(
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "intermediate chatter" }] },
        },
        successResult("the final answer"),
      ],
      () => {},
    ),
  });

  const result = await runner.run(baseInput());

  expect(result.text).toBe("the final answer");
});

test("a non-success or errored result throws", async () => {
  const runner = createAgentSdkRunner({
    mcpServers: {},
    queryFn: capturingQuery([errorResult("error_max_turns", "ran out of turns")], () => {}),
  });

  await expect(runner.run(baseInput())).rejects.toThrow(/error_max_turns/);
  await expect(runner.run(baseInput())).rejects.toThrow(/ran out of turns/);
});

test("permissionMode is dontAsk and settingSources is empty", async () => {
  let captured: CapturedParams | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {},
    queryFn: capturingQuery([successResult("done")], (params) => {
      captured = params;
    }),
  });

  await runner.run(baseInput());

  expect(captured?.options?.permissionMode).toBe("dontAsk");
  expect(captured?.options?.settingSources).toEqual([]);
});

test("ANTHROPIC_API_KEY is stripped from the env passed to the SDK, other vars kept", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-should-not-be-used";
  process.env.JIDOKA_TEST_MARKER = "keep-me";

  let captured: CapturedParams | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {},
    queryFn: capturingQuery([successResult("done")], (params) => {
      captured = params;
    }),
  });

  await runner.run(baseInput());

  const env = captured?.options?.env as Record<string, string | undefined>;
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.JIDOKA_TEST_MARKER).toBe("keep-me");

  delete process.env.JIDOKA_TEST_MARKER;
});

test("maxBudgetUsd and model are passed through when set", async () => {
  let captured: CapturedParams | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {},
    model: "claude-opus-5",
    maxBudgetUsd: 2.5,
    queryFn: capturingQuery([successResult("done")], (params) => {
      captured = params;
    }),
  });

  await runner.run(baseInput({ maxTurns: 7 }));

  expect(captured?.options?.model).toBe("claude-opus-5");
  expect(captured?.options?.maxBudgetUsd).toBe(2.5);
  expect(captured?.options?.maxTurns).toBe(7);
});

test("a per-run model overrides the runner's configured default", async () => {
  let captured: CapturedParams | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {},
    model: "claude-sonnet-5",
    queryFn: capturingQuery([successResult("done")], (params) => {
      captured = params;
    }),
  });

  await runner.run(baseInput({ model: "claude-opus-5" }));

  expect(captured?.options?.model).toBe("claude-opus-5");
});
