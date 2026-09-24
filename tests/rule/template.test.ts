import { test, expect } from "bun:test";
import { renderTemplate, renderInput } from "../../src/rule/template";

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
