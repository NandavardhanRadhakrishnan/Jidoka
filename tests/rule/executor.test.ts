import { test, expect } from "bun:test";
import { runRule, rerunStep } from "../../src/rule/executor";
import { RuleDefinitionSchema } from "../../src/domain/rule";
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
  deadline: null,
  dedupCandidateId: null,
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
const noRules = () => null;

test("an ai step stores its output in the context and can be templated into the next step", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize: {{task.body}}", output: "summary" },
      { id: "s2", type: "ai", prompt: "Classify: {{context.summary}}", output: "category" },
      { id: "s3", type: "assign", to: "human" },
    ],
  });
  const provider = scriptedProvider(["Customer chasing delivery", "external"]);

  const result = await runRule(
    { provider, callTool: noTools, loadRule: noRules },
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
  const definition = RuleDefinitionSchema.parse({
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

  const external = await runRule(
    { provider: scriptedProvider(["external"]), callTool: noTools, loadRule: noRules },
    definition,
    task,
  );
  expect(external.assignee).toBe("human");
  expect(external.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s2a"]);

  const unknown = await runRule(
    { provider: scriptedProvider(["something else"]), callTool: noTools, loadRule: noRules },
    definition,
    task,
  );
  expect(unknown.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s2c"]);
});

test("an mcp_tool step renders its input and stores the tool result", async () => {
  const definition = RuleDefinitionSchema.parse({
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

  const result = await runRule(
    {
      provider: scriptedProvider([]),
      callTool: async (server, tool, input) => {
        calls.push({ server, tool, input });
        return "thread text";
      },
      loadRule: noRules,
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
  const definition = RuleDefinitionSchema.parse({
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

  const result = await runRule(
    {
      provider,
      callTool: async (server, tool) => {
        toolCalls.push(`${server}/${tool}`);
        return "tool output";
      },
      loadRule: noRules,
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
  const definition = RuleDefinitionSchema.parse({
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

  await runRule(
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
      loadRule: noRules,
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
  const definition = RuleDefinitionSchema.parse({
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
    runRule(
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
        loadRule: noRules,
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
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "agent", prompt: "Go", tools: ["ghost__tool"], output: "brief" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  await expect(
    runRule(
      {
        provider: scriptedProvider([]),
        callTool: noTools,
        loadRule: noRules,
        listTools: () => [],
      },
      definition,
      task,
    ),
  ).rejects.toThrow(/unavailable tools ghost__tool/);
});

test("call_rule runs the pinned version and merges its context", async () => {
  const child = RuleDefinitionSchema.parse({
    steps: [{ id: "c1", type: "ai", prompt: "Summarize {{task.title}}", output: "summary" }],
  });
  const parent = RuleDefinitionSchema.parse({
    steps: [
      { id: "p1", type: "call_rule", typeId: "type-2", version: 3 },
      { id: "p2", type: "assign", to: "human" },
    ],
  });
  const asked: string[] = [];

  const result = await runRule(
    {
      provider: scriptedProvider(["done"]),
      callTool: noTools,
      loadRule: (typeId, version) => {
        asked.push(`${typeId}@${version}`);
        return { id: "child-rule", definition: child };
      },
    },
    parent,
    task,
  );

  expect(asked).toEqual(["type-2@3"]);
  expect(result.context.summary).toBe("done");
});

test("a rule that calls itself fails instead of looping", async () => {
  const selfCalling = RuleDefinitionSchema.parse({
    steps: [{ id: "p1", type: "call_rule", typeId: "type-1", version: 1 }],
  });

  await expect(
    runRule(
      {
        provider: scriptedProvider([]),
        callTool: noTools,
        loadRule: () => ({ id: "self-rule", definition: selfCalling }),
        self: { typeId: "type-1", version: 1, ruleId: "self-rule" },
      },
      selfCalling,
      task,
    ),
  ).rejects.toThrow(/loop/i);
});

test("an ai step with a model set passes it to the provider", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", model: "claude-haiku-4-5-20251001", output: "summary" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const seenModels: (string | undefined)[] = [];
  const provider = {
    id: "stub",
    async complete(req: { model?: string }) {
      seenModels.push(req.model);
      return { text: "done", toolCalls: [] };
    },
  };

  await runRule({ provider, callTool: noTools, loadRule: noRules }, definition, task);

  expect(seenModels).toEqual(["claude-haiku-4-5-20251001"]);
});

test("an ai step with no model set passes none", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const seenModels: (string | undefined)[] = [];
  const provider = {
    id: "stub",
    async complete(req: { model?: string }) {
      seenModels.push(req.model);
      return { text: "done", toolCalls: [] };
    },
  };

  await runRule({ provider, callTool: noTools, loadRule: noRules }, definition, task);

  expect(seenModels).toEqual([undefined]);
});

test("an agent step with a model set passes it through the in-process runner", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Go",
        tools: [],
        model: "claude-opus-5",
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const seenModels: (string | undefined)[] = [];
  const provider = {
    id: "stub",
    async complete(req: { model?: string }) {
      seenModels.push(req.model);
      return { text: "done", toolCalls: [] };
    },
  };

  await runRule(
    { provider, callTool: noTools, loadRule: noRules, listTools: () => [] },
    definition,
    task,
  );

  expect(seenModels).toEqual(["claude-opus-5"]);
});

test("the schema rejects an unknown step type", () => {
  expect(() =>
    RuleDefinitionSchema.parse({ steps: [{ id: "x", type: "teleport" }] }),
  ).toThrow();
});

test("hint injection appends notes only when getHints returns entries", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "ai", prompt: "Summarize: {{task.body}}", output: "summary" }],
  });
  const provider = scriptedProvider(["out"]);

  await runRule(
    {
      provider,
      callTool: noTools,
      loadRule: noRules,
      self: { typeId: "type-1", version: 1, ruleId: "rule-1" },
      getHints: () => ["Use formal tone", "Keep it short"],
    },
    definition,
    task,
  );

  expect(provider.prompts[0]).toBe(
    "Summarize: I ordered last week.\n\nNotes from past corrections on this step:\n- Use formal tone\n- Keep it short",
  );
});

test("hint injection omits notes when getHints is undefined or empty", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "ai", prompt: "Summarize: {{task.body}}", output: "summary" }],
  });

  const withoutGetter = scriptedProvider(["a"]);
  await runRule(
    {
      provider: withoutGetter,
      callTool: noTools,
      loadRule: noRules,
      self: { typeId: "type-1", version: 1, ruleId: "rule-1" },
    },
    definition,
    task,
  );
  expect(withoutGetter.prompts[0]).toBe("Summarize: I ordered last week.");

  const emptyHints = scriptedProvider(["b"]);
  await runRule(
    {
      provider: emptyHints,
      callTool: noTools,
      loadRule: noRules,
      self: { typeId: "type-1", version: 1, ruleId: "rule-1" },
      getHints: () => [],
    },
    definition,
    task,
  );
  expect(emptyHints.prompts[0]).toBe("Summarize: I ordered last week.");
});

test("rerunStep finds a top-level ai step and patches only that context key", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "First", output: "summary" },
      { id: "s2", type: "ai", prompt: "Second", output: "category" },
    ],
  });
  const provider = scriptedProvider(["fresh summary"]);
  const taskWithContext = { ...task, context: { summary: "old", category: "keep-me", extra: 1 } };

  const { context, log } = await rerunStep(
    { provider, callTool: noTools, loadRule: noRules, self: { typeId: "t", version: 1, ruleId: "r1" } },
    definition,
    taskWithContext,
    "s1",
  );

  expect(context).toEqual({ summary: "fresh summary" });
  expect(log).toEqual({ stepId: "s1", type: "ai", output: "summary" });
  expect(taskWithContext.context).toEqual({ summary: "old", category: "keep-me", extra: 1 });
});

test("rerunStep finds a step nested inside a branch case", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "branch",
        type: "branch",
        on: "category",
        cases: {
          x: [{ id: "nested", type: "ai", prompt: "Nested {{task.title}}", output: "out" }],
        },
      },
    ],
  });
  const provider = scriptedProvider(["nested result"]);

  const { context } = await rerunStep(
    { provider, callTool: noTools, loadRule: noRules },
    definition,
    { ...task, context: { category: "x", out: "stale" } },
    "nested",
  );

  expect(context).toEqual({ out: "nested result" });
});

test("rerunStep finds a step inside a called sub-rule", async () => {
  const child = RuleDefinitionSchema.parse({
    steps: [{ id: "child-ai", type: "ai", prompt: "Child {{task.title}}", output: "summary" }],
  });
  const parent = RuleDefinitionSchema.parse({
    steps: [{ id: "call", type: "call_rule", typeId: "type-2", version: 1 }],
  });
  const provider = scriptedProvider(["from child"]);

  const { context } = await rerunStep(
    {
      provider,
      callTool: noTools,
      loadRule: () => ({ id: "child-rule-id", definition: child }),
    },
    parent,
    { ...task, context: { summary: "old" } },
    "child-ai",
  );

  expect(context).toEqual({ summary: "from child" });
});

test("rerunStep throws when the step id does not exist", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "ai", prompt: "x", output: "y" }],
  });

  await expect(
    rerunStep(
      { provider: scriptedProvider([]), callTool: noTools, loadRule: noRules },
      definition,
      task,
      "missing",
    ),
  ).rejects.toThrow(/missing/i);
});
