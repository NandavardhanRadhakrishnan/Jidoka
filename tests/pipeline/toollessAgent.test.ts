import { test, expect } from "bun:test";
import { PipelineDefinitionSchema } from "../../src/domain/pipeline";
import { runPipeline } from "../../src/pipeline/executor";
import { createInProcessRunner } from "../../src/agent/runner";
import { createAgentSdkRunner } from "../../src/agent/claudeAgentSdk";
import type { Task } from "../../src/domain/task";

const task: Task = {
  id: "t1",
  sourceId: "manual",
  externalId: "m1",
  url: "https://dev.azure.com/acme/_git/app/pullrequest/42",
  title: "Review PR 42",
  body: "Please review the change.",
  metadata: {},
  typeId: "type-1",
  typeCandidates: null,
  state: "processing",
  assignee: null,
  context: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("an agent step may declare no tools at all", () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "agent", prompt: "Review {{task.url}}", output: "review" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  expect(definition.steps[0]).toMatchObject({ type: "agent", tools: [], maxIterations: 6 });
});

test("a toolless agent step runs and its session reaches the handoff", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "agent", prompt: "Review the PR at {{task.url}}", tools: [], output: "review" },
      {
        id: "s2",
        type: "assign",
        to: "human",
        open: [
          { kind: "url", label: "The PR", url: "{{task.url}}" },
          { kind: "session", label: "Review conversation", sessionId: "{{context.review_session}}" },
        ],
      },
    ],
  });

  const result = await runPipeline(
    {
      provider: { id: "stub", async complete() { return { text: "", toolCalls: [] }; } },
      callTool: async () => "",
      loadPipeline: () => null,
      listTools: () => [],
      runAgent: {
        id: "fake",
        async run(input) {
          expect(input.allowedTools).toEqual([]);
          return { text: "Looks good, two nits.", toolCalls: [], sessionId: "sess-42" };
        },
      },
    },
    definition,
    task,
  );

  expect(result.context.review).toBe("Looks good, two nits.");
  expect(result.handoff).toEqual([
    { kind: "url", label: "The PR", url: "https://dev.azure.com/acme/_git/app/pullrequest/42" },
    { kind: "command", label: "Review conversation", command: "claude --resume sess-42" },
  ]);
});

test("the in-process runner accepts an empty allowlist", async () => {
  const runner = createInProcessRunner({
    provider: {
      id: "stub",
      async complete(req) {
        expect(req.tools).toEqual([]);
        return { text: "reviewed", toolCalls: [] };
      },
    },
    listTools: () => [],
    callTool: async () => "",
  });

  expect(await runner.run({ prompt: "review", allowedTools: [], maxTurns: 3 })).toEqual({
    text: "reviewed",
    toolCalls: [],
  });
});

test("the SDK runner passes no tools and no servers when the step has none", async () => {
  let seen: Record<string, unknown> | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {},
    queryFn: ({ options }) => {
      seen = options;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1" };
      })();
    },
  });

  const result = await runner.run({ prompt: "review", allowedTools: [], maxTurns: 4 });

  expect(result).toMatchObject({ text: "done", sessionId: "s1" });
  expect(seen?.allowedTools).toEqual([]);
  expect(seen?.mcpServers).toEqual({});
});
