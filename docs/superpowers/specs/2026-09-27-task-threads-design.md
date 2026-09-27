# Task threads: automatic follow-up passes on a reopened task

**Status:** design approved, not yet planned/implemented.

## Motivation

A task's rule runs once and hands off to AI or a human. Some tasks aren't actually done at that point — they close for a round, then come back. The concrete case: a code-review story is assigned to a reviewer in Azure DevOps; Jidoka's rule has Claude review the diff and hands the reviewer's part off to a human, who leaves comments, tags the PR "waiting for author," and marks the Jidoka task done. The author fixes the comments and reassigns the *same* work item back to "Code Review." Today, nothing happens: `pollOnce` (`src/sources/poller.ts:20`) sees a task already exists for that `(sourceId, externalId)` and skips it unconditionally, regardless of state. The rule never runs again, and even if it did, it would start a brand-new Claude conversation with no memory that a review already happened.

This spec makes that reopen automatic and gives the rule a way to continue the same Claude session rather than starting cold — asking a targeted follow-up ("did the author address every comment? anything new?") instead of repeating the full first-pass prompt. The mechanism generalizes past this one example: any task whose source item changes again after the rule already ran can be picked back up, as many times as it recurs.

## Scope

**In scope:**
- A source-defined signal that tells Jidoka "this occurrence of an already-known item is a real change," so a reopen is possible without every source needing to be rewritten and without a naive source (one that returns the same items every poll) reopening things constantly.
- Reusing the same task row across passes — the board card cycles through states again, keeping its id and full history.
- Resuming a prior Claude Agent SDK session from a rule's `agent` step, so a follow-up pass continues the actual conversation instead of starting fresh.
- A `Thread` section in the task drawer showing every pass, current pass expanded, history collapsed and drillable.

**Explicitly out of scope**, decided during brainstorming:
1. **Content-diffing to detect a "real" change.** Rejected in favor of an explicit source-defined signal (see Detection) — diffing would let a source with no cursor semantics (the sample-folder source, which always returns the same items) reopen a `done` task on every poll forever.
2. **Continuity for plain `ai` steps.** Only `agent` steps (the Claude Agent SDK backend) produce a real resumable session today; `ai` steps are stateless completions with no session concept to hang continuity off of.
3. **A dedicated `onReopen` step list on `RuleDefinition`.** Considered as an alternative to branching on a context flag inside the existing step list; rejected as a bigger schema change for the same outcome — a `branch` step already does the job.
4. **A dedicated `threads` DB table.** Everything lives in the existing `context` JSON bag, consistent with `ruleLog`/`mergedFrom`/`dedupRationale`.
5. **Raw step-level trace in the UI.** Superseded by the Thread section showing actual output content per pass; `ruleLog` still exists in `context` for internal bookkeeping, just isn't rendered as a flat list anymore.
6. **Teaching `buildRule` to author the branch/resume pattern.** A rule built before this feature (or one whose description never mentions follow-ups) simply has no branch on `isFollowUp` and reruns identically on every reopen, which is a strict improvement over today's silent no-op, not a regression. Teaching the rule-building agent this pattern is a smaller follow-on, not built here.

## Data model

**`src/sources/types.ts`** — `RawItem` gains one optional field:
```ts
export interface RawItem {
  externalId: string;
  title: string;
  body: string;
  url?: string;
  metadata?: Record<string, unknown>;
  /** Opaque token the source defines meaning for (an ADO rev number, a
   *  last-modified timestamp, a hash of whatever fields that connector cares
   *  about). Jidoka never inspects it — only compares it to what it last
   *  stored. Omit it and this task never reopens automatically, which is
   *  today's behavior, unchanged. */
  revision?: string;
}
```

**`src/domain/task.ts`** — no new column. `Task.context` gains three ad hoc keys, the same convention as `ruleLog`/`mergedFrom`/`dedupRationale`:
- `context.revision: string` — the last-seen token, stamped at ingestion and refreshed on every reopen.
- `context.isFollowUp: "true" | "false"` — stamped fresh on every rule run (never accumulated), so a `branch` step can key on it.
- `context.thread: ThreadPass[]` — the accumulated history of prior passes, pushed right before a reopen overwrites `context` for the new pass:

```ts
interface ThreadPass {
  /** Snapshot of that pass's produced context values — context[key] gets
   *  overwritten by the next pass, so the archive must carry the values, not
   *  just which steps ran. */
  outputs: Record<string, unknown>;
  /** Still needed after the snapshot above: tells the UI which step type
   *  (ai/agent/mcp_tool) produced each output key, for the kind badge. */
  ruleLog: StepLogEntry[];
  handoff?: ResolvedHandoffTarget[];
  assignee: Assignee | null;
  completedAt?: string;
  completionNote?: string;
  closedAt: string;
}
```

**`src/domain/rule.ts`** — `AgentStep` gains one optional field:
```ts
resumeSessionFrom: z.string().optional(), // context key holding a prior session id
```

## Detection (poller)

**`src/sources/poller.ts`** — `pollOnce` currently does `if (findTaskBySource(...)) continue;` unconditionally for any item whose `(sourceId, externalId)` already has a task. New logic:

```ts
const REOPENABLE_STATES = new Set<TaskState>(["done", "assigned_ai", "assigned_human"]);

const created: Task[] = [];
const reopened: { task: Task; item: RawItem }[] = [];

for (const item of result.items) {
  const existing = findTaskBySource(db, source.id, item.externalId);
  if (existing) {
    if (
      item.revision &&
      item.revision !== (existing.context.revision as string | undefined) &&
      REOPENABLE_STATES.has(existing.state)
    ) {
      reopened.push({ task: existing, item });
    }
    continue;
  }
  if (wasMerged(db, source.id, item.externalId)) continue;
  created.push(insertTask(db, { ...item, sourceId: source.id }));
}

setCursor(db, source.id, result.cursor);

for (const task of created) await onTask(task);
for (const { task, item } of reopened) await onTaskChanged(task, item);
```

- `insertTask` (`src/repo/tasks.ts`) stamps `context: { revision: item.revision }` at creation when `item.revision` is present (today it hardcodes `context: '{}'`), so the first later comparison has something to diff against. `NewTask` gains an optional `revision?: string` passed through from `RawItem`.
- A revision change while the task is `processing`, or in any pre-triage state (`ingested`, `needs_type_confirmation`, `needs_onboarding`, `needs_dedup_confirmation`), is **not** reopenable — there's no completed rule run yet to follow up on, and reopening mid-run would race the run in flight. It's simply not flagged. `onTaskChanged` (below) still refreshes `context.revision` to the latest value whenever it runs for *any* reason, so a bump that happened during that window doesn't get mistaken for a fresh change once the task later reaches a reopenable state.
- `startPoller`'s signature gains a second callback parameter, `onTaskChanged: (task: Task, item: RawItem) => Promise<void>`, alongside the existing `onTask`. `src/main.ts`'s one `startPoller(...)` call (the only caller — `src/api/server.ts`'s manual task-creation route calls `insertTask`/`onTaskIngested` directly and can't collide with an existing externalId, since it 409s first) wires it to a new orchestrator export, `onTaskChanged`, the same try/catch-and-log pattern the existing `onTask` wiring already uses.

## Orchestrator — the reopen flow

New export in `src/orchestrator.ts`, sibling to `reopenTask`:

```ts
export async function onTaskChanged(deps: AppDeps, task: Task, item: RawItem): Promise<Task> {
  if (!task.typeId) {
    // No rule has ever run for this task — REOPENABLE_STATES all imply a
    // type was assigned, so this is defensive only, not a real path.
    return updateTask(deps.db, task.id, { context: { ...task.context, revision: item.revision } });
  }

  const pass: ThreadPass = {
    outputs: Object.fromEntries(
      ruleLogFromContext(task.context)
        .filter((e) => e.output && e.type !== "assign")
        .map((e) => [e.output as string, task.context[e.output as string]]),
    ),
    ruleLog: ruleLogFromContext(task.context),
    handoff: task.context.handoff as ResolvedHandoffTarget[] | undefined,
    assignee: task.assignee,
    completedAt: task.context.completedAt as string | undefined,
    completionNote: task.context.completionNote as string | undefined,
    closedAt: new Date().toISOString(),
  };

  const reopened = updateTask(deps.db, task.id, {
    title: item.title,
    body: item.body,
    metadata: item.metadata ?? {},
    state: "processing",
    assignee: null,
    context: {
      ...task.context,
      revision: item.revision,
      isFollowUp: "true",
      thread: [...asThreadArray(task.context.thread), pass],
      completedAt: undefined,
      completionNote: undefined,
    },
  });

  return runRuleForTask(deps, reopened);
}
```

- Reuses `runRuleForTask` completely unchanged — it just runs the current active rule from the top over the updated row, same as any first pass. `ruleLogFromContext`/`asThreadArray` are one-line helpers in the same style as the existing `asMergedFromArray`.
- `runRuleForTask` stamps `isFollowUp: "false"` into context before calling `runRule` whenever the task doesn't already carry `"true"` — concretely, `context: { isFollowUp: "false", ...task.context }` (the task's own value wins if already present), so every rule run has a consistent, present value to branch on from the very first pass, without `onTaskChanged` needing to special-case "is this the first reopen."
- Title/body/metadata are refreshed on every reopen so the rule and any templated prompt see the current source content (e.g. new comments), not the stale first-pass text.

## Executor / AgentRunner — resuming a session

**`src/agent/runner.ts`** — `AgentRunInput` gains one optional field, `resumeSessionId?: string`. `createInProcessRunner` accepts and ignores it — that backend is a stateless per-call loop with no session concept, so a rule using `resumeSessionFrom` against an in-process deployment just runs fresh every time, no error.

**`src/agent/claudeAgentSdk.ts`** — `createAgentSdkRunner`: when `input.resumeSessionId` is set, `queryOptions.resume = input.resumeSessionId` before calling `query()`. Confirmed against the installed SDK's `sdk.d.ts`: a session id returned as `session_id` on a prior run is resumable via exactly this option.

**`src/rule/executor.ts`** — `runOneStep`, for an `agent` step, resolves `resumeSessionId` before calling the runner:
```ts
const resumeSessionId = step.resumeSessionFrom
  ? (state.context[step.resumeSessionFrom] as string | undefined)
  : undefined;

result = await runner.run({
  ...,
  ...(resumeSessionId ? { resumeSessionId } : {}),
});
```
If the key is unset or empty (the very first pass, or a rule version that never ran before), it's omitted — a normal fresh run.

**The chaining pattern, no new mechanism needed:** a follow-up step can share the same `output` name as the original step it's following up on — `AgentStep.output` is just a context-key label, and nothing stops two step ids writing to the same one. So a rule author (or, later, `buildRule`) writes:
- First-pass step: `id: "review"`, `output: "review"` → writes `context.review` + `context.review_session`.
- Follow-up step: `id: "review_followup"`, `output: "review"` (same key), `resumeSessionFrom: "review_session"` → on pass 2, resumes pass 1's session and overwrites the same two keys; on pass 3, it resumes pass 2's session (already sitting in `review_session`), and so on indefinitely. One field, one naming convention, no pass counter.
- A top-level `branch` step on `context.isFollowUp` (cases `"false"` / `"true"`) selects which of the two steps runs.

Teaching `buildRule` to author this pattern automatically from a natural-language description that mentions follow-ups is noted as a follow-on in Scope, not built here — a rule can be hand-edited to use it today.

## UI

The task drawer (`src/client/TaskDetail.tsx`) reorders to: merged-from (unchanged, top, when present) → Task content → **Thread** → the human-assign panel or done-footer (unchanged conditions, just moved after Thread) → the "Mark as duplicate of…" control. The existing "What the rule produced" and "Run trace" sections are removed — Thread absorbs both, for every task, not only reopened ones (a task that's never been reopened just shows a Thread with one row: the current pass, nothing below it).

**Current pass row:** not a toggle — always expanded, non-interactive header (`pass N` / `current` / output count / `today`). Below it, one full `.artifact` card per output (from the existing `outputs`/`producedBy` computation, unchanged), each with a `kind-badge` reading `ai` / `agent` / `mcp tool` — replacing today's "AI output"/"agent output"/"tool output" provenance-badge copy with the bare step kind, a small simplification that falls out of this rework.

**Past pass rows** (from `task.context.thread`, newest first): `context.thread` is stored oldest-first (each reopen `push`es onto the end, so `thread[0]` is pass 1), and the UI reverses it for display. Pass numbering is 1-indexed position in that stored array, plus one for the always-present current pass — two archived entries means the current pass is "pass 3," matching the mockup. Rows render newest-first: current pass, then `thread[thread.length - 1]`, …, down to `thread[0]`. Collapsed by default — header shows `pass n` / a one-line summary / output count / relative time (`closedAt`) / a chevron. Expanding one reveals a denser `.out-list`: each output is its own collapsed row (key + a CSS-truncated one-line gist + kind-badge + chevron), individually expandable to its full content. Two-level collapse keeps a long history scannable without a wall of text up front.

No raw step-id trace anywhere — `ruleLog` stays in `context`/`ThreadPass` for internal use (deriving each output's kind badge, `findDependentSteps`), just never rendered as a flat list.

No `Board.tsx` change — a reopened task is an ordinary state transition, so it moves lanes exactly like any other.

## Edge cases / explicitly deferred

- **Rule version drift across passes.** A reopen always runs the *current* active rule (same as `processWaitingTasks`), not whatever version ran the first pass. If the rule changed shape between passes (the follow-up step got renamed or removed), `resumeSessionFrom` simply finds nothing in `context` and runs fresh — no error, no migration.
- **Rules with no `isFollowUp` branch.** They keep running the same steps every reopen with no continuity — strictly better than today's silent no-op, not a regression, and not something this spec needs to fix for existing rules.
- **Concurrent reopen vs. in-flight processing.** Excluded by construction — `processing` isn't in `REOPENABLE_STATES`, mirroring the existing `mergeTasks` guard on the dedup feature.
- **Unbounded thread history.** `context.thread` grows by one entry per reopen with no cap — accepted, matching this codebase's existing stance on `mergedFrom` and hints (pruning is a human's job, not automatic).
- **No dedicated `threads` table.** Everything lives in `context`; a queryable cross-task "all threads" view is out of scope for v1.
- **A `failed` task is not in `REOPENABLE_STATES`.** A revision change on a task whose rule threw doesn't automatically retry it — that's a "retry a failed run" concern, separate from "the source item changed and now needs a follow-up pass," and this spec doesn't address it.
- **Manual reopen (`reopenTask`) is untouched.** It's still the human-initiated single-row undo of a `done` task; `onTaskChanged` is the new automatic, source-driven path. They don't call each other. `reopenTask` does **not** push a `ThreadPass` today, so a manually-reopened-then-redone task won't show that round in the Thread history — accepted as a gap, not fixed here, since folding it in would mean `reopenTask` also needing a "what changed" signal it has no source for.

## Testing

TDD per layer, matching how the dedup and hints specs were built:

- `tests/sources/poller.test.ts` — a repeat item with an unchanged `revision` is a no-op (today's behavior); a changed `revision` on a `done`/`assigned_ai`/`assigned_human` task calls the new `onTaskChanged` callback with the existing task and the new item; a changed `revision` on a `processing` or pre-triage-state task does not; an item with no `revision` field never triggers it, even when title/body differ; `insertTask` stamps `context.revision` from a new item that has one.
- `tests/orchestrator.test.ts` — `onTaskChanged` archives the current pass into `context.thread` (with a correct `outputs` snapshot built from that pass's own `ruleLog`, excluding `assign` entries), stamps `isFollowUp: "true"` and the new `revision`, clears `completedAt`/`completionNote`, and re-runs the active rule; a first-ever `runRuleForTask` call stamps `isFollowUp: "false"` when the task doesn't already carry a value.
- `tests/rule/executor.test.ts` — an `agent` step with `resumeSessionFrom` set passes `resumeSessionId` through when the context key holds a value, omits it when absent or empty; unaffected when the step has no `resumeSessionFrom`.
- `tests/agent/claudeAgentSdk.test.ts` — `resumeSessionId` becomes `queryOptions.resume`, via the existing `queryFn` injection seam.
- `tests/agent/runner.test.ts` — `createInProcessRunner` accepts and ignores `resumeSessionId`.
- `tests/api/server.test.ts` — none new; no new routes, since reopen is fully poller/orchestrator-driven.
- UI — manual verification via `bun run dev`, this codebase's existing convention for `Board.tsx`/`TaskDetail.tsx` changes (no automated component tests exist for either).

Full `bun run typecheck` + `bun test` clean before considering any task in the resulting plan done, per this repo's standing convention.
