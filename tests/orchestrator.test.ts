import { test, expect } from "bun:test";
import { openDb, migrate } from "../src/db";
import { insertTask, getTask, deleteTask, updateTask } from "../src/repo/tasks";
import { insertTaskType, getTaskType, listTaskTypes, updateTaskType } from "../src/repo/taskTypes";
import { insertRule, activateRule, getActiveRule } from "../src/repo/rules";
import { wasMerged } from "../src/repo/mergedSourceItems";
import {
  onTaskIngested,
  onTaskChanged,
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
  retriageTask,
  retriageOpenTasksForType,
  setTaskPriority,
  refreshPriorityForType,
  completeTask,
  reopenTask,
  type AppDeps,
} from "../src/orchestrator";
import { insertHint } from "../src/repo/hints";
import { listAudit } from "../src/repo/audit";
import { upsertValid, setResolvedIdentity } from "../src/repo/extensions";
import type { AiProvider } from "../src/ai/provider";
import type { AgentRunInput, AgentRunner } from "../src/agent/runner";

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

/** The reopen relevance check's reply that lets a reopen proceed. */
const RELEVANT = JSON.stringify({ relevant: true });

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

test("a matched task with an active rule stamps isFollowUp false on its first run", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "isFollowUp={{context.isFollowUp}}", output: "flag" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  let capturedPrompt = "";
  let call = 0;
  const app: AppDeps = {
    db,
    provider: {
      id: "stub",
      async complete(req) {
        call++;
        if (call === 1) {
          return {
            text: JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
            toolCalls: [],
          };
        }
        const first = req.messages[0];
        capturedPrompt = first && "content" in first ? first.content : "";
        return { text: "captured", toolCalls: [] };
      },
    },
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };

  const result = await onTaskIngested(app, task);

  expect(capturedPrompt).toBe("isFollowUp=false");
  expect(result.context.isFollowUp).toBe("false");
});

test("onTaskChanged archives the current pass, stamps isFollowUp true and the new revision, and reruns the active rule", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Code review", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "pass={{context.isFollowUp}}", output: "review" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const initial = updateTask(db, insertTask(db, sample).id, {
    typeId: type.id,
    state: "done",
    assignee: "human",
    title: "Old title",
    body: "Old body",
    context: {
      revision: "rev-1",
      isFollowUp: "false",
      review: "first pass review",
      completedAt: "2026-01-01T00:00:00.000Z",
      completionNote: "Left comments, waiting for author",
      ruleLog: [
        { stepId: "s1", type: "ai", output: "review" },
        { stepId: "s2", type: "assign" },
      ],
    },
  });
  const app = deps(db, [RELEVANT, "pass=true"]);

  const result = await onTaskChanged(app, initial, {
    externalId: initial.externalId,
    title: "New title",
    body: "New body",
    revision: "rev-2",
  });

  expect(result.title).toBe("New title");
  expect(result.body).toBe("New body");
  expect(result.context.revision).toBe("rev-2");
  expect(result.context.isFollowUp).toBe("true");
  expect(result.context.completedAt).toBeUndefined();
  expect(result.context.completionNote).toBeUndefined();
  expect(result.context.review).toBe("pass=true");
  expect(result.state).toBe("assigned_human");

  const thread = result.context.thread as Array<Record<string, unknown>>;
  expect(thread).toHaveLength(1);
  expect(thread[0]).toMatchObject({
    outputs: { review: "first pass review" },
    assignee: "human",
    completedAt: "2026-01-01T00:00:00.000Z",
    completionNote: "Left comments, waiting for author",
  });
  expect(thread[0]?.ruleLog).toEqual([
    { stepId: "s1", type: "ai", output: "review" },
    { stepId: "s2", type: "assign" },
  ]);
});

test("onTaskChanged archives passes in order across multiple reopens", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Code review", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "go", output: "review" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const initial = updateTask(db, insertTask(db, sample).id, {
    typeId: type.id,
    state: "done",
    assignee: "human",
    context: { revision: "rev-1", review: "pass 1", ruleLog: [{ stepId: "s1", type: "ai", output: "review" }] },
  });
  const app = deps(db, [RELEVANT, "pass 2", RELEVANT, "pass 3"]);

  const afterFirstReopen = await onTaskChanged(app, initial, {
    externalId: initial.externalId,
    title: initial.title,
    body: initial.body,
    revision: "rev-2",
  });
  const done = updateTask(db, afterFirstReopen.id, { state: "done" });

  const afterSecondReopen = await onTaskChanged(app, done, {
    externalId: done.externalId,
    title: done.title,
    body: done.body,
    revision: "rev-3",
  });

  const thread = afterSecondReopen.context.thread as Array<Record<string, unknown>>;
  expect(thread).toHaveLength(2);
  expect(thread[0]?.outputs).toEqual({ review: "pass 1" });
  expect(thread[1]?.outputs).toEqual({ review: "pass 2" });
  expect(afterSecondReopen.context.review).toBe("pass 3");
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

test("retriageTask is a no-op when triage confirms the task's current type", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = updateTask(db, insertTask(db, sample).id, {
    typeId: type.id,
    state: "assigned_human",
    assignee: "human",
    context: { summary: "already handled" },
  });
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
  ]);

  const result = await retriageTask(app, task);

  expect(result.state).toBe("assigned_human");
  expect(result.assignee).toBe("human");
  expect(result.context.summary).toBe("already handled");
  expect(getTask(db, task.id)?.state).toBe("assigned_human");
});

test("retriageTask moves a task to a newly matched type and runs its rule", async () => {
  const db = freshDb();
  const oldType = insertTaskType(db, { name: "Old bucket", description: "vague" });
  const newType = insertTaskType(db, { name: "Customer email", description: "an external question" });
  activateRule(
    db,
    insertRule(db, {
      typeId: newType.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = updateTask(db, insertTask(db, sample).id, {
    typeId: oldType.id,
    state: "assigned_human",
    assignee: "human",
    context: { summary: "stale" },
  });
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: newType.id, confidence: 0.95 }], proposal: null }),
    "Customer is chasing a delivery",
  ]);

  const result = await retriageTask(app, task);

  expect(result.typeId).toBe(newType.id);
  expect(result.state).toBe("assigned_human");
  expect(result.context.summary).toBe("Customer is chasing a delivery");
});

test("retriageTask surfaces ambiguity even for an already-assigned task", async () => {
  const db = freshDb();
  const a = insertTaskType(db, { name: "Customer email", description: "d" });
  const b = insertTaskType(db, { name: "Internal request", description: "d" });
  const task = updateTask(db, insertTask(db, sample).id, {
    typeId: a.id,
    state: "assigned_human",
    assignee: "human",
  });
  const app = deps(db, [
    JSON.stringify({
      scores: [
        { typeId: a.id, confidence: 0.7 },
        { typeId: b.id, confidence: 0.65 },
      ],
      proposal: null,
    }),
  ]);

  const result = await retriageTask(app, task);

  expect(result.state).toBe("needs_type_confirmation");
  expect(result.typeCandidates).toEqual([a.id, b.id]);
});

test("retriageOpenTasksForType only re-triages open tasks: done and processing are skipped, failed is included", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });

  const open1 = updateTask(db, insertTask(db, { ...sample, externalId: "open1" }).id, {
    typeId: type.id,
    state: "assigned_human",
    assignee: "human",
  });
  const doneTask = updateTask(db, insertTask(db, { ...sample, externalId: "done1" }).id, {
    typeId: type.id,
    state: "done",
  });
  const processingTask = updateTask(db, insertTask(db, { ...sample, externalId: "proc1" }).id, {
    typeId: type.id,
    state: "processing",
  });
  const failedTask = updateTask(db, insertTask(db, { ...sample, externalId: "failed1" }).id, {
    typeId: type.id,
    state: "failed",
    context: { error: "boom" },
  });

  let calls = 0;
  const app: AppDeps = {
    db,
    provider: {
      id: "stub",
      async complete() {
        calls++;
        return {
          text: JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
          toolCalls: [],
        };
      },
    },
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };

  await retriageOpenTasksForType(app, type.id);

  // Exactly the two open tasks (assigned_human + failed) were re-triaged;
  // done and processing were never even sent to the provider.
  expect(calls).toBe(2);
  expect(getTask(db, doneTask.id)?.state).toBe("done");
  expect(getTask(db, processingTask.id)?.state).toBe("processing");
  // Matched back to the same type each is already on, so both are no-ops.
  expect(getTask(db, open1.id)?.state).toBe("assigned_human");
  expect(getTask(db, failedTask.id)?.state).toBe("failed");
});

test("a task assigned to ai with an agentTask runs it and lands in done with the result as the completion note", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          {
            id: "s1",
            type: "assign",
            to: "ai",
            agentTask: { prompt: "Resolve {{task.title}}", tools: [], maxIterations: 2 },
          },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  const runCalls: AgentRunInput[] = [];
  const runAgent: AgentRunner = {
    id: "stub",
    async run(input) {
      runCalls.push(input);
      return { text: "Order 42 shipped yesterday.", toolCalls: [] };
    },
  };
  const app: AppDeps = {
    ...deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]),
    runAgent,
  };

  const result = await onTaskIngested(app, task);
  expect(result.state).toBe("assigned_ai");
  expect(result.assignee).toBe("ai");

  await Bun.sleep(10);

  const finished = getTask(db, task.id)!;
  expect(finished.state).toBe("done");
  expect(finished.context.completionNote).toBe("Order 42 shipped yesterday.");
  expect(runCalls[0]?.prompt).toBe("Resolve Where is my order?");
  expect(runCalls[0]?.allowedTools).toEqual([]);
  expect(runCalls[0]?.maxTurns).toBe(2);
});

test("an assign-to-ai step with no agentTask still gets picked up, via the default fallback", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: { steps: [{ id: "s1", type: "assign", to: "ai" }] },
    }).id,
  );
  const task = insertTask(db, sample);
  const runCalls: AgentRunInput[] = [];
  const runAgent: AgentRunner = {
    id: "stub",
    async run(input) {
      runCalls.push(input);
      return { text: "Handled.", toolCalls: [] };
    },
  };
  const app: AppDeps = {
    ...deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]),
    runAgent,
  };

  await onTaskIngested(app, task);
  await Bun.sleep(10);

  expect(runCalls[0]?.allowedTools).toEqual([]);
  const finished = getTask(db, task.id)!;
  expect(finished.state).toBe("done");
});

test("a failing ai-assigned agent run leaves the task failed with the error recorded", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          {
            id: "s1",
            type: "assign",
            to: "ai",
            agentTask: { prompt: "Resolve it", tools: [], maxIterations: 6 },
          },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      throw new Error("agent sdk crashed");
    },
  };
  const app: AppDeps = {
    ...deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]),
    runAgent,
  };

  const result = await onTaskIngested(app, task);
  expect(result.state).toBe("assigned_ai");

  await Bun.sleep(10);

  const finished = getTask(db, task.id)!;
  expect(finished.state).toBe("failed");
  expect(String(finished.context.error)).toContain("agent sdk crashed");
});

test("an ai-assigned task closed by something else while the run is in flight is not clobbered on completion", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: {
        steps: [
          {
            id: "s1",
            type: "assign",
            to: "ai",
            agentTask: { prompt: "Resolve it", tools: [], maxIterations: 6 },
          },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      // Simulate a human closing the task by hand (or a merge/reopen) while
      // this run is still in flight, before the worker's own completion write.
      updateTask(db, task.id, {
        state: "done",
        context: { completedAt: "manual", completionNote: "closed by a human mid-run" },
      });
      return { text: "AI would have said this.", toolCalls: [] };
    },
  };
  const app: AppDeps = {
    ...deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]),
    runAgent,
  };

  await onTaskIngested(app, task);
  await Bun.sleep(10);

  const finished = getTask(db, task.id)!;
  expect(finished.state).toBe("done");
  expect(finished.context.completionNote).toBe("closed by a human mid-run");
});

test("a matched task with no urgency signal takes its type's default priority", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Legal letter", description: "d" });
  updateTaskType(db, type.id, { defaultPriority: "high" });
  const task = insertTask(db, sample);
  const app = deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]);

  const result = await onTaskIngested(app, task);

  expect(result.priority).toBe("high");
});

test("an urgency signal raises a matched task above its type's default and keeps the reason", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({
      scores: [{ typeId: type.id, confidence: 0.95 }],
      proposal: null,
      urgency: { level: "urgent", reason: "chargeback threatened" },
    }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.priority).toBe("urgent");
  expect(result.context.urgency).toEqual({ level: "urgent", reason: "chargeback threatened" });
});

test("confirming an ambiguous task's type applies that type's default priority", async () => {
  const db = freshDb();
  const a = insertTaskType(db, { name: "Customer email", description: "d" });
  const b = insertTaskType(db, { name: "Outage report", description: "d" });
  updateTaskType(db, b.id, { defaultPriority: "urgent" });
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
  const waiting = await onTaskIngested(app, task);
  expect(waiting.priority).toBe("normal");

  const confirmed = await confirmTaskType(app, waiting.id, b.id);

  expect(confirmed.priority).toBe("urgent");
});

test("a priority set by hand survives a later re-triage", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const other = insertTaskType(db, { name: "Outage report", description: "d" });
  const task = updateTask(db, insertTask(db, sample).id, { typeId: type.id, state: "assigned_human" });
  const app = deps(db, [
    JSON.stringify({
      scores: [{ typeId: other.id, confidence: 0.95 }],
      proposal: null,
      urgency: { level: "urgent", reason: "outage" },
    }),
  ]);

  const manual = setTaskPriority(app, task.id, "low");
  const result = await retriageTask(app, manual);

  expect(manual.priority).toBe("low");
  expect(result.priority).toBe("low");
});

test("setting priority back to auto drops the manual override and recomputes it", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Legal letter", description: "d" });
  updateTaskType(db, type.id, { defaultPriority: "high" });
  const task = updateTask(db, insertTask(db, sample).id, { typeId: type.id, state: "assigned_human" });
  const app = deps(db, []);

  setTaskPriority(app, task.id, "low");
  const auto = setTaskPriority(app, task.id, "auto");

  expect(auto.priority).toBe("high");
  expect(auto.context.priorityOverride).toBeUndefined();
});

test("changing a type's default re-prioritises its open tasks but not done or hand-set ones", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const open = updateTask(db, insertTask(db, sample).id, { typeId: type.id, state: "assigned_human" });
  const done = updateTask(db, insertTask(db, { ...sample, externalId: "m2" }).id, {
    typeId: type.id,
    state: "done",
  });
  const handSet = updateTask(db, insertTask(db, { ...sample, externalId: "m3" }).id, {
    typeId: type.id,
    state: "assigned_human",
  });
  const app = deps(db, []);
  setTaskPriority(app, handSet.id, "low");

  updateTaskType(db, type.id, { defaultPriority: "high" });
  refreshPriorityForType(app, type.id);

  expect(getTask(db, open.id)?.priority).toBe("high");
  expect(getTask(db, done.id)?.priority).toBe("normal");
  expect(getTask(db, handSet.id)?.priority).toBe("low");
});

function auditKinds(db: ReturnType<typeof freshDb>, taskId: string, kind: string) {
  return listAudit(db, { taskId }).filter((e) => e.kind === kind);
}

test("triage is audited with its outcome, deadline and urgency", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({
      scores: [{ typeId: type.id, confidence: 0.95 }],
      proposal: null,
      deadline: "2026-02-01",
      urgency: { level: "high", reason: "escalated" },
    }),
  ]);

  await onTaskIngested(app, task);

  const [entry] = auditKinds(db, task.id, "triaged");
  expect(entry).toMatchObject({
    actor: "system",
    typeId: type.id,
    data: {
      outcome: { kind: "matched", typeId: type.id },
      deadline: "2026-02-01",
      urgency: { level: "high", reason: "escalated" },
      priority: "high",
    },
  });
});

test("a rule run is audited with the rule version, step log and resulting assignee", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const rule = insertRule(db, {
    typeId: type.id,
    definition: {
      steps: [
        { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
        { id: "s2", type: "assign", to: "human" },
      ],
    },
  });
  activateRule(db, rule.id);
  const task = insertTask(db, sample);
  const app = deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }), "Chasing a delivery"]);

  await onTaskIngested(app, task);

  const [entry] = auditKinds(db, task.id, "rule_ran");
  expect(entry).toMatchObject({ ruleId: rule.id, typeId: type.id, data: { version: rule.version, assignee: "human" } });
  expect((entry!.data.log as { stepId: string }[]).map((l) => l.stepId)).toEqual(["s1", "s2"]);
});

test("a failing rule run is audited with its error", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: { steps: [{ id: "s1", type: "call_rule", typeId: "ghost", version: 1 }, { id: "s2", type: "assign", to: "human" }] },
    }).id,
  );
  const task = updateTask(db, insertTask(db, sample).id, { typeId: type.id });

  const result = await runRuleForTask(deps(db, []), task);

  expect(result.state).toBe("failed");
  expect(auditKinds(db, task.id, "rule_ran")[0]?.data.error).toBeString();
});

test("human decisions are audited with the human as actor", async () => {
  const db = freshDb();
  const a = insertTaskType(db, { name: "Customer email", description: "d" });
  const b = insertTaskType(db, { name: "Internal request", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: a.id, confidence: 0.7 }, { typeId: b.id, confidence: 0.65 }], proposal: null }),
  ]);
  await onTaskIngested(app, task);

  await confirmTaskType(app, task.id, b.id);
  await skipOnboarding(app, task.id);
  setTaskPriority(app, task.id, "urgent");
  completeTask(app, task.id, "replied by phone");
  reopenTask(app, task.id);

  const human = listAudit(db, { taskId: task.id }).filter((e) => e.actor === "human").reverse();
  expect(human.map((e) => e.kind)).toEqual([
    "type_confirmed",
    "onboarding_skipped",
    "priority_set",
    "completed",
    "reopened",
  ]);
  expect(human[0]!.data).toEqual({ typeId: b.id, candidates: [a.id, b.id] });
  expect(human[2]!.data).toEqual({ from: "normal", to: "urgent" });
  expect(human[3]!.data).toEqual({ note: "replied by phone" });
});

test("merging a duplicate is audited against both tasks and survives the duplicate's deletion", () => {
  const db = freshDb();
  const kept = updateTask(db, insertTask(db, sample).id, { state: "assigned_human" });
  const dup = updateTask(db, insertTask(db, { ...sample, externalId: "m2" }).id, { state: "assigned_human" });

  markDuplicate(deps(db, []), dup.id, kept.id);

  expect(auditKinds(db, dup.id, "merged")[0]).toMatchObject({ actor: "human", data: { intoTaskId: kept.id } });
  expect(auditKinds(db, kept.id, "merged")[0]).toMatchObject({ actor: "human", data: { duplicateTaskId: dup.id } });
});

test("rule activation is audited with the acknowledged write tools", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const rule = insertRule(db, { typeId: type.id, definition: { steps: [{ id: "s1", type: "assign", to: "human" }] } });

  await activateTypeRule(deps(db, []), rule.id, { acknowledgedWriteTools: ["gh__add_comment"] });

  const entry = listAudit(db).find((e) => e.kind === "rule_activated");
  expect(entry).toMatchObject({
    actor: "human",
    ruleId: rule.id,
    typeId: type.id,
    data: { version: rule.version, acknowledgedWriteTools: ["gh__add_comment"] },
  });
});

test("an AI worker finishing a task is audited with the AI as actor", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activateRule(db, insertRule(db, { typeId: type.id, definition: { steps: [{ id: "s1", type: "assign", to: "ai" }] } }).id);
  const task = insertTask(db, sample);
  const runAgent: AgentRunner = { id: "stub", async run() { return { text: "Handled.", toolCalls: [] }; } };
  const app: AppDeps = {
    ...deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]),
    runAgent,
  };

  await onTaskIngested(app, task);
  await Bun.sleep(10);

  expect(auditKinds(db, task.id, "completed")[0]).toMatchObject({ actor: "ai", data: { note: "Handled." } });
});

test("a not-relevant ingestion outcome dismisses the task instead of proposing a type", async () => {
  const db = freshDb();
  const task = insertTask(db, sample);
  const app = deps(db, [JSON.stringify({ scores: [], proposal: { name: "x", description: "y", rationale: "z" }, notRelevant: true })]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("dismissed");
  expect(listTaskTypes(db)).toHaveLength(0);
  expect(auditKinds(db, task.id, "triaged")[0]?.data.outcome).toEqual({ kind: "not_relevant" });
});

test("re-triage that finds a task no longer relevant dismisses it", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = updateTask(db, insertTask(db, sample).id, { typeId: type.id, state: "assigned_human" });
  const app = deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.9 }], proposal: null, notRelevant: true })]);

  const result = await retriageTask(app, task);

  expect(result.state).toBe("dismissed");
});

test("triage is told the connected user's identity for a task from an extension source", async () => {
  const db = freshDb();
  upsertValid(db, { id: "gh", name: "GitHub", version: "1", summary: "s", readOnly: true, auth: { mode: "api-key", label: "T" } });
  setResolvedIdentity(db, "gh", "octocat");
  const task = insertTask(db, { ...sample, sourceId: "gh" });
  let seen = "";
  const provider: AiProvider = {
    id: "stub",
    async complete(req) {
      seen = JSON.stringify(req.messages);
      return { text: JSON.stringify({ scores: [], proposal: null, notRelevant: true }), toolCalls: [] };
    },
  };

  await onTaskIngested({ ...deps(db, []), provider }, task);

  expect(seen).toContain("octocat");
});

test("a reopen judged not relevant only refreshes the revision: no new pass, no rule run, state kept", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Bug report", description: "d" });
  activateRule(
    db,
    insertRule(db, {
      typeId: type.id,
      definition: { steps: [{ id: "s1", type: "ai", prompt: "ack", output: "ack" }, { id: "s2", type: "assign", to: "human" }] },
    }).id,
  );
  const initial = updateTask(db, insertTask(db, sample).id, {
    typeId: type.id,
    state: "assigned_human",
    assignee: "human",
    context: { revision: "rev-1", ack: "first ack" },
  });
  const app = deps(db, [JSON.stringify({ relevant: false, reason: "our own comment" }), "SHOULD NOT RUN"]);

  const result = await onTaskChanged(app, initial, {
    externalId: initial.externalId,
    title: initial.title,
    body: "bot: acknowledged",
    revision: "rev-2",
  });

  expect(result.state).toBe("assigned_human");
  expect(result.context.revision).toBe("rev-2");
  expect(result.context.thread).toBeUndefined();
  expect(result.context.ack).toBe("first ack");
  expect(auditKinds(db, initial.id, "reopen_skipped")[0]?.data).toMatchObject({ revision: "rev-2", reason: "our own comment" });
});

test("a dismissed task whose source item changes is re-triaged with the new content", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const dismissed = updateTask(db, insertTask(db, sample).id, { state: "dismissed", context: { revision: "rev-1" } });
  const app = deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]);

  const result = await onTaskChanged(app, dismissed, {
    externalId: dismissed.externalId,
    title: "Now addressed to you",
    body: "@you can you handle this?",
    revision: "rev-2",
  });

  expect(result.body).toBe("@you can you handle this?");
  expect(result.context.revision).toBe("rev-2");
  expect(result.typeId).toBe(type.id);
  expect(result.state).toBe("needs_onboarding");
});
