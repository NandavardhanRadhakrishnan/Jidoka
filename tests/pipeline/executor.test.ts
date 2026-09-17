import { test, expect } from "bun:test";
import { runPipeline } from "../../src/pipeline/executor";
import { PipelineDefinitionSchema } from "../../src/domain/pipeline";
import type { AiProvider } from "../../src/ai/provider";
import type { Task } from "../../src/domain/task";

const task: Task = {
  id: "t1",
  sourceId: "outlook",
  externalId: "m1",
  url: null,
  title: "Where is my order?",
  body: "I ordered last week.",
  metadata: { from: "customer@example.com" },
  typeId: "type-1",
  typeCandidates: null,
  state: "processing",
  assignee: null,
  context: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function scriptedProvider(replies: string[]): AiProvider & { prompts: string[] } {
  let i = 0;
  return {
    id: "stub",
    prompts: [],
    async complete(req) {
      const last = req.messages.at(-1);
      this.prompts.push(last && "content" in last ? last.content : "");
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
}

const noTools = async () => {
  throw new Error("no MCP in this test");
};
const noPipelines = () => null;

test("an ai step stores its output in the context and can be templated into the next step", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize: {{task.body}}", output: "summary" },
      { id: "s2", type: "ai", prompt: "Classify: {{context.summary}}", output: "category" },
      { id: "s3", type: "assign", to: "human" },
    ],
  });
  const provider = scriptedProvider(["Customer chasing delivery", "external"]);

  const result = await runPipeline(
    { provider, callTool: noTools, loadPipeline: noPipelines },
    definition,
    task,
  );

  expect(provider.prompts[0]).toBe("Summarize: I ordered last week.");
  expect(provider.prompts[1]).toBe("Classify: Customer chasing delivery");
  expect(result.context).toEqual({ summary: "Customer chasing delivery", category: "external" });
  expect(result.assignee).toBe("human");
  expect(result.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s3"]);
});

test("a branch step runs the matching case and falls back to default", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Classify {{task.title}}", output: "category" },
      {
        id: "s2",
        type: "branch",
        on: "category",
        cases: {
          external: [{ id: "s2a", type: "assign", to: "human" }],
          internal: [{ id: "s2b", type: "assign", to: "ai" }],
        },
        default: [{ id: "s2c", type: "assign", to: "human" }],
      },
    ],
  });

  const external = await runPipeline(
    { provider: scriptedProvider(["external"]), callTool: noTools, loadPipeline: noPipelines },
    definition,
    task,
  );
  expect(external.assignee).toBe("human");
  expect(external.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s2a"]);

  const unknown = await runPipeline(
    { provider: scriptedProvider(["something else"]), callTool: noTools, loadPipeline: noPipelines },
    definition,
    task,
  );
  expect(unknown.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s2c"]);
});

test("an mcp_tool step renders its input and stores the tool result", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "mcp_tool",
        server: "outlook",
        tool: "get_thread",
        input: { address: "{{task.metadata.from}}" },
        output: "thread",
      },
      { id: "s2", type: "assign", to: "ai" },
    ],
  });
  const calls: unknown[] = [];

  const result = await runPipeline(
    {
      provider: scriptedProvider([]),
      callTool: async (server, tool, input) => {
        calls.push({ server, tool, input });
        return "thread text";
      },
      loadPipeline: noPipelines,
    },
    definition,
    task,
  );

  expect(calls).toEqual([
    { server: "outlook", tool: "get_thread", input: { address: "customer@example.com" } },
  ]);
  expect(result.context.thread).toBe("thread text");
  expect(result.assignee).toBe("ai");
});

test("an agent step loops over tool calls until the model stops calling tools", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Gather context for {{task.title}}",
        tools: ["outlook__search_messages", "outlook__get_thread"],
        maxIterations: 4,
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  const turns = [
    {
      text: "",
      toolCalls: [
        { id: "c1", name: "outlook__search_messages", input: { from: "customer@example.com" } },
      ],
      raw: [{ type: "tool_use", id: "c1" }],
    },
    {
      text: "",
      toolCalls: [{ id: "c2", name: "outlook__get_thread", input: { id: "m9" } }],
      raw: [{ type: "tool_use", id: "c2" }],
    },
    { text: "Customer asked twice about order 42", toolCalls: [], raw: [] },
  ];
  let turn = 0;
  const seen: unknown[] = [];
  const provider = {
    id: "stub",
    async complete(req: { messages: unknown[]; tools?: { name: string }[] }) {
      seen.push({ messageCount: req.messages.length, tools: req.tools?.map((t) => t.name) });
      return turns[turn++]!;
    },
  };
  const toolCalls: string[] = [];

  const result = await runPipeline(
    {
      provider,
      callTool: async (server, tool) => {
        toolCalls.push(`${server}/${tool}`);
        return "tool output";
      },
      loadPipeline: noPipelines,
      listTools: () => [
        { name: "outlook__search_messages", description: "Search", inputSchema: { type: "object" } },
        { name: "outlook__get_thread", description: "Thread", inputSchema: { type: "object" } },
        { name: "orders__lookup", description: "Orders", inputSchema: { type: "object" } },
      ],
    },
    definition,
    task,
  );

  expect(toolCalls).toEqual(["outlook/search_messages", "outlook/get_thread"]);
  expect(result.context.brief).toBe("Customer asked twice about order 42");
  expect(seen[0]).toEqual({
    messageCount: 1,
    tools: ["outlook__search_messages", "outlook__get_thread"],
  });
  expect(seen[2]).toEqual({
    messageCount: 5,
    tools: ["outlook__search_messages", "outlook__get_thread"],
  });
  expect(result.assignee).toBe("human");
});

test("an agent step stops at maxIterations", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Keep going",
        tools: ["outlook__get_thread"],
        maxIterations: 2,
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  let calls = 0;

  await runPipeline(
    {
      provider: {
        id: "stub",
        async complete() {
          calls += 1;
          return {
            text: "still working",
            toolCalls: [{ id: `c${calls}`, name: "outlook__get_thread", input: {} }],
            raw: [],
          };
        },
      },
      callTool: async () => "output",
      loadPipeline: noPipelines,
      listTools: () => [
        { name: "outlook__get_thread", description: "Thread", inputSchema: { type: "object" } },
      ],
    },
    definition,
    task,
  );

  expect(calls).toBe(2);
});

test("an agent step fails when a tool fails twice", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Try",
        tools: ["outlook__get_thread"],
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  await expect(
    runPipeline(
      {
        provider: {
          id: "stub",
          async complete() {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "outlook__get_thread", input: {} }],
              raw: [],
            };
          },
        },
        callTool: async () => {
          throw new Error("graph timeout");
        },
        loadPipeline: noPipelines,
        listTools: () => [
          { name: "outlook__get_thread", description: "Thread", inputSchema: { type: "object" } },
        ],
      },
      definition,
      task,
    ),
  ).rejects.toThrow(/failed twice: graph timeout/);
});

test("an agent step refuses tools that are not available", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "agent", prompt: "Go", tools: ["ghost__tool"], output: "brief" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  await expect(
    runPipeline(
      {
        provider: scriptedProvider([]),
        callTool: noTools,
        loadPipeline: noPipelines,
        listTools: () => [],
      },
      definition,
      task,
    ),
  ).rejects.toThrow(/unavailable tools ghost__tool/);
});

test("call_pipeline runs the pinned version and merges its context", async () => {
  const child = PipelineDefinitionSchema.parse({
    steps: [{ id: "c1", type: "ai", prompt: "Summarize {{task.title}}", output: "summary" }],
  });
  const parent = PipelineDefinitionSchema.parse({
    steps: [
      { id: "p1", type: "call_pipeline", typeId: "type-2", version: 3 },
      { id: "p2", type: "assign", to: "human" },
    ],
  });
  const asked: string[] = [];

  const result = await runPipeline(
    {
      provider: scriptedProvider(["done"]),
      callTool: noTools,
      loadPipeline: (typeId, version) => {
        asked.push(`${typeId}@${version}`);
        return child;
      },
    },
    parent,
    task,
  );

  expect(asked).toEqual(["type-2@3"]);
  expect(result.context.summary).toBe("done");
});

test("a pipeline that calls itself fails instead of looping", async () => {
  const selfCalling = PipelineDefinitionSchema.parse({
    steps: [{ id: "p1", type: "call_pipeline", typeId: "type-1", version: 1 }],
  });

  await expect(
    runPipeline(
      {
        provider: scriptedProvider([]),
        callTool: noTools,
        loadPipeline: () => selfCalling,
        self: { typeId: "type-1", version: 1 },
      },
      selfCalling,
      task,
    ),
  ).rejects.toThrow(/loop/i);
});

test("the schema rejects an unknown step type", () => {
  expect(() =>
    PipelineDefinitionSchema.parse({ steps: [{ id: "x", type: "teleport" }] }),
  ).toThrow();
});
