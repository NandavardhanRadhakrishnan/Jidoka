import { test, expect } from "bun:test";
import { computeWriteTools } from "../../src/rule/writeTools";
import { RuleDefinitionSchema } from "../../src/domain/rule";
import type { ToolSpec } from "../../src/ai/provider";

const readTool: ToolSpec = {
  name: "outlook__get_thread",
  description: "",
  inputSchema: {},
  annotations: { readOnlyHint: true },
};
const writeTool: ToolSpec = {
  name: "outlook__send_reply",
  description: "",
  inputSchema: {},
  annotations: { readOnlyHint: false },
};
const unknownAnnotationTool: ToolSpec = {
  name: "files__write_file",
  description: "",
  inputSchema: {},
};

test("an agent step's read-only tools are excluded, its write tools included", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "p",
        tools: ["outlook__get_thread", "outlook__send_reply"],
        output: "o",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  expect(computeWriteTools(definition, [readTool, writeTool])).toEqual(["outlook__send_reply"]);
});

test("a tool with no annotation at all is treated as a write tool", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "agent", prompt: "p", tools: ["files__write_file"], output: "o" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  expect(computeWriteTools(definition, [unknownAnnotationTool])).toEqual(["files__write_file"]);
});

test("an mcp_tool step's server/tool pair is checked the same way", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "mcp_tool", server: "outlook", tool: "send_reply", input: {}, output: "o" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  expect(computeWriteTools(definition, [writeTool])).toEqual(["outlook__send_reply"]);
});

test("an assign step's agentTask.tools are included in the write-tool set", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "assign",
        to: "ai",
        agentTask: { prompt: "p", tools: ["outlook__send_reply"] },
      },
    ],
  });

  expect(computeWriteTools(definition, [writeTool])).toEqual(["outlook__send_reply"]);
});

test("tools inside nested branch cases and defaults are found too", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "p", output: "category" },
      {
        id: "s2",
        type: "branch",
        on: "category",
        cases: {
          a: [
            { id: "s2a", type: "agent", prompt: "p", tools: ["outlook__send_reply"], output: "o" },
            { id: "s2a2", type: "assign", to: "human" },
          ],
        },
        default: [
          { id: "s2d", type: "mcp_tool", server: "outlook", tool: "send_reply", input: {}, output: "o" },
          { id: "s2d2", type: "assign", to: "human" },
        ],
      },
    ],
  });

  expect(computeWriteTools(definition, [writeTool])).toEqual(["outlook__send_reply"]);
});

test("a tool referenced nowhere in the rule is not included even if it's a write tool", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "assign", to: "human" }],
  });

  expect(computeWriteTools(definition, [writeTool])).toEqual([]);
});

test("call_rule steps are not expanded — a called rule's tools are that rule's own concern", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [{ id: "s1", type: "call_rule", typeId: "other-type", version: 1 }],
  });

  expect(computeWriteTools(definition, [writeTool])).toEqual([]);
});

test("the result is deduplicated and sorted", () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "p",
        tools: ["outlook__send_reply", "files__write_file"],
        output: "o",
      },
      { id: "s2", type: "mcp_tool", server: "outlook", tool: "send_reply", input: {}, output: "o2" },
      { id: "s3", type: "assign", to: "human" },
    ],
  });

  expect(computeWriteTools(definition, [writeTool, unknownAnnotationTool])).toEqual([
    "files__write_file",
    "outlook__send_reply",
  ]);
});
