import { test, expect } from "bun:test";
import { openDb, migrate } from "../src/db";
import { insertTask, getTask, deleteTask, updateTask } from "../src/repo/tasks";
import { insertTaskType, getTaskType, listTaskTypes } from "../src/repo/taskTypes";
import { insertRule, activateRule, getActiveRule } from "../src/repo/rules";
import { wasMerged } from "../src/repo/mergedSourceItems";
import {
  onTaskIngested,
  confirmTaskType,
  skipOnboarding,
  onboardType,
  activateTypeRule,
  mergeTasks,
  resolveDuplicate,
  markDuplicate,
  runRuleForTask,
  rerunStep,
  getDependents,
  type AppDeps,
} from "../src/orchestrator";
import { insertHint } from "../src/repo/hints";
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

test("a deadline mentioned in the task survives an ambiguous triage outcome", async () => {
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
      deadline: "2026-02-01",
    }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.deadline).toBe("2026-02-01");
});

test("a deadline mentioned in the task survives a matched triage outcome and rule run", async () => {
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
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null, deadline: "2026-02-01" }),
    "Customer is chasing a delivery",
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.deadline).toBe("2026-02-01");
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

test("a task with no URL runs normally against a rule that needs {{task.url}}, rendering it empty", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "PR review", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "Review {{task.url}}", output: "review" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = insertTask(db, { ...sample, url: null });
  const app = deps(db, ["Looks fine"]);

  const result = await confirmTaskType(app, task.id, type.id);

  expect(result.state).toBe("assigned_human");
  expect(result.context.review).toBe("Looks fine");
});

test("a task with no URL drops the empty url-kind handoff target from an assign step's open array", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "PR review", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          {
            id: "s1",
            type: "assign",
            to: "human",
            open: [{ kind: "url", label: "Task", url: "{{task.url}}" }],
          },
        ],
      },
    }).id,
  );
  const task = insertTask(db, { ...sample, url: null });
  const app = deps(db, []);

  const result = await confirmTaskType(app, task.id, type.id);

  expect(result.state).toBe("assigned_human");
  expect(result.context.handoff).toEqual([]);
});

test("a task with a URL runs normally against a rule that needs {{task.url}}", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "PR review", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "Review {{task.url}}", output: "review" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = insertTask(db, { ...sample, url: "https://github.com/org/repo/pull/1" });
  const app = deps(db, ["Looks fine"]);

  const result = await confirmTaskType(app, task.id, type.id);

  expect(result.state).toBe("assigned_human");
  expect(result.context.review).toBe("Looks fine");
});

test("a task matching an open candidate is flagged for dedup confirmation, not triaged", async () => {
  const db = freshDb();
  const existing = insertTask(db, { ...sample, externalId: "m0" });
  const task = insertTask(db, { ...sample, externalId: "m1" });
  const app = deps(db, [
    JSON.stringify({ duplicateOfTaskId: existing.id, confidence: 0.9, rationale: "same order number" }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("needs_dedup_confirmation");
  expect(result.dedupCandidateId).toBe(existing.id);
  expect(result.context.dedupRationale).toBe("same order number");
});

test("a task assigned to a human is still a valid dedup candidate", async () => {
  const db = freshDb();
  const existingRaw = insertTask(db, { ...sample, externalId: "m0" });
  const existing = updateTask(db, existingRaw.id, { state: "assigned_human", assignee: "human" });
  const task = insertTask(db, { ...sample, externalId: "m1" });
  const app = deps(db, [
    JSON.stringify({ duplicateOfTaskId: existing.id, confidence: 0.8, rationale: "same customer, same issue" }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("needs_dedup_confirmation");
  expect(result.dedupCandidateId).toBe(existing.id);
});

test("a done task is not a dedup candidate, so a new task proceeds straight to triage", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const doneRaw = insertTask(db, { ...sample, externalId: "m0" });
  updateTask(db, doneRaw.id, { state: "done" });
  const task = insertTask(db, { ...sample, externalId: "m1" });
  const app = deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]);

  const result = await onTaskIngested(app, task);

  expect(result.state).not.toBe("needs_dedup_confirmation");
  expect(result.typeId).toBe(type.id);
});

test("resolveDuplicate(true) merges the duplicate into its candidate and deletes it", async () => {
  const db = freshDb();
  const target = insertTask(db, { ...sample, externalId: "m0" });
  const dupRaw = insertTask(db, { ...sample, externalId: "m1" });
  const dup = updateTask(db, dupRaw.id, { state: "needs_dedup_confirmation", dedupCandidateId: target.id });
  const app = deps(db, []);

  const merged = await resolveDuplicate(app, dup.id, true);

  expect(merged.id).toBe(target.id);
  expect(merged.context.mergedFrom).toEqual([
    expect.objectContaining({ taskId: dup.id, sourceId: dup.sourceId, externalId: dup.externalId }),
  ]);
  expect(getTask(db, dup.id)).toBeNull();
});

test("resolveDuplicate(false) clears the candidate and proceeds through triage", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const other = insertTask(db, { ...sample, externalId: "m0" });
  const taskRaw = insertTask(db, { ...sample, externalId: "m1" });
  const task = updateTask(db, taskRaw.id, { state: "needs_dedup_confirmation", dedupCandidateId: other.id });
  const app = deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]);

  const result = await resolveDuplicate(app, task.id, false);

  expect(result.dedupCandidateId).toBeNull();
  expect(result.typeId).toBe(type.id);
  expect(getTask(db, other.id)).not.toBeNull();
});

test("markDuplicate merges a task into a chosen target regardless of dedup state", async () => {
  const db = freshDb();
  const targetRaw = insertTask(db, { ...sample, externalId: "m0" });
  const target = updateTask(db, targetRaw.id, { state: "done" });
  const dup = insertTask(db, { ...sample, externalId: "m1" });
  const app = deps(db, []);

  const merged = markDuplicate(app, dup.id, target.id);

  expect(merged.id).toBe(target.id);
  expect((merged.context.mergedFrom as unknown[]).length).toBe(1);
  expect(getTask(db, dup.id)).toBeNull();
});

test("mergeTasks refuses to merge away a task that is currently processing", () => {
  const db = freshDb();
  const target = insertTask(db, { ...sample, externalId: "m0" });
  const dupRaw = insertTask(db, { ...sample, externalId: "m1" });
  const dup = updateTask(db, dupRaw.id, { state: "processing" });
  const app = deps(db, []);

  expect(() => mergeTasks(app, dup.id, target.id)).toThrow(/processing/);
});

test("two different duplicates merging into the same target both record their mergedFrom entries", () => {
  const db = freshDb();
  const target = insertTask(db, { ...sample, externalId: "m0" });
  const dupA = insertTask(db, { ...sample, externalId: "m1" });
  const dupB = insertTask(db, { ...sample, externalId: "m2" });
  const app = deps(db, []);

  mergeTasks(app, dupA.id, target.id);
  const merged = mergeTasks(app, dupB.id, target.id);

  const recorded = merged.context.mergedFrom as { taskId: string }[];
  expect(recorded.map((r) => r.taskId)).toEqual([dupA.id, dupB.id]);
});

test("resolveDuplicate surfaces a clear error rather than crashing when the candidate task is gone", async () => {
  const db = freshDb();
  const candidate = insertTask(db, { ...sample, externalId: "m0" });
  const taskRaw = insertTask(db, { ...sample, externalId: "m1" });
  const task = updateTask(db, taskRaw.id, { state: "needs_dedup_confirmation", dedupCandidateId: candidate.id });
  deleteTask(db, candidate.id);
  const app = deps(db, []);

  await expect(resolveDuplicate(app, task.id, true)).rejects.toThrow(/unknown task/);
});

test("mergeTasks tombstones the duplicate's source item so a re-listing poller never resurrects it", async () => {
  const db = freshDb();
  const target = insertTask(db, { ...sample, externalId: "m0" });
  const dup = insertTask(db, { ...sample, externalId: "m1" });
  const app = deps(db, []);

  mergeTasks(app, dup.id, target.id);

  expect(wasMerged(db, dup.sourceId, dup.externalId)).toBe(true);
});

test("mergeTasks refuses to merge into a target that is currently processing, to avoid losing the merge record", () => {
  const db = freshDb();
  const targetRaw = insertTask(db, { ...sample, externalId: "m0" });
  const target = updateTask(db, targetRaw.id, { state: "processing" });
  const dup = insertTask(db, { ...sample, externalId: "m1" });
  const app = deps(db, []);

  expect(() => mergeTasks(app, dup.id, target.id)).toThrow(/processing/);
});

test("resolveDuplicate(false) proceeds through triage even when the candidate was already cleared, so a dangling reference is never a dead end", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const taskRaw = insertTask(db, { ...sample, externalId: "m1" });
  const task = updateTask(db, taskRaw.id, { state: "needs_dedup_confirmation", dedupCandidateId: null });
  const app = deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]);

  const result = await resolveDuplicate(app, task.id, false);

  expect(result.typeId).toBe(type.id);
});

test("a task pending its own dedup confirmation is not offered as a dedup candidate to a newer task", async () => {
  const db = freshDb();
  const other = insertTask(db, { ...sample, externalId: "m0" });
  const pendingRaw = insertTask(db, { ...sample, externalId: "m-pending" });
  updateTask(db, pendingRaw.id, { state: "needs_dedup_confirmation", dedupCandidateId: other.id });
  const task = insertTask(db, { ...sample, externalId: "m1" });

  let capturedMessage = "";
  const app: AppDeps = {
    db,
    provider: {
      id: "stub",
      async complete(req) {
        const first = req.messages[0]; capturedMessage = first && "content" in first ? first.content : "";
        return {
          text: JSON.stringify({ duplicateOfTaskId: other.id, confidence: 0.9, rationale: "match" }),
          toolCalls: [],
        };
      },
    },
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };

  await onTaskIngested(app, task);

  expect(capturedMessage).not.toContain(pendingRaw.id);
  expect(capturedMessage).toContain(other.id);
});

test("dedup candidates are capped at the 30 most recently created tasks", async () => {
  const db = freshDb();
  for (let i = 0; i < 35; i++) {
    insertTask(db, { ...sample, externalId: `old-${i}` });
  }
  const task = insertTask(db, { ...sample, externalId: "new" });

  let capturedMessage = "";
  const app: AppDeps = {
    db,
    provider: {
      id: "stub",
      async complete(req) {
        const first = req.messages[0]; capturedMessage = first && "content" in first ? first.content : "";
        const firstId = capturedMessage.match(/- id: (\S+)/)?.[1] ?? "";
        return {
          text: JSON.stringify({ duplicateOfTaskId: firstId, confidence: 0.9, rationale: "match" }),
          toolCalls: [],
        };
      },
    },
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };

  await onTaskIngested(app, task);

  const idCount = (capturedMessage.match(/- id:/g) ?? []).length;
  expect(idCount).toBe(30);
});

test("runRuleForTask injects saved hints into the ai step prompt", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const rule = activateRule(
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
  insertHint(db, { ruleId: rule.id, stepId: "s1", text: "Always use formal tone" });
  const task = updateTask(db, insertTask(db, sample).id, { typeId: type.id, state: "processing" });

  let captured = "";
  const app: AppDeps = {
    ...deps(db, ["done"]),
    provider: {
      id: "stub",
      async complete(req) {
        const first = req.messages[0];
        captured = first && "content" in first ? first.content : "";
        return { text: "done", toolCalls: [] };
      },
    },
  };

  await runRuleForTask(app, getTask(db, task.id)!, rule);

  expect(captured).toContain("Notes from past corrections on this step");
  expect(captured).toContain("Always use formal tone");
});

test("rerunStep updates only the target context key and appends ruleLog", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "A", output: "a" },
          { id: "s2", type: "ai", prompt: "B", output: "b" },
          { id: "s3", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = updateTask(db, insertTask(db, sample).id, {
    typeId: type.id,
    state: "assigned_human",
    assignee: "human",
    context: {
      a: "old-a",
      b: "keep-b",
      ruleLog: [
        { stepId: "s1", type: "ai", output: "a" },
        { stepId: "s2", type: "ai", output: "b" },
        { stepId: "s3", type: "assign" },
      ],
    },
  });
  const app = deps(db, ["new-a"]);

  const updated = await rerunStep(app, task.id, "s1");

  expect(updated.state).toBe("assigned_human");
  expect(updated.assignee).toBe("human");
  expect(updated.context.a).toBe("new-a");
  expect(updated.context.b).toBe("keep-b");
  const log = updated.context.ruleLog as { stepId: string }[];
  expect(log).toHaveLength(4);
  expect(log[3]).toMatchObject({ stepId: "s1", type: "ai", output: "a" });
});

test("getDependents respects ranStepIds from ruleLog", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "a", type: "ai", prompt: "extract", output: "fields" },
          { id: "b", type: "ai", prompt: "Build from {{context.fields}}", output: "query" },
          { id: "c", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const taskId = updateTask(db, insertTask(db, sample).id, {
    typeId: type.id,
    context: {
      fields: "x",
      ruleLog: [{ stepId: "a", type: "ai", output: "fields" }],
    },
  }).id;
  const app = deps(db, []);

  expect(getDependents(app, taskId, "a")).toEqual({ safe: [], unsafe: [] });

  updateTask(db, taskId, {
    context: {
      fields: "x",
      ruleLog: [
        { stepId: "a", type: "ai", output: "fields" },
        { stepId: "b", type: "ai", output: "query" },
      ],
    },
  });

  expect(getDependents(app, taskId, "a")).toEqual({ safe: ["b"], unsafe: [] });
});
