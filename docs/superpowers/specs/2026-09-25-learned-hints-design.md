# Per-type/per-step learned hints ("memory")

## Motivation

Rules are built once by an AI agent and then executed unchanged for every task of that type (`CLAUDE.md`: "the agent never regenerates a rule per task"). Today the only way to fix a recurring AI mistake — a wrong field case, a partner-specific quirk, a formatting preference — is to edit the rule's step prompt directly, or redo onboarding. That's high-ceremony for what's often a one-line correction, and it puts the fix in a place (the step definition) shared by every task of that type rather than as an incremental note.

This item lets a human, while reviewing an AI-produced output in the task drawer, save a short freeform correction against the specific step that produced it. Every future run of that step includes the accumulated hints for that step in its prompt. Hints are additive and reviewable, not a hidden prompt rewrite: `RuleEditor.tsx` gets a small list view so they stay inspectable and deletable, matching the existing "rules are inspectable/editable" philosophy.

Backlog item 11 in `jidoka-redesign-testing-backlog` memory; also referenced during item 10 (search) as the intended home for entity-alias corrections like "abhi" → "Aditya Birla" — that connection is *not* built here (hints don't influence search), just noted as the reason search didn't try to solve it itself.

A related but materially bigger idea — making rule *regeneration* itself an agent that fetches the current rule and its hints and patches only what's wrong, instead of requiring the whole workflow to be retyped — is being split into its own backlog item and spec, built after this one, since it depends on hints existing and touches a shared abstraction (`AgentRunner`) well beyond this feature's footprint. See the sibling memory update for that item.

## Data model

New domain type, `src/domain/hint.ts`:

```ts
export interface Hint {
  id: string;
  ruleId: string;
  /** The exact step id within that one rule's definition. Unique within a rule
   *  (RuleStepSchema requires it, and the builder rejects duplicates), so this
   *  is unambiguous in a way an output name is not (nothing stops two steps
   *  sharing an output name today). */
  stepId: string;
  text: string;
  /** What the human had selected when writing it, if anything — reference only, never
   *  matched against at runtime. */
  excerpt: string | null;
  createdAt: string;
}

export interface NewHint {
  ruleId: string;
  stepId: string;
  text: string;
  excerpt?: string | null;
}
```

New table, `src/db/migrations.ts` (same style as `rules`/`task_types`):

```sql
CREATE TABLE IF NOT EXISTS hints (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  text TEXT NOT NULL,
  excerpt TEXT,
  created_at TEXT NOT NULL
)
```

New `src/repo/hints.ts`, mirroring `src/repo/rules.ts`'s shape:

```ts
export function insertHint(db: Database, input: NewHint): Hint
export function listHintsForRule(db: Database, ruleId: string): Hint[]
export function listHintsForStep(db: Database, ruleId: string, stepId: string): Hint[]
export function deleteHint(db: Database, id: string): void
```

## Scoping rule: `(ruleId, stepId)`, and why that's now the right key

An earlier version of this spec keyed hints by `(typeId, stepOutput)` — reasoning that `step.id` isn't guaranteed stable across a rebuild (the rule-building agent regenerates JSON, ids included, every time), while `output` is the same human-visible label already shown in the drawer. Working through the consequences of that surfaced real problems: nothing stops two different steps sharing the same `output` name (only `id` uniqueness is enforced, in `builder.ts`'s duplicate check), so a hint could silently leak across unrelated steps; a step rename would silently orphan its hints with no signal; a step whose *purpose* changed while keeping the same output name would silently keep inheriting hints that no longer applied.

The fix isn't a better string key — it's not needing hints to survive a rebuild unassisted at all. **Every rebuild becomes an explicit reconciliation point** (see below), so a hint only ever needs to be unambiguous *within the one exact rule version it was written against* — and `step.id` already is that, cleanly: guaranteed unique within a rule, and never needs to mean the same thing across versions because nothing relies on it doing so implicitly anymore.

`output` keeps its existing, unrelated job: it's still the name a step's result lands under in `context`, and still what `{{context.<output>}}` templates reference — that role is orthogonal to how hints are stored and doesn't change.

Only `ai` and `agent` steps take a free-text `prompt` a hint can be appended to; `mcp_tool` steps take a structured `input` object, not prose, so hints never apply to them. `TaskDetail.tsx` already computes this distinction (`provenanceLabel`/`producedBy`) for the existing provenance badges — the "+ hint" button reuses that same logic, and `producedBy` needs to start carrying each entry's `stepId` (from `StepLogEntry`, which already has it), not just its `type`, since the UI now needs to send `stepId`.

## Runtime: hint injection

`src/rule/executor.ts`'s `ExecutorDeps` gains:

```ts
getHints?: (ruleId: string, stepId: string) => string[];
```

Injected, not a direct DB call, so the executor stays testable with stub providers per `CLAUDE.md` conventions (same pattern as its existing `loadRule`/`callTool`). The orchestrator wires the real implementation as `(ruleId, stepId) => listHintsForStep(deps.db, ruleId, stepId).map(h => h.text)` wherever it builds `ExecutorDeps` for `runRule`.

Before an `ai` or `agent` step renders its prompt, if `getHints` returns any hints for the owning rule + that step's `id`, they're appended:

```
<rendered step.prompt>

Notes from past corrections on this step:
- <hint 1 text>
- <hint 2 text>
```

Only appended when at least one hint exists — a step with none renders byte-for-byte the same prompt as before this feature existed. Hints are plain text; the model reads them alongside the task's actual data already in the same prompt and applies judgment about whether a hint like "for this partner…" applies to the current task. No structured condition-matching is built (considered and explicitly rejected as disproportionate to the goal of staying low-ceremony).

**Which rule owns a step, for hint lookup, rerun, and dependents alike:** a `call_rule` step hands execution to a *different* rule entirely — a different `ruleId`, not just a different type. Two changes make that resolvable:

- `RuleLoader`'s signature changes from `(typeId, version) => RuleDefinition | null` to `(typeId, version) => { id: string; definition: RuleDefinition } | null`, so the executor learns the called rule's own id, not just its steps. The orchestrator's current implementation (`listRules(deps.db, typeId).find(p => p.version === version)?.definition ?? null`) already has the full `Rule` row in hand at that point — it just needs to stop discarding `.id`.
- `runSteps` threads "which rule owns the step currently executing" through its recursion, starting from `deps.self.ruleId` and switching to the called rule's id when it descends into a `call_rule` step's children. `runRuleForTask` already has the full active `Rule` row (`active.id`) when it constructs `self` today, so this is just not dropping that field either.

## Runtime: single-step rerun

New export from `src/rule/executor.ts`, extracted from the same logic `runSteps` already uses so there is exactly one place that builds a prompt and calls the provider for a given step:

```ts
export async function rerunStep(
  deps: ExecutorDeps,
  definition: RuleDefinition,
  task: Task,
  stepId: string,
): Promise<{ context: Record<string, unknown>; log: StepLogEntry }>
```

Mechanically: `runSteps`'s `case "ai":`/`case "agent":` bodies are factored into a shared `runOneStep(deps, step, task, state)` used both by normal execution and by `rerunStep`. `rerunStep` searches `definition.steps` (recursively through `branch` cases/default, and following a `call_rule` step into the called rule via the now-id-aware `RuleLoader`) for an `ai`/`agent` step whose `id === stepId` — unambiguous, since step ids are unique within a rule. If not found — the active rule changed since this task ran and no longer has that step — it throws a clear error rather than guessing; callers surface that as a normal API error, no partial mutation.

When found, it builds `scope` from the task's **current** `context` (so it sees every other step's results, including anything a human already hand-fixed) via the same `scopeFor` used by normal runs, re-renders that step's prompt (hints included, via the same injection path above, keyed by the step's `id`), and re-invokes exactly what that step type already does — `deps.provider.complete(...)` for `ai`, the agent runner for `agent`. The found step's `output` field is what tells this function which `context` key to write the result into (this is the only place `output` still matters for rerun — purely as "where does this step's result live," unrelated to hint scoping). It returns a patch containing only `context[step.output]` (and, for `agent`, the refreshed `${step.output}_session` key) plus one new `StepLogEntry`. Nothing else in the rule runs *automatically* — no earlier or later step, no full-rule re-entry, no task state transition. This is the whole point: an `ai` step is provably side-effect-free to redo (pure text generation); an `agent` step can still call its allowed MCP tools again, so redoing one is a smaller, single-step version of a risk that already exists every time that step runs at all — accepted per the user's call, since it's an explicit, scoped, human-initiated action, the same trust level already extended to existing explicit actions like "Pick up" or "Mark done".

### Downstream dependents

Rerunning one step can leave *later* steps holding values computed from the *old*, now-corrected output — e.g. the real aditya birla rule builds `mongo_query_text` from `{{context.extracted_fields}}`, then `devops_email_draft` from `{{context.mongo_query_text}}`; fixing `extracted_fields` alone leaves the other two stale with no signal that happened. Rather than auto-cascading (which reintroduces the exact risk single-step rerun exists to avoid — a downstream `mcp_tool` step could re-fire an external write, and a downstream `branch` step could re-route the task down a different path than what actually happened) or staying silent about it, detection + an opt-in cascade button:

New pure function, `src/rule/dependents.ts`:

```ts
export function findDependentSteps(
  definition: RuleDefinition,
  ranStepIds: Set<string>,   // step ids from this task's own ruleLog — steps that actually
                              // executed for THIS task, not every step the rule could reach
  changedStepId: string,
): { safe: string[]; unsafe: string[] }   // step ids, classified
```

Resolves `changedStepId` to its `output` name (needed because template references are by output name, not step id — an orthogonal concern to how hints are stored), then flattens `definition.steps` through `branch` cases/default (not through `call_rule` — a dependent in a *different* rule is out of scope for v1, see Deferred), restricted to steps whose `id` is in `ranStepIds`. Starting from that output name as the one dirty value, repeatedly scans each remaining step's templatable text (`prompt`/`input`/branch `on`) for a `{{context.<dirty-value>}}` reference, growing the dirty set (and the result) until it stabilizes — a transitive closure over a small, per-task-finite set. Classifies each dependent found by step id: `ai`/`agent` → `safe` (rerunnable the same way as the primary step); `mcp_tool` or a `branch` whose `on` matches a dirty value → `unsafe` (surfaced as a warning only, never an auto-rerun button — re-invoking a tool call or re-choosing a branch path goes past the write-risk boundary already agreed for rerun itself).

New route, `GET /api/tasks/:id/dependents?stepId=X` → `{ safe: string[], unsafe: string[] }` (step ids), backing the UI below. No new orchestrator/executor mutation needed for detection — it's a read against the task's current `ruleLog` and the type's active rule definition.

**UI:** when "Re-run this step" is available and `findDependentSteps` reports any `safe` dependents, a secondary "Also rerun N downstream step(s)" button appears alongside it. Clicking it reruns the primary step, then each safe dependent in rule order via the same single-step `rerunStep` call (sequenced client-side — no new cascading backend endpoint; each call is just the existing primitive), so each dependent sees the freshly-updated context from the one before it. Any `unsafe` dependents are named in a plain-text warning next to the button ("also feeds into a tool-call step, not rerun automatically") rather than offered a button at all.

New orchestrator function, `src/orchestrator.ts`:

```ts
export async function rerunStep(deps: AppDeps, taskId: string, stepId: string): Promise<Task>
```

Loads the task, loads the type's active rule, calls the executor's `rerunStep`, and persists the patch via `updateTask(deps.db, taskId, { context: { ...task.context, [step.output]: result, ...(sessionKey ? { [`${step.output}_session`]: sessionKey } : {}), ruleLog: [...existingLog, newEntry] } })`. The executor and orchestrator each exporting a function named `rerunStep` is intentional, not a conflict — different modules, and it mirrors the existing `runRule` (executor) / `runRuleForTask` (orchestrator) pairing.

## Rebuild-time reconciliation

Because hints are pinned to one exact `ruleId`, they don't survive a new rule version on their own — every rebuild is a deliberate point where old hints get explicitly absorbed, carried forward, or dropped, never silently carried or silently lost.

**AI-regenerated rule** (`onboardType`/`buildRule`): before calling the model, the orchestrator fetches the previous active rule's steps together with `listHintsForRule(db, previousRule.id)`, and feeds both into the builder prompt (`BuildInput` gains an optional `previousRule?: { definition: RuleDefinition; hints: Hint[] }`) with an instruction to fold relevant corrections into the new step prompts it writes. The old hint rows are **not** automatically recreated against the new rule — the rebuild absorbs their guidance once; the rows themselves just go inert, tied to the now-superseded `ruleId`. This is the mechanism that fixes the "renamed/repurposed step silently keeps stale hints" problem from the earlier design: there's no more silent survival, only a deliberate per-rebuild absorb-or-drop.

**Manually edited rule** (`RuleEditor.tsx` → `saveAsNewVersion`): a human hand-editing steps isn't asking an AI to rewrite prose for hints to get folded into, so the mechanism is a picker instead. When the previous active rule had any hints, a section appears before saving:

```
Carry forward hints from the previous version?
┌─────────────────────────────────────────────────────┐
│ "For this partner, gender must be caps not lowercase"│
│ was on: mongo_query_text                             │
│ Keep on: [ mongo_query_text ▾ ]  or  [ Don't carry ]  │
├─────────────────────────────────────────────────────┤
│ "Always mention the PO number in the subject line"   │
│ was on: devops_email_draft                            │
│ Keep on: [ devops_email_draft ▾ ]  or  [ Don't carry ]│
└─────────────────────────────────────────────────────┘
```

Each row is one old hint, labeled with the *old* step's output name for context. The dropdown lists the *new* definition's steps (by output name — still the recognizable label) plus "Don't carry", **defaulted to "Don't carry"** — opt-in, matching the "nothing survives without a deliberate decision" principle. On save, only the rows the human explicitly repointed get recreated as new `Hint` rows against `(newRuleId, thatStep.id)`; the rest simply don't carry forward.

## API

`src/api/server.ts`, same thin-Hono-route style as everything else:

- `GET /api/rules/:ruleId/hints` → `{ hints: Hint[] }` — used by `RuleEditor.tsx`'s management list and by the reconciliation picker (reading the *previous* rule's hints).
- `POST /api/rules/:ruleId/hints` → body `{ stepId, text, excerpt? }`, returns the created `Hint` — used by the reconciliation picker to recreate carried-forward hints against a newly created rule.
- `POST /api/tasks/:id/hints` → body `{ stepId, text, excerpt? }`, returns the created `Hint` — the task-drawer capture path; resolves the task's type's active rule server-side so the client never needs to know a `ruleId` just to save a hint from the drawer.
- `DELETE /api/hints/:id` → 204
- `POST /api/tasks/:id/rerun-step` → body `{ stepId }`, returns the updated `Task`
- `GET /api/tasks/:id/dependents?stepId=X` → `{ safe: string[], unsafe: string[] }`

`src/client/api.ts` gains matching thin wrappers (`ruleHints`, `addRuleHint`, `addTaskHint`, `deleteHint`, `rerunStep`, `dependents`), following the existing client API module's pattern.

## UI

**Capture**, in `TaskDetail.tsx`'s existing output-block loop: `producedBy` (built from `ruleLog`) starts carrying each entry's `stepId` alongside its `type`, not just `type`. For an entry where `provenanceLabel(key).kind === "produced"` and the producing step's type is `"ai"` or `"agent"` (never for `mcp_tool` or a static `note:`), render a small "+ hint" button. Clicking it opens a textarea; if `window.getSelection().toString()` is non-empty when clicked, it's quoted at the top of the textarea as reference only (not matched against anything). Saving calls `api.addTaskHint(task.id, { stepId, text, excerpt })`.

A separate, always-available "Re-run this step" button sits on the same qualifying output blocks (not gated on a hint having just been added — rerunning with zero hints saved is just "regenerate," a reasonable action on its own), calling `api.rerunStep(task.id, stepId)` and refreshing the task on success. Saving a hint and re-running stay two independent actions — a human who fixes an output by hand and doesn't want to explain anything to the AI can skip both; one who wants the current task corrected *and* future runs improved does both, in either order. When `api.dependents(task.id, stepId)` reports downstream steps, the secondary "Also rerun N downstream step(s)" button described above appears next to it.

**Management**, in `RuleEditor.tsx`: a small "Hints" section (fetched via `api.ruleHints(ruleId)` in its existing `useEffect`, for whichever rule is currently loaded), grouped by step (labeled with that step's output name), each row showing the text and a delete button. Exists so hints stay visible and prunable rather than a write-only influence on behavior — matches `CLAUDE.md`'s framing of rules as "inspectable/editable by users."

**Reconciliation**, also in `RuleEditor.tsx`: the picker described above, shown when creating a new version (either path) and the previous active rule had hints.

## Deferred / accepted gaps

- **Dependent detection doesn't cross a `call_rule` boundary.** A step in a *called* rule that depends on the changed key won't be found by `findDependentSteps`. Flagged rather than built, matching the same rule-boundary limit accepted elsewhere in this spec.
- **`mcp_tool`/`branch` dependents are warned about, never auto-rerun.** The human has to notice the warning and handle those manually (e.g. by hand-editing whatever the stale tool call produced) — there's no assisted path for that in v1.
- **Rerun never touches task state.** A rerun (single-step or with downstream dependents) that produces a worse result than before has no undo beyond the human manually fixing it or writing another hint and rerunning again — same recovery path as any other manual correction today.
- **Hints can still accumulate unboundedly within one rule version's lifetime.** Reconciliation resets/prunes at every rebuild, but between rebuilds nothing caps how many hints pile onto one step or catches two hints that contradict each other.
- **Agentic rule regeneration is not this spec.** Feeding hints into `buildRule` at all (the reconciliation section above) is; making regeneration itself a tool-using agent that patches only what's wrong is a separate, later backlog item — see Motivation.

## Testing

TDD per layer, matching how items 6-10 were built this session:

- `tests/repo/hints.test.ts` — CRUD round-trip, scoped by `(ruleId, stepId)`.
- `tests/rule/executor.test.ts` — hint injection appends the notes block only when hints exist for that step id; `rerunStep` finds a step by id (including inside a branch and inside a called sub-rule, now that `RuleLoader` exposes the called rule's id), overwrites only that step's output context key, throws when the step no longer exists in the active rule.
- `tests/rule/dependents.test.ts` — `findDependentSteps` finds a direct `ai`/`agent` dependent, follows a transitive chain (A → B → C), classifies an `mcp_tool` dependent and a `branch` whose `on` matches as `unsafe`, ignores steps not in `ranStepIds`, ignores steps inside an un-taken branch case.
- `tests/rule/builder.test.ts` — `buildRule` includes the previous rule + hints in its prompt when `previousRule` is supplied; omits that section entirely when it isn't (fresh onboarding stays unchanged).
- `tests/orchestrator.test.ts` — `rerunStep` persists the patch without disturbing task state or other context keys; `onboardType`/rebuild flow fetches and passes through the previous rule's hints.
- `tests/api/server.test.ts` — the six new routes.
- `tests/client/` — none planned; the UI pieces (capture, rerun, dependents button, reconciliation picker) are thin enough to verify live via Playwright against the running dev server, same as items 9 and 10.

Full `bun run typecheck` + `bun test` clean before considering any task in the resulting plan done, per this repo's standing convention.
