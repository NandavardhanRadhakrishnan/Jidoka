# Relevance check: is an update actually addressed to the user

## Motivation

Today, any task source ingests and any task-threads reopen fires on *any* change to a tracked item, with no notion of whether that change is actually addressed to the connected user. Three concrete problems fall out of this:

1. **Self-feedback loops.** A real incident during MCP testing: a rule posted an acknowledgment comment on a GitHub issue; the comment itself bumped the issue's `updated_at`; task-threads saw that as "the item changed," reopened the task, re-ran the rule, which posted another comment, which bumped `updated_at` again — caught manually after 3 real duplicate comments on a live issue. Full writeup: `docs/superpowers/specs/2026-09-27-task-threads-design.md`'s reopen mechanism combined badly with a write-capable rule and a naive revision signal (the source extension's own bug, not a task-threads defect — but a real one, and a recurring risk for any source/rule combination that writes back to what it reads).
2. **Wasted AI spend on noise.** A busy thread with many participants gets every message triaged, even messages that are side conversation between other people, never actually directed at or actionable by the connected user.
3. **A real blind spot in naive "who was this addressed to" filtering.** A message that never names the user by name but is squarely their job (e.g. a generic infra request their team owns) would be missed by any classifier that only looks at addressing structure (mentions, reply-to) rather than content/domain match.

This spec is the result of extensive brainstorming, including an empirical spike into using a cheap local classifier (Laya) as a pre-filter — written up separately in `docs/superpowers/specs/2026-10-02-laya-relevance-check-spike-findings.md`. That spike's conclusion shapes this design directly: a cheap classifier is unreliable at exactly the judgment ("does *anything* I know about apply here, or is this genuinely unrelated to my job") that a pre-filter in front of triage would need to get right, sometimes confidently wrong. The system Jidoka already has — full LLM triage — handles that judgment correctly today. This spec does not reintroduce a cheap pre-filter; it extends triage and the reopen path with the relevance judgment directly.

## Scope

**In scope:**
- A `not_relevant` outcome added to triage's existing classification, so an ingested item that doesn't need the connected user's attention never becomes a live task.
- An analogous, lighter check before task-threads reopens an already-typed task, informed by that task's own type rather than the whole registry.
- Resolving the connected user's identity on a given source (from the vault's existing credential, where the source can supply one), so "was this authored by/addressed to the user" is a real signal available to both checks.
- Teaching the rule-builder to pull full thread context (not just the bare item) for types whose tasks represent one message in an ongoing conversation — a second, independent cause of the same incident (the generated rule redrafted its acknowledgment from scratch every reopen, with zero memory it had replied before).
- Teaching the extension generator to export identity resolution when a source has an obvious one.

**Explicitly out of scope, decided during brainstorming:**
1. **A cheap classifier gating whether triage runs at all.** Spiked, found unreliable at open-set detection specifically — see the spike findings doc. Full triage's real cost is accepted instead.
2. **Hierarchical type-registry bucketing for triage cost at scale.** A real future need once a registry gets large (the spike confirmed cardinality plus semantic tightness both matter), but not the problem this spec solves, and not built here.
3. **A generic structural safety net against reopen loops** (a reopen-count cap, a cooldown) independent of relevance judgment. Discussed early in the brainstorm as a backstop; this spec's mechanism addresses the root cause directly (an update failing relevance never triggers a reopen in the first place), which should make the scenario far rarer. Worth revisiting only if it still happens after this ships.
4. **Cross-source identity unification.** A user's GitHub login and email address never need to be the same value or even aware of each other — each source's resolved identity only has to be meaningful *within* that source.
5. **Deep semantic negative/positive example accumulation** (the "teach the classifier from corrections" idea explored mid-brainstorm) — a real idea for a future iteration once this ships and we see real false-positive/negative rates, not built now. Not needed for the core mechanism: triage's existing example-accumulation convention (examples attached to a type) already covers the "this type's boundary" learning triage already does; nothing new is required for v1.

## Data model

**`src/domain/task.ts`** — `TaskState` gains `"dismissed"`:
```ts
export type TaskState =
  | "ingested" | "needs_type_confirmation" | "needs_onboarding"
  | "needs_dedup_confirmation" | "processing" | "assigned_ai"
  | "assigned_human" | "done" | "failed" | "dismissed";
```
Bucketed into the existing **Settled** lane in `src/client/columns.ts`'s `LANE_OF` (no new lane — "closed or failed" already fits "we decided this didn't need you," and keeping it inspectable there is deliberate: if the user suspects something was wrongly dismissed, Settled is where they'd look, same as a `failed` task today). `STATE_LABEL` gains `dismissed: "not relevant"`.

**`src/triage/triage.ts`** — `TriageOutcome` gains a variant:
```ts
export type TriageOutcome =
  | { kind: "matched"; typeId: string }
  | { kind: "ambiguous"; candidateTypeIds: string[] }
  | { kind: "new_type"; proposal: TypeProposal }
  | { kind: "not_relevant" };
```
`responseSchema` gains `notRelevant: z.boolean().optional()`. In `triageTask`, this is checked **before** the existing score-based logic, as a new early return — entirely additive, no existing branch changes:
```ts
if (response.notRelevant) return { outcome: { kind: "not_relevant" }, deadline };
// ...existing top/runnerUp logic, unchanged
```
A model that doesn't set `notRelevant` (or sets it `false`) falls through to exactly today's behavior. This is the "fail open" rule made concrete: the model has to affirmatively flag irrelevance; silence/uncertainty defaults to the existing matched/ambiguous/new_type path, never to a silent drop.

`triageTask`'s own signature gains a fourth parameter: `triageTask(provider, task, types, identity: string | null)`, threaded straight through to `triageUserMessage` below. Both of `triageTask`'s existing callers (`triageAndAssign` in `src/orchestrator.ts`, and `retriageTask`/`retriageOpenTasksForType` from the re-triage work) are updated to fetch and pass the task's source identity — see "Relevance at ingestion" below for where that lookup happens.

**`extensions` table** (`src/db/migrations.ts`) gains a nullable column:
```sql
ALTER TABLE extensions ADD COLUMN resolved_identity TEXT;
```
(Per the existing convention from the task-threads work, `migrate()` already tolerates a "duplicate column" error on re-run, so this follows the established `ALTER TABLE` pattern directly.)

**Extension contract** (`src/sources/types.ts` stays untouched; this is a `source.ts` export convention, same as `createSource`): an extension may optionally export
```ts
export async function getIdentity(deps: ExtensionSourceDeps): Promise<string>
```
returning whatever string is meaningful on that source (a GitHub login, an email address, a Slack user id). No manifest schema change — same reasoning as `createSource` itself: this is a code contract a generator or a human author implements, not a declared capability.

## Identity resolution

**`src/extensions/runtime.ts`** gains `resolveIdentity(db, extensionsDir, vault, id): Promise<string | null>`, mirroring `loadOneExtensionSource`'s cache-busted dynamic import: imports the extension's `source.ts`, and if it exports `getIdentity`, calls it with `{ getToken: () => vault.getToken(id) }` and returns the result; returns `null` if the export is absent, or if it throws (identity resolution failing must never fail a connect — log and continue unset).

**`src/api/extensions.ts`** — the three connect handlers (`/connect/api-key`, `/connect/device/complete`, `/connect/pkce/callback`) each call `resolveIdentity` immediately after the credential is saved, and persist the result via a new `extensionsRepo.setResolvedIdentity(db, id, identity)` (a plain `UPDATE`, mirroring `setEnabled`). Re-running on every successful (re)connect means a credential change always gets a fresh identity with no separate "did it change" detection needed — if `resolveIdentity` returns `null` (no export, or it failed), any previously-stored identity for that extension is **not** cleared (treat a transient resolution failure as "unknown for now," not "definitely has no identity" — a real network hiccup on one connect shouldn't permanently disable relevance-awareness for that source).

## Relevance at ingestion — folded into triage

**`src/triage/prompt.ts`** — `TRIAGE_SYSTEM` gains instructions for the new field, and `triageUserMessage` gains the resolved identity as an input when the task's source has one:
```ts
export function triageUserMessage(task: Task, types: TaskType[], identity: string | null): string {
  // ...existing known-types block...
  const who = identity ? `\n\nThe connected user's identity on this source: ${identity}` : "";
  return `today: ${today}\n\nKnown task types:\n${known}${who}\n\nTask:\n...`;
}
```
Prompt addition to `TRIAGE_SYSTEM`, roughly:
> Also decide whether this task actually needs the connected user's attention or action at all — set `"notRelevant": true` only when you're confident it doesn't (e.g. it's side conversation between other people that doesn't involve or concern the user, or — when an identity is given — it was authored by the user/the connected identity itself, which is never something they need to act on). When unsure, leave it unset and classify normally; don't guess at irrelevance.

This directly covers the self-authorship case from the original incident: Jidoka's own posted comment, re-ingested or re-checked, is authored by the same identity the vault resolved for that source — the model is told explicitly that content from that identity is never actionable by that same identity. It also covers the "generic infra request, nobody named" case *correctly*, because this is still triage's full content+domain-aware judgment, not an addressing-only check — the exact gap that sank the earlier cheap-pre-filter design doesn't apply here, since nothing about this change narrows triage's inputs, it only adds one more output it can produce.

**`src/orchestrator.ts`** — `applyTriageOutcome` (shared by both `triageAndAssign`, for fresh ingestion, and `retriageTask`, for a description-change re-triage) gains a branch:
```ts
if (outcome.kind === "not_relevant") {
  return updateTask(deps.db, task.id, { state: "dismissed" });
}
```
`triageAndAssign` and `retriageTask` each gain a lookup — a new small helper, `getResolvedIdentity(deps.db, task.sourceId)` (returning `null` for the sample-folder/manual-injection sources, which have no extension record at all) — and pass its result as `triageTask`'s new fourth argument.

## Relevance at reopen — a lighter, type-aware check

Task-threads' reopen is a different question from fresh-ingestion triage: the task already has a type, so there's no "which type" judgment to make — only "does this specific delta warrant re-running the rule." This gets its own small function rather than overloading `triageTask`'s type-registry-shaped schema:

**`src/triage/triage.ts`** (or a sibling module, `src/triage/reopenRelevance.ts` if `triage.ts` gets crowded):
```ts
export async function assessReopenRelevance(
  provider: AiProvider,
  task: Task,
  type: TaskType,
  item: RawItem,
  identity: string | null,
): Promise<{ relevant: boolean }>
```
A small, single-purpose prompt: given the type's own name/description (not the whole registry), the task's prior content/state, the new item content, and the resolved identity when available, decide whether this specific change warrants attention — same fail-open instinct (default `true` unless confident otherwise), same self-authorship awareness when identity is known.

**`src/sources/poller.ts`** — currently, any revision change on a reopenable-state task is unconditionally queued for `onTaskChanged`. This becomes conditional: `pollOnce` (or `onTaskChanged` itself, which already has `deps` available) calls `assessReopenRelevance` before proceeding. If not relevant: **don't reopen** — just refresh `context.revision` to the new value via a plain `updateTask` (so the next poll tick doesn't keep flagging the same now-stale "changed" state forever) and leave the task's state untouched. This is the actual fix for the original incident: the second and third comments in that loop would each have been correctly recognized as "this is the connected identity's own prior output," and the task would have stayed `assigned_human` after its first real reopen instead of looping.

## Rule-builder: pulling full context, not just the bare item

Independent root cause from the same incident: the generated rule's `mcp_tool` step called GitHub's `issue_read` with `method: "get"` only — title/body/labels, never `get_comments` — so every reopen drafted an acknowledgment with zero awareness it had replied before. `src/rule/builder.ts`'s system prompt gains an instruction along these lines:
> If this type's tasks represent one message in an ongoing conversation or thread (an email thread, an issue with comments, a chat), make sure the rule actually has access to the full conversation before responding — use a read tool that returns the full history (comments, prior messages), not just the single item's own fields, and for an `agent`/`assign`-to-ai step that may run again on a follow-up pass, set `resumeSessionFrom` so a later pass continues the same conversation instead of drafting cold.

No schema change — `resumeSessionFrom` already exists (built for task-threads); this is purely a system-prompt improvement to `buildRule`'s existing call, graded by: does a freshly-built rule for a threaded source actually use it. Verify during implementation by re-running the same onboarding prompt from the original incident (`"For each bug report, post a comment on the GitHub issue acknowledging the report..."`) and confirming the generated rule now includes a comment-fetching step and `resumeSessionFrom`.

## Extension generator: exporting identity

`src/extensions/generator.ts`'s system prompt gains an instruction: when the target system has an obvious self-identity endpoint reachable with the same credential (GitHub's `GET /user`, Microsoft Graph's `GET /me`, similar), export `getIdentity(deps)` from `source.ts` alongside `createSource(deps)`, same deps shape, returning the resolved identity as a plain string. When no such endpoint is obvious, omit it — relevance-check continues to work without identity, just with one fewer signal.

## Edge cases / explicitly deferred

- **A dismissed task that was actually relevant (false positive).** No automated recovery path in v1 — a human noticing a wrongly-dismissed task in the Settled lane has no "un-dismiss and re-triage" button yet. Worth a small follow-up (a manual re-triage action, mirroring `reopenTask`'s shape) once real false-positive rates are visible; not built now to keep this spec bounded.
- **Manual task injection (`POST /api/tasks`) and the sample-folder source** have no extension record and thus no resolved identity — relevance-check still runs (triage still gains the `notRelevant` field in its schema regardless), just without the identity signal, relying purely on content/domain judgment. This is strictly better than today's "no relevance judgment at all," not a regression.
- **An extension's `getIdentity` export changing meaning across versions** (e.g. a generated extension is later hand-edited to point at a different account) — re-resolved on every connect, so a fresh connect self-corrects; a credential that silently starts returning a different identity without a reconnect is not detected. Same class of gap as the existing vault's own `auth.mode` mismatch detection (noted as a known gap in `jidoka-open-items`), not solved here.
- **`assessReopenRelevance`'s own cost** — one additional AI call per revision-changed, reopenable-state task, in exchange for not running the full rule (potentially several AI/tool calls) on something that didn't need it. Net cost should go down relative to today's "always reopen," not up.

## Testing

TDD per layer, matching this repo's established convention:
- `tests/triage/triage.test.ts` — `notRelevant: true` short-circuits to `{ kind: "not_relevant" }` regardless of scores; `notRelevant` absent/false preserves every existing matched/ambiguous/new_type test unchanged; identity is correctly interpolated into the user message when present and omitted when null.
- `tests/orchestrator.test.ts` — a `not_relevant` ingestion outcome lands the task in `dismissed`, not `needs_onboarding`/`needs_type_confirmation`; `retriageTask` on an already-`dismissed`-eligible delta behaves the same way; `assessReopenRelevance` returning `relevant: false` refreshes `context.revision` without reopening (task stays in its prior state, no new thread-pass entry); `relevant: true` proceeds exactly as today's `onTaskChanged`.
- `tests/extensions/runtime.test.ts` (or wherever `loadOneExtensionSource`'s existing tests live) — `resolveIdentity` calls an exported `getIdentity`, returns `null` when absent, returns `null` (not throwing) when the export throws.
- `tests/api/extensions.test.ts` — each connect route persists a resolved identity when the (test fixture) extension exports `getIdentity`; a failing/absent `getIdentity` doesn't fail the connect itself.
- `tests/rule/builder.test.ts` — the updated system prompt is exercised the same way existing builder tests already check for tool usage (asserting the stub provider's prompt contains the new instruction, or — if feasible — a fixture description that should produce a comment-fetching step, matching how this codebase already tests prompt-conditioned builder output).
- `tests/client/columns.test.ts` — `dismissed` buckets into `settled`; `STATE_LABEL` exhaustiveness (TypeScript already enforces this via `Record<TaskState, string>`, so this is really a compile-time check, not a runtime test).

Full `bun run typecheck` + `bun test` clean, per this repo's standing convention, before any part of this is considered done.
