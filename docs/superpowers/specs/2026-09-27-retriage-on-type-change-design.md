# Re-triage on type merge / rename / description change

## Motivation

`CLAUDE.md`'s triage section states the rule as written but never implemented:

> Re-triage: when a type is merged, renamed, or its description changes, only **open** tasks are re-triaged. Completed tasks keep their original type.

Today `PATCH /api/types/:id` runs `mergeTaskType` or `updateTaskType` and stops — nothing looks at the tasks already classified under the type being changed. A task minted before a description edit keeps pointing at a type whose new description may no longer describe it at all, and there's no path back into triage short of manually re-ingesting it. This closes that gap for the three operations `CLAUDE.md` names, without touching the ingestion path (`onTaskIngested`) itself.

## Scope

In scope: `src/orchestrator.ts` (one new exported re-triage entry point plus a small helper), `src/api/server.ts`'s existing `PATCH /api/types/:id` route (wiring only — detect which operation happened and call the new orchestrator function), and their tests. Out of scope, per the parallel work happening elsewhere in this repo: `src/sources/`, `src/agent/`, `src/rule/`, `src/client/*.tsx`, `src/config.ts`, `src/auth/`, `src/main.ts`. No schema change, no new `TaskTypeStatus` value, no new domain type.

## What "open" means here

`TaskState` is `ingested | needs_type_confirmation | needs_onboarding | needs_dedup_confirmation | processing | assigned_ai | assigned_human | done | failed`. Two calls:

- **`done` is excluded.** That's the literal spec text ("completed tasks keep their original type") and matches every other place this codebase treats `done` as the one true terminal state (`completeTask`/`reopenTask`).
- **`failed` is included (treated as open).** A failed task isn't resolved — it's a rule run that threw partway through (`runRuleForTask`'s catch clause). Nothing about a description change makes a failed task's classification more "final"; if anything, a type description that got fixed because it was too narrow is exactly the kind of change that might let a previously-misclassified, now-failing task land somewhere it can actually succeed. Excluding `failed` would mean a permanently-broken task never gets a second look from anything, including the mechanism explicitly meant to reconsider classification. Included.
- **`processing` is excluded, but for a different reason than `done`.** A task in `processing` has a rule actively running against it (possibly an in-flight `agent` step lasting minutes). `runRuleForTask` finishes by calling `updateTask` with the *whole* result — context, assignee, state — computed from a snapshot it took when the run started. If re-triage concurrently rewrote `typeId`/`state` on the same row, the in-flight run's eventual write would silently clobber it (last write wins; there's no optimistic locking anywhere in `src/repo/tasks.ts`). This mirrors `mergeTasks`'s existing guard, which refuses to merge a task that's currently `processing` for the identical reason. Re-triage differs from `mergeTasks` in that it runs over a whole batch, so instead of failing the entire operation over one busy task, a `processing` task is just skipped this pass — it was already re-classified once (whatever type led its rule to start running), and if it's still assigned to the changed type after it finishes, the next description edit will catch it. This is a narrow, accepted gap (see Deferred).

So: **open = every state except `done` and `processing`.**

## Merge: bulk reassignment, not re-triage

`mergeTaskType(db, fromId, intoId)` already does the whole job in one transaction: `UPDATE tasks SET type_id = intoId WHERE type_id = fromId`, then deletes the `fromId` row. That statement doesn't filter by state — it moves *every* task currently on `fromId`, done ones included.

This is deliberately kept as-is, not narrowed to open tasks, and the reasoning is why merge doesn't actually fall under "re-triage" at all despite `CLAUDE.md` grouping the three operations in one sentence:

- A merge is a **human declaring two categories are the same thing**, not a reclassification decision. There is no AI call, no ambiguity, nothing to "triage" — every task on `fromId` unconditionally becomes a task on `intoId`, because after the merge, `fromId` is not a thing anymore (`mergeTaskType` deletes its row in the same transaction).
- That last point is exactly why done tasks can't be carved out. "Completed tasks keep their original type" only makes sense when the original type still *exists* to be kept. If a done task's `typeId` stayed pointed at `fromId` after `mergeTaskType` deletes that row, every downstream reader of that task (`getTaskType`, the board, anything joining through `typeId`) would hit a dangling reference — not "kept its original type," just broken. Reassigning it to `intoId` **is** how a done task keeps its original type once the human has declared `intoId` to be that type's new identity.
- Concretely: `mergeTaskType`'s existing behavior already satisfies the spec correctly once "re-triage" is read as "a reclassification decision," which merge structurally isn't. No repo or orchestrator change needed for merge; the existing `tests/repo/taskTypes.test.ts` coverage stands. `src/api/server.ts`'s merge branch is untouched.

(The task brief for this work floated reassigning only *open* tasks on merge and leaving done tasks on `fromId`. Tried that on paper first: it requires either not deleting the `fromId` row — a bigger, unasked-for schema/status change — or accepting dangling `typeId`s on done tasks, which breaks type lookups. Both are worse than the existing behavior, so this spec keeps `mergeTaskType` exactly as it is.)

## Rename vs. description change

`updateTaskType`'s single `TaskTypePatch` can't tell these apart by itself — a caller might send `{ name }`, `{ description }`, or both. The distinction has to be made in `src/api/server.ts`'s route, which already fetches the current type row to check it exists:

```ts
app.patch("/api/types/:id", async (c) => {
  const id = c.req.param("id");
  const current = getTaskType(deps.db, id);
  if (!current) return c.json({ error: "unknown type" }, 404);
  const patch = await readJson<{ name?: string; description?: string; mergeInto?: string }>(c);
  if (!patch) return c.json({ error: "body must be valid JSON" }, 400);

  if (patch.mergeInto) {
    if (!getTaskType(deps.db, patch.mergeInto)) return c.json({ error: "unknown target" }, 404);
    mergeTaskType(deps.db, id, patch.mergeInto);
    return c.json({ merged: true });
  }

  const descriptionChanged =
    typeof patch.description === "string" && patch.description !== current.description;
  const updated = updateTaskType(deps.db, id, patch);
  if (descriptionChanged) {
    void retriageOpenTasksForType(deps, id).catch((error) => {
      console.error(`[api] re-triage for type ${id} failed:`, error);
    });
  }
  return c.json({ type: updated });
});
```

A pure rename (`{ name: "..." }` with no `description`, or a `description` identical to the current one) triggers nothing — the type's classification identity didn't change, only its label, so nothing about how existing tasks were sorted into it is now wrong. Only an actual text change to `description` triggers re-triage, since `description` (via `triageUserMessage`, `src/triage/prompt.ts`) is the literal text the triage prompt classifies against.

`retriageOpenTasksForType` runs in the background (`void ... .catch(...)`), the same fire-and-forget pattern `POST /api/tasks` already uses for `onTaskIngested` — a description change can affect many open tasks, each needing a real AI call, which is far too slow to hold an HTTP request open for. Tests observe the result the same way the existing ingestion test does: `await Bun.sleep(10)` after the request, then read the tasks back.

## `retriageOpenTasksForType`: reusing `triageTask`, not reinventing it

New exports in `src/orchestrator.ts`:

```ts
export async function retriageTask(deps: AppDeps, task: Task): Promise<Task>
export async function retriageOpenTasksForType(deps: AppDeps, typeId: string): Promise<void>
```

`retriageOpenTasksForType` finds every task currently on `typeId` in an open state (per the definition above) and calls `retriageTask` on each, sequentially (bounded, already-small task volumes per type; no need for concurrency control beyond what `AiProvider` callers already tolerate elsewhere):

```ts
const OPEN_FOR_RETRIAGE = new Set<TaskState>([
  "ingested", "needs_type_confirmation", "needs_onboarding",
  "needs_dedup_confirmation", "assigned_ai", "assigned_human", "failed",
]);

export async function retriageOpenTasksForType(deps: AppDeps, typeId: string): Promise<void> {
  const targets = listTasks(deps.db).filter(
    (t) => t.typeId === typeId && OPEN_FOR_RETRIAGE.has(t.state),
  );
  for (const task of targets) {
    await retriageTask(deps, task);
  }
}
```

`retriageTask` runs the exact same `triageTask` call ingestion uses, against the full current type registry, and handles its outcome exactly the way `onTaskIngested`'s internal `triageAndAssign` already does for a brand new task — reused, not duplicated, by extracting the outcome-handling into a shared helper both call. The one addition re-triage needs that fresh ingestion doesn't: **if triage matches the task back to the same type it already had, do nothing.** Without that check, every open task under a type would get shoved through `processTask` (and a busy `agent` rule re-run) on every unrelated description tweak, purely because the classifier re-confirmed what was already true. `triageAndAssign`'s existing unconditional-update behavior is fine for a task that's never been classified before (there's no "same as before" to compare against on ingestion); it's wrong for re-triage.

```ts
async function applyTriageOutcome(deps: AppDeps, task: Task, result: TriageResult): Promise<Task> {
  const { outcome, deadline } = result;

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

async function triageAndAssign(deps: AppDeps, task: Task): Promise<Task> {
  const result = await triageTask(deps.provider, task, listTaskTypes(deps.db));
  return applyTriageOutcome(deps, task, result);
}

export async function retriageTask(deps: AppDeps, task: Task): Promise<Task> {
  const result = await triageTask(deps.provider, task, listTaskTypes(deps.db));
  if (result.outcome.kind === "matched" && result.outcome.typeId === task.typeId) {
    return task; // classification confirmed unchanged — no-op, no rule re-run
  }
  return applyTriageOutcome(deps, task, result);
}
```

Outcome handling this reuses, unchanged, for a task that already has state/assignee/context from a prior run:

- **`ambiguous`** — moves to `needs_type_confirmation` with the new candidates; whatever it was previously assigned/processing stays in `context`/`assignee` as leftover history until a human answers via the existing `confirmTaskType`, which already fully re-runs `processTask` and so overwrites stale state anyway.
- **`new_type`** — inserts the proposed type and moves the task to `needs_onboarding`, same as first ingestion.
- **`matched` with a *different* `typeId`** — updates `typeId` and calls `processTask`, which runs the (possibly onboarding-less) new type's rule, exactly mirroring what would have happened had the task been ingested fresh under the corrected description.
- **`matched` with the *same* `typeId`** — no-op, added by this spec, not present in the ingestion path because it can't come up there.

No new state, no new `Task`/`TaskType` fields, no schema change.

## Why merge needs no AI call but description-change does

Merge is a human asserting identity between two existing categories — there's nothing to classify, so a bulk `UPDATE` is both correct and sufficient (see above). A description change *redefines what the type means*, so a task's existing membership is exactly the thing now in question — only a real `triageTask` call (the same one the system already trusts to classify a task from scratch) can say whether it still belongs, belongs elsewhere, or is now ambiguous. Using a real AI call here isn't overkill; it's the whole point — anything cheaper (e.g., "always keep them where they are unless a human intervenes") would just quietly leave the exact drift this feature exists to catch.

## Deferred / accepted gaps

- **A task re-triaged mid-`processing` isn't caught by this pass.** It's skipped (see "What 'open' means"); the next description edit on its type will catch it if it's still misclassified by then. No polling/retry mechanism added for this.
- **Concurrent re-triage runs for the same type aren't de-duplicated.** Two rapid description edits to the same type each kick off their own background `retriageOpenTasksForType`; nothing serializes them. Given description edits are a rare, human-paced action (not a hot path), this is accepted rather than built around.
- **No batching/backoff on the AI calls.** Each open task gets its own `triageTask` call, sequentially, with no rate limiting beyond whatever `AiProvider` implementations already do. Fine at today's expected task-type volumes; flagged as a scaling concern if a type ever accumulates hundreds of open tasks.
- **`needs_type_confirmation` and `needs_dedup_confirmation` tasks are technically included in the open set but almost never matched by `typeId`,** since a task in either state typically has `typeId === null` (triage/dedup hasn't run to completion yet). Included for correctness of the "open" definition rather than because it's expected to do anything in practice.

## Testing

TDD per layer:

- `tests/orchestrator.test.ts` — new cases for `retriageTask`/`retriageOpenTasksForType`: a `matched`-same-type outcome is a no-op (state/context untouched); a `matched`-different-type outcome moves the task and runs the new type's rule; an `ambiguous` outcome sets `needs_type_confirmation` on an already-`assigned_human` task; a `done` task is excluded from `retriageOpenTasksForType`'s batch; a `processing` task is excluded; a `failed` task is included and gets re-triaged.
- `tests/api/server.test.ts` — `PATCH /api/types/:id` with only `name` changed triggers no AI call (stub provider given zero replies still returns 200); a `description` change triggers a background re-triage observed via `Bun.sleep` afterward, matching the existing ingestion test's pattern; merge behavior (already covered at the repo layer) is left as-is.
- No `tests/repo/taskTypes.test.ts` changes — `mergeTaskType`/`updateTaskType` are unchanged by this spec.

Full `bun run typecheck` + `bun test` clean before considering this done, per this repo's standing convention. Baseline going in: 353 pass, 0 fail.
