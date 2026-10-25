# Reliable Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cursor-based `poll(cursor)` contract with `list({ since })`, so an extension only supplies stable keys and Jidoka owns windows, filing, threading, failures, Retry, Dismiss and Rescan.

**Architecture:** New pure pieces first (item checks, thread composition), then the item record and poll log tables, then a new poller that files each item in its own transaction and routes items into tasks by thread key. The orchestrator's change flow takes the new items and defers changes while a task is busy. The old contract is renamed `Legacy*` in Task 1 so every task stays green, and deleted in Task 8.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Hono, React, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-reliable-polling-design.md`

## Global Constraints

- Work on branch `feat/reliable-polling` (already checked out, cut from `feat/roster`).
- `bun test` and `bun run typecheck` pass at the end of every task.
- IDs are `crypto.randomUUID()`, timestamps `new Date().toISOString()`. Tests use `openDb(":memory:")` + `migrate(db)` and fake sources; no network.
- Window: first poll `since` = now − **7 days** (recorded as the horizon); later `since` = start of the last `kind = 'poll'` with `outcome = 'ok'` − **5 minutes**; if none since the horizon, the horizon. `list` timeout **60 seconds**.
- Item checks: key non-empty, ≤ **512** chars; `occurredAt` parses as a date; title non-empty after trim; a known key keeps its first `threadKey`; one list never repeats a key with different content.
- Failed items are never retried automatically; Retry re-lists from the row's `failed_window`; Rescan lists from the horizon and never moves the window.
- Body line per item: `— <from name or address> · <occurredAt, local date and time> —`, or `— <occurredAt> —` without a `from` participant; items separated by a blank line.
- Client styling follows the existing conventions: classes in `src/client/modernist.css`, no new inline `style={}`, Archivo 400/600/800, radius 0.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_014qyKwe5fVhjFDMKwTQet6v`

## Review Focus

- **A reply arrives in an earlier poll than its conversation's first message:** one task results, and when the first message arrives the task's title becomes that first message's title. Pinned in Task 4.
- **An extension that ignores `since` and returns everything every poll:** no task is reopened, no row is marked changed, `new` and `changed` stay 0. Pinned in Task 4.
- **A task deleted by hand (its rows' `task_id` became NULL) then a new item for its thread:** a new task is created, not an error. Pinned in Task 4.
- **The same key twice in one list with identical content:** filed once, not a failure. Pinned in Task 1.
- **A pending change on a task whose rule run then fails:** the flag stays set and nothing runs; it runs when the task later reaches a reopenable state. Pinned in Task 5.

---

## File structure

| File | Responsibility |
|---|---|
| `src/sources/types.ts` | `SourceItem`, `ListResult`, `TaskSource` (new); `Legacy*` until Task 8 |
| `src/sources/checks.ts` (new) | Per-item and per-list checks |
| `src/sources/compose.ts` (new) | Building a task's title/body/url/metadata from its item rows |
| `src/repo/sourceItems.ts` (new) | `source_items` SQL |
| `src/repo/sourcePolls.ts` (new) | `source_polls` and `source_horizons` SQL, window selection |
| `src/sources/poller.ts` | New poll loop: `pollSource`, `retryFailure`, `rescanSource`, `startPoller` |
| `src/orchestrator.ts` | Change flow with new items, `pendingChange`, merge repointing |
| `src/triage/reopenRelevance.ts` | Judges new items |
| `src/extensions/runtime.ts`, `generator.ts` | `list` contract, prompt, shape check |
| `src/api/extensions.ts` | Polls, failures, Retry, Dismiss, Rescan, Test preview, card fields |
| `src/main.ts` | Wiring |
| `src/client/api.ts`, `Extensions.tsx`, `modernist.css` | Extension card |

---

### Task 1: New contract types and item checks

**Files:**
- Modify: `src/sources/types.ts`; mechanical rename in `src/sources/poller.ts`, `src/sources/sample/folder.ts`, `src/extensions/runtime.ts`, `src/extensions/generator.ts`, `src/orchestrator.ts`, `src/triage/reopenRelevance.ts`, `src/api/extensions.ts`, `src/main.ts`, and tests that import the old names
- Create: `src/sources/checks.ts`
- Test: `tests/sources/checks.test.ts`

**Interfaces:**
- Produces: `SourceItem`, `ListResult`, `TaskSource` exactly as spec §1 (with `list(window: { since: string | null }): Promise<ListResult>`); old types renamed `LegacyRawItem`, `LegacyPollResult`, `LegacyTaskSource` (no behaviour change).
- Produces (`src/sources/checks.ts`):
  - `checkItem(item: unknown, known: { threadKey: string | null } | null): string | null` → error message or null
  - `checkList(items: unknown[]): { valid: SourceItem[]; failures: { key?: string; error: string }[] }` → runs `checkItem` (with `known = null`) and the duplicate rule; identical duplicates collapse to one item

- [ ] **Step 1: Rename the old types** to `Legacy*` across `src` and `tests`, then add the three new types. Run `bun run typecheck`: clean; `bun test`: all pass.

- [ ] **Step 2: Write the failing tests** in `tests/sources/checks.test.ts`:

```ts
const ok = { key: "m1", occurredAt: "2026-10-01T10:00:00Z", title: "Hi", body: "b" };
test("a valid item passes", () => expect(checkItem(ok, null)).toBeNull());
test("empty or overlong keys fail", () => {
  expect(checkItem({ ...ok, key: "" }, null)).toBe("item has no key");
  expect(checkItem({ ...ok, key: "x".repeat(513) }, null)).toBe("key is longer than 512 characters");
});
test("a bad date fails", () => expect(checkItem({ ...ok, occurredAt: "soon" }, null)).toBe("occurredAt is not a valid date"));
test("an empty title fails", () => expect(checkItem({ ...ok, title: "  " }, null)).toBe("item has no title"));
test("a known key with a different thread key fails", () => {
  expect(checkItem({ ...ok, threadKey: "t2" }, { threadKey: "t1" })).toBe("thread key changed from t1 to t2");
  expect(checkItem({ ...ok, threadKey: "t1" }, { threadKey: "t1" })).toBeNull();
});
test("identical duplicates collapse; differing duplicates fail", () => {
  expect(checkList([ok, { ...ok }]).valid).toHaveLength(1);
  const r = checkList([ok, { ...ok, body: "other" }]);
  expect(r.valid).toHaveLength(0);
  expect(r.failures).toEqual([{ key: "m1", error: "key m1 appears twice with different content" }]);
});
test("a non-object fails without a key", () =>
  expect(checkList([42]).failures).toEqual([{ error: "item is not an object" }]));
```

- [ ] **Step 3: Run** `bun test tests/sources/checks.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `checkItem` and `checkList`** in `src/sources/checks.ts` with exactly those messages. "Different content" means any field differs (compare with `JSON.stringify` of the item).

- [ ] **Step 5: Run** the test file, `bun test`, `bun run typecheck`. Expected: all pass, clean.

- [ ] **Step 6: Commit** `feat(polling): list contract types and item checks`.

---

### Task 2: Item record and poll log tables

**Files:**
- Modify: `src/db/migrations.ts` (append the spec §2 `source_items`, its two indexes, `source_polls`, its index, `source_horizons`; **not** the DROP statements, which come in Task 8)
- Create: `src/repo/sourceItems.ts`, `src/repo/sourcePolls.ts`
- Test: `tests/repo/sourceItems.test.ts`, `tests/repo/sourcePolls.test.ts`, `tests/db/migrations.test.ts`

**Interfaces:**
- Produces (`src/repo/sourceItems.ts`), with `SourceItemRow` = the table's columns in camelCase, `metadata` and `participants` parsed:
  - `getItemRow(db, sourceId, key): SourceItemRow | null`
  - `fileIngested(db, sourceId, item: SourceItem, taskId: string): void` (insert or update content, `status = 'ingested'`, clear `error`/`failed_window`, set `last_seen_at`; sets `first_seen_at` only on insert)
  - `touchSeen(db, sourceId, key): void`
  - `fileFailure(db, sourceId, key, error, window: string | null): "recorded" | "already_ingested"` (never downgrades an `ingested` row)
  - `dismissFailure(db, sourceId, key): void`
  - `listFailures(db, sourceId): SourceItemRow[]` (`status = 'failed'`, newest `last_seen_at` first)
  - `countFailures(db, sourceId): number`
  - `taskForThread(db, sourceId, threadKey): string | null` (a `task_id` from any row with that thread key)
  - `rowsForTask(db, taskId): SourceItemRow[]` (ingested rows, `occurred_at` ascending)
  - `repointTask(db, fromTaskId, toTaskId): void`
- Produces (`src/repo/sourcePolls.ts`), with `PollRecord` = row in camelCase, `unkeyedFailures` parsed:
  - `startPoll(db, sourceId, kind: "poll" | "retry" | "rescan", since: string | null): PollRecord`
  - `finishPoll(db, id, result: { outcome: "ok" | "error"; error?: string; seen: number; new: number; changed: number; failed: number; unkeyedFailures: { key?: string; error: string }[] }): PollRecord`
  - `listPolls(db, sourceId, limit = 50): PollRecord[]` (newest first)
  - `lastPoll(db, sourceId): PollRecord | null` (newest `kind = 'poll'`)
  - `getHorizon(db, sourceId): string | null`, `setHorizon(db, sourceId, horizon): void`
  - `nextWindow(db, sourceId, now: Date): { since: string; isFirst: boolean }` (spec §2 step 1; on first poll it **does not** write the horizon — the poller does)

- [ ] **Step 1: Write failing tests**:
  - migrations test: the three tables and three indexes exist; `migrate()` re-runs cleanly.
  - `sourceItems.test.ts`: `fileIngested` then `getItemRow` returns content and `status: "ingested"`; `fileFailure` on a new key records `failed` with `failedWindow`; `fileFailure` on an ingested key returns `"already_ingested"` and leaves it ingested; `dismissFailure` → `status: "dismissed"`, `countFailures` drops to 0; `fileIngested` on a failed key clears `error`; `taskForThread` finds a task through any row of the thread; `rowsForTask` orders by `occurredAt`; `repointTask` moves rows; deleting the task sets `taskId` to null.
  - `sourcePolls.test.ts`:
    - `nextWindow` on a new source: `isFirst: true`, `since` = now − 7 days.
    - With a horizon and no ok poll: `since` = horizon.
    - After an ok `poll` started at T: `since` = T − 5 minutes.
    - An ok `rescan` or `retry` started later than T does not change that.
    - An `error` poll does not change it.
    - `listPolls` is newest first; `finishPoll` stores counts and `unkeyedFailures`.

- [ ] **Step 2: Run** them. Expected: FAIL.

- [ ] **Step 3: Implement** the migrations and both repos with the signatures above.

- [ ] **Step 4: Run** the three test files, `bun test`, `bun run typecheck`. Expected: pass, clean.

- [ ] **Step 5: Commit** `feat(polling): item record and poll log tables`.

---

### Task 3: Building a task from its items

**Files:**
- Create: `src/sources/compose.ts`
- Test: `tests/sources/compose.test.ts`

**Interfaces:**
- Consumes: `SourceItemRow` (Task 2).
- Produces: `composeTask(rows: SourceItemRow[]): { title: string; body: string; url: string | null; metadata: Record<string, unknown> }` — rows sorted by `occurredAt` inside the function, so callers may pass any order.

- [ ] **Step 1: Write failing tests**:
  - One row: the title is the row's title; the body is the heading line plus the row's body.
  - Two rows passed newest-first:
    - the title is the older row's title;
    - the body has the older row first;
    - `url` and `metadata` come from the newer row.
  - The heading line:
    - uses the `from` participant's `name` when present;
    - otherwise the `from` participant's address (the identity without `email:`);
    - otherwise only the date.
    Assert the exact `— Bob Smith · ` prefix and that the date part is `new Date(occurredAt).toLocaleString()`.
  - Items are separated by exactly one blank line.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `composeTask`.**
- [ ] **Step 4: Run** the file, `bun test`, `bun run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(polling): build task content from thread items`.

---

### Task 4: The new poll loop

**Files:**
- Modify: `src/sources/poller.ts` (add the new functions alongside the legacy `pollOnce`; `startPoller` switches in Task 6)
- Test: `tests/sources/pollSource.test.ts` (new file; the legacy `poller.test.ts` is deleted in Task 8)

**Interfaces:**
- Consumes: Tasks 1–3; `insertTask`, `getTask`, `updateTask` (`src/repo/tasks.ts`); `upsertSourceParticipants` (`src/repo/participants.ts`); the existing `sanitizeParticipants`.
- Produces:
  ```ts
  export interface PollHooks {
    onCreated(task: Task): Promise<void>;
    onChanged(task: Task, newItems: SourceItem[]): Promise<void>;
  }
  export interface PollOutcome { poll: PollRecord; recovered: number }
  export function pollSource(db, source: TaskSource, hooks: PollHooks, opts?: { now?: Date; timeoutMs?: number }): Promise<PollOutcome>
  export function retryFailure(db, source: TaskSource, key: string, hooks: PollHooks, opts?): Promise<PollOutcome>
  export function rescanSource(db, source: TaskSource, hooks: PollHooks, opts?): Promise<PollOutcome>
  ```
  `recovered` = keys filed by this run that had no row before (used by Rescan's message). All three share one internal `runList(db, source, kind, since, hooks, opts)`.

**Filing rules** (spec §2 step 4 and §3), per item, one `db.transaction` covering the row, the task write and the participants:
- **New key:** if `taskForThread(threadKey ?? key)` returns a task that still exists, join it. Otherwise, if `findTaskBySource(source.id, threadKey ?? key)` finds a task (one created before this item record existed), join it. Otherwise `insertTask` with `externalId = threadKey ?? key`, then compose. Participants go through `sanitizeParticipants` → `upsertSourceParticipants`.
- **Known key:**
  - same `version` (both absent counts as same): `touchSeen` only;
  - different `version`: update the row and recompose;
  - row `failed` or `dismissed`: treat as new.
- **Task content:** after any row change, `updateTask(title, body, url, metadata) = composeTask(rowsForTask(taskId))`.
- **Hooks**, called after the transaction commits:
  - `onCreated` for a task created in this run;
  - `onChanged(task, newItems)` once per existing task that gained or changed items in this run, with those items.

- [ ] **Step 1: Write failing tests** in `pollSource.test.ts`, with a fake `TaskSource` that records each `since` it received and returns scripted results:
  - **First poll:** `since` = now − 7 days; the horizon is recorded; items create tasks; `onCreated` fires once per task.
  - **Second poll:** `since` = the first poll's start − 5 minutes.
  - **Outage:**
    - when `list` throws, the poll is `error` with the message and the next `since` is unchanged;
    - when `list` takes longer than `timeoutMs`, the poll is `error` with `list timed out after 60s` (use `timeoutMs: 50` in the test, and assert the message for the default).
  - **Idempotence:** a list that returns the same items again is skipped, with `new = 0`, `changed = 0` and no hooks. *(Review Focus 2.)*
  - **Version change:** the row and task update, and `onChanged` fires with that item.
  - **Threads:**
    - two keys with one thread key give one task, whose body has both items in `occurredAt` order;
    - the reply arrives first and the root next poll: still one task, now titled with the root's title. *(Review Focus 1.)*
  - **Deleted task:** after `deleteTask`, a new item for that thread creates a new task. *(Review Focus 3.)*
  - **Failures:**
    - a keyed failure from `failures` records a `failed` row with `failedWindow` = that poll's `since`;
    - a check failure records a `failed` row;
    - an unkeyed failure lands in `unkeyedFailures`;
    - the poll is still `ok`, and the other items in the same list are filed;
    - a failure is not retried on the next poll: the row is unchanged and no extra `list` call is made for it.
  - **Recovery:** a failed key that later comes back valid is filed, with `status: "ingested"`.
  - **Retry:** lists with `since` = the row's `failedWindow`, has `kind: "retry"`, and doesn't change the next normal window.
  - **Rescan:**
    - lists from the horizon;
    - `recovered` counts only keys with no previous row;
    - `kind: "rescan"`, and the next normal window is unchanged.
  - **Crash safety:**
    - make `onCreated` throw for the first task and confirm the item row is still filed;
    - return two items where the second's `participants` array holds an object whose `identity` getter throws, and confirm the first item is filed, the second isn't, and the poll is `error`;
    - re-poll with the getter fixed and confirm the first item is skipped (no duplicate task) and the second is filed.
  - **Joining an existing task:** a task inserted directly with `externalId` equal to a new item's thread key is joined, not duplicated.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `pollSource`, `retryFailure`, `rescanSource` and the shared internal list runner. Use `Promise.race` with a timer for the timeout. An `error` poll logs exactly one `console.error` line (`[poller] <source id>: <error>`). Throwing hooks are caught and logged with one `console.error` line each; they never fail the poll.
- [ ] **Step 4: Run** the file, `bun test`, `bun run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(polling): Jidoka-owned poll loop with item record`.

---

### Task 5: Orchestrator — change flow, pending changes, merges

**Files:**
- Modify: `src/orchestrator.ts`, `src/triage/reopenRelevance.ts`
- Test: `tests/orchestrator.test.ts`, `tests/triage/reopenRelevance.test.ts`

**Interfaces:**
- Consumes: `SourceItem`; `repointTask` (Task 2).
- Produces:
  - `onTaskChanged(deps: AppDeps, task: Task, newItems: SourceItem[]): Promise<Task>` replaces the `LegacyRawItem` version. The task's content has already been rebuilt by the poller; this function only decides follow-up.
  - `assessReopenRelevance(provider, task, type, newItems: SourceItem[], identity)`: the prompt lists the new items (title and body, each with `occurredAt`) under "New messages in this thread". The rest of the prompt is unchanged.
  - `drainPendingChange(deps, task): Promise<Task>`: no-op unless `task.context.pendingChange` (a `string[]` of item keys) is set **and** the task is in `done | assigned_ai | assigned_human | dismissed`. In that case it clears the flag and runs `onTaskChanged` with the rows for those keys, rebuilt into `SourceItem`s via `getItemRow`.

**Behaviour:**
- In `onTaskChanged`, a task in `processing`, `ingested`, `needs_type_confirmation`, `needs_onboarding` or `needs_dedup_confirmation` gets `context.pendingChange` set to the union of the existing and new keys. Nothing else happens.
- Reopenable states keep today's flow: relevance check, archive the pass, re-run the rule; `dismissed` re-triages. Every `context.revision` read and write is deleted.
- Call `drainPendingChange` at the end of `runRuleForTask` (after the success-path update), in `skipOnboarding`, and in `applyTriageOutcome` after a `not_relevant` dismissal.
- In `mergeTasks`, call `repointTask(duplicate.id, target.id)` before `deleteTask`. Remove the `recordMergedSourceItem` call; the table and its repo are deleted in Task 8.

- [ ] **Step 1: Write failing tests**:
  - **Relevance:** `assessReopenRelevance` puts each new item's title and body in the prompt (assert on the stub provider's captured prompt).
  - **Busy task:** `onTaskChanged` on a `processing` task sets `pendingChange` to the item keys and does not call the provider.
  - **Drain after a run:** after `runRuleForTask` completes into `assigned_human` with `pendingChange` set, the change flow runs once and the flag is cleared.
  - **Failed run:** when the run fails (state `failed`), the flag stays set and the flow doesn't run. Moving the task to `done` with `completeTask` and calling `drainPendingChange` then runs it. *(Review Focus 5.)*
  - **Merge:** `mergeTasks` repoints the duplicate's `source_items` rows to the target.
  - **Updated callers:** the existing `onTaskChanged` and `reopenRelevance` tests now pass `SourceItem[]` instead of a `LegacyRawItem`.
- [ ] **Step 2: Run** both files. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files, `bun test`, `bun run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(polling): change flow takes new items; defer changes on busy tasks`.

---

### Task 6: Extensions on the list contract; wiring

**Files:**
- Modify: `src/extensions/runtime.ts`, `src/extensions/generator.ts`, `src/sources/poller.ts` (`startPoller`), `src/main.ts`
- Test: `tests/extensions/runtime.test.ts`, `tests/extensions/generator.test.ts`, `tests/main.smoke.test.ts`

**Interfaces:**
- Consumes: `pollSource`, `PollHooks` (Task 4); `onTaskIngested`, `onTaskChanged` (Task 5).
- Produces:
  - `loadOneExtensionSource(...)` returns `TaskSource` (`{ id, list }`), throwing `${id}: createSource() must return an object with a list({ since }) function` when `list` is missing.
  - `startPoller(db, sources: TaskSource[], hooks: PollHooks, intervalMs, loadDynamicSources?)` calls `pollSource` per source. The single-flight guard and id-collision check stay as they are.
  - `SYSTEM_PROMPT` teaches spec §6 in full, including the key table rows from spec §1.
  - The generator's shape check requires `list` and rejects a source with only `poll`.
- In `main.ts`, the sample source wiring stays for now (removed in Task 8). Pass `[]` for static sources when no sample dir is set, and pass the hooks:
  - `onCreated` → `onTaskIngested`
  - `onChanged` → `onTaskChanged`
  - both keeping the existing try/catch logging

- [ ] **Step 1: Write failing tests**:
  - **Runtime:** a fixture `source.ts` exporting `createSource` with `list` loads, and its `list` is called with `{ since }`. A fixture with only `poll` throws the message above.
  - **Generator:**
    - `SYSTEM_PROMPT` contains `list({ since })`, `threadKey`, `never use IMAP UIDs`, `never invent a fallback key` and `failures`, and no longer contains `poll(cursor)`;
    - the shape check returns `createSource(deps) must return an object with a list({ since }) function` for a poll-only draft.
  - **Smoke:** `createApp` still serves `/api/tasks` (unchanged assertion, proving the wiring compiles and starts).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The sample source still implements `LegacyTaskSource`, so wrap it in `main.ts` for one task only. Ledger this as a ruling: the adapter turns each legacy item into a `SourceItem` with `key = externalId`, `occurredAt = now`. It's deleted in Task 8.
- [ ] **Step 4: Run** the three files, `bun test`, `bun run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(polling): extensions use list({ since }); poller wired to the new loop`.

---

### Task 7: Extension API — polls, failures, Retry, Dismiss, Rescan, Test preview

**Files:**
- Modify: `src/api/extensions.ts`
- Test: `tests/api/extensions.test.ts`

**Interfaces:**
- Consumes: `pollSource` hooks from `ExtensionRoutesDeps`. Add a `pollHooks: PollHooks` dependency and wire it in `main.ts` with the same hooks as the poller. Also uses `retryFailure`, `rescanSource`, `listPolls`, `lastPoll`, `listFailures`, `countFailures`, `dismissFailure`, `checkList`, `loadOneExtensionSource`.
- Produces routes (spec §5), each 404 for an unknown extension and 400 when not connected (as `test-poll` today):
  - `GET /api/extensions/:id/polls` → `{ polls: PollRecord[] }`
  - `GET /api/extensions/:id/failures` → `{ failures: SourceItemRow[] }`
  - `POST /api/extensions/:id/failures/:key/retry` → `{ poll: PollRecord }`, and 404 when the key has no failed row
  - `POST /api/extensions/:id/failures/:key/dismiss` → `{ dismissed: true }`
  - `POST /api/extensions/:id/rescan` → `{ recovered: number, poll: PollRecord }`
  - `POST /api/extensions/:id/test-poll` → `{ items: SourceItem[], failures: {key?, error}[], checkFailures: {key?, error}[] }`, built from `list({ since: null })` passed through `checkList`. It writes nothing.
  - `GET /api/extensions` items gain `lastPoll: PollRecord | null` and `failedCount: number`.
  - `POST /:id/delete` also deletes the source's `source_items`, `source_polls` and `source_horizons` rows, in place of `removeCursor`.

- [ ] **Step 1: Write failing tests**, using an extension fixture whose `list` returns one valid item, one keyed failure and one item with an empty title:
  - **Test preview:** `test-poll` returns 1 item, 1 failure and 1 check failure, and afterwards there are no tasks and no `source_items` rows.
  - **Polling, failures, Rescan:**
    - after one `pollSource`, `GET polls` shows one ok poll;
    - `GET failures` shows 2 rows;
    - `GET /api/extensions` has `failedCount: 2`;
    - `dismiss` on one key drops it to 1;
    - `retry` on the other calls `list` with that row's `failedWindow`;
    - `rescan` returns `recovered: 0` on a second run;
    - delete removes the source's rows from all three tables.
  - **Errors:** retry on an unknown key is 404.
  - The keys in route paths are `encodeURIComponent`ed in the test. Message-IDs contain `@`, `<`, `>`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file, `bun test`, `bun run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(polling): extension API for polls, failures, retry, dismiss, rescan`.

---

### Task 8: Remove the old contract, the sample source and the old extensions

**Files:**
- Modify: `src/sources/types.ts`, `src/sources/poller.ts`, `src/orchestrator.ts`, `src/repo/tasks.ts`, `src/domain/task.ts`, `src/client/TaskDetail.tsx`, `src/config.ts`, `src/domain/settings.ts`, `src/api/settings.ts`, `src/client/Settings.tsx`, `src/main.ts`, `src/db/migrations.ts`, `CLAUDE.md`, `README.md`, `docs/backlog.md`
- Delete: `src/sources/sample/`, `src/repo/sourceState.ts`, `src/repo/mergedSourceItems.ts`, `tests/sources/sampleFolder.test.ts`, `tests/sources/poller.test.ts` (superseded by `pollSource.test.ts`), `extensions/youtube-channel-feed/` (`git rm`)
- Test: `tests/config.test.ts`, `tests/api/settings.test.ts`, `tests/repo/settings.test.ts`, `tests/repo/tasks.test.ts`, `tests/db/migrations.test.ts`

- [ ] **Step 1: Update the tests first:**
  - **Config and settings tests:** swap `sampleDir` for `pollIntervalMs: 30000` in `config.test.ts`, `api/settings.test.ts` and `repo/settings.test.ts`.
  - **Migrations:** `source_state` and `merged_source_items` no longer exist after `migrate()`.
  - **Tasks:** delete the two `revision` tests in `repo/tasks.test.ts`.
  - **Settings validation:** `SettingsSchema.parse({ sampleDir: "./samples" })` returns an object with no `sampleDir` property.

  Run: the migration and settings-validation tests FAIL.
- [ ] **Step 2: Delete the legacy code:**
  - the `Legacy*` types, the legacy `pollOnce` and `REOPENABLE_STATES`;
  - the Task 6 sample adapter;
  - `NewTask.revision` and `insertTask`'s revision context;
  - `"revision"` in `TaskDetail`'s `INTERNAL_KEYS`;
  - every `sampleDir` / `JIDOKA_SAMPLE_DIR` field and its Settings input;
  - the sample wiring in `main.ts`, keeping its "No static sources configured" warning, reworded to "add a task from the board, or install an extension";
  - the two repos.

  Then append `DROP TABLE IF EXISTS source_state` and `DROP TABLE IF EXISTS merged_source_items` to `MIGRATIONS`.
- [ ] **Step 3: Update the docs** as spec §7 says:
  - **`CLAUDE.md`:** the `Run with JIDOKA_SAMPLE_DIR` line becomes "Add a task from the board or install an extension to get tasks", and the `src/sources/` code-map line drops "the sample folder source".
  - **`README.md`:** remove the sample-folder lines (the quick start and the env var table row).
  - **`docs/backlog.md`:**
    - item 9 gains "A sample-data extension replaces the removed sample-folder source";
    - delete the extension-system line "Poll failures are console-only" (it includes the per-poll timeout).
- [ ] **Step 4: Run** `grep -rn "LegacyRawItem\|LegacyTaskSource\|sampleDir\|JIDOKA_SAMPLE_DIR\|getCursor\|wasMerged" src tests CLAUDE.md README.md`. Expected: no output. Then `bun test` and `bun run typecheck`: pass, clean.
- [ ] **Step 5: Commit** `refactor(polling): remove the cursor contract, sample source and old extensions`.

---

### Task 9: Extension card

**Files:**
- Create: `docs/superpowers/specs/2026-10-25-polling-card-handoff.md` (Step 1), then the design's returned README copied to the same file (Step 2)
- Modify: `src/client/api.ts`, `src/client/Extensions.tsx`, `src/client/App.tsx` (rail badge), `src/client/modernist.css`
- Test: `tests/client/pollStatus.test.ts` (pure helpers moved to `src/client/pollStatus.ts`)

**Interfaces:**
- Consumes: Task 7's routes and fields.
- Produces:
  - **`api.ts`:** `polls(id)`, `failures(id)`, `retryFailure(id, key)`, `dismissFailure(id, key)`, `rescanExtension(id)`; `testPoll(id)` now returns the preview shape; `ExtensionListItem` gains `lastPoll` and `failedCount`.
  - **`pollStatus.ts`:** `pollSummary(poll: PollRecord | null, now: Date): string`, returning:
    - `"Never polled"`
    - `"Polled 2 min ago · 3 new · 1 changed · 1 failed"`, leaving out zero counts except `new`
    - `"Last poll failed 2 min ago: <error>"`
  - `rescanMessage(recovered: number): string` → `"Recovered N items not seen before"`, or `"Nothing new found"` for 0.

- [ ] **Step 1: Write the Claude Design brief.** It covers spec §5's card elements (status line, failures with Retry/Dismiss, unkeyed failures, collapsible poll history, Rescan, the Test preview with key and thread key, the rail badge), plus the constraints in Global Constraints. **Stop and ask the user to run it in the Claude Design `Jidoka` project** (the MCP connection was rejected; the user pastes it). Continue only once they hand back the README.
- [ ] **Step 2: Copy the returned handoff** into the doc above and commit it with the brief.
- [ ] **Step 3: Write failing tests** for `pollSummary` (each of the three forms, singular and plural counts, the zero-count omission) and `rescanMessage`.
- [ ] **Step 4: Run.** Expected: FAIL.
- [ ] **Step 5: Implement** the helpers, the api calls and the card per the handoff, using the repo's existing hover convention where the handoff says otherwise, and no inline styles.
- [ ] **Step 6: Verify** with `bun test` and `bun run typecheck`, then in the browser on a scratch DB (`JIDOKA_DB=./scratch-polling.db JIDOKA_PORT=3107`) with a fixture extension, per the handoff's acceptance checks.
- [ ] **Step 7: Commit** `feat(polling): extension card shows polls, failures, retry, dismiss, rescan`.

---

### Task 10: Live check against GreenMail, then hand-off

- [ ] **Step 1:** Delete the untracked `github-issues-test` and `imap-inbox-tasks` extensions through the card's Delete (that clears their DB rows and credentials). Back up `jidoka.db*` first, as before.
- [ ] **Step 2:** Start GreenMail (`.local\greenmail\start.cmd`), Jidoka, and Thunderbird (`.local\thunderbird.cmd`). Ask the user to generate the IMAP extension with the same plain prompt as before and connect it with `pass`.
- [ ] **Step 3: Check, and report what was seen:**
  - **Threads:** send Bob → you, then a reply from Bob. One task, with the reply in its body.
  - **Separate conversation:** send vendor → you. A second task.
  - **Restart:** restart GreenMail, send Bob → you again, and confirm it's ingested.
  - **Visibility:** the card's status line and history match.
  - **Failures:** if any failure appears, confirm it's shown with Retry.
- [ ] **Step 4:** Run `bun test` and `bun run typecheck`, then use superpowers:finishing-a-development-branch.
