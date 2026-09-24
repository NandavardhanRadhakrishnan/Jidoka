# Cross-source task dedup/merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a newly ingested task describes the same underlying work as an existing open task (via a new AI check ahead of triage) and let a human confirm the merge; also let a human manually tag any task as a duplicate of any other task at any time, independent of detection.

**Architecture:** A new `src/dedup/` module (mirroring `src/triage/`'s shape) runs one AI-completion check before triage in `onTaskIngested`. A detected match pauses the task in a new `needs_dedup_confirmation` state for a human to confirm or dismiss. One shared `mergeTasks()` function in `src/orchestrator.ts` does the actual merge (append a source-reference record to the kept task's `context.mergedFrom`, delete the duplicate's row) for both the AI-confirmed path and a new manual "mark as duplicate of…" UI path. Detection never auto-merges — every AI-detected match always waits for a human.

**Tech Stack:** Bun, TypeScript, Zod (response schemas), Hono (API routes), React (client), `bun:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-24-cross-source-dedup-design.md`

## Global Constraints

- Every LLM call goes through `AiProvider`/`completeJson`; never send `budget_tokens` or `thinking` (Anthropic default is `claude-opus-5`).
- No test hits a network — stub `AiProvider`s only, matching every existing test file's pattern.
- IDs are `crypto.randomUUID()` (already handled by `insertTask`); timestamps are ISO-8601 UTC (`new Date().toISOString()`).
- AI-detected duplicates never auto-merge — every detected match always creates a `needs_dedup_confirmation` pause; no confidence threshold ever skips the human.
- A merge never re-runs the kept task's rule and there is no un-merge flow — both explicitly out of scope.
- `src/db/index.ts`'s `migrate()` must stay idempotent against a real, already-migrated `jidoka.db` — any new `ALTER TABLE` goes through the existing "duplicate column name" tolerance, not a new migration mechanism.
- Follow existing API conventions exactly: routes pre-validate ids/bodies and return `{ error }` JSON with a specific status code rather than letting a thrown `Error` bubble into Hono's default 500.

## Review Focus

- A task's `dedupCandidateId` can point at a task that's since been deleted (merged away itself, or manually removed) by the time a human finally resolves the pending prompt — `resolveDuplicate`/the `/dedup` route must surface a clear error, not crash. (Task 3, Task 4)
- `mark-duplicate` targeting a nonexistent task id must 404, not throw past the route into a 500. (Task 4)
- `mark-duplicate` (or the AI-confirmed path) on a task that is currently `processing` must be rejected with a clear 4xx, not silently corrupt an in-flight rule run. (Task 3, Task 4)
- Two different duplicates merging into the same target must both be recorded — the second merge must not clobber the first `mergedFrom` entry. (Task 3)
- A task in an active, non-terminal state (`needs_type_confirmation`, `processing`, `assigned_ai`, `assigned_human`, `ingested`) must still be a valid dedup **candidate** — only `done`/`failed`/`needs_dedup_confirmation` are excluded; a reasonable person filing a duplicate of something already assigned to a human absolutely expects it to be caught. (Task 3)

---

## Task 1: Schema — `needs_dedup_confirmation` state, `dedupCandidateId`, `deleteTask`

**Files:**
- Modify: `src/domain/task.ts`
- Modify: `src/db/migrations.ts`
- Modify: `src/repo/tasks.ts`
- Modify: `tests/repo/tasks.test.ts`
- Modify: `tests/triage/triage.test.ts`, `tests/client/columns.test.ts`, `tests/rule/executor.test.ts`, `tests/rule/handoff.test.ts`, `tests/rule/toollessAgent.test.ts` (each has a hand-built `Task` object literal that needs the new field)

**Interfaces:**
- Produces: `Task.dedupCandidateId: string | null`, `TaskPatch.dedupCandidateId?: string | null`, `TaskState` including `"needs_dedup_confirmation"`, `deleteTask(db: Database, id: string): void` in `src/repo/tasks.ts`.

- [ ] **Step 1: Write the failing repo tests**

Add to `tests/repo/tasks.test.ts` (after the existing `"updateTask patches a deadline"` test):

```typescript
test("updateTask patches a dedup candidate id", () => {
  const db = freshDb();
  const task = insertTask(db, sample);
  const other = insertTask(db, { ...sample, externalId: "msg-2" });

  const updated = updateTask(db, task.id, {
    state: "needs_dedup_confirmation",
    dedupCandidateId: other.id,
  });

  expect(updated.state).toBe("needs_dedup_confirmation");
  expect(updated.dedupCandidateId).toBe(other.id);
  expect(getTask(db, task.id)?.dedupCandidateId).toBe(other.id);
});

test("insertTask defaults dedupCandidateId to null", () => {
  const db = freshDb();
  const task = insertTask(db, sample);
  expect(task.dedupCandidateId).toBeNull();
});

test("deleteTask removes the row", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  deleteTask(db, task.id);

  expect(getTask(db, task.id)).toBeNull();
  expect(listTasks(db)).toHaveLength(0);
});
```

Add `deleteTask` to the import at the top of the file:

```typescript
import {
  insertTask,
  getTask,
  listTasks,
  findTaskBySource,
  updateTask,
  deleteTask,
} from "../../src/repo/tasks";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/repo/tasks.test.ts`
Expected: FAIL — `deleteTask` is not exported, `dedupCandidateId` doesn't exist on `Task`/`TaskPatch`.

- [ ] **Step 3: Add the state, domain fields, and migration**

In `src/domain/task.ts`, add the new state and fields:

```typescript
export type TaskState =
  | "ingested"
  | "needs_type_confirmation"
  | "needs_onboarding"
  | "needs_dedup_confirmation"
  | "processing"
  | "assigned_ai"
  | "assigned_human"
  | "done"
  | "failed";
```

```typescript
export interface Task {
  id: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  typeId: string | null;
  typeCandidates: string[] | null;
  state: TaskState;
  assignee: Assignee | null;
  deadline: string | null;
  /** Set while state is needs_dedup_confirmation: the task this might duplicate. */
  dedupCandidateId: string | null;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

```typescript
export interface TaskPatch {
  state?: TaskState;
  typeId?: string | null;
  typeCandidates?: string[] | null;
  assignee?: Assignee | null;
  deadline?: string | null;
  dedupCandidateId?: string | null;
  context?: Record<string, unknown>;
}
```

In `src/db/migrations.ts`, append after the `deadline` migration:

```typescript
  `ALTER TABLE tasks ADD COLUMN dedup_candidate_id TEXT`,
];
```

(This joins the existing array — the `];` above replaces the previous closing line. `migrate()` in `src/db/index.ts` already tolerates a "duplicate column name" error from a prior `ALTER TABLE ADD COLUMN` migration (added when the `deadline` column shipped), so no runner changes are needed here.)

- [ ] **Step 4: Wire the column through the repo layer**

In `src/repo/tasks.ts`, add to `Row`:

```typescript
interface Row {
  id: string;
  source_id: string;
  external_id: string;
  url: string | null;
  title: string;
  body: string;
  metadata: string;
  type_id: string | null;
  type_candidates: string | null;
  state: string;
  assignee: string | null;
  deadline: string | null;
  dedup_candidate_id: string | null;
  context: string;
  created_at: string;
  updated_at: string;
}
```

In `toTask`:

```typescript
    deadline: row.deadline,
    dedupCandidateId: row.dedup_candidate_id,
    context: JSON.parse(row.context) as Record<string, unknown>,
```

In `updateTask`, extend the SQL and bound values:

```typescript
export function updateTask(db: Database, id: string, patch: TaskPatch): Task {
  const current = getTask(db, id);
  if (!current) throw new Error(`updateTask: unknown task ${id}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.query(
    `UPDATE tasks SET state = ?, type_id = ?, type_candidates = ?, assignee = ?,
                      deadline = ?, dedup_candidate_id = ?, context = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.state,
    next.typeId,
    next.typeCandidates ? JSON.stringify(next.typeCandidates) : null,
    next.assignee,
    next.deadline,
    next.dedupCandidateId,
    JSON.stringify(next.context),
    next.updatedAt,
    id,
  );
  return next;
}
```

Add `deleteTask` at the end of the file:

```typescript
export function deleteTask(db: Database, id: string): void {
  db.query("DELETE FROM tasks WHERE id = ?").run(id);
}
```

- [ ] **Step 5: Run the repo tests to verify they pass**

Run: `bun test tests/repo/tasks.test.ts`
Expected: PASS (all tests, including the pre-existing ones — `insertTask` doesn't need changes since an un-listed column defaults to `NULL`).

- [ ] **Step 6: Fix the ripple — every hand-built `Task` fixture needs the new field**

`bun run typecheck` will now list every hand-built `Task` object literal missing `dedupCandidateId`. In each of `tests/triage/triage.test.ts`, `tests/client/columns.test.ts`, `tests/rule/executor.test.ts`, `tests/rule/handoff.test.ts`, `tests/rule/toollessAgent.test.ts`, add the field right after the existing `deadline: null,` line:

```typescript
  deadline: null,
  dedupCandidateId: null,
```

- [ ] **Step 7: Run typecheck and the full suite**

Run: `bun run typecheck`
Expected: clean, no errors.

Run: `bun test`
Expected: all pass (274 + the 3 new repo tests = 277).

- [ ] **Step 8: Commit**

```bash
git add src/domain/task.ts src/db/migrations.ts src/repo/tasks.ts tests/repo/tasks.test.ts tests/triage/triage.test.ts tests/client/columns.test.ts tests/rule/executor.test.ts tests/rule/handoff.test.ts tests/rule/toollessAgent.test.ts
git commit -m "feat: add needs_dedup_confirmation state, dedupCandidateId, and deleteTask"
```

---

## Task 2: Dedup detection module

**Files:**
- Create: `src/dedup/prompt.ts`
- Create: `src/dedup/dedup.ts`
- Test: `tests/dedup/dedup.test.ts`

**Interfaces:**
- Consumes: `AiProvider`/`completeJson` from `src/ai/provider.ts` (`complete(req): Promise<AiResult>`); `Task` from `src/domain/task.ts` (with `dedupCandidateId` from Task 1).
- Produces: `checkForDuplicate(provider: AiProvider, task: Task, candidates: Task[]): Promise<DedupMatch | null>`, `DedupMatch { taskId: string; confidence: number; rationale: string }`, `DEDUP_MIN_CONFIDENCE = 0.6` — all from `src/dedup/dedup.ts`, consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/dedup/dedup.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { checkForDuplicate, DEDUP_MIN_CONFIDENCE } from "../../src/dedup/dedup";
import type { AiProvider } from "../../src/ai/provider";
import type { Task } from "../../src/domain/task";

function stub(reply: unknown): AiProvider {
  return {
    id: "stub",
    async complete() {
      return { text: JSON.stringify(reply), toolCalls: [] };
    },
  };
}

function task(id: string, title: string, body = "…"): Task {
  return {
    id,
    sourceId: "outlook",
    externalId: id,
    url: null,
    title,
    body,
    metadata: {},
    typeId: null,
    typeCandidates: null,
    state: "ingested",
    assignee: null,
    deadline: null,
    dedupCandidateId: null,
    context: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("an empty candidate list never calls the provider", async () => {
  let called = false;
  const provider: AiProvider = {
    id: "stub",
    async complete() {
      called = true;
      return { text: "{}", toolCalls: [] };
    },
  };

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), []);

  expect(match).toBeNull();
  expect(called).toBe(false);
});

test("a confident match against a known candidate is returned", async () => {
  const candidate = task("c1", "Order #4021 missing");
  const provider = stub({ duplicateOfTaskId: "c1", confidence: 0.9, rationale: "same order number" });

  const match = await checkForDuplicate(provider, task("new", "Where is my order #4021?"), [candidate]);

  expect(match).toEqual({ taskId: "c1", confidence: 0.9, rationale: "same order number" });
});

test("confidence below the threshold is treated as no match", async () => {
  const candidate = task("c1", "Order #4021 missing");
  const provider = stub({
    duplicateOfTaskId: "c1",
    confidence: DEDUP_MIN_CONFIDENCE - 0.01,
    rationale: "maybe",
  });

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), [candidate]);

  expect(match).toBeNull();
});

test("an id outside the candidate list is ignored", async () => {
  const candidate = task("c1", "Order #4021 missing");
  const provider = stub({ duplicateOfTaskId: "ghost", confidence: 0.95, rationale: "?" });

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), [candidate]);

  expect(match).toBeNull();
});

test("no match from the model is returned as null", async () => {
  const candidate = task("c1", "Unrelated topic");
  const provider = stub({ duplicateOfTaskId: null, confidence: 0.1, rationale: "no relation" });

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), [candidate]);

  expect(match).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/dedup/dedup.test.ts`
Expected: FAIL — `src/dedup/dedup.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the prompt module**

Create `src/dedup/prompt.ts`:

```typescript
import type { Task } from "../domain/task";

export const DEDUP_SYSTEM = `You check whether a newly submitted task describes the same underlying
work as one already tracked, so the system can avoid tracking the same work twice.

You are given the new task and a list of candidate tasks already on the board. Decide
whether the new task is clearly about the same underlying work as exactly one candidate.
Only match when you are confident — near-identical requests, the same issue reported
through a different channel, or explicit cross-references (the same ticket number, the
same order, the same person's same problem). Do not match tasks that are merely similar
in topic or type.

Reply with JSON of this shape:
{
  "duplicateOfTaskId": "<id>" | null,
  "confidence": <0..1>,
  "rationale": "<one sentence>"
}`;

export function dedupUserMessage(task: Task, candidates: Task[]): string {
  const list = candidates
    .map(
      (c) =>
        `- id: ${c.id}\n  source: ${c.sourceId}\n  title: ${c.title}\n  excerpt: ${c.body.slice(0, 300)}`,
    )
    .join("\n");

  return `Candidate tasks already tracked:\n${list}\n\nNew task:\nsource: ${task.sourceId}\ntitle: ${task.title}\nbody:\n${task.body}`;
}
```

- [ ] **Step 4: Write the detection function**

Create `src/dedup/dedup.ts`:

```typescript
import { z } from "zod";
import { completeJson, type AiProvider } from "../ai/provider";
import type { Task } from "../domain/task";
import { DEDUP_SYSTEM, dedupUserMessage } from "./prompt";

export const DEDUP_MIN_CONFIDENCE = 0.6;

export interface DedupMatch {
  taskId: string;
  confidence: number;
  rationale: string;
}

const responseSchema = z.object({
  duplicateOfTaskId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export async function checkForDuplicate(
  provider: AiProvider,
  task: Task,
  candidates: Task[],
): Promise<DedupMatch | null> {
  if (candidates.length === 0) return null;

  const response = await completeJson(
    provider,
    {
      system: DEDUP_SYSTEM,
      messages: [{ role: "user", content: dedupUserMessage(task, candidates) }],
      maxTokens: 500,
    },
    responseSchema,
  );

  if (!response.duplicateOfTaskId) return null;
  if (!candidates.some((c) => c.id === response.duplicateOfTaskId)) return null;
  if (response.confidence < DEDUP_MIN_CONFIDENCE) return null;

  return {
    taskId: response.duplicateOfTaskId,
    confidence: response.confidence,
    rationale: response.rationale,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/dedup/dedup.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Run typecheck and the full suite**

Run: `bun run typecheck && bun test`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/dedup tests/dedup
git commit -m "feat: add AI-based duplicate detection ahead of triage"
```

---

## Task 3: Orchestrator — detection wiring, merge, resolve, manual tag

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `checkForDuplicate`, `DedupMatch` (Task 2); `deleteTask` (Task 1); existing `getTask`, `listTasks`, `updateTask` from `src/repo/tasks.ts`; existing `triageTask` from `src/triage/triage.ts`.
- Produces: `mergeTasks(deps: AppDeps, duplicateTaskId: string, intoTaskId: string): Task`, `resolveDuplicate(deps: AppDeps, taskId: string, isDuplicate: boolean): Promise<Task>`, `markDuplicate(deps: AppDeps, taskId: string, ofTaskId: string): Task` — all exported from `src/orchestrator.ts`, consumed by Task 4's API routes. `onTaskIngested`'s existing signature and exported name are unchanged; its old body becomes an internal `triageAndAssign` used by both the normal path and `resolveDuplicate`'s "not a duplicate" branch.

- [ ] **Step 1: Write the failing tests**

Add to `tests/orchestrator.test.ts`, right after the existing imports (extend them):

```typescript
import { insertTask, getTask, deleteTask, updateTask } from "../src/repo/tasks";
import {
  onTaskIngested,
  confirmTaskType,
  skipOnboarding,
  onboardType,
  activateTypeRule,
  mergeTasks,
  resolveDuplicate,
  markDuplicate,
  type AppDeps,
} from "../src/orchestrator";
```

(This replaces the existing `import { insertTask, getTask } from "../src/repo/tasks";` and `import { onTaskIngested, confirmTaskType, skipOnboarding, onboardType, activateTypeRule, type AppDeps } from "../src/orchestrator";` lines with the extended versions above.)

Add these tests after the existing `"a task with a URL runs normally against a rule that needs {{task.url}}"` test, at the end of the file:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/orchestrator.test.ts`
Expected: FAIL — `mergeTasks`, `resolveDuplicate`, `markDuplicate` are not exported; the "still triaged" tests fail because `onTaskIngested` doesn't check for duplicates yet, so with only one stubbed reply shaped for dedup, `triageTask`'s `completeJson` call errors on invalid JSON, and the "done task" test fails because it expects `needs_dedup_confirmation` to never be reached, which currently can't happen at all (also passes vacuously — that one may show as an unrelated failure or false pass; the two new "flagged for dedup" tests are the load-bearing RED signal).

- [ ] **Step 3: Extract `triageAndAssign` and add the detection step**

In `src/orchestrator.ts`, replace the existing `onTaskIngested` function with:

```typescript
export async function onTaskIngested(deps: AppDeps, task: Task): Promise<Task> {
  const candidates = listTasks(deps.db)
    .filter((t) => t.id !== task.id && !["done", "failed", "needs_dedup_confirmation"].includes(t.state))
    .slice(0, 30);

  const match = await checkForDuplicate(deps.provider, task, candidates);
  if (match) {
    return updateTask(deps.db, task.id, {
      state: "needs_dedup_confirmation",
      dedupCandidateId: match.taskId,
      context: { ...task.context, dedupRationale: match.rationale },
    });
  }

  return triageAndAssign(deps, task);
}

async function triageAndAssign(deps: AppDeps, task: Task): Promise<Task> {
  const { outcome, deadline } = await triageTask(deps.provider, task, listTaskTypes(deps.db));

  if (outcome.kind === "ambiguous") {
    return updateTask(deps.db, task.id, {
      state: "needs_type_confirmation",
      typeCandidates: outcome.candidateTypeIds,
      deadline,
    });
  }

  if (outcome.kind === "new_type") {
    const type = insertTaskType(deps.db, {
      name: outcome.proposal.name,
      description: outcome.proposal.description,
    });
    return updateTask(deps.db, task.id, {
      typeId: type.id,
      typeCandidates: null,
      state: "needs_onboarding",
      deadline,
    });
  }

  const matched = updateTask(deps.db, task.id, {
    typeId: outcome.typeId,
    typeCandidates: null,
    deadline,
  });
  return processTask(deps, matched);
}
```

Add the import at the top of the file:

```typescript
import { checkForDuplicate } from "./dedup/dedup";
```

And extend the existing repo import to include `deleteTask`:

```typescript
import { getTask, listTasks, updateTask, deleteTask } from "./repo/tasks";
```

- [ ] **Step 4: Add `mergeTasks`, `resolveDuplicate`, `markDuplicate`**

Add these at the end of `src/orchestrator.ts`:

```typescript
interface MergedFromRecord {
  taskId: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  mergedAt: string;
}

function asMergedFromArray(value: unknown): MergedFromRecord[] {
  return Array.isArray(value) ? (value as MergedFromRecord[]) : [];
}

/** The one place a duplicate task's row goes away: appends its source
 *  reference onto the kept task's context, then deletes it outright. */
export function mergeTasks(deps: AppDeps, duplicateTaskId: string, intoTaskId: string): Task {
  const duplicate = getTask(deps.db, duplicateTaskId);
  const target = getTask(deps.db, intoTaskId);
  if (!duplicate) throw new Error(`mergeTasks: unknown task ${duplicateTaskId}`);
  if (!target) throw new Error(`mergeTasks: unknown task ${intoTaskId}`);
  if (duplicate.state === "processing") {
    throw new Error("mergeTasks: cannot merge a task that is currently processing");
  }

  const record: MergedFromRecord = {
    taskId: duplicate.id,
    sourceId: duplicate.sourceId,
    externalId: duplicate.externalId,
    url: duplicate.url,
    title: duplicate.title,
    mergedAt: new Date().toISOString(),
  };
  const updated = updateTask(deps.db, target.id, {
    context: { ...target.context, mergedFrom: [...asMergedFromArray(target.context.mergedFrom), record] },
  });
  deleteTask(deps.db, duplicate.id);
  return updated;
}

/** A human resolving an AI-detected `needs_dedup_confirmation` pause. */
export async function resolveDuplicate(deps: AppDeps, taskId: string, isDuplicate: boolean): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`resolveDuplicate: unknown task ${taskId}`);
  if (!task.dedupCandidateId) {
    throw new Error(`resolveDuplicate: task ${taskId} has no pending duplicate candidate`);
  }

  if (isDuplicate) return mergeTasks(deps, task.id, task.dedupCandidateId);

  const cleared = updateTask(deps.db, task.id, { dedupCandidateId: null });
  return triageAndAssign(deps, cleared);
}

/** A human manually tagging any task as a duplicate of any other, independent of detection. */
export function markDuplicate(deps: AppDeps, taskId: string, ofTaskId: string): Task {
  if (taskId === ofTaskId) throw new Error("markDuplicate: a task cannot be a duplicate of itself");
  return mergeTasks(deps, taskId, ofTaskId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/orchestrator.test.ts`
Expected: PASS, all tests (existing + 9 new).

- [ ] **Step 6: Run typecheck and the full suite**

Run: `bun run typecheck && bun test`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: wire dedup detection into ingestion and add mergeTasks/resolveDuplicate/markDuplicate"
```

---

## Task 4: API routes

**Files:**
- Modify: `src/api/server.ts`
- Modify: `tests/api/server.test.ts`

**Interfaces:**
- Consumes: `resolveDuplicate`, `markDuplicate` (Task 3); `getTask`, `updateTask`, `deleteTask` from `src/repo/tasks.ts`.
- Produces: `POST /api/tasks/:id/dedup` (body `{ isDuplicate: boolean }`, returns `{ task }` when not a duplicate or `{ merged: true, intoTaskId }` when merged), `POST /api/tasks/:id/mark-duplicate` (body `{ ofTaskId: string }`, returns `{ merged: true, intoTaskId }`) — both consumed by Task 5's `src/client/api.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/server.test.ts`. Extend the existing import line:

```typescript
import { getTask, insertTask, updateTask, deleteTask } from "../../src/repo/tasks";
```

Add these tests at the end of the file:

```typescript
test("POST /api/tasks/:id/dedup confirms a duplicate, deletes it, and records the merge on the target", async () => {
  const { deps, fetch } = app([]);
  const target = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });
  updateTask(deps.db, dup.id, { state: "needs_dedup_confirmation", dedupCandidateId: target.id });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/dedup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { merged: boolean; intoTaskId: string };
  expect(body.merged).toBe(true);
  expect(body.intoTaskId).toBe(target.id);
  expect(getTask(deps.db, dup.id)).toBeNull();
  expect(getTask(deps.db, target.id)?.context.mergedFrom).toBeDefined();
});

test("POST /api/tasks/:id/dedup on a task with no pending candidate is rejected", async () => {
  const { deps, fetch } = app([]);
  const task = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Solo", body: "b" });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/dedup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );

  expect(response.status).toBe(400);
});

test("POST /api/tasks/:id/dedup on an unknown task 404s", async () => {
  const { fetch } = app([]);
  const response = await fetch(
    new Request("http://localhost/api/tasks/ghost/dedup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );
  expect(response.status).toBe(404);
});

test("POST /api/tasks/:id/dedup surfaces a 409, not a crash, when the candidate task is gone", async () => {
  const { deps, fetch } = app([]);
  const candidate = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });
  updateTask(deps.db, dup.id, { state: "needs_dedup_confirmation", dedupCandidateId: candidate.id });
  deleteTask(deps.db, candidate.id);

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/dedup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );

  expect(response.status).toBe(409);
});

test("POST /api/tasks/:id/mark-duplicate merges into a chosen target of any state", async () => {
  const { deps, fetch } = app([]);
  const target = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  updateTask(deps.db, target.id, { state: "done" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: target.id }),
    }),
  );

  expect(response.status).toBe(200);
  expect(getTask(deps.db, dup.id)).toBeNull();
});

test("POST /api/tasks/:id/mark-duplicate rejects an unknown target, self-reference, and a processing duplicate", async () => {
  const { deps, fetch } = app([]);
  const target = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });

  const unknownTarget = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: "ghost" }),
    }),
  );
  expect(unknownTarget.status).toBe(404);

  const selfMerge = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: dup.id }),
    }),
  );
  expect(selfMerge.status).toBe(400);

  updateTask(deps.db, dup.id, { state: "processing" });
  const whileProcessing = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: target.id }),
    }),
  );
  expect(whileProcessing.status).toBe(409);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/api/server.test.ts`
Expected: FAIL — both routes 404 (not registered yet).

- [ ] **Step 3: Add the routes**

In `src/api/server.ts`, extend the orchestrator import:

```typescript
import {
  activateTypeRule,
  completeTask,
  confirmTaskType,
  reopenTask,
  onboardType,
  onTaskIngested,
  skipOnboarding,
  resolveDuplicate,
  markDuplicate,
  type AppDeps,
} from "../orchestrator";
```

Add `deleteTask` isn't needed here (routes don't delete directly — `mergeTasks` does), but the routes need `getTask`, already imported. Add the two routes right after the existing `/api/tasks/:id/skip-onboarding` route:

```typescript
  app.post("/api/tasks/:id/dedup", async (c) => {
    const id = c.req.param("id");
    const task = getTask(deps.db, id);
    if (!task) return c.json({ error: "unknown task" }, 404);
    const input = await readJson<{ isDuplicate?: boolean }>(c);
    if (typeof input?.isDuplicate !== "boolean") return c.json({ error: "isDuplicate is required" }, 400);
    if (!task.dedupCandidateId) return c.json({ error: "this task has no pending duplicate candidate" }, 400);

    try {
      const result = await resolveDuplicate(deps, id, input.isDuplicate);
      return input.isDuplicate
        ? c.json({ merged: true, intoTaskId: task.dedupCandidateId })
        : c.json({ task: result });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post("/api/tasks/:id/mark-duplicate", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    const input = await readJson<{ ofTaskId?: string }>(c);
    if (!input?.ofTaskId) return c.json({ error: "ofTaskId is required" }, 400);
    if (input.ofTaskId === id) return c.json({ error: "a task cannot be a duplicate of itself" }, 400);
    if (!getTask(deps.db, input.ofTaskId)) return c.json({ error: "unknown target task" }, 404);

    try {
      markDuplicate(deps, id, input.ofTaskId);
      return c.json({ merged: true, intoTaskId: input.ofTaskId });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/api/server.test.ts`
Expected: PASS, all tests (existing + 6 new).

- [ ] **Step 5: Run typecheck and the full suite**

Run: `bun run typecheck && bun test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat: add POST /api/tasks/:id/dedup and /mark-duplicate routes"
```

---

## Task 5: Client API wrapper and board lane mapping

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/columns.ts`
- Modify: `tests/client/columns.test.ts`

**Interfaces:**
- Consumes: the two new routes from Task 4.
- Produces: `api.resolveDuplicate(taskId, isDuplicate)`, `api.markDuplicate(taskId, ofTaskId)` in `src/client/api.ts`; `LANE_OF["needs_dedup_confirmation"] === "needs"`, `STATE_LABEL["needs_dedup_confirmation"]` in `src/client/columns.ts` — consumed by Task 6 and Task 7.

This task deliberately doesn't touch `App.tsx` — `Board` and `TaskDetail` don't accept the new props yet, so wiring `App.tsx` now would either require a throwaway intermediate prop or leave the build red until Task 7. Task 6 and Task 7 each own their component's interface *and* its one `App.tsx` call site, so every task in this plan starts and ends with a clean `bun run typecheck`.

- [ ] **Step 1: Write the failing test**

Add to `tests/client/columns.test.ts`, extending the hardcoded `states` array in the existing `"every task state maps to exactly one of the three lanes"` test to include `"needs_dedup_confirmation"`:

```typescript
  const states: TaskState[] = [
    "ingested",
    "needs_type_confirmation",
    "needs_onboarding",
    "needs_dedup_confirmation",
    "processing",
    "assigned_ai",
    "assigned_human",
    "done",
    "failed",
  ];
```

Add a new dedicated test right after it:

```typescript
test("needs_dedup_confirmation lands in the needs lane specifically", () => {
  expect(LANE_OF.needs_dedup_confirmation).toBe("needs");
});
```

Also add `dedupCandidateId: null,` right after the existing `deadline: null,` line in that file's `task()` helper (needed for the type to compile, same ripple as Task 1's other fixture updates — this file wasn't in Task 1's list because it uses a helper function rather than inline literals scattered across tests, so it only needs the one update here).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/client/columns.test.ts`
Expected: FAIL — `LANE_OF.needs_dedup_confirmation` is `undefined`, not `"needs"`.

- [ ] **Step 3: Update `columns.ts`**

In `src/client/columns.ts`:

```typescript
export const LANE_OF: Record<TaskState, LaneKey> = {
  needs_type_confirmation: "needs",
  needs_onboarding: "needs",
  needs_dedup_confirmation: "needs",
  assigned_human: "needs",
  ingested: "running",
  processing: "running",
  assigned_ai: "running",
  done: "settled",
  failed: "settled",
};
```

```typescript
export const STATE_LABEL: Record<TaskState, string> = {
  ingested: "ingested",
  needs_type_confirmation: "needs type confirmation",
  needs_onboarding: "needs onboarding",
  needs_dedup_confirmation: "possible duplicate",
  processing: "processing",
  assigned_ai: "assigned to AI",
  assigned_human: "assigned to human",
  done: "done",
  failed: "failed",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/client/columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the client API methods**

In `src/client/api.ts`, add inside the `api` object, after `skipOnboarding`:

```typescript
  resolveDuplicate: (taskId: string, isDuplicate: boolean) =>
    json<{ task?: Task; merged?: boolean; intoTaskId?: string }>(`/api/tasks/${taskId}/dedup`, {
      method: "POST",
      body: JSON.stringify({ isDuplicate }),
    }),
  markDuplicate: (taskId: string, ofTaskId: string) =>
    json<{ merged: true; intoTaskId: string }>(`/api/tasks/${taskId}/mark-duplicate`, {
      method: "POST",
      body: JSON.stringify({ ofTaskId }),
    }),
```

- [ ] **Step 6: Run typecheck and the full suite**

Run: `bun run typecheck && bun test`
Expected: both clean — `api.resolveDuplicate`/`api.markDuplicate` are unused so far (Task 6/7 call them), which is not a typecheck error.

- [ ] **Step 7: Commit**

```bash
git add src/client/api.ts src/client/columns.ts tests/client/columns.test.ts
git commit -m "feat: add dedup client API methods and board lane mapping"
```

---

## Task 6: Board.tsx — AI-detected duplicate panel

**Files:**
- Modify: `src/client/Board.tsx`
- Modify: `src/client/App.tsx`

**Interfaces:**
- Consumes: `Task.dedupCandidateId`, `Task.context.dedupRationale` (Task 1/3); `api.resolveDuplicate` (Task 5).
- Produces: `Board`'s prop type gains `onResolveDuplicate: (taskId: string, isDuplicate: boolean) => Promise<void>`; `TaskCard`'s prop type gains `allTasks` and `onResolveDuplicate`; `App.tsx` gains a `resolveDuplicate` handler, consumed only here.

- [ ] **Step 1: Update `TaskCard`'s props and tone logic**

In `src/client/Board.tsx`, update `TaskCard`'s signature:

```typescript
function TaskCard({
  task,
  types,
  allTasks,
  onOpen,
  onOnboard,
  onConfirmType,
  onResolveDuplicate,
}: {
  task: Task;
  types: TypeWithRules[];
  allTasks: Task[];
  onOpen: () => void;
  onOnboard: () => void;
  onConfirmType: (typeId: string) => Promise<void>;
  onResolveDuplicate: (isDuplicate: boolean) => Promise<void>;
}) {
```

Update the `tone` computation to include the new state in the "needs" bucket:

```typescript
  const tone = laneTone(
    task.state === "needs_type_confirmation" ||
      task.state === "needs_onboarding" ||
      task.state === "needs_dedup_confirmation" ||
      task.state === "assigned_human"
      ? "needs"
      : task.state === "done" || task.state === "failed"
        ? "settled"
        : "running",
    task.state === "failed",
  );
```

Add, right after the existing `excerptLine` computation:

```typescript
  const dedupCandidate = task.dedupCandidateId ? allTasks.find((t) => t.id === task.dedupCandidateId) : undefined;
  const dedupRationale = typeof task.context.dedupRationale === "string" ? task.context.dedupRationale : null;
```

- [ ] **Step 2: Add the confirmation panel**

Add this block right after the existing `{triaging && (...)}` block (before the `{task.state === "needs_onboarding" && (...)}` block):

```typescript
        {task.state === "needs_dedup_confirmation" && dedupCandidate && (
          <div className="triage">
            <div className="triage-why">
              This looks like it might be the same as "{dedupCandidate.title}"
              {dedupRationale ? ` — ${dedupRationale}` : ""}.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onResolveDuplicate(true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Yes, same task
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onResolveDuplicate(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                No, keep separate
              </button>
            </div>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: 0, alignSelf: "flex-start" }}
              onClick={onOpen}
            >
              Read the whole task
            </button>
          </div>
        )}
```

- [ ] **Step 3: Update `Board`'s props and the `TaskCard` call site**

Update `Board`'s signature:

```typescript
export function Board({
  tasks,
  types,
  onSelect,
  onOnboard,
  onConfirmType,
  onResolveDuplicate,
  settledFrom,
  settledTo,
}: {
  tasks: Task[];
  types: TypeWithRules[];
  onSelect: (task: Task) => void;
  onOnboard: (task: Task) => void;
  onConfirmType: (taskId: string, typeId: string) => Promise<void>;
  onResolveDuplicate: (taskId: string, isDuplicate: boolean) => Promise<void>;
  settledFrom: string;
  settledTo: string;
}) {
```

Update the `<TaskCard>` render inside `Board`'s `.map`:

```typescript
              {laneTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  types={types}
                  allTasks={tasks}
                  onOpen={() => onSelect(task)}
                  onOnboard={() => onOnboard(task)}
                  onConfirmType={(typeId) => onConfirmType(task.id, typeId)}
                  onResolveDuplicate={(isDuplicate) => onResolveDuplicate(task.id, isDuplicate)}
                />
              ))}
```

- [ ] **Step 4: Wire `App.tsx`**

Add this function in `src/client/App.tsx`, right after the existing `confirmType` function:

```typescript
  async function resolveDuplicate(taskId: string, isDuplicate: boolean) {
    await api.resolveDuplicate(taskId, isDuplicate);
    await refresh();
  }
```

Update the `<Board>` render to pass it:

```typescript
            <Board
              tasks={tasks}
              types={types}
              onSelect={(t) => setSelectedTaskId(t.id)}
              onOnboard={(t) => setOnboardingTaskId(t.id)}
              onConfirmType={confirmType}
              onResolveDuplicate={resolveDuplicate}
              settledFrom={settledFrom}
              settledTo={settledTo}
            />
```

- [ ] **Step 5: Run typecheck and the full suite**

Run: `bun run typecheck && bun test`
Expected: both clean.

- [ ] **Step 6: Manual verification**

This codebase has no automated component tests for `Board.tsx` (same existing convention as every other client component). Verify in-browser:

1. Start the dev server: `JIDOKA_SAMPLE_DIR=./samples bun run dev`
2. Since triggering a *real* AI-detected duplicate needs two similar tasks and a live provider, use the same Playwright `window.fetch` monkey-patch technique used to verify the deadline urgency chip (item 6): intercept `GET /api/tasks` and inject a task with `state: "needs_dedup_confirmation"`, `dedupCandidateId` pointing at another real task's id in the response, and `context.dedupRationale` set to a test string.
3. Confirm the card renders the panel with the candidate's real title, the rationale text, and both buttons.
4. Stop the dev server afterward (check for a pre-existing dev server first, same caution as before — don't kill one you didn't start).

- [ ] **Step 7: Commit**

```bash
git add src/client/Board.tsx src/client/App.tsx
git commit -m "feat: show an AI-detected duplicate confirmation panel on the task card"
```

---

## Task 7: TaskDetail.tsx — manual tagging and merge history

**Files:**
- Modify: `src/client/TaskDetail.tsx`
- Modify: `src/client/App.tsx`

**Interfaces:**
- Consumes: `api.markDuplicate` (Task 5); `Task.context.mergedFrom` (Task 3's `MergedFromRecord` shape, duplicated locally for display since `context` is untyped).
- Produces: `TaskDetail`'s prop type gains `allTasks: Task[]` and `onMarkDuplicate: (ofTaskId: string) => Promise<void>`; `App.tsx` gains a `markDuplicate` handler, consumed only here.

- [ ] **Step 1: Update props, internal keys, and the tone computation**

In `src/client/TaskDetail.tsx`, update the component signature:

```typescript
export function TaskDetail({
  task,
  allTasks,
  onChanged,
  onClose,
  onMarkDuplicate,
}: {
  task: Task;
  allTasks: Task[];
  onChanged: () => Promise<void>;
  onClose: () => void;
  onMarkDuplicate: (ofTaskId: string) => Promise<void>;
}) {
```

Update `INTERNAL_KEYS` so the merge bookkeeping keys don't leak into the generic "What the rule produced" list:

```typescript
const INTERNAL_KEYS = new Set([
  "ruleLog",
  "completedAt",
  "completionNote",
  "error",
  "handoff",
  "pickedUpAt",
  "mergedFrom",
  "dedupRationale",
]);
```

Update the `tone` computation to include the new state:

```typescript
  const tone =
    task.state === "done"
      ? "var(--color-neutral-500)"
      : task.state === "failed"
        ? "var(--color-accent-800)"
        : task.state === "assigned_human" ||
            task.state === "needs_type_confirmation" ||
            task.state === "needs_onboarding" ||
            task.state === "needs_dedup_confirmation"
          ? "var(--color-accent)"
          : "var(--color-neutral-800)";
```

Add a new interface at module scope, right after the existing `StepLogEntry` interface (before `INTERNAL_KEYS`):

```typescript
interface MergedFromRecord {
  taskId: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  mergedAt: string;
}
```

Add these derived values inside the component body, right after the existing `outputs`/`producedBy` block:

```typescript
  const mergedFrom = Array.isArray(task.context.mergedFrom)
    ? (task.context.mergedFrom as MergedFromRecord[])
    : [];

  const [dedupOpen, setDedupOpen] = useState(false);
  const [dedupQuery, setDedupQuery] = useState("");
  const dedupMatches = dedupOpen
    ? allTasks
        .filter((t) => t.id !== task.id && t.title.toLowerCase().includes(dedupQuery.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  async function markAsDuplicate(ofTaskId: string) {
    await act(() => onMarkDuplicate(ofTaskId));
  }
```

- [ ] **Step 2: Add the merge-history section**

Add this right after the opening `<div className="drawer-body">` tag, before the existing `{outputs.length > 0 && (...)}` block:

```typescript
          {mergedFrom.length > 0 && (
            <section className="drawer-section">
              <h6 style={{ margin: 0 }}>Merged from</h6>
              {mergedFrom.map((m) => (
                <div key={m.taskId} className="artifact">
                  <div className="head">
                    <span className="mono key">{m.sourceId}</span>
                    <span className="provenance-badge provenance-unknown" style={{ marginLeft: "auto" }}>
                      duplicate
                    </span>
                  </div>
                  <div className="content">
                    {m.url ? (
                      <a href={m.url} target="_blank" rel="noreferrer">
                        {m.title}
                      </a>
                    ) : (
                      m.title
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}
```

- [ ] **Step 3: Add the manual "Mark as duplicate of…" control**

Add this section right before the existing `{task.state === "done" ? (...) : task.state !== "assigned_human" ? (...) : null}` block:

```typescript
          <section className="drawer-section">
            {!dedupOpen ? (
              <button
                className="btn btn-secondary"
                style={{ alignSelf: "flex-start" }}
                disabled={task.state === "processing"}
                title={task.state === "processing" ? "Can't merge away a task while its rule is running" : undefined}
                onClick={() => setDedupOpen(true)}
              >
                Mark as duplicate of…
              </button>
            ) : (
              <>
                <div className="field">
                  <label>Find the task this duplicates</label>
                  <input
                    className="input"
                    autoFocus
                    value={dedupQuery}
                    placeholder="Search by title…"
                    onChange={(e) => setDedupQuery(e.target.value)}
                  />
                </div>
                {dedupQuery.trim() && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {dedupMatches.length === 0 && <span className="text-muted">No matching tasks</span>}
                    {dedupMatches.map((match) => (
                      <button
                        key={match.id}
                        className="candidate-btn"
                        disabled={busy}
                        onClick={() => void markAsDuplicate(match.id)}
                      >
                        <span className="row">
                          <span className="name">{match.title}</span>
                        </span>
                        <span className="desc">
                          {match.sourceId} · {match.state.replace(/_/g, " ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11, padding: 0, alignSelf: "flex-start" }}
                  onClick={() => {
                    setDedupOpen(false);
                    setDedupQuery("");
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </section>
```

- [ ] **Step 4: Wire `App.tsx`**

Add this function in `src/client/App.tsx`, right after the `resolveDuplicate` function Task 6 added:

```typescript
  async function markDuplicate(taskId: string, ofTaskId: string) {
    await api.markDuplicate(taskId, ofTaskId);
    await refresh();
  }
```

Update the `<TaskDetail>` render to pass the new props:

```typescript
      {selectedTask && !showingOnboarding && (
        <TaskDetail
          task={selectedTask}
          allTasks={tasks}
          onChanged={refresh}
          onClose={() => setSelectedTaskId(null)}
          onMarkDuplicate={(ofTaskId) => markDuplicate(selectedTask.id, ofTaskId)}
        />
      )}
```

- [ ] **Step 5: Run typecheck and the full suite**

Run: `bun run typecheck && bun test`
Expected: both clean.

- [ ] **Step 6: Manual verification**

This codebase has no automated component tests for `TaskDetail.tsx` (same existing convention). Verify in-browser with the dev server running:

1. Open any task's drawer, click "Mark as duplicate of…", type part of another task's title, confirm a match appears and is selectable, and that choosing it closes the drawer and the duplicate disappears from the board on refresh.
2. Open the task it was merged into and confirm a "Merged from" section now shows the deleted task's title and source.
3. Open a task in `processing` state (or use the same `window.fetch` monkey-patch technique to force one into view) and confirm the "Mark as duplicate of…" button is disabled with a tooltip.
4. Stop the dev server afterward (same caution as Task 6 — check for a pre-existing one first).

- [ ] **Step 7: Commit**

```bash
git add src/client/TaskDetail.tsx src/client/App.tsx
git commit -m "feat: add manual duplicate tagging and merge history to the task drawer"
```
