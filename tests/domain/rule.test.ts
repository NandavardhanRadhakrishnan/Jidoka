import { test, expect } from "bun:test";
import { RuleDefinitionSchema } from "../../src/domain/rule";

test("an assign-to-ai step accepts an optional agentTask with AgentStep-shaped defaults", () => {
  const parsed = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "assign",
        to: "ai",
        agentTask: { prompt: "Resolve {{task.title}}", tools: ["files__write"] },
      },
    ],
  });

  const step = parsed.steps[0];
  if (step?.type !== "assign") throw new Error("expected an assign step");
  expect(step.agentTask?.prompt).toBe("Resolve {{task.title}}");
  expect(step.agentTask?.tools).toEqual(["files__write"]);
  expect(step.agentTask?.maxIterations).toBe(6);
});

test("an assign-to-human step does not require agentTask", () => {
  const parsed = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "assign", to: "human" }],
  });
  const step = parsed.steps[0];
  if (step?.type !== "assign") throw new Error("expected an assign step");
  expect(step.agentTask).toBeUndefined();
});

test("an assign-to-ai step with no agentTask parses fine too, for the fallback path", () => {
  const parsed = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "assign", to: "ai" }],
  });
  const step = parsed.steps[0];
  if (step?.type !== "assign") throw new Error("expected an assign step");
  expect(step.to).toBe("ai");
  expect(step.agentTask).toBeUndefined();
});

test("agentTask.tools defaults to an empty array when omitted", () => {
  const parsed = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "assign", to: "ai", agentTask: { prompt: "p" } }],
  });
  const step = parsed.steps[0];
  if (step?.type !== "assign") throw new Error("expected an assign step");
  expect(step.agentTask?.tools).toEqual([]);
});

test("agentTask.maxIterations is bounded like an agent step's", () => {
  expect(() =>
    RuleDefinitionSchema.parse({
      steps: [{ id: "s1", type: "assign", to: "ai", agentTask: { prompt: "p", maxIterations: 99 } }],
    }),
  ).toThrow();
});
