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
