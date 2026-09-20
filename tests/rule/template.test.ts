import { test, expect } from "bun:test";
import { renderTemplate, renderInput, ruleUsesTaskUrl } from "../../src/rule/template";
import { RuleDefinitionSchema } from "../../src/domain/rule";

const scope = {
  task: { title: "Where is my order?", body: "Not arrived", metadata: { from: "a@b.com" } },
  context: { summary: "Customer chasing delivery" },
};

test("renderTemplate substitutes task and context paths", () => {
  expect(renderTemplate("Subject: {{task.title}} / {{context.summary}}", scope)).toBe(
    "Subject: Where is my order? / Customer chasing delivery",
  );
});

test("renderTemplate substitutes nested metadata and leaves unknown paths empty", () => {
  expect(renderTemplate("From {{task.metadata.from}}|{{context.missing}}", scope)).toBe(
    "From a@b.com|",
  );
});

test("renderInput walks objects and arrays", () => {
  expect(
    renderInput({ query: "from:{{task.metadata.from}}", tags: ["{{context.summary}}", 3] }, scope),
  ).toEqual({ query: "from:a@b.com", tags: ["Customer chasing delivery", 3] });
});

test("ruleUsesTaskUrl finds {{task.url}} in an ai/agent prompt", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Look at {{task.url}}", output: "o" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  expect(ruleUsesTaskUrl(definition)).toBe(true);
});

test("ruleUsesTaskUrl finds {{task.url}} in an assign step's note and handoff targets", () => {
  const inNote = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "assign", to: "human", note: "See {{task.url}}" }],
  });
  expect(ruleUsesTaskUrl(inNote)).toBe(true);

  const inOpenUrl = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "assign",
        to: "human",
        open: [{ kind: "url", label: "PR", url: "{{task.url}}" }],
      },
    ],
  });
  expect(ruleUsesTaskUrl(inOpenUrl)).toBe(true);
});

test("ruleUsesTaskUrl finds {{task.url}} inside a branch's nested cases and default", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "classify", output: "category" },
      {
        id: "s2",
        type: "branch",
        on: "category",
        cases: {
          a: [{ id: "s2a", type: "assign", to: "human", note: "{{task.url}}" }],
        },
        default: [{ id: "s2d", type: "assign", to: "human" }],
      },
    ],
  });
  expect(ruleUsesTaskUrl(definition)).toBe(true);
});

test("ruleUsesTaskUrl is false when no step references task.url", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
      { id: "s2", type: "assign", to: "human", note: "{{context.summary}}" },
    ],
  });
  expect(ruleUsesTaskUrl(definition)).toBe(false);
});
