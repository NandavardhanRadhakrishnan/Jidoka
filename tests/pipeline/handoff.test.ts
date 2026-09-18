import { test, expect } from "bun:test";
import { PipelineDefinitionSchema } from "../../src/domain/pipeline";
import { runPipeline, resolveHandoff } from "../../src/pipeline/executor";
import type { Task } from "../../src/domain/task";
import type { AgentRunner } from "../../src/agent/runner";

const task: Task = {
  id: "t1",
  sourceId: "outlook",
  externalId: "m1",
  url: "https://outlook.office.com/mail/id/m1",
  title: "Where is my order?",
  body: "Nothing arrived.",
  metadata: { from: "customer@example.com" },
  typeId: "type-1",
  typeCandidates: null,
  state: "processing",
  assignee: null,
  context: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const scope = {
  task: { title: "Where is my order?", url: "https://example.com/m1" },
  context: { reply: "We are checking with the courier.", brief_session: "sess-99", blank: "" },
};

test("session targets become a resume command and empty ones are dropped", () => {
  const resolved = resolveHandoff(
    [
      { kind: "url", label: "The email", url: "{{task.url}}" },
      { kind: "url", label: "Missing", url: "{{context.blank}}" },
      { kind: "draft", label: "Reply", content: "{{context.reply}}" },
      { kind: "session", label: "Prep chat", sessionId: "{{context.brief_session}}" },
      { kind: "session", label: "No session", sessionId: "{{context.nothing}}" },
      { kind: "command", label: "Checkout", command: "gh pr checkout 42" },
    ],
    scope,
  );

  expect(resolved).toEqual([
    { kind: "url", label: "The email", url: "https://example.com/m1" },
    { kind: "draft", label: "Reply", content: "We are checking with the courier." },
    { kind: "command", label: "Prep chat", command: "claude --resume sess-99" },
    { kind: "command", label: "Checkout", command: "gh pr checkout 42" },
  ]);
});

test("an agent step's session id reaches the handoff the assign step declares", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Review {{task.title}}",
        tools: ["github__get_pr"],
        output: "review",
      },
      {
        id: "s2",
        type: "assign",
        to: "human",
        open: [
          { kind: "url", label: "The email", url: "{{task.url}}" },
          { kind: "session", label: "Review conversation", sessionId: "{{context.review_session}}" },
        ],
      },
    ],
  });

  const runner: AgentRunner = {
    id: "fake",
    async run() {
      return { text: "looks fine", toolCalls: [], sessionId: "sess-abc" };
    },
  };

  const result = await runPipeline(
    {
      provider: { id: "stub", async complete() { return { text: "", toolCalls: [] }; } },
      callTool: async () => "",
      loadPipeline: () => null,
      listTools: () => [
        { name: "github__get_pr", description: "PR", inputSchema: { type: "object" } },
      ],
      runAgent: runner,
    },
    definition,
    task,
  );

  expect(result.context.review_session).toBe("sess-abc");
  expect(result.handoff).toEqual([
    { kind: "url", label: "The email", url: "https://outlook.office.com/mail/id/m1" },
    { kind: "command", label: "Review conversation", command: "claude --resume sess-abc" },
  ]);
  expect(result.assignee).toBe("human");
});

test("an assign step with no open list produces no handoff", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [{ id: "s1", type: "assign", to: "human" }],
  });

  const result = await runPipeline(
    {
      provider: { id: "stub", async complete() { return { text: "", toolCalls: [] }; } },
      callTool: async () => "",
      loadPipeline: () => null,
    },
    definition,
    task,
  );

  expect(result.handoff).toBeUndefined();
});
