# Cross-source task dedup/merge

**Status:** design approved, not yet planned/implemented.

## Problem

Backlog item 7 (`jidoka-redesign-testing-backlog` memory): when two tasks from different sources (an email and its linked Azure DevOps ticket, say) describe the same underlying work, today they become two independent board cards. `findTaskBySource` only prevents re-inserting the *exact same* source item on a re-poll (`sourceId` + `externalId` match) — it has no notion of two different source items describing the same thing. The type-rule half of "handle it the same way regardless of source" already works today (a `Rule` attaches to a `TaskType`, not a source; triage classifies by content), so the only missing piece is detecting and merging duplicates.

## Scope

**In scope:**
- An AI check at ingestion, before triage, that compares a new task against currently-open tasks and flags a likely duplicate for human confirmation — never auto-merges.
- A manual "mark as duplicate" action a human can use at any time (the AI check can miss things, and a human might spot a duplicate against a task finished long ago that's no longer a detection candidate).
- One shared merge mechanism behind both paths.

**Explicitly out of scope**, decided during brainstorming:
1. **Auto-merge above a confidence threshold.** Rejected specifically because a wrong auto-merge silently drops a real, distinct task — the worse failure mode for this feature. Every AI-detected duplicate always goes to a human to confirm.
2. **Any gate on a missed duplicate.** If AI detection doesn't flag it, the task proceeds through triage and its rule exactly like any other task — including automatic AI/agent actions with no human in the loop. This mirrors the trust model the rest of the system already has for rules that act automatically; dedup only intercepts what it actually detects. A lower-confidence "soft pause" before AI-assigned work was considered and rejected as more friction and build surface than a v1 needs.
3. **Re-processing the kept task on merge.** Merging attaches a link and a note, nothing more — it does not re-run the kept task's rule with the newly-merged content folded in.
4. **Un-merging.** If a merge turns out to be wrong, the audit trail (the deleted task's source reference, preserved on the kept task) is there for a human to act on by hand; no dedicated "undo" flow.

## Detection & candidate set

New module `src/dedup/dedup.ts` (mirrors `src/triage/triage.ts`'s shape) and `src/dedup/prompt.ts`.

Runs once per ingested task, **before** triage, as its own AI call — not folded into triage's existing call, because the prompt needs the full title+body of every candidate task, which would bloat triage's cheap per-type-scoring prompt for the common case where nothing matches.

**Candidates:** every other task with `state` not in `done`, `failed`, `needs_dedup_confirmation` (excludes settled tasks — there's nothing to usefully merge into if the earlier task is already finished — and excludes tasks that are themselves unresolved duplicate candidates), capped at the 30 most recently created. If the candidate set is empty, skip the AI call entirely and go straight to triage (same short-circuit triage already applies for "no known types yet").

**Prompt:** the new task's title/body plus each candidate's id/title/a body excerpt (first ~300 chars, bounding prompt size). Asks whether the new task describes the same underlying work as any one candidate.

```typescript
// src/dedup/dedup.ts
export const DEDUP_MIN_CONFIDENCE = 0.6;

export interface DedupMatch {
  taskId: string;
  confidence: number;
  rationale: string;
}

export async function checkForDuplicate(
  provider: AiProvider,
  task: Task,
  candidates: Task[],
): Promise<DedupMatch | null>
```

Response schema: `{ duplicateOfTaskId: string | null, confidence: number, rationale: string }`. `checkForDuplicate` returns `null` when the model found no match, when it named an id outside the candidate set (defensive, same pattern triage already uses for unknown type ids), or when confidence is below `DEDUP_MIN_CONFIDENCE`. That threshold only gates whether it's worth *asking* a human — it never triggers an automatic merge.

## Schema

- New `TaskState`: `"needs_dedup_confirmation"` — lands in the existing "needs" lane (`LANE_OF` in `src/client/columns.ts`), labeled "possible duplicate" (`STATE_LABEL`).
- New column `dedup_candidate_id TEXT` on `tasks`, added via the same idempotent-`ALTER TABLE` pattern item 6 introduced in `src/db/migrations.ts` (`migrate()` already tolerates "duplicate column name" on repeat runs).
- `Task`/`TaskPatch` (`src/domain/task.ts`) gain `dedupCandidateId: string | null`.
- No new column for the merge record — it reuses the existing ad hoc `context` JSON bag, same as `ruleLog`/`handoff`/`completedAt`: `context.mergedFrom?: { taskId: string; sourceId: string; externalId: string; url: string | null; title: string; mergedAt: string }[]`.

## Merge mechanics

One function both entry points funnel through, in `src/orchestrator.ts`:

```typescript
export function mergeTasks(deps: AppDeps, duplicateTaskId: string, intoTaskId: string): Task {
  const duplicate = getTask(deps.db, duplicateTaskId);
  const target = getTask(deps.db, intoTaskId);
  if (!duplicate) throw new Error(`mergeTasks: unknown task ${duplicateTaskId}`);
  if (!target) throw new Error(`mergeTasks: unknown task ${intoTaskId}`);
  if (duplicate.state === "processing") {
    throw new Error("mergeTasks: cannot merge a task that is currently processing");
  }

  const record = {
    taskId: duplicate.id,
    sourceId: duplicate.sourceId,
    externalId: duplicate.externalId,
    url: duplicate.url,
    title: duplicate.title,
    mergedAt: new Date().toISOString(),
  };
  const updated = updateTask(deps.db, target.id, {
    context: { ...target.context, mergedFrom: [...(asArray(target.context.mergedFrom)), record] },
  });
  deleteTask(deps.db, duplicate.id);
  return updated;
}
```

(`asArray` is a one-line local helper — `Array.isArray(x) ? x : []` — since `context` is untyped `Record<string, unknown>`.)

New repo function `deleteTask(db, id): void` in `src/repo/tasks.ts` (`DELETE FROM tasks WHERE id = ?`).

The `processing` guard only applies to the task being *removed*, not the target it's merging into: deleting a row out from under an in-flight `runRuleForTask` would make that call's own later `updateTask` throw `unknown task`. Merging into a target that happens to be `processing` is safe — it's an ordinary `updateTask` context-patch, no different from any other concurrent update the rest of the system already tolerates.

Two thin wrappers:

```typescript
export function resolveDuplicate(deps: AppDeps, taskId: string, isDuplicate: boolean): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`resolveDuplicate: unknown task ${taskId}`);
  if (!task.dedupCandidateId) throw new Error(`resolveDuplicate: task ${taskId} has no pending duplicate candidate`);

  if (isDuplicate) return Promise.resolve(mergeTasks(deps, task.id, task.dedupCandidateId));

  const cleared = updateTask(deps.db, task.id, { dedupCandidateId: null });
  return triageAndAssign(deps, cleared); // the body already in onTaskIngested today, extracted unchanged; sets the real next state itself
}

export function markDuplicate(deps: AppDeps, taskId: string, ofTaskId: string): Task {
  return mergeTasks(deps, taskId, ofTaskId);
}
```

`onTaskIngested` gains the detection step ahead of its existing body, which is extracted verbatim into `triageAndAssign` so both the normal path and the "confirmed not a duplicate" path call the same code:

```typescript
export async function onTaskIngested(deps: AppDeps, task: Task): Promise<Task> {
  const candidates = listTasks(deps.db).filter(
    (t) => t.id !== task.id && !["done", "failed", "needs_dedup_confirmation"].includes(t.state),
  ).slice(0, 30);

  if (candidates.length > 0) {
    const match = await checkForDuplicate(deps.provider, task, candidates);
    if (match) {
      return updateTask(deps.db, task.id, {
        state: "needs_dedup_confirmation",
        dedupCandidateId: match.taskId,
        context: { ...task.context, dedupRationale: match.rationale },
      });
    }
  }

  return triageAndAssign(deps, task);
}
```

## API

- `POST /api/tasks/:id/dedup` — body `{ isDuplicate: boolean }` → `resolveDuplicate`. Returns `{ task }` (the task moving on to triage) or `{ merged: true, intoTaskId }` (mirrors the existing `{ merged: true }` shape `PATCH /api/types/:id` already returns for its own merge case) — there is no "task" left to return when it was the one deleted.
- `POST /api/tasks/:id/mark-duplicate` — body `{ ofTaskId: string }` → validates both ids exist and aren't the same task, then `markDuplicate`. Returns `{ merged: true, intoTaskId }`.

`src/client/api.ts` gains matching `resolveDuplicate(taskId, isDuplicate)` and `markDuplicate(taskId, ofTaskId)` entries.

## UI

**AI-detected path (`Board.tsx`'s `TaskCard`):** a `needs_dedup_confirmation` task renders a panel matching the existing ambiguous-triage pattern exactly (`.triage`/`.triage-why`/`.candidate-btn` classes already in `modernist.css`, no new CSS needed) — the candidate task's title (looked up from a new `allTasks: Task[]` prop threaded from `Board` down to `TaskCard`, since the candidate may sit in a different lane than the card itself), the AI's `context.dedupRationale`, and two buttons: "Yes, same task" (→ `resolveDuplicate(id, true)`) / "No, keep separate" (→ `resolveDuplicate(id, false)`), plus a "Read the whole task" link that opens the drawer, same as the ambiguous-type flow.

**Manual path (`TaskDetail.tsx`):** a new "Mark as duplicate of…" control in its own `drawer-section`, disabled with a tooltip when `task.state === "processing"`. Expands to a text filter over `allTasks` (a new prop, threaded from `App.tsx`'s already-held `tasks` state — the same list `Board` receives) matched by title, client-side, no new endpoint needed for search; picking a result calls `markDuplicate` then closes the drawer (the task it was showing no longer exists). Unlike detection candidates, any state is a valid target, including `done`.

**Merge history:** `TaskDetail.tsx` renders a `mergedFrom` section (title, source, link) when `task.context.mergedFrom` is a non-empty array, placed near the top of `drawer-body`, above "What the rule produced".

## Testing

- `tests/dedup/dedup.test.ts` (new, mirrors `tests/triage/triage.test.ts`): a clear match returns it; confidence below `DEDUP_MIN_CONFIDENCE` returns null; an unknown candidate id from the model is ignored; empty candidate list is never sent to the provider (assert the stub's `complete` isn't called).
- `tests/repo/tasks.test.ts`: `deleteTask` removes the row; `getTask` afterward is null.
- `tests/orchestrator.test.ts`: a detected duplicate lands in `needs_dedup_confirmation` with `dedupCandidateId` set and does not run triage (assert the stub provider's triage-shaped reply was never consumed); `resolveDuplicate(..., true)` deletes the duplicate and appends `mergedFrom` on the target; `resolveDuplicate(..., false)` clears the candidate and proceeds through triage normally; `markDuplicate` works independent of any pending candidate; `mergeTasks` throws when the duplicate is `processing`.
- `tests/api/server.test.ts`: both new routes — happy path, unknown id 404s, `mark-duplicate` targeting itself is rejected.
- UI: manual verification with the dev server (this codebase's existing convention — no automated component tests exist for `Board.tsx`/`TaskDetail.tsx` either), covering both entry points and the `processing`-disabled state.
