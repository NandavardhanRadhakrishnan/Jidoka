import { test, expect } from "bun:test";
import { findDependentSteps } from "../../src/rule/dependents";
import { RuleDefinitionSchema } from "../../src/domain/rule";

test("findDependentSteps reports a direct dependent", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "a", type: "ai", prompt: "extract", output: "fields" },
      { id: "b", type: "ai", prompt: "Build query from {{context.fields}}", output: "query" },
      { id: "c", type: "assign", to: "human" },
    ],
  });

  const result = findDependentSteps(definition, new Set(["a", "b", "c"]), "a");

  expect(result.safe).toEqual(["b"]);
  expect(result.unsafe).toEqual([]);
});

test("findDependentSteps follows a transitive chain", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "a", type: "ai", prompt: "extract", output: "fields" },
      { id: "b", type: "ai", prompt: "from {{context.fields}}", output: "query_text" },
      { id: "c", type: "ai", prompt: "draft using {{context.query_text}}", output: "draft" },
    ],
  });

  const result = findDependentSteps(
    definition,
    new Set(["a", "b", "c"]),
    "a",
  );

  expect(result.safe).toEqual(["b", "c"]);
  expect(result.unsafe).toEqual([]);
});

test("findDependentSteps classifies mcp_tool dependents as unsafe", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "a", type: "ai", prompt: "extract", output: "fields" },
      {
        id: "b",
        type: "mcp_tool",
        server: "s",
        tool: "t",
        input: { q: "{{context.fields}}" },
        output: "result",
      },
    ],
  });

  const result = findDependentSteps(definition, new Set(["a", "b"]), "a");

  expect(result.safe).toEqual([]);
  expect(result.unsafe).toEqual(["b"]);
});

test("findDependentSteps classifies a branch whose on key is dirty as unsafe", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "a", type: "ai", prompt: "classify", output: "category" },
      {
        id: "b",
        type: "branch",
        on: "category",
        cases: { external: [{ id: "b1", type: "assign", to: "human" }] },
      },
    ],
  });

  const result = findDependentSteps(definition, new Set(["a", "b", "b1"]), "a");

  expect(result.unsafe).toEqual(["b"]);
  expect(result.safe).toEqual([]);
});

test("findDependentSteps ignores steps not in ranStepIds even when text references the dirty value", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "a", type: "ai", prompt: "extract", output: "fields" },
      { id: "b", type: "ai", prompt: "uses {{context.fields}}", output: "query" },
    ],
  });

  const result = findDependentSteps(definition, new Set(["a"]), "a");

  expect(result.safe).toEqual([]);
  expect(result.unsafe).toEqual([]);
});

test("findDependentSteps ignores steps in an untaken branch case", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "a", type: "ai", prompt: "classify", output: "category" },
      {
        id: "branch",
        type: "branch",
        on: "category",
        cases: {
          external: [{ id: "taken", type: "ai", prompt: "ok", output: "ok" }],
          internal: [
            {
              id: "skipped",
              type: "ai",
              prompt: "needs {{context.category}}",
              output: "inner",
            },
          ],
        },
      },
    ],
  });

  const result = findDependentSteps(
    definition,
    new Set(["a", "branch", "taken"]),
    "a",
  );

  expect(result.safe).not.toContain("skipped");
  expect(result.unsafe).not.toContain("skipped");
});
