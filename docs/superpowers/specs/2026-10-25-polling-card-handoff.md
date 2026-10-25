> Note: the README that Claude Design returns will be appended below this brief.

## Brief for Claude Design (paste this)

Pull the latest `NandavardhanRadhakrishnan/Jidoka` @ `feat/reliable-polling` from GitHub first (not `main`: this branch holds the roster and the new polling backend). The API shapes below match that branch. Then design the **extension card** for the Extensions screen (`src/client/Extensions.tsx`, the `.ext-row` list). Use the existing screen as the baseline and extend it; don't redesign the connect, activate, disable, disconnect, delete or "Describe a source you don't have" parts.

### The feature

Extensions poll external systems (IMAP, GitHub, ...) for new items. Polling is becoming reliable: every poll is recorded, an item that fails to build is kept as a **failure** instead of being lost, and the user can retry, dismiss, or rescan. The card must make three things visible at a glance: whether polling is healthy, what failed, and what the recent polls did. It must also show the extension author (and the user, before installing) exactly what a Test poll would produce.

This replaces today's Test result (`✓ N item(s) found`), and the per-card state is otherwise unchanged (status, summary, read-only/can-write, Connect/Activate/Test/Disable/Disconnect/Delete).

### Card elements

1. **Status line** (one line under the summary, mono). Exactly one of:
   - `Polled 2 min ago · 3 new · 1 changed · 1 failed`. Counts other than `new` are left out when zero; `new` always shows (`0 new`).
   - `Never polled`.
   - `Last poll failed 2 min ago: <error>`. This is the error state: the whole poll errored (not just some items). Use the accent tone for it; long errors truncate to one line with the full text on hover, and wrap fully inside the expanded view.
   The line reflects the last regular poll only (not retries or rescans).
2. **Failures list.** Appears only when `failedCount > 0`. A heading with a count (like `h6` plus mono count), then one row per failure:
   - **Key**, mono, truncated in the middle or at the end with an ellipsis. Real keys are long Message-IDs, e.g. `<75c1a1ab-0c7b-49cd-bf1c-0bdc54f804b2@acme.test>`. The full key shows on hover (`title`) and there's a small copy affordance (copy to clipboard, with a brief "Copied" state).
   - **Error**, wrapping, `error-text` tone.
   - **When**, relative ("2 min ago"), from `lastSeenAt`.
   - **Retry** and **Dismiss** buttons per row (small; Dismiss is the quieter ghost). While a retry runs, that row shows a busy state and both buttons are disabled. A retry that still fails leaves the row with its fresh error; a retry that succeeds removes the row. Dismiss removes the row.
   - **Unkeyed failures:** the most recent regular poll can report failures with no key (the extension couldn't even read the id). They show in the same list as rows with the error alone: no key, no Retry, no Dismiss, a muted "no key" label, and "from the last poll" as the when. They disappear when a newer poll no longer reports them.
3. **Poll history.** A collapsible section, collapsed by default, with a toggle that reads e.g. `History · 12 polls` and a chevron. Each entry is one row, newest first, up to 50:
   - **Kind** badge: `poll`, `retry` or `rescan`.
   - **When** (relative, absolute on hover).
   - **Since** window (mono, e.g. `since 14:02`, `since 7 days ago` for a first poll, `no window` when null).
   - **Counts:** `seen`, `new`, `changed`, `failed` (omit zeros except `new`), as compact mono text.
   - **Outcome:** ok or error; on error, show the error text. A poll still running (no `finishedAt`) shows `running`.
4. **Rescan button.** On the card (not the screen-level "Rescan" button in the top right, which rescans the extensions folder for new extensions; keep that one, but label the new per-card one clearly, e.g. `Rescan source`, so the two aren't confused). It re-lists from the start of the source's history and files anything not seen before. Busy state while running. The result appears inline after it finishes, and stays until the next action:
   - `Recovered 4 items not seen before` (singular: `Recovered 1 item not seen before`)
   - `Nothing new found`
   - On failure, an `error-text` message.
   Show Rescan source only for a connected extension.
5. **Test preview** (replaces the `✓ N item(s) found` line). Appears after pressing Test, before or after install, and writes nothing. Show:
   - A summary: `N items · M failures · K check failures`.
   - **Items:** a compact list (cap the visible rows, e.g. 5, with `+N more`): title, then `key` and `thread key` as two mono lines, each truncated with the full value on hover. An item without a `threadKey` shows `no thread` (it becomes a task on its own).
   - **Failures** (from the extension's own `list`) and **Check failures** (the item shape was invalid, or a key appeared twice with different content), each as a small labelled group of `key?` + error rows. These are previews: no Retry or Dismiss.
   - If the Test call itself errors, keep today's behavior: the `✗` error text with the existing **Fix** ghost button.
   - A dismiss/clear control for the preview.
6. **Rail badge.** The Extensions rail item in `App.tsx` shows a numeric badge with the **total `failedCount` across all extensions**, hidden at 0, capped visually at `99+`. It must read clearly on both the resting and the active (`.on`) rail item, and not shift the label or icon. Accessible name: `Extensions, N failed`.

### States to design

- **Healthy:** polled recently, no failures. No failures section at all (not an empty box), history collapsed.
- **Never polled:** just activated or never enabled. Status line `Never polled`; no history toggle (or a disabled `History · none`); Rescan source available only once connected.
- **Failures present:** the failures list and its count; the card's tone bar uses the accent tone while any failure exists (today the tone bar is accent only for `needs_reauth`, neutral-800 when connected and enabled, neutral-500 otherwise; propose how failures and a failed last poll fit that).
- **Last poll failed:** the error status line, plus whatever failures remain.
- **Busy:** Retry, Rescan source and Test each in progress.
- **Not connected / disabled / invalid:** the status line and sections hide when there is nothing to show (the polls, failures, rescan and test routes answer 400 for a source that isn't connected, so the client must not call them for one). Show only the status line from the list payload (`lastPoll`) and `Never polled` where it's null.
- **Loading** of the failures and history (fetched when the card is expanded or on mount; say which) and a **load error**.

### Prototype data (use these three extensions)

1. **`imap-work`, healthy.** Name `IMAP (work mailbox)`, connected and enabled, can write false. Last poll 2 min ago: `3 new`, 0 changed, 0 failed. History of about 6 entries: regular polls every 5 minutes, one `rescan` (recovered 0), one `retry` from earlier that recovered an item. No failures.
2. **`imap-support`, two failures and a failed last poll.** Connected and enabled. Last poll 2 min ago, outcome `error`, error `IMAP: connection reset by peer`. Two failures:
   - keyed: key `<75c1a1ab-0c7b-49cd-bf1c-0bdc54f804b2@acme.test>`, error `body is not valid UTF-8`, last seen 12 min ago
   - unkeyed: no key, error `message has no Message-ID header`, from the last poll that succeeded 17 min ago
   History includes a failed poll, an ok poll with `5 new · 2 failed`, a retry that failed again, and a rescan that recovered 4.
3. **`github-issues`, never polled.** Connected, not yet activated. `lastPoll` is null, no history, no failures.

Also show the Test preview open on `imap-work` with 3 items (two of them in one thread), one failure and one check failure.

### Exact API shapes

`GET /api/extensions` → `{ extensions: ExtensionListItem[] }`; each gains:

```ts
lastPoll: PollRecord | null;   // last regular poll only (kind = 'poll')
failedCount: number;           // source_items with status 'failed'

interface PollRecord {
  id: string;
  sourceId: string;
  kind: "poll" | "retry" | "rescan";
  since: string | null;          // ISO-8601 UTC, the window start
  startedAt: string;             // ISO-8601 UTC
  finishedAt: string | null;     // null while running
  outcome: "ok" | "error" | null;
  error: string | null;          // set when outcome is "error"
  seen: number;
  new: number;
  changed: number;
  failed: number;
  unkeyedFailures: { key?: string; error: string }[];
}
```

Routes (all 400 `{ error }` when the extension isn't connected, 404 for an unknown one):

```
GET  /api/extensions/:id/polls                      → { polls: PollRecord[] }          newest first, up to 50
GET  /api/extensions/:id/failures                   → { failures: SourceItemRow[] }    status 'failed' only, newest first
POST /api/extensions/:id/failures/:key/retry        → { poll: PollRecord }             :key is URL-encoded; 404 if no failed item has that key
POST /api/extensions/:id/failures/:key/dismiss      → { dismissed: true }
POST /api/extensions/:id/rescan                     → { recovered: number, poll: PollRecord }
POST /api/extensions/:id/test-poll                  → { items, failures, checkFailures }
```

```ts
interface SourceItemRow {          // failures carry only these fields filled in
  sourceId: string;
  key: string;
  status: "failed";                // 'ingested' | 'dismissed' never come back here
  error: string | null;
  failedWindow: string | null;     // the since of the poll that failed; Retry re-lists from here
  firstSeenAt: string;
  lastSeenAt: string;              // use this for "when"
  // threadKey, version, occurredAt, title, body, url, metadata, participants, taskId: all null/empty for a failure
}

// test-poll
{
  items: {
    key: string;                   // immutable id, e.g. a Message-ID
    threadKey?: string;            // items with the same threadKey become one task
    version?: string;
    occurredAt: string;
    title: string;
    body: string;
    url?: string;
    participants?: { identity: string; role: string; name?: string }[];
  }[];
  failures: { key?: string; error: string }[];        // from the extension's own list()
  checkFailures: { key?: string; error: string }[];   // Jidoka's item checks
}
```

Retry on a failure that was dismissed or already recovered returns 404; treat that as "already gone" and drop the row. The unkeyed failures to show come from the last regular poll's `unkeyedFailures` (already in `lastPoll` on the list payload).

### Constraints

- **Modernist design system only.** Use the tokens and classes already in `src/client/modernist.css`; check it before inventing CSS. Archivo at weights 400, 600 and 800 only. All radii are 0. Tokens, never raw hex.
- **Reuse the existing patterns:** the `.ext-row` card with its `tone-bar`, `body`, `head`, `desc`, `meta` and `actions`; `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`; the `.error-text`, `.mono` and `.text-muted` helpers; badges like `.yours-badge` and `.me-badge`; and the existing collapsible/trigger patterns in the app. Say which existing class each element reuses, and list only what is genuinely new.
- **No inline styles in the implementation.** The prototype may use them, but the README must give every new class for `modernist.css`, with its rules.
- **Hover:** row and ghost hovers use `color-mix(in srgb, var(--color-text) 6%, transparent)`, as `.type-row` and `.pane-row` do, not ramp tokens.
- **No "open in a new tab or window" affordances** (including `target="_blank"` links, "pop out" buttons): the client will move to a Tauri desktop shell. Copy-to-clipboard is fine.
- Single user, no auth. Keep it keyboard-operable: toggles and per-row buttons are real `<button>`s with visible focus, and the badge and status line carry accessible text.
- Must hold up at the screen's current width (`max-width: 980px`) and narrower: long keys and errors truncate or wrap, never overflow the card.

### Output

Produce a handoff package (`design_handoff_polling_card/`, README.md + prototype) in the same format as `design_handoff_roster/`: Overview, Fidelity, Concepts, a numbered Behavior spec by file (`Extensions.tsx`, `App.tsx` for the rail badge, `api.ts`), States the client must handle, the new classes for `src/client/modernist.css`, Acceptance checks, and Assets. The README must also contain:

- **Repo files to change**, each with what changes: `src/client/Extensions.tsx`, `src/client/App.tsx`, `src/client/api.ts`, `src/client/modernist.css`, and a new pure-helper module `src/client/pollStatus.ts` for the status line and rescan message (`pollSummary(poll, now)` and `rescanMessage(recovered)`, returning exactly the strings above).
- **Acceptance checks**: numbered, each verifiable in the browser against the three prototype extensions (status line forms, zero-count omission, truncation with full key on hover, copy, Retry and Dismiss outcomes, unkeyed rows, collapsed-by-default history, Rescan messages in singular, plural and zero, the Test preview, the rail badge total and its hidden-at-zero case).
- **New Lucide icons** needed (names), in addition to those already in `src/client/icons`; say which existing icons you reuse.

## Returned handoff (design_handoff_polling_card/README.md)

### Handoff: Extension card, reliable polling

#### Overview
Extends each card on the Extensions screen (`.ext-row` in `src/client/Extensions.tsx`) so it shows, at a glance:
- whether polling is healthy (a **status line**),
- what failed (a **Failures** list with Retry, Dismiss and copy-key),
- what recent polls did (a collapsible **History**),
- and, after **Test**, exactly what a poll would produce (a **Test poll preview**, which replaces `✓ N item(s) found`).

It also adds a per-card **Rescan source** action and a failure-count **badge** on the Extensions rail item.

Connect, Activate, Disable, Disconnect, Delete, the top-right folder **Rescan** and "Describe a source you don't have" are unchanged.

Repo: `NandavardhanRadhakrishnan/Jidoka` @ `feat/reliable-polling`. The API shapes are the ones on that branch (see §3 `api.ts`).

#### About the design files
`Jidoka.dc.html` is a **design reference built in HTML**, not production code. Rebuild it in `src/client/` with the repo's patterns: `modernist.css` classes, `api.ts`, `Icon`. The prototype uses inline styles because of how it's built. **The implementation must use classes only, with no inline `style`**; the new classes are in §6.

Open `Jidoka.dc.html` next to `support.js` (both are in this folder). It loads the Modernist stylesheet from `../_ds/`. Outside the design project, link the repo's `src/client/modernist.css` instead; it uses the same tokens. It contains the rail and the Extensions screen only.

Prototype tweaks:
- **latency** (ms): how long each simulated request takes, so busy states are visible.
- **loadState**: `live`, `loading` or `error`. Forces the per-card failures and history fetches into that state.
- **moreStates**: adds two cards beyond the brief's three: `outlook-personal` (not connected, with a `lastPoll` from 3 days ago) and `zendesk-views` (invalid manifest, never polled).

#### Fidelity
High fidelity. Use the tokens already in `modernist.css`:
- Archivo at 400, 600 and 800 only, plus the existing `.mono` class (system monospace) for keys, counts, windows and badges.
- All radii are 0.
- Row hovers and quiet ghost hovers use `color-mix(in srgb, var(--color-text) 6%, transparent)`, as `.type-row` and `.pane-row` do.
- Paragraph-size accent text uses `--color-accent-700` (`.error-text`), never `--color-accent`.

#### Concepts (as the UI presents them)
- **Poll**: one run of an extension's `list()` against a window. Every run is recorded as a `PollRecord`. Kinds:
  - `poll`: the regular scheduled run. Only these drive the status line.
  - `retry`: re-lists one failed item's window (`failedWindow`).
  - `rescan`: re-lists from the start of the source's history and files anything not seen before.
- **Window** (`since`): where a poll started listing from. A whole-poll error doesn't advance it, so after a failed poll the next one re-lists the same window.
- **Failure**: an item the extension listed but Jidoka couldn't build. It's kept as a `source_items` row with status `failed` and can be retried or dismissed.
- **Unkeyed failure**: the extension couldn't read the item's id at all, so there's nothing to store, retry or dismiss. It's reported on the poll record only, in `unkeyedFailures`.
- **Test poll**: runs `list()` once and writes nothing. It returns the items it would file, the extension's own failures, and **check failures** (Jidoka's item checks: invalid shape, or one key with two different contents).

#### Card anatomy (top to bottom) and the class each part reuses
| Part | Reuses | New |
|---|---|---|
| Tone bar | `.ext-row .tone-bar` | `.tone-on` / `.tone-off` / `.tone-warn` modifiers replace the inline `background` |
| Head (icon, name, status) | `.ext-row .head`, `.name`, `.status` | status colour takes the same tone modifier |
| Summary | `.ext-row .desc` | none |
| **Status line** | `.mono` | `.poll-status` (+ `.is-error`, `.wrap`) |
| **Rescan result** | `.mono`, `.error-text` | `.poll-note` |
| Invalid error, Connect, test error + **Fix** | unchanged | none |
| read-only / can write | `.ext-row .meta` | none |
| **Failures** | `.drawer-section-head` (h6 + `.count`), `.out-list`, `.btn-secondary.btn-sm`, `.btn-ghost.btn-sm`, `.error-text` | `.failure-row`, `.key-trunc`, `.icon-btn`, `.btn-quiet`, `.poll-loading`, `.poll-load-error` |
| **Test poll preview** | `h6`, `.error-text`, `.icon-btn` | `.test-preview`, `.test-group`, `.test-item`, `.test-kv` |
| **History** | toggle modelled on `.trace-toggle`; list in `.out-list`; badge metrics from `.yours-badge` | `.poll-history`, `.poll-toggle`, `.poll-row`, `.poll-kind` |
| Actions | `.ext-row .actions`, `.btn-*`, `--shadow-md` | `.ext-more`, `.ext-menu`; narrow layout via container query |

#### Behavior spec

##### 1. `src/client/Extensions.tsx`

**1.1 Structure.** Move each card's polling UI into a component in the same file, `ExtensionPolling({ ext, now, onListChanged })`, so per-card state (polls, failures, load states, busy flags, history open, rescan note, test result) lives with its card instead of in more `Record<id, …>` maps. `Extensions` keeps the list, connect flow, generation and Delete.

**1.2 List refresh.** `refresh()` today also resets `connectingId`, `device` and `apiKeyValue`. Add `reloadList()`, which only re-fetches `api.extensions()`. Use it after Retry, Dismiss and Rescan source so a connect in progress on another card isn't cancelled. Also call `reloadList()` every 30 s while the screen is mounted, and tick a `now` value every 30 s so relative times stay current.

**1.3 When to fetch.** Fetch on mount, not on expand. The History toggle shows a count, and unkeyed failures need the poll history, so both must be loaded before the user opens anything. For each card:
- **Connected** (`status === "connected"`, enabled or not): `GET /polls`. Also `GET /failures` when `failedCount > 0`.
- **Anything else** (not connected, needs reauth, invalid, unknown): call nothing. Those routes answer 400. Show only the status line from `lastPoll`.
- Re-fetch a card's polls and failures when its `lastPoll.id` changes on a list reload, and after Retry, Dismiss or Rescan source on it.

**1.4 Tone.** Keep `toneOf` for the head's status text. The tone bar uses a new `barTone(ext, unkeyedShown)`:
1. `needs_reauth` → `tone-warn` (accent), as today.
2. Connected and any of `failedCount > 0`, an unkeyed failure shown, or `lastPoll.outcome === "error"` → `tone-warn`.
3. Connected and enabled → `tone-on` (`neutral-800`).
4. Otherwise → `tone-off` (`neutral-500`).
A not-connected card never goes accent for failures, because nothing on it can act on them.

**1.5 Status line** (`.poll-status`, one line, directly under `.desc`). Text is `pollSummary(ext.lastPoll, now)` from `pollStatus.ts`:
- `Polled 2 min ago · 3 new · 1 changed · 1 failed`. `changed` and `failed` are left out at 0. `new` always shows (`0 new`).
- `Never polled` when `lastPoll` is null.
- `Last poll failed 2 min ago: <error>` when `lastPoll.outcome === "error"`. Add `.is-error` (`accent-700`).
- Edge case outside the brief's three forms: if the server ever returns a regular poll with no `finishedAt`, show `Polling now…`.
- Relative time is measured from `finishedAt`.
- One line with ellipsis; `title` holds the full text. While History is open the line gets `.wrap` and shows the whole error.
- Accessible name: `aria-label="Polling status: <text>"`. It's not a live region, so it isn't announced on every refresh.
- It reflects `lastPoll` only. Retries and rescans never change it.

**1.6 Rescan result** (`.poll-note`, directly under the status line):
- Success: `rescanMessage(recovered)`, which returns `Recovered 4 items not seen before`, `Recovered 1 item not seen before` or `Nothing new found`.
- Failure: `.error-text`, `Rescan failed: <server error>`.
- Use `role="status"` so the result is announced.
- It stays until the next action on that card: Test, Rescan source, Retry, Dismiss, Activate, Disable or Disconnect.

**1.7 Failures** (`<section aria-label="Failures">`, shown only for a connected card with `failedCount > 0` or at least one unkeyed failure to show; never an empty box):
- Head: `.drawer-section-head` with `h6` "Failures" and a mono `.count` that counts the rows shown (keyed plus unkeyed). The count is blank while loading.
- Container: `.out-list`. Rows: `.failure-row`, keyed rows first (server order, newest first), then unkeyed.
- **Keyed row**, line 1 (`.line`, wraps when narrow):
  - The key in `.key-trunc`, truncated in the middle: `.head` is everything but the last 14 characters, with an ellipsis; `.tail` is the last 14 characters and never shrinks. So `<75c1a1ab-0c7b-…f804b2@acme.test>` keeps its domain visible. Keys of 26 characters or fewer aren't split. `title` holds the full key.
  - Copy (`.icon-btn`, `copy` icon, `aria-label="Copy key <key>"`) writes the full key to the clipboard. For 1.5 s it shows `check` plus "Copied", and its label becomes "Key copied".
  - When (`.when`): `relTime(lastSeenAt, now)`, with `title` holding the absolute time.
  - `[Retry]` (`.btn.btn-secondary.btn-sm`) and `[Dismiss]` (`.btn.btn-ghost.btn-quiet.btn-sm`).
- **Keyed row**, line 2: the error as `.error-text`, wrapping (`overflow-wrap: anywhere`).
- **Retry** calls `POST /failures/:key/retry`, with the key URL-encoded.
  - While it runs: `aria-busy="true"` on the row, both buttons disabled, Retry reads "Retrying…", and the when cell reads "retrying…".
  - Response `poll.failed > 0`: re-fetch failures. The row stays, with its fresh error and `lastSeenAt`.
  - Response `poll.failed === 0`: the row goes.
  - 404: treat it as already gone and drop the row silently.
  - Other errors: keep the row and show the message as `.error-text` on line 2 until the next action.
  - Afterwards, re-fetch polls (a `retry` entry is added) and call `reloadList()` (so `failedCount` and the rail badge update).
- **Dismiss** calls `POST /failures/:key/dismiss`. Same busy treatment ("Dismissing…"). On success, or on a 404, remove the row and call `reloadList()`.
- **Unkeyed row**: `.no-key` "no key" in place of the key, no copy, no buttons. The when cell reads "from the last poll", with `title` holding that poll's absolute `finishedAt`. Error on line 2.
- **Which unkeyed failures to show.** The brief says to use `lastPoll.unkeyedFailures`, but its sample data shows them coming from an earlier successful poll while `lastPoll` itself errored. A poll that errors as a whole lists nothing, so it can't say the unkeyed items have gone. Rule, in `unkeyedToShow(lastPoll, polls)`:
  - If `lastPoll.outcome === "ok"`, use its `unkeyedFailures`.
  - Otherwise use the newest `kind === "poll"` record with `outcome === "ok"` from `GET /polls`.
  - Show only entries without a `key`. Entries that have a key are already in the keyed list.
  - They disappear when a newer successful regular poll stops reporting them.
- **Loading**: one `.poll-loading` row, "Loading failures…" (`role="status"`).
- **Load error**: a `.poll-load-error` row with `.error-text` "Couldn't load failures: <message>" and `[Try again]` (`.btn-ghost.btn-quiet.btn-sm`).

**1.8 Test** (a `⋯` menu item for connected cards; see 1.11).
- While it runs: "Testing…", disabled, `aria-busy`. The previous preview and the rescan note are cleared.
- On error: keep today's `<p className="error-text">✗ {error}</p>` and the **Fix** ghost button, in the same place (before `.meta`). `fix()` reads the error from the new test-result state.
- On success: render `.test-preview` (`<section aria-label="Test poll preview">`) after Failures:
  - **Head** (`.test-preview-head`): `h6` "Test poll"; `.summary`, mono, `N items · M failures · K check failures` (each count pluralised, so `1 failure`); `.note`, "Preview only. Nothing was written."; and a clear button (`.icon-btn`, `x`, `aria-label="Clear test preview"`) at the far right.
  - **Items group** (`.test-group`, only if there are items): the label "Items" plus `.sub` "becomes N tasks" (distinct `threadKey ?? key`). Items are grouped into the tasks they'd become, in first-seen order:
    - Each group is a `.test-task`: a head (`.test-task-head`, 2px divider rule on top) with a `.poll-kind.kind-rescan`-style solid badge `Task 1`, the count `2 items`, then `thread` + the thread key as `.key-trunc` (with `title`), or `no thread · its own task` when the item has no `threadKey`.
    - Under the head, the group's items sit behind a 2px `neutral-300` left rule (`.test-task-items`). Each `.test-item` shows the title and, right-aligned, a mono role: `creates task` on the first item (title at 800) and `adds to task` on the rest (title at 400). Then one `.test-kv` `key` line.
    - Show the first 5 items across all groups. If there are more, `[+N more]` (`.btn-ghost.btn-quiet.btn-sm`) reveals the rest.
  - **Failures group** ("Failures · from the extension's list()") and **Check failures group** ("Check failures · Jidoka's item checks"): only when non-empty. Rows are `.test-fail-row`: `.key-trunc` (or `.no-key`), then `.error-text`. No Retry, no Dismiss, no copy.
- The preview only exists after Test has run. No card opens with one. It stays until ✕ or the next Test, and it lives in component state, so leaving the Extensions screen and coming back clears it.

**1.9 History** (`.poll-history`, shown for a connected card unless the polls loaded and came back empty; for a never-polled source the toggle is omitted entirely, not disabled):
- Toggle: `<button class="poll-toggle" aria-expanded aria-controls>`. It shows `chevron-right` when closed and `chevron-down` (accent) when open, then "History", then a mono `.count`: `· 12 polls` (`· 1 poll`). **Collapsed by default**, and not persisted.
- While loading: `· loading…`, disabled. On a load error: `· couldn't load`, disabled, followed by `[Try again]`.
- Body (`.out-list`, `id` matches `aria-controls`): one `.poll-row` per record, newest first, up to 50:
  - **Kind**: `.poll-kind.kind-poll` (outlined), `.kind-retry` (`neutral-200`) or `.kind-rescan` (solid `neutral-900`).
  - **When**: `relTime(startedAt)`, with `title` holding the absolute time.
  - **Since**: `sinceLabel(poll)`. `since 14:02` when the window starts less than a day before `startedAt`; `since 7 days ago` when it's a day or more (a first poll); `no window` when `since` is null. `title` holds the absolute `since`.
  - **Counts**: `pollCounts(poll)` gives `seen` (left out at 0), `new` (always), and `changed` and `failed` (left out at 0), for example `7 seen · 5 new · 2 failed` or `0 new`.
  - **Outcome**: `ok` (`neutral-700`), `error` (`accent-700`, with the full error as `.error-text` on its own line indented under the counts), or `running` (`neutral-600`) when `finishedAt` is null.

**1.10 Rescan source** (`[Rescan source]`, `.btn-secondary.btn-sm`, first in the actions cluster, for connected cards only):
- The top-right `[Rescan]` (extensions folder) is unchanged. The label "Rescan source" is what tells the two apart.
- While running: "Rescanning…", disabled, `aria-busy`.
- Afterwards: the result as in 1.6. Re-fetch polls (a `rescan` entry is added) and failures, then call `reloadList()`.

**1.11 Actions layout.** One cluster in `.ext-row .actions`, ordered by how often each action is used. Rare or hard-to-undo actions go in a `⋯` menu.
- **Outside, left to right:**
  - **Rescan source** (`.btn-secondary.btn-sm`), always when connected.
  - **Activate** (`.btn-primary.btn-sm`) when connected and not enabled, or **Disable** (`.btn-secondary.btn-sm`) when enabled. They share one slot, so the toggle doesn't move.
  - **More** (`.ext-more`, `ellipsis` icon, `aria-haspopup="menu"`, `aria-expanded`, `aria-label="More actions for <name>"`), always.
- **In the menu** (`.ext-menu`, `role="menu"`, items are `role="menuitem"` `<button>`s):
  - **Test**, always when connected. It reads "Testing…" and is disabled while running. Choosing it closes the menu, and the result appears in the card.
  - **Disconnect**, when connected or `needs_reauth`.
  - A separator, when anything is above it.
  - **Delete**, always, in `accent-700`.
- The menu opens below the button, right-aligned, at `--shadow-md`. It closes on item click, outside click and Escape, and focus returns to the More button. Arrow keys move between items; the first item is focused on open.
- The handlers are today's `disable`, `disconnect` and `remove`, unchanged.
- No tooltips.
- When the list is narrower than 680px (a container query), the cluster drops below the body, left-aligned in the body's column.

**1.12 Not connected / disabled / invalid.**
- Disabled but connected: everything works (the routes accept a connected source). The tone bar follows 1.4.
- Not connected, needs reauth, invalid or unknown: show the status line only, from `lastPoll`, or `Never polled`. No Failures, History, Rescan source, Test or preview, and no requests to those routes.
- Disconnect drops the per-card polling state.

##### 2. `src/client/App.tsx` (rail badge)
- Add `failedTotal` state. In `refresh()`, also call `api.extensions()` and sum `failedCount`. It's local and cheap, and it's already on the 5 s timer.
- Pass `onFailedTotalChange={setFailedTotal}` to `<Extensions />`. Extensions calls it after every `reloadList()`, so the badge updates as soon as a row is retried or dismissed.
- On the Extensions `rail-item`:
  - `aria-label={failedTotal > 0 ? \`Extensions, ${failedTotal} failed\` : "Extensions"}`.
  - Rail open: after the label span (which keeps `flex: 1`), `<span className="badge" aria-hidden="true">{failedTotal > 99 ? "99+" : failedTotal}</span>`.
  - Rail collapsed: the same span with `className="badge corner"`, pinned to the icon's top-right corner, so the icon stays centred.
  - Render nothing at 0.
- The accent badge with `--color-bg` text reads the same on the resting row (transparent), on hover (6% tint) and on `.on` (surface). It's 15px tall against the 17px icon, so the row height doesn't change.

##### 3. `src/client/api.ts`
- Add to `ExtensionListItem`: `lastPoll: PollRecord | null; failedCount: number;`.
- Add the types `PollRecord`, `SourceItemRow`, `PreviewFailure = { key?: string; error: string }`, `TestPollItem` and `TestPollResult = { items: TestPollItem[]; failures: PreviewFailure[]; checkFailures: PreviewFailure[] }`, exactly as on the branch.
- In `json()`, throw `class ApiError extends Error { status: number }` instead of a bare `Error`, so callers can test `e.status === 404`. Existing callers only read `.message`, so nothing else changes.
- New calls:
```ts
polls:          (id) => json<{ polls: PollRecord[] }>(`/api/extensions/${id}/polls`).then(r => r.polls),
failures:       (id) => json<{ failures: SourceItemRow[] }>(`/api/extensions/${id}/failures`).then(r => r.failures),
retryFailure:   (id, key) => json<{ poll: PollRecord }>(`/api/extensions/${id}/failures/${encodeURIComponent(key)}/retry`, { method: "POST" }).then(r => r.poll),
dismissFailure: (id, key) => json<{ dismissed: true }>(`/api/extensions/${id}/failures/${encodeURIComponent(key)}/dismiss`, { method: "POST" }),
rescanSource:   (id) => json<{ recovered: number; poll: PollRecord }>(`/api/extensions/${id}/rescan`, { method: "POST" }),
testPoll:       (id) => json<TestPollResult>(`/api/extensions/${id}/test-poll`, { method: "POST" }),   // shape changed
```
- Name the per-source call `rescanSource` so it isn't confused with `rescanExtensions` (the folder).

##### 4. `src/client/pollStatus.ts` (new, pure, no React)
```ts
relTime(iso: string, now: number): string                 // "just now" | "N min ago" | "N h ago" | "1 day ago" | "N days ago"
pollSummary(poll: PollRecord | null, now: number): string  // §1.5 strings exactly
rescanMessage(recovered: number): string                   // "Nothing new found" | "Recovered 1 item not seen before" | "Recovered N items not seen before"
pollCounts(poll: PollRecord): string                        // §1.9 counts
sinceLabel(poll: PollRecord): string                        // "since 14:02" | "since 7 days ago" | "no window"
splitKey(key: string): [head: string, tail: string]         // middle truncation, tail = last 14 chars, no split ≤ 26
unkeyedToShow(lastPoll: PollRecord | null, polls: PollRecord[] | null): { error: string }[]   // §1.7 rule
```
The prototype's logic class has a working copy of each one under `// ---- pollStatus.ts`. Add `tests/client/pollStatus.test.ts` covering the strings in Acceptance checks 2–4 and 12.

##### 5. States the client must handle
- **Healthy**: the status line, no Failures section, History collapsed.
- **Never polled**: `Never polled`, no History toggle, no Failures. Test and Rescan source only once connected.
- **Failures present**: the Failures list with its count, and an accent tone bar.
- **Last poll failed**: the `.is-error` status line plus whatever failures remain. The tone bar is accent even with no failures.
- **Busy**: Retry and Dismiss per row; Test and Rescan source per card. Each is independent. Two rows can retry at once; a card can test while another rescans.
- **Loading / load error**: for failures (§1.7) and history (§1.9), independently.
- **Not connected / invalid**: the status line only (§1.12).
- **Retry or Dismiss 404**: drop the row without an error.
- **Rail**: hidden at 0, `99+` above 99, correct on `.on`, resting and collapsed items.

#### 6. New and changed classes for `src/client/modernist.css`
Values match the prototype. All radii are 0. "6% hover" means `background: color-mix(in srgb, var(--color-text) 6%, transparent)`.
```
/* — extension card layout (changed) — */
.extension-list                 + container-type: inline-size
.ext-row                        display grid; grid-template-columns 4px minmax(0,1fr) auto; column-gap 16px; row-gap 12px;
                                align-items start (replaces flex + gap 16px; padding and borders unchanged)
.ext-row .actions               unchanged (flex, gap 8px, wrap); + justify-self end
.ext-more                       position relative; display flex; align-self stretch
.ext-more > button              grid; place-items center; width 32px; min-height 32px; border 0; transparent; color neutral-700; cursor pointer;
                                svg 17px, stroke-width 3; :hover and [aria-expanded="true"] 6% hover + color text
.ext-menu                       position absolute; top calc(100% + 4px); right 0; z-index 5; min-width 160px; flex column;
                                surface bg; 1px divider border; box-shadow var(--shadow-md); padding 4px 0
.ext-menu [role="menuitem"]     flex; text-align left; border 0; transparent; padding 8px 12px; 13px; color text; cursor pointer;
                                :hover and :focus-visible 6% hover; :disabled 45% opacity
.ext-menu .danger               color accent-700
.ext-menu [role="separator"]    height 1px; divider bg; margin 4px 0
@container (max-width: 680px)   .ext-row { grid-template-columns: 4px minmax(0,1fr) }
                                .ext-row .tone-bar { grid-row: 1 / span 2 }
                                .ext-row .actions { grid-column: 2; justify-self: start }
.ext-row .tone-bar.tone-on      background neutral-800     .ext-row .status.tone-on   color neutral-800
.ext-row .tone-bar.tone-off     background neutral-500     .ext-row .status.tone-off  color neutral-500
.ext-row .tone-bar.tone-warn    background accent          .ext-row .status.tone-warn color accent

/* — status line + rescan note — */
.poll-status                    mono 11.5px/1.45; color neutral-700; min-width 0; overflow hidden; text-overflow ellipsis; white-space nowrap
.poll-status.is-error           color accent-700
.poll-status.wrap               white-space normal; overflow-wrap anywhere
.poll-note                      mono 11.5px; color text   (failure variant: .error-text, no .poll-note)

/* — shared small controls — */
.btn-quiet                      modifier for .btn-ghost: color neutral-700; :hover:not(:disabled) 6% hover; :active:not(:disabled) text 12% mix
.icon-btn                       inline-flex; align center; justify center; gap 3px; height 22px; min-width 22px; padding 0 4px;
                                border 0; transparent; color neutral-600; mono 10.5px; cursor pointer; flex none
                                svg 13px; :hover 6% hover + color text
.key-trunc                      mono 11px; display flex; min-width 0; overflow hidden
.key-trunc .head                overflow hidden; text-overflow ellipsis; white-space nowrap
.key-trunc .tail                flex none; white-space nowrap
.no-key                         mono 11px; color neutral-600

/* — failures — */
.poll-section                   flex column; gap 6px; margin-top 8px   (head reuses .drawer-section-head, list reuses .out-list)
.failure-row                    flex column; gap 3px; padding 8px 10px; :hover 6% hover
.failure-row + .failure-row     border-top 1px divider
.failure-row .line              flex; align center; gap 8px; flex-wrap wrap; min-width 0
.failure-row .key-cell          flex 1 1 200px; min-width 0; flex; align center; gap 4px
.failure-row .when              mono 10.5px; color neutral-600; flex none
.failure-row .row-actions       flex; gap 4px; flex none
.failure-row .error-text,
.test-fail-row .error-text,
.poll-row .error-text           font-size 12px; line-height 1.45; overflow-wrap anywhere; margin 0
.poll-loading                   mono 11px; color neutral-600; padding 8px 10px
.poll-load-error                flex; align center; gap 8px; flex-wrap wrap; padding 8px 10px

/* — test preview — */
.test-preview                   1px divider border; surface bg; flex column; margin-top 8px
.test-preview-head              flex; align center; gap 8px; flex-wrap wrap; padding 6px 6px 6px 10px; border-bottom 1px divider
.test-preview-head h6           margin 0
.test-preview-head .summary     mono 11px; color neutral-800
.test-preview-head .note        11px; color neutral-600
.test-preview-head .icon-btn    margin-left auto; width 24px; height 24px; svg 14px
.test-group                     flex column; padding 8px 10px 6px
.test-group + .test-group       border-top 1px divider
.test-group-label               mono 9.5px caps; letter-spacing .1em; color neutral-600 (as .participant-row .role)
.test-group-label .sub          mono 10.5px; no caps; letter-spacing 0; margin-left 8px
.test-task                      flex column; margin-top 8px; min-width 0
.test-task-head                 mono 11px; flex; align center; gap 8px; min-width 0; padding 3px 0; border-top 2px divider; color neutral-600 for labels
.test-task-head .task-badge     mono 9.5px caps; .04em; padding 0 6px; line-height 16px; bg neutral-900; color bg; flex none
.test-task-items                flex column; border-left 2px neutral-300; margin-left 2px; padding-left 10px
.test-item .role                mono 10px; color neutral-600; flex none
.test-item .title.is-follow     font-weight 400
.test-item                      flex column; gap 1px; padding 5px 0; min-width 0
.test-item + .test-item         border-top 1px divider
.test-item .title               heading 800 13px/1.3; overflow-wrap anywhere
.test-kv                        mono 11px; flex; gap 6px; min-width 0
.test-kv .k                     width 44px; flex none; color neutral-600
.test-kv .none                  color neutral-600
.test-fail-row                  flex column; gap 1px; padding 5px 0; min-width 0
.test-fail-row + .test-fail-row border-top 1px divider

/* — history — */
.poll-history                   flex column; margin-top 6px
.poll-history-head              flex; align center; gap 8px; border-top 1px divider
.poll-toggle                    flex; align center; gap 6px; border 0; background none; padding 8px 6px 6px 0; cursor pointer; text-align left;
                                heading 800 11.5px; letter-spacing .08em; uppercase; color text   (a lighter .trace-toggle)
.poll-toggle:hover:not(:disabled)        color accent-700
.poll-toggle:disabled                    cursor default
.poll-toggle svg                          14px
.poll-toggle[aria-expanded="true"] svg    color accent
.poll-toggle .count             mono 11px; weight 400; letter-spacing 0; no caps; color neutral-600
.poll-row                       flex; flex-wrap wrap; align baseline; column-gap 12px; row-gap 2px; padding 6px 10px; :hover 6% hover
.poll-row + .poll-row           border-top 1px divider
.poll-row .kind-cell            width 52px; flex none; display flex
.poll-row .when                 mono 11px; width 76px; flex none
.poll-row .since                mono 11px; width 122px; flex none; color neutral-600
.poll-row .counts               mono 11px; flex 1 1 140px; min-width 0; color neutral-800
.poll-row .outcome              mono 10.5px caps; letter-spacing .06em; flex none; color neutral-700
.poll-row .outcome.is-error     color accent-700
.poll-row .outcome.is-running   color neutral-600
.poll-row .error-text           flex-basis 100%; padding-left 64px
.poll-kind                      add to the existing `.yours-badge, .me-badge, .org-badge` rule (mono 9.5px caps, .04em, padding 0 6px, line-height 16px, nowrap, flex-shrink 0)
.poll-kind.kind-poll            transparent; 1px divider border; color neutral-700; line-height 14px
.poll-kind.kind-retry           bg neutral-200; color neutral-900
.poll-kind.kind-rescan          bg neutral-900; color bg

/* — rail badge (changed) — */
.rail-item .badge               (existing: 10px; accent bg; bg colour) + flex none; line-height 15px; padding 0 6px; font-variant-numeric tabular-nums
.rail-item .badge.corner        position absolute; top 3px; left 29px; font-size 9px; line-height 14px; padding 0 4px
```
Keyboard focus uses the global `:focus-visible` ring everywhere. No new focus styles are needed.

Replace the card's existing inline button sizing (`padding: 6px 12px; font-size: 12px`) with `.btn-sm` while you're in the file, so the card has no inline styles left.

#### Acceptance checks
All run in the prototype with the default tweaks, unless a step says otherwise.
1. **Rail badge total.** The Extensions rail item shows `1` (only `imap-support` has `failedCount` 1). Its accessible name is "Extensions, 1 failed". Switch to Board: the badge still reads on the resting item. Collapse the rail: the badge sits on the icon's top-right corner and the icon doesn't move. In no state does the label shift.
2. **Status line, ok.** `imap-work` reads `Polled 2 min ago · 3 new`, with no `0 changed` or `0 failed`.
3. **Status line, never polled.** `github-issues` reads `Never polled`. It has no History toggle and no Failures section.
4. **Status line, error.** `imap-support` reads `Last poll failed 2 min ago: IMAP: connection reset by peer` in `accent-700`. In a narrow pane it truncates to one line and hovering shows the full text. Opening its History wraps it in full.
5. **Tone bars.** `imap-support` is accent. `imap-work` is `neutral-800`. `github-issues` (connected, not activated) is `neutral-500`.
6. **Failures list.** `imap-support` shows "Failures 2". The keyed row shows `<75c1a1ab-0c7b-…` truncated with `…f804b2@acme.test>` kept, "12 min ago" and `body is not valid UTF-8`. Hovering the key shows it in full.
7. **Copy.** The copy button changes to "Copied" for about 1.5 s, and the clipboard holds the full key, angle brackets included.
8. **Unkeyed row.** It reads "no key", has no copy, Retry or Dismiss, shows "from the last poll" (hover: the 17-min-ago poll's time) and `message has no Message-ID header`.
9. **Retry, still failing.** First Retry: the row shows "Retrying…", both buttons disabled. Then the row stays with the fresh error `body is not valid UTF-8 (invalid byte 0xC3 at offset 2048)` and "just now". History gains a `retry` row reading `1 seen · 0 new · 1 failed`.
10. **Retry, succeeding.** Second Retry: the row disappears and the count reads 1 (the unkeyed row). The rail badge is hidden because the total is 0. The tone bar stays accent (last poll failed, unkeyed row present).
11. **Dismiss.** Reload, then Dismiss the keyed row: "Dismissing…", then the row is removed and the badge hidden.
12. **History.** It's collapsed on every card at load. `imap-work` reads `History · 7 polls`. Expanded, it shows the kind badges `poll`, `rescan` and `retry`; the oldest row reads `since 7 days ago · 41 seen · 41 new`; the rescan row reads `no window`; and quiet polls read `0 new` with no `0 seen`. `imap-support` shows two `error` rows with the full error under them.
13. **Rescan source, zero and singular.** On `imap-work` it reads "Rescanning…", then `Nothing new found`. On `github-issues`: `Recovered 1 item not seen before`; `History · 1 poll` appears, while the status line stays `Never polled`.
14. **Rescan source, error then plural.** On `imap-support`, the first rescan shows the `.error-text` `Rescan failed: IMAP: connection reset by peer`. The second shows `Recovered 3 items not seen before`. The message clears when you press Test on that card.
15. **Test preview.** At load, no card shows a preview. Choose Test from `⋯` on `imap-work`:
    - `3 items · 1 failure · 1 check failure` and "becomes 2 tasks".
    - `Task 1 · 2 items · thread …7e1f90c4b2a6@acme.test>` holds both vendor-onboarding items under one left rule: the first reads `creates task`, the reply `adds to task`. `Task 2 · 1 item · no thread · its own task` holds the invoice.
    - A Failures group and a Check failures group with no Retry or Dismiss.
    - The `x` clears it.
16. **Test: cap, error and busy.** Test on `github-issues` shows 5 items and `+2 more`, which expands to 7. Test on `imap-support` shows `✗ IMAP: connection reset by peer` with **Fix**. While running, Test reads "Testing…" and is disabled.
17. **Load states.** With `loadState` set to `loading`, `imap-support` shows "Loading failures…" and every connected card shows `History · loading…` (disabled). With `error`, it shows "Couldn't load failures: …" with Try again, and `History · couldn't load`.
18. **Not connected and invalid.** With `moreStates` on, Outlook shows only `Polled 3 days ago · 2 new` and Connect: no Test, Rescan source, Failures or History. Zendesk shows `Never polled` and its manifest error. Disconnect `imap-work`: its sections and Test and Rescan source disappear. In the app, the network panel shows no polls, failures, rescan or test-poll calls for that card.
19. **Narrow.** Below about 680px of list width, the actions move under the card body. Long keys and errors truncate or wrap and never overflow the card.
20. **Actions.** `imap-work` (enabled) shows Rescan source, Disable and `⋯` (Test, Disconnect, Delete). `github-issues` (connected, not enabled) shows Rescan source, Activate and `⋯` (Test, Disconnect, Delete). With `moreStates`, Outlook (not connected) shows only `⋯` (Delete). Run Test on `imap-work`, switch to Board and back: the preview is gone. Escape and an outside click close the menu.
21. **Keyboard and shell.** Tab reaches every History toggle (`aria-expanded` flips), copy, Retry, Dismiss, `+N more` and the preview clear, each with the accent focus ring. Nothing opens a new tab or window. The new code has no inline `style`. Only Archivo 400, 600 and 800 are used, plus `.mono`.
22. **Helpers.**
    - `pollSummary(null, now)` returns `Never polled`.
    - `rescanMessage(0)` returns `Nothing new found`.
    - `rescanMessage(1)` returns `Recovered 1 item not seen before`.
    - `rescanMessage(4)` returns `Recovered 4 items not seen before`.

#### Assets
New Lucide icons for `src/client/icons.tsx`, squared off like the existing set (path data in the prototype's `ICONS` map):
- `copy`: `["M8 8h14v14H8z", "M4 16H2V2h14v2"]` (copy key)
- `check`: `["M20 6 9 17l-5-5"]` ("Copied")
- `ellipsis`: `["M5 12h.01", "M12 12h.01", "M19 12h.01"]` at stroke-width 3 (card More menu)

Reused: `chevron-right` and `chevron-down` (History toggle), `x` (clear preview), `plug` (rail), and `mail`, `github` and `server` (card icons).

#### Files
- `Jidoka.dc.html`, the prototype. Relevant parts:
  - **Template:** the `cards` loop. In order: status line, rescan note, Failures section, Test poll preview, History. Also the rail `navItems` badge spans.
  - **Logic:** the `// ---- pollStatus.ts` helpers, `seed()` (the three extensions, their polls and failures), `TESTS` (the preview data), `buildCard()` (every state rule in §1), and `retry`, `dismiss`, `rescan` and `test` (the simulated outcomes).
- **Repo files to change:**
  - `src/client/Extensions.tsx`: `ExtensionPolling` per card; status line; Failures with Retry, Dismiss and copy; History; Rescan source; the Test preview replacing `✓ N item(s) found`; `reloadList()`; `barTone`; the 30 s refresh; no calls for unconnected sources; and `onFailedTotalChange`.
  - `src/client/App.tsx`: `failedTotal` from `api.extensions()` in `refresh()`; the badge and accessible name on the Extensions rail item; wire up `onFailedTotalChange`.
  - `src/client/api.ts`: `lastPoll` and `failedCount` on `ExtensionListItem`; the `PollRecord`, `SourceItemRow` and `TestPollResult` types; `ApiError` with `status`; `polls`, `failures`, `retryFailure`, `dismissFailure` and `rescanSource`; the new `testPoll` shape.
  - `src/client/pollStatus.ts` (new): the pure helpers in §4.
  - `src/client/icons.tsx`: `copy`, `check`, `ellipsis`.
  - `src/client/modernist.css`: §6.
  - `tests/client/pollStatus.test.ts` (new): the helper strings.
