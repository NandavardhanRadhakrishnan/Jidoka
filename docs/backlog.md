# Backlog

What is still unbuilt, roughly in the order to pick it up. Finished work lives in git history and in `docs/superpowers/specs/`; when an item ships, delete it here rather than marking it done.

Last updated: 2026-10-06.

Size key: **S** = a bounded build, no design questions · **M** = one focused design session, then build · **L** = a full brainstorm before anything is written.

## Next up

### 1. Waiting state, scheduled re-checks, SLAs and escalation — L

Real playbooks run on time and on other people: act, wait for someone, resume on their reply or on a deadline, escalate if neither comes. Jidoka today handles each item in a single pass.

- **Waiting state.** Task threads already resume a task when its source changes, but there is no visible "waiting on X" state, no record of *who* is being waited on, and no timeout when nobody replies. Research basis: HR case pause states (awaiting employee 5 days, vendor 10, manager 3, an effective date), AP chasing requesters, small firms waiting on an accountant or PEO.
- **Scheduled re-checks.** `deadline` is extracted at triage, but nothing re-evaluates a task as time passes. Needed for dunning ladders (31/61/91 days overdue), SLA escalation at 25/50/75/100%, and "chase if no reply in N days". Needs a timer in the poller or orchestrator.
- **Open questions:** do clocks live on the type (an SLA), inside the rule (a "wait until reply or N days" step), or both? How is a ladder expressed in the rule format? How do timers interact with task threads and the relevance check? What does "waiting on X" look like on the board?
- **Good first test case:** payment chasing from an overdue-invoice ledger source (Xero/QuickBooks). That needs extension `config` storage (see Extension system) for per-install thresholds like days overdue.

Evidence: `reports/Office work task types and playbooks.md`, section "Real playbooks run on clocks, approvals and other people".

### 2. Approve-then-send handoff — M

A draft handoff gets a **Send** button whose click executes the MCP write Jidoka prepared — per-execution approval for external sends and anything that moves money. This adds to activation-time write-tool approval; it does not replace it. Open questions: the draft must carry a ready-to-run tool call with arguments; editing the draft must update those arguments; the call needs re-validating at click time in case the thread moved on.

Evidence: draft-then-human-approves is the default across surveyed products; only 20% of executives trust agents with financial transactions (PwC).

### 3. Agentic rule regeneration + replay testing — L

- **Agentic regeneration.** Describe only what's wrong with a rule, and a tool-using agent fetches the current rule and its hints and patches just the affected steps. Spec: `docs/superpowers/specs/2026-09-25-agentic-rule-regeneration-design.md` (not built). The 2026-10-04 live GitHub test showed why: a one-shot rebuild copies the old rule nearly verbatim.
- **Replay testing.** Before activating a new rule version, replay the last N real tasks of that type and diff the outcomes against the current version. Needs a dry-run mode for the executor (stub writes; decide whether reads hit live systems). Every serious competitor gates releases this way (Intercom Fin Simulations, Decagon, Sierra, Agentforce Testing Center).

### 4. Bulk type discovery + starter types — L

Types are discovered one task at a time and the registry starts empty. Competitors cluster recent history up front (Front scans 10k conversations, Help Scout proposes 8–15 topics, UiPath shows 30 clusters) and ship template galleries. Setup cost is the biggest small-business adoption barrier in the research. Includes a starter list of common types (payment chase, quote request, status inquiry, meeting request, invoice to file). Open questions: sources only poll forward today, so history needs a backfill path in the source interface; clustering cost; reviewing ~20 proposed types at once.

### 5. Named assignees — M

`assign` targets only "human"; in a small firm that means a specific person or an outside party (the accountant, a VA). The reference data sets spec and plan are written but not built: `docs/superpowers/specs/2026-09-19-reference-data-sets-design.md`, `docs/superpowers/plans/2026-09-19-reference-library.md` (team-roster use case). Remaining design question: how `assign` names someone from the roster.

### 6. Per-type stats — S build, needs a UI design first

Per-type counts (done, failed, reassigned, reopened, share handled by AI vs a human) on the type's detail screen. The audit log already records the data. Agree the UI before building.

### 7. Outcome signal back into learning — L

Human overrides, reassignments and reopens aren't fed back anywhere. Decide what counts as a signal and whether it updates hints, triage examples, or prompts a rule regeneration.

### 8. Task decomposition — decision needed

Break one big task into several smaller ones. Three entry points, undecided:
- (a) offer "break into smaller tasks" as an alternative to skipping onboarding;
- (b) a standalone chat box where you describe how to split;
- (c) a rule step that creates child tasks with their own assignees and states — the shape real playbooks use (employee onboarding spawns IT, facilities and payroll tasks; procurement runs legal, finance and security approvals in parallel). `call_rule` is synchronous and creates no tasks today.

## Small follow-ups — S

- **Sort lanes by priority.** Lanes are ordered newest first; priority doesn't affect order.
- **Audit log viewer.** `GET /api/audit?taskId=` exists; there is no screen for it.
- **Un-dismiss.** A wrongly dismissed task has no "re-triage" button; it only comes back if its source item changes.
- **Rule editing UI.** Types can be merged from the UI, but a rule can only be changed by rebuilding it from a description or editing steps one by one in the step list.
- **`agentTask` authoring.** An assign-to-AI step's `agentTask` can't be produced by the rule builder or the step editor; it has to be posted to the rules API by hand.
- **Settings "restart" message.** Shown after every save, but the audit retention field takes effect without a restart.
- **AI worker gaps.** Reopening a task doesn't re-trigger the `assigned_ai` worker; no mid-run cancellation; no retry policy.

## Platform and hygiene

- **Tauri packaging.** The client is expected to move to a Tauri desktop shell; keep "open in a new window" behind one helper.
- **API-key execution path** is unit-tested only, never run live (deliberately deferred).
- **Agent sessions inherit Jidoka's working directory.** The Agent SDK takes a `cwd`; set it per task so a review session doesn't see this repo.
- **cwd-relative paths.** `dbPath` and `extensionsDir` resolve against the launch directory, not the executable's location. Startup logs the resolved paths; a real fix is deferred.

## Extension system

- **`config` has no storage.** The manifest schema validates `config`, but nothing persists per-install values. Needed by item 1's ledger source.
- **Poll failures are console-only.** No `lastError` in the UI, repeated identical log lines for a permanently broken extension, and no per-poll timeout (`test-poll` has none either).
- **Authors can't import Jidoka's types.** `ExtensionSourceDeps` is exported from `src/sources/types.ts`, but a third-party `source.ts` can't import it; needs a type entry point plus docs for the `createSource` / `getIdentity` contract.
- **No pruning.** Deleting an extension folder by hand leaves its DB row behind.
- **`expectedMcpServer` matching** against configured MCP servers is unbuilt; installing an MCP server from inside Jidoka is a separate quality-of-life item.
- **Abandoned drafts leak.** The generator's pending-drafts registry has no TTL; an abandoned draft keeps its temp dir and reserves its id.
- **No timeout on generate/fix.** A long generation has no client- or server-side timeout.
- **Generated code runs before review.** `createSource()` and top-level statements run in-process during the generator's shape check, before the draft is shown.
- **Minor:** invalid extensions show a blank name; the API key input isn't masked; a credential whose auth mode no longer matches the manifest is only detected by `getToken()`; the `jidoka-ext-cache` temp dir is never swept; the PKCE pending-connect map has no TTL.
