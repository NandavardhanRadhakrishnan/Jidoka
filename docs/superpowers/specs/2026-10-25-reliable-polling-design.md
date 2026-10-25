# Reliable polling: extensions supply keys, Jidoka owns completeness

**Status:** design approved, not yet planned/implemented.

## Motivation

A live test of a generated IMAP extension against a local GreenMail server lost an email silently. The extension assumed the IMAP server returns the header section of a FETCH before the text section; GreenMail returns them in either order. When the headers came second, the extension couldn't identify the conversation, built no item, and still returned a cursor past that message. Jidoka stored the cursor, so the email was never asked for again, nothing was recorded anywhere, and the board simply stayed empty. The extension card's Test button said "1 item found" at the same time, because Test polls from the start while the poller starts from the saved cursor.

The extension bug is incidental. The fault is in Jidoka's polling contract:

1. **The extension alone decides how far the cursor moves.** Jidoka stores whatever cursor `poll` returns, even when the extension saw an item and failed to emit it.
2. **Losses are invisible.** Nothing records what a poll saw versus what was ingested; errors go to the console only.
3. **Test and the real poll answer different questions**, so a loss looks like a contradiction rather than a diagnosis.
4. **There is no rewind.** Recovery means editing `jidoka.db` or reinstalling the extension.
5. **Extensions carry the hard parts**: cursors, threading, change detection. Every generated extension gets a fresh chance to get each one wrong.

The goal, as the user put it: there is one concrete polling implementation. An extension guarantees only that it produces unique keys, per task or per item within a thread. Everything else is Jidoka's responsibility: no task is ever missed, and if one is, it is visible and recoverable.

The model is Kafka Connect source connectors. A connector polls an external system and returns records that each carry a key; the framework, not the connector, commits offsets, and only after the records are safely written; idempotent writes keyed by record key make re-delivery harmless; records that fail conversion go to a visible dead-letter queue instead of disappearing. The honest limit carries over too: no framework can deliver a record the connector never emitted. Jidoka handles that case by making re-reading cheap and safe (stable keys plus a manual Rescan), not by trusting the extension.

## Scope

**In scope:**
- A new source contract, `list({ since })`, replacing `poll(cursor)`.
- A per-source record of every key Jidoka has seen (`source_items`) and of every poll (`source_polls`).
- A Jidoka-owned poll loop: time windows with overlap, a first-poll lookback, idempotent filing, outage handling, per-poll timeout.
- Jidoka-owned threading: grouping items into tasks by thread key, building task content, change detection, follow-ups deferred while a task is busy.
- Visible failures with manual Retry and Dismiss; a manual Rescan.
- The extension card showing poll status, failures and history; Test showing what an install would produce.
- The extension generator taught the new contract.
- Removing the old contract, the built-in sample-folder source, and the three existing extensions.

**Explicitly out of scope, decided during brainstorming:**
1. **Automatic retry of failed items.** The same extension code fails the same way until someone fixes it; retrying every poll only repeats the error. Failed items are shown once and retried on request.
2. **A scheduled full re-list.** Considered as a safety net for items an extension silently omits; the user chose a manual Rescan button instead.
3. **A separate `fetch(key)` per item.** The extension returns full items from `list`. Simpler to author and to generate; most sources (IMAP included) must read headers just to list.
4. **Supporting the old `poll(cursor)` contract.** No third-party ecosystem exists yet. Running both contracts would mean two poller paths, the old one keeping exactly the weaknesses this removes. Wrapping old extensions in the new machinery was rejected because the extension would still own its cursor.
5. **Porting the existing extensions or the sample-folder source.** They are discarded; a sample-data extension will be built later with the new generator.
6. **Vetted protocol helpers** (a bundled IMAP library for extensions). Would reduce how much protocol code a generated extension writes; a separate, larger change.
7. **Configurable lookback and overlap.** Fixed defaults (7 days, 5 minutes) until there is a reason to change them.

## 1. The source contract

`src/sources/types.ts` replaces `RawItem`, `PollResult` and `TaskSource`:

```ts
export interface SourceItem {
  /** Immutable and taken from the item itself: a Message-ID, a Gmail message
   *  id, an issue node id. Never a mailbox position (IMAP UID) or a made-up
   *  fallback. */
  key: string;
  /** Items with the same threadKey become one task. Must be computable from
   *  this item alone. Omit it and the item is a task on its own. */
  threadKey?: string;
  /** Changes when the item's content changes (updated_at, an etag). Omit it
   *  for items that never change, like an email. */
  version?: string;
  /** When the item happened, ISO-8601. Orders the items within a thread. */
  occurredAt: string;
  title: string;
  body: string;
  url?: string;
  metadata?: Record<string, unknown>;
  participants?: SourceParticipant[];
}

export interface ListResult {
  items: SourceItem[];
  /** Items the extension saw but couldn't build. `key` is optional because
   *  sometimes even the id can't be read. */
  failures?: { key?: string; error: string }[];
}

export interface TaskSource {
  readonly id: string;
  /** Return at least every item that changed at or after `since`; returning
   *  more is fine. `since` is null for "everything you have". */
  list(window: { since: string | null }): Promise<ListResult>;
}
```

`ExtensionSourceDeps` (`getToken`) and the `getIdentity` export are unchanged.

**What an extension promises**, and nothing else:
1. **Stable keys.** A key is immutable and comes from the item. The same item gets the same key on every call.
2. **Self-contained thread keys.** A thread key is computable from that one item, with no lookup across other items, so items can arrive in any order and still group correctly.
3. **Completeness of the window.** `list` returns every item that changed at or after `since`. A superset is fine.

It keeps no cursor, does no paging between calls, and holds no memory across calls.

Where sources get these keys, for the generator prompt and for authors:

| Source | Item key | Thread key | Avoid |
|---|---|---|---|
| Gmail API | message `id` | `threadId` | |
| Gmail over IMAP | `X-GM-MSGID` | `X-GM-THRID` | IMAP UIDs (per folder, reset) |
| Microsoft Graph | `internetMessageId`, or immutable ids | `conversationId` | the default `id` (changes when a message moves folder) |
| Plain IMAP | `Message-ID` header | first id in `References`, else `In-Reply-To`, else its own Message-ID | IMAP UIDs; for a missing Message-ID, a hash of sender, date and subject |
| Slack | channel + `ts` | `thread_ts` | |
| Teams | message `id` | parent message id | |
| GitHub / Jira / Zendesk | comment id, or the issue/ticket id | the issue/ticket | |
| WhatsApp / SMS | provider message id | the contact / phone pair | |
| Ledgers (Xero, QuickBooks) | invoice id | none | use the last-updated time as `version` |

**Checks Jidoka runs on every returned item.** An item that fails a check is treated as a failure (section 4), exactly like one the extension reported:
- `key` is a non-empty string of at most 512 characters.
- `occurredAt` parses as a date.
- `title` is non-empty after trimming.
- A known key comes back with the same `threadKey` it was first seen with.
- One list does not return the same key twice with different content.

Participants keep the roster's existing validation (`sanitizeParticipants` in the poller): malformed entries are dropped with a warning and never fail the item.

## 2. The item record and the poll loop

### Data model

`src/db/migrations.ts` appends:

```sql
CREATE TABLE IF NOT EXISTS source_items (
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  thread_key TEXT,
  version TEXT,
  occurred_at TEXT,
  title TEXT,
  body TEXT,
  url TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  participants TEXT NOT NULL DEFAULT '[]',
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL,             -- 'ingested' | 'failed' | 'dismissed'
  error TEXT,
  failed_window TEXT,               -- the `since` of the list that produced the failure
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, key)
)
CREATE INDEX IF NOT EXISTS source_items_thread ON source_items (source_id, thread_key)
CREATE INDEX IF NOT EXISTS source_items_task ON source_items (task_id)

CREATE TABLE IF NOT EXISTS source_polls (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'poll' | 'retry' | 'rescan'
  since TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,                     -- 'ok' | 'error'
  error TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  new INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  unkeyed_failures TEXT NOT NULL DEFAULT '[]'
)
CREATE INDEX IF NOT EXISTS source_polls_source ON source_polls (source_id, started_at)

CREATE TABLE IF NOT EXISTS source_horizons (
  source_id TEXT PRIMARY KEY,
  horizon TEXT NOT NULL             -- the first poll's `since`; Rescan never lists earlier
)
DROP TABLE IF EXISTS source_state
DROP TABLE IF EXISTS merged_source_items
```

Failure rows store the error but no content; ingested rows store the item's content so Jidoka can rebuild a thread's task (section 3). SQL lives in `src/repo/sourceItems.ts` and `src/repo/sourcePolls.ts`.

### One poll of one source

`src/sources/poller.ts` keeps the interval loop, the dynamic-source loading and the single-flight guard; `pollOnce` is rewritten:

1. **Pick the window.**
   - If the source has a horizon: `since` = start time of its last poll with `kind = 'poll'` and `outcome = 'ok'` minus **5 minutes**. Retries and rescans never move the window. If no poll has succeeded since the horizon was recorded, `since` = the horizon.
   - First-ever poll: `since` = now minus **7 days**; record it as the source's horizon.
2. **Record the poll** as a `source_polls` row with `kind = 'poll'`, `started_at = now`.
3. **Call `list({ since })`** with a **60-second timeout**. If it throws or times out: mark the poll `outcome = 'error'` with the message and stop. The window is unchanged, so the next poll covers the same range. One console line per failed poll, never more.
4. **File each item** (section 3), one SQLite transaction per item covering its `source_items` row, its task change and its participants. Per item:
   - fails a check: record a failure (section 4);
   - new key: route to its thread's task, or create a task;
   - known key, same `version` (or both absent): update `last_seen_at`, nothing else;
   - known key, different `version`: update the row's content and the task (section 3);
   - known key with `status = 'failed'` or `'dismissed'`: file it as new and set `status = 'ingested'`, clearing the error.
5. **Record failures** from `ListResult.failures` (section 4).
6. **Finish the poll:** counts, `finished_at`, `outcome = 'ok'`.

Orchestrator callbacks (`onTaskIngested`, the change flow) run after the item's transaction commits, as today.

**Guarantee.** Items are delivered at least once by re-listing and filed exactly once by key. A crash mid-poll leaves the poll without `outcome = 'ok'`, so the next poll re-lists the same window and every already-filed key is skipped.

## 3. Threads into tasks

**Routing a new key.**
- `externalId` of a new task is the item's `threadKey`, or its `key` when it has none. `(source_id, external_id)` stays unique on `tasks`.
- A new key whose `threadKey` matches another row of the same source with a `task_id` joins that task. Otherwise it creates a task.
- `source_items.task_id` is the routing truth. `mergeTasks` repoints the duplicate's rows (`UPDATE source_items SET task_id = target WHERE task_id = duplicate`) before deleting it, so a later reply on a merged-away conversation lands on the surviving task. `merged_source_items` and the poller's `wasMerged` check are removed.

**Building task content** from the task's ingested rows, ordered by `occurred_at`:
- **Title:** the first item's title.
- **Body:** every item in order, each preceded by a line `— <from name or address> · <occurredAt, local date and time> —` when the item has a `from` participant, or `— <occurredAt> —` otherwise; items separated by a blank line.
- **URL, metadata:** the newest item's.
- **Participants:** every item's participants, through the roster's `upsertSourceParticipants`.

A single-item task is built the same way.

**Changes.** A new item joining an existing task, or a known item with a new `version`, is a change to that task:
- The task's title, body, url and metadata are rebuilt and saved straight away, whatever the task's state.
- If the task is in a reopenable state (`done`, `assigned_ai`, `assigned_human`, `dismissed`), the existing change flow runs: relevance check, archiving the previous pass into `context.thread`, re-running the rule; `dismissed` re-triages, as today.
- If the task is `processing` or pre-triage (`ingested`, `needs_type_confirmation`, `needs_onboarding`, `needs_dedup_confirmation`), `context.pendingChange` is set to the change's new item keys. When the rule run or triage finishes and leaves the task in a reopenable state, the orchestrator runs the change flow once for those keys and clears the flag. A reply is never lost as a follow-up.

`onTaskChanged(deps, task, change)` takes `{ newItems: SourceItem[] }` instead of a `RawItem`. `assessReopenRelevance` judges the new items. `RawItem.revision`, `context.revision`, the poller's `REOPENABLE_STATES` revision comparison and `NewTask.revision` are removed.

## 4. Failures, Retry, Dismiss, Rescan

**Recording failures.**
- **Keyed** (from `ListResult.failures` with a key, or a failed check): upsert the `source_items` row with `status = 'failed'`, the error, `failed_window = this poll's since`, `last_seen_at = now`. A row already `ingested` is not downgraded; the failure goes into the poll's `unkeyed_failures` list instead, with its key in the message.
- **Unkeyed:** appended to the poll's `unkeyed_failures`.
- Never retried automatically. The poll still finishes `ok`, so the window moves on and other items keep flowing. Failures count towards the poll's `failed`.

**Retry** (one failed key): runs a `kind = 'retry'` poll with `since = failed_window`. Filing is the same as a normal poll, so the failed key recovers if the extension now builds it, and anything else in that window that was missing is filed too.

**Dismiss** (one failed key): `status = 'dismissed'`. It stays in history, stops being flagged and counted. If the key later comes back as a valid item it is filed as new.

**Rescan** (whole source): a `kind = 'rescan'` poll with `since` = the source's horizon. Unseen keys are filed; the result reports how many were recovered ("Recovered N items not seen before"). Rescan does not move the window: it is not used for picking a normal poll's `since`.

## 5. API and UI

`src/api/extensions.ts` gains:

```
GET  /api/extensions/:id/polls            recent source_polls, newest first (50)
GET  /api/extensions/:id/failures         source_items with status 'failed'
POST /api/extensions/:id/failures/:key/retry
POST /api/extensions/:id/failures/:key/dismiss
POST /api/extensions/:id/rescan           → { recovered: number, poll }
POST /api/extensions/:id/test-poll        list({ since: null }) preview; writes nothing
```

`test-poll`'s response becomes `{ items, failures, checkFailures }`, each item showing its key and thread key. `GET /api/extensions` adds per extension: `lastPoll` (outcome, finished_at, counts, error) and `failedCount`.

**Extension card** (visual design via a Claude Design handoff, as the roster did):
- A status line: "Polled 2 min ago · 3 new · 1 changed · 1 failed", or the last poll's error.
- Failures: key, error, when; Retry and Dismiss per row. Unkeyed failures from recent polls show their error alone.
- Poll history: collapsible list of polls, retries and rescans with counts.
- A Rescan button.
- The Test preview shows key and thread key per item and lists failures and check failures.
- The Extensions rail item shows a badge with the total failed count across extensions.

## 6. Generator

`src/extensions/generator.ts`:
- The system prompt teaches `createSource(deps) → { list({ since }) }` returning `ListResult`, the `SourceItem` fields, the three promises in section 1, the key table, and the rules "never use IMAP UIDs or mailbox positions as keys", "never invent a fallback key", "report items you couldn't build in `failures`, never drop them", "keep no cursor; filter by `since`".
- `getIdentity` and participants guidance stay as they are.
- The shape check requires `createSource(deps).list` to be a function and no longer accepts `poll`. It still does not call the network.

## 7. Removals

- `poll`, `PollResult`, `RawItem`, `RawItem.revision`, `NewTask.revision`, the cursor repo (`src/repo/sourceState.ts`), `merged_source_items` and its repo, the cursor-based poller loop.
- The built-in sample-folder source (`src/sources/sample/`), `sampleDir` in `Config`, `Settings`, the settings API and the Settings screen, `JIDOKA_SAMPLE_DIR`, `tests/sources/sampleFolder.test.ts`, and the sample wiring in `src/main.ts`. The `samples/` data folder stays for a future sample-data extension.
- `extensions/youtube-channel-feed` (tracked) is deleted. The untracked `extensions/github-issues-test` and `extensions/imap-inbox-tasks` are deleted locally, with their DB rows, credentials and cursors cleared through the existing delete route.
- Existing tasks from removed sources stay on the board unchanged.
- `CLAUDE.md` and `README.md` replace sample mode with "add a task from the board, or install an extension"; backlog item 9 (first-run setup) notes the coming sample-data extension. The backlog's extension-system items "Poll failures are console-only" and "no per-poll timeout" are removed as shipped.

## 8. Error handling

| Failure | Handling |
|---|---|
| `list` throws or exceeds 60 s | Poll `outcome = 'error'`, window held, card shows the error, one console line |
| Item fails a check, or the extension reports it | `failed` row (or unkeyed entry), shown, retried only on Retry |
| Jidoka fails while filing an item | That item's transaction rolls back; the poll ends `error`; the next poll re-lists and skips filed keys |
| Triage or a rule fails after filing | Unchanged: the task exists and shows its failed state |
| A known key returns with a different thread key | Check failure; the existing task is untouched |

## 9. Testing

In-memory DB, fake `list` sources, no network:
- **Poll loop:** first poll uses the 7-day lookback and records the horizon; later windows are last ok start minus 5 minutes; an outage holds the window; a timeout is an outage; a crash between items then a re-poll creates no duplicates.
- **Filing:** new key creates a task; known key with same version is skipped; new version updates the task; a failed key that returns is recovered.
- **Threads:** items group by thread key in any arrival order; title and body are built in `occurred_at` order; a reply during `processing` sets `pendingChange` and the change flow runs once processing finishes; a merge repoints rows and a later reply lands on the surviving task.
- **Failures:** keyed and unkeyed failures are recorded without retry; an ingested row is never downgraded; Retry lists from `failed_window`; Dismiss clears the flag; one bad item doesn't block others.
- **Checks:** empty key, bad date, empty title, changed thread key, duplicate key with different content.
- **Rescan:** lists from the horizon, files only unseen keys, reports the count, doesn't move the window.
- **API:** polls, failures, retry, dismiss, rescan, test-poll preview.
- **Generator:** shape check accepts `list`, rejects `poll`; the prompt includes the key rules.
- **Removal:** `createApp` and the smoke test start without `sampleDir`; settings without `sampleDir` validate.

**Live check:** regenerate the IMAP extension with the new prompt against GreenMail. Send Bob → you, a reply, and a vendor email; restart GreenMail and send another. Expected: one task per conversation, the reply joining its task, nothing lost across the restart, and any extension failure visible on the card with Retry working once fixed.
