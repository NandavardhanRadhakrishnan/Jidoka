import { test, expect } from "bun:test";
import { buildRule } from "../../src/rule/builder";
import type { AiProvider } from "../../src/ai/provider";
import type { TaskType } from "../../src/domain/taskType";
import { modelCatalog } from "../../src/ai/models";

const models = modelCatalog("anthropic");

const type: TaskType = {
  id: "type-1",
  name: "Customer email",
  description: "A question from an external customer",
  examples: [],
  status: "proposed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function scripted(replies: string[]): AiProvider & { prompts: string[] } {
  let i = 0;
  return {
    id: "stub",
    prompts: [],
    async complete(req) {
      const last = req.messages.at(-1);
      const content = last && "content" in last ? last.content : "";
      this.prompts.push(`${req.system ?? ""}\n${content}`);
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
}

const valid = JSON.stringify({
  steps: [
    { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
    { id: "s2", type: "assign", to: "human", note: "{{context.summary}}" },
  ],
});

test("buildRule returns a validated definition", async () => {
  const provider = scripted([valid]);

  const definition = await buildRule(provider, {
    type,
    description: "Summarize the email then give it to a human",
    tools: [
      { name: "outlook__get_thread", description: "Fetch a thread", inputSchema: { type: "object" } },
    ],
    models: [],
  });

  expect(definition.steps).toHaveLength(2);
  expect(definition.steps[0]).toMatchObject({ type: "ai", output: "summary" });
  expect(provider.prompts[0]).toContain("outlook__get_thread");
  expect(provider.prompts[0]).toContain("Summarize the email then give it to a human");
});

test("buildRule retries once when the model emits an invalid step", async () => {
  const provider = scripted([
    JSON.stringify({ steps: [{ id: "s1", type: "teleport" }] }),
    valid,
  ]);

  const definition = await buildRule(provider, { type, description: "d", tools: [], models: [] });

  expect(definition.steps).toHaveLength(2);
  expect(provider.prompts).toHaveLength(2);
});

test("buildRule rejects a definition that references an unknown tool", async () => {
  const provider = scripted([
    JSON.stringify({
      steps: [
        { id: "s1", type: "mcp_tool", server: "ghost", tool: "x", input: {}, output: "o" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
    valid,
  ]);

  const definition = await buildRule(provider, {
    type,
    description: "d",
    tools: [
      { name: "outlook__get_thread", description: "Fetch a thread", inputSchema: { type: "object" } },
    ],
    models: [],
  });

  expect(definition.steps[0]).toMatchObject({ type: "ai" });
  expect(provider.prompts[1]).toContain("ghost");
});

test("buildRule keeps a model the response sets on an ai/agent step", async () => {
  const withModel = JSON.stringify({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", model: "claude-haiku-4-5-20251001", output: "summary" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const provider = scripted([withModel]);

  const definition = await buildRule(provider, { type, description: "d", tools: [], models });

  expect(definition.steps[0]).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  expect(provider.prompts[0]).toContain("claude-haiku-4-5-20251001");
});

test("buildRule retries when the response sets an unknown model id", async () => {
  const provider = scripted([
    JSON.stringify({
      steps: [
        { id: "s1", type: "ai", prompt: "x", model: "gpt-nonexistent", output: "o" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
    valid,
  ]);

  const definition = await buildRule(provider, { type, description: "d", tools: [], models });

  expect(definition.steps).toHaveLength(2);
  expect(provider.prompts[1]).toContain("gpt-nonexistent");
});
