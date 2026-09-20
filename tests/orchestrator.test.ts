import { test, expect } from "bun:test";
import { openDb, migrate } from "../src/db";
import { insertTask, getTask } from "../src/repo/tasks";
import { insertTaskType, getTaskType, listTaskTypes } from "../src/repo/taskTypes";
import { insertRule, activateRule, getActiveRule } from "../src/repo/rules";
import {
  onTaskIngested,
  confirmTaskType,
  skipOnboarding,
  onboardType,
  activateTypeRule,
  type AppDeps,
} from "../src/orchestrator";
import type { AiProvider } from "../src/ai/provider";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function deps(db: ReturnType<typeof freshDb>, replies: string[]): AppDeps {
  let i = 0;
  const provider: AiProvider = {
    id: "stub",
    async complete() {
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
  return {
    db,
    provider,
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };
}

const sample = { sourceId: "outlook", externalId: "m1", title: "Where is my order?", body: "…" };

test("an unmatched task creates a proposed type and waits for onboarding", async () => {
  const db = freshDb();
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({
      scores: [],
      proposal: { name: "Customer email", description: "External question", rationale: "first" },
    }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("needs_onboarding");
  const types = listTaskTypes(db);
  expect(types).toHaveLength(1);
  expect(types[0]?.status).toBe("proposed");
  expect(result.typeId).toBe(types[0]!.id);
});

test("an ambiguous task waits for the user and records candidates", async () => {
  const db = freshDb();
  const a = insertTaskType(db, { name: "Customer email", description: "d" });
  const b = insertTaskType(db, { name: "Internal request", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({
      scores: [
        { typeId: a.id, confidence: 0.7 },
        { typeId: b.id, confidence: 0.65 },
      ],
      proposal: null,
    }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("needs_type_confirmation");
  expect(result.typeCandidates).toEqual([a.id, b.id]);
});

test("a matched task with an active rule runs it and lands assigned", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
    "Customer is chasing a delivery",
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("assigned_human");
  expect(result.assignee).toBe("human");
  expect(result.context.summary).toBe("Customer is chasing a delivery");
});

test("a failing rule leaves the task in the failed state with the error recorded", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "mcp_tool", server: "ghost", tool: "x", input: {}, output: "o" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  const app = {
    ...deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]),
    mcp: {
      listTools: () => [],
      callTool: async () => {
        throw new Error("unknown MCP server: ghost");
      },
    },
  };

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("failed");
  expect(String(result.context.error)).toContain("ghost");
});

test("confirming a type stores an example and continues processing", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.4 }], proposal: null }),
  ]);
  await onTaskIngested(app, task);

  const confirmed = await confirmTaskType(app, task.id, type.id);

  expect(confirmed.typeId).toBe(type.id);
  expect(confirmed.state).toBe("needs_onboarding");
  expect(getTaskType(db, type.id)?.examples).toEqual(["Where is my order?"]);
});

test("skipping onboarding assigns the task to a human and leaves the type proposed", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
  ]);
  await onTaskIngested(app, task);

  const skipped = await skipOnboarding(app, task.id);

  expect(skipped.state).toBe("assigned_human");
  expect(getTaskType(db, type.id)?.status).toBe("proposed");
});

test("activating an onboarded rule processes the tasks that were waiting", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
    JSON.stringify({
      steps: [
        { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
    "A summary",
  ]);
  await onTaskIngested(app, task);

  const draft = await onboardType(app, type.id, "Summarize it and give it to a human");
  expect(draft.status).toBe("draft");
  expect(getTask(db, task.id)?.state).toBe("needs_onboarding");

  await activateTypeRule(app, draft.id);

  expect(getActiveRule(db, type.id)?.id).toBe(draft.id);
  expect(getTaskType(db, type.id)?.status).toBe("active");
  const processed = getTask(db, task.id);
  expect(processed?.state).toBe("assigned_human");
  expect(processed?.context.summary).toBe("A summary");
});
