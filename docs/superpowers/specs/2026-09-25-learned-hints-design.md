# Per-type/per-step learned hints ("memory")

## Motivation

Rules are built once by an AI agent and then executed unchanged for every task of that type (`CLAUDE.md`: "the agent never regenerates a rule per task"). Today the only way to fix a recurring AI mistake — a wrong field case, a partner-specific quirk, a formatting preference — is to edit the rule's step prompt directly, or redo onboarding. That's high-ceremony for what's often a one-line correction, and it puts the fix in a place (the step definition) shared by every task of that type rather than as an incremental note.

This item lets a human, while reviewing an AI-produced output in the task drawer, save a short freeform correction against the specific step that produced it. Every future run of that step for that type includes the accumulated hints for that step in its prompt. Hints are additive and reviewable, not a hidden prompt rewrite: `RuleEditor.tsx` gets a small list view so they stay inspectable and deletable, matching the existing "rules are inspectable/editable" philosophy.

Backlog item 11 in `jidoka-redesign-testing-backlog` memory; also referenced during item 10 (search) as the intended home for entity-alias corrections like "abhi" → "Aditya Birla" — that connection is *not* built here (hints don't influence search), just noted as the reason search didn't try to solve it itself.

## Data model

New domain type, `src/domain/hint.ts`:

```ts
export interface Hint {
  id: string;
  typeId: string;
  /** The step's `output` key this hint targets — not step.id, which the rule-building
   *  agent regenerates on every rebuild. The output key is the same human-visible
   *  label already shown in the drawer (e.g. "mongo_query_text"). */
  stepOutput: string;
  text: string;
  /** What the human had selected when writing it, if anything — reference only, never
   *  matched against at runtime. */
  excerpt: string | null;
  createdAt: string;
}

export interface NewHint {
  typeId: string;
  stepOutput: string;
  text: string;
  excerpt?: string | null;
}
```

New table, `src/db/migrations.ts` (same style as `rules`/`task_types`):

```sql
CREATE TABLE IF NOT EXISTS hints (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  step_output TEXT NOT NULL,
  text TEXT NOT NULL,
  excerpt TEXT,
  created_at TEXT NOT NULL
)
```

No foreign key enforcement needed (SQLite, no cascading requirement — a type merge/delete leaving orphaned hints is an accepted gap, see Deferred).

New `src/repo/hints.ts`, mirroring `src/repo/rules.ts`'s shape:

```ts
export function insertHint(db: Database, input: NewHint): Hint
export function listHintsForType(db: Database, typeId: string): Hint[]
export function listHintsForStep(db: Database, typeId: string, stepOutput: string): Hint[]
export function deleteHint(db: Database, id: string): void
```

## Scoping rule: why `(typeId, stepOutput)` and not `(ruleId, stepId)`

Every step in `RuleDefinitionSchema` requires an `id`, but that id is whatever the rule-building agent's JSON output happens to contain — it is not guaranteed stable across a rebuild (`buildRule` in `src/rule/builder.ts` only validates ids are non-duplicate within one definition; nothing ties an id to the same conceptual step across versions). `output`, by contrast, is the human-meaningful label already rendered in `TaskDetail.tsx`'s "What the rule produced" section (e.g. `mongo_query_text`) and is what a human is actually looking at when they decide to add a hint. Scoping hints by `(typeId, stepOutput)` means they survive a rule edit as long as the conceptual step keeps the same output name, which is the best stability available without inventing a separate stable-step-identity mechanism — out of scope here.

Only `ai` and `agent` steps take a free-text `prompt` a hint can be appended to; `mcp_tool` steps take a structured `input` object, not prose, so hints never apply to them. `TaskDetail.tsx` already computes this distinction (`provenanceLabel`/`producedBy`) for the existing provenance badges — the "+ hint" button reuses that same logic to decide where it's offered.

## Runtime: hint injection

`src/rule/executor.ts`'s `ExecutorDeps` gains:

```ts
getHints?: (typeId: string, stepOutput: string) => string[];
```

Injected, not a direct DB call, so the executor stays testable with stub providers per `CLAUDE.md` conventions (same pattern as its existing `loadRule`/`callTool`). The orchestrator wires the real implementation as `(typeId, stepOutput) => listHintsForStep(deps.db, typeId, stepOutput).map(h => h.text)` wherever it builds `ExecutorDeps` for `runRule`.

Before an `ai` or `agent` step renders its prompt, if `getHints` returns any hints for the owning type + that step's `output`, they're appended:

```
<rendered step.prompt>

Notes from past corrections on this step:
- <hint 1 text>
- <hint 2 text>
```

Only appended when at least one hint exists — a step/type with none renders byte-for-byte the same prompt as before this feature existed. Hints are plain text; the model reads them alongside the task's actual data already in the same prompt and applies judgment about whether a hint like "for this partner…" applies to the current task. No structured condition-matching is built (considered and explicitly rejected as disproportionate to the goal of staying low-ceremony).

**Which type owns a step**, for both hint lookup and step lookup in rerun (below): a `call_rule` step hands execution to a different type's rule. `runSteps` currently has no notion of "which type does the step I'm running belong to" — it needs one, threaded as a new parameter defaulting to `deps.self.typeId` and switching to `step.typeId` when recursing into a called rule's steps, so a hint resolves against the type that actually owns the step producing it, not always the entry-point type.

## Runtime: single-step rerun

New export from `src/rule/executor.ts`, extracted from the same logic `runSteps` already uses so there is exactly one place that builds a prompt and calls the provider for a given step:

```ts
export async function rerunStep(
  deps: ExecutorDeps,
  definition: RuleDefinition,
  task: Task,
  stepOutput: string,
): Promise<{ context: Record<string, unknown>; log: StepLogEntry }>
```

Mechanically: `runSteps`'s `case "ai":`/`case "agent":` bodies are factored into a shared `runOneStep(deps, step, task, state)` used both by normal execution and by `rerunStep`. `rerunStep` searches `definition.steps` (recursively through `branch` cases/default, and following a `call_rule` step into the called type's own active rule definition, loaded via `deps.loadRule`) for an `ai`/`agent` step whose `output === stepOutput`. If not found — the active rule changed since this task ran and no longer has that step — it throws a clear error rather than guessing; callers surface that as a normal API error, no partial mutation.

When found, it builds `scope` from the task's **current** `context` (so it sees every other step's results, including anything a human already hand-fixed) via the same `scopeFor` used by normal runs, re-renders that step's prompt (hints included, via the same injection path above), and re-invokes exactly what that step type already does — `deps.provider.complete(...)` for `ai`, the agent runner for `agent`. It returns a patch containing only `context[stepOutput]` (and, for `agent`, the refreshed `${stepOutput}_session` key) plus one new `StepLogEntry`. Nothing else in the rule runs *automatically* — no earlier or later step, no full-rule re-entry, no task state transition. This is the whole point: an `ai` step is provably side-effect-free to redo (pure text generation); an `agent` step can still call its allowed MCP tools again, so redoing one is a smaller, single-step version of a risk that already exists every time that step runs at all — accepted per the user's call, since it's an explicit, scoped, human-initiated action, the same trust level already extended to existing explicit actions like "Pick up" or "Mark done".

### Downstream dependents

Rerunning one step can leave *later* steps holding values computed from the *old*, now-corrected output — e.g. the real aditya birla rule builds `mongo_query_text` from `{{context.extracted_fields}}`, then `devops_email_draft` from `{{context.mongo_query_text}}`; fixing `extracted_fields` alone leaves the other two stale with no signal that happened. Rather than auto-cascading (which reintroduces the exact risk single-step rerun exists to avoid — a downstream `mcp_tool` step could re-fire an external write, and a downstream `branch` step could re-route the task down a different path than what actually happened) or staying silent about it, detection + an opt-in cascade button:

New pure function, `src/rule/dependents.ts`:

```ts
export function findDependentSteps(
  definition: RuleDefinition,
  ranOutputs: Set<string>,   // output keys from this task's own ruleLog — steps that actually
                              // executed for THIS task, not every step the rule could reach
  changedKey: string,
): { safe: string[]; unsafe: string[] }
```

Flattens `definition.steps` through `branch` cases/default (not through `call_rule` — a dependent in a *different* type's rule is out of scope for v1, see Deferred), restricted to steps whose `output` is in `ranOutputs`. Starting from `{changedKey}` as the dirty set, repeatedly scans each remaining step's templatable text (`prompt`/`input`/branch `on`) for a `{{context.<dirty-key>}}` reference to any key currently in the dirty set, growing it until it stabilizes (transitive closure over a small, per-task-finite set — reuses the same placeholder-scan technique the now-removed `ruleUsesTaskUrl`, item 8, used, applied here as an opt-in warning rather than a hard block). Classifies each dependent found: `ai`/`agent` → `safe` (rerunnable the same way as the primary step); `mcp_tool` or a `branch` whose `on` is a dirty key → `unsafe` (surfaced as a warning only, never an auto-rerun button — re-invoking a tool call or re-choosing a branch path goes past the write-risk boundary already agreed for rerun itself).

New route, `GET /api/tasks/:id/dependents?stepOutput=X` → `{ safe: string[], unsafe: string[] }`, backing the UI below. No new orchestrator/executor mutation needed for detection — it's a read against the task's current `ruleLog` and the type's active rule definition.

**UI:** when "Re-run this step" is available and `findDependentSteps` reports any `safe` dependents, a secondary "Also rerun N downstream step(s)" button appears alongside it, listing which output keys. Clicking it reruns the primary step, then each safe dependent in rule order via the same single-step `rerunStep` call (sequenced client-side — no new cascading backend endpoint; each call is just the existing primitive), so each dependent sees the freshly-updated context from the one before it. Any `unsafe` dependents are named in a plain-text warning next to the button ("also feeds into `<tool step>`, not rerun automatically") rather than offered a button at all.

New orchestrator function, `src/orchestrator.ts`:

```ts
export async function rerunStep(deps: AppDeps, taskId: string, stepOutput: string): Promise<Task>
```

Loads the task, loads the type's active rule, calls the executor's `rerunStep`, and persists the patch via `updateTask(deps.db, taskId, { context: { ...task.context, [stepOutput]: result, ...(sessionKey ? { [`${stepOutput}_session`]: sessionKey } : {}), ruleLog: [...existingLog, newEntry] } })`. The executor and orchestrator each exporting a function named `rerunStep` is intentional, not a conflict — different modules, and it mirrors the existing `runRule` (executor) / `runRuleForTask` (orchestrator) pairing.

## API

`src/api/server.ts`, same thin-Hono-route style as everything else:

- `GET /api/types/:id/hints` → `{ hints: Hint[] }`
- `POST /api/types/:id/hints` → body `{ stepOutput, text, excerpt? }`, returns the created `Hint`
- `DELETE /api/hints/:id` → 204
- `POST /api/tasks/:id/rerun-step` → body `{ stepOutput }`, returns the updated `Task`
- `GET /api/tasks/:id/dependents?stepOutput=X` → `{ safe: string[], unsafe: string[] }`

`src/client/api.ts` gains matching thin wrappers (`hints`, `addHint`, `deleteHint`, `rerunStep`, `dependents`), following the existing client API module's pattern.

## UI

**Capture**, in `TaskDetail.tsx`'s existing output-block loop: for an entry where `provenanceLabel(key).kind === "produced"` and `producedBy.get(key)` is `"ai"` or `"agent"` (never for `mcp_tool` or a static `note:`), render a small "+ hint" button. Clicking it opens a textarea; if `window.getSelection().toString()` is non-empty when clicked, it's quoted at the top of the textarea as reference only (not matched against anything). Saving calls `api.addHint(task.typeId, { stepOutput: key, text, excerpt })`.

A separate, always-available "Re-run this step" button sits on the same qualifying output blocks (not gated on a hint having just been added — rerunning with zero hints saved is just "regenerate," a reasonable action on its own), calling `api.rerunStep(task.id, key)` and refreshing the task on success. Saving a hint and re-running stay two independent actions — a human who fixes an output by hand and doesn't want to explain anything to the AI can skip both; one who wants the current task corrected *and* future runs improved does both, in either order. When `api.dependents(task.id, key)` reports downstream steps, the secondary "Also rerun N downstream step(s)" button described above appears next to it.

**Management**, in `RuleEditor.tsx`: a small "Hints" section (fetched via `api.hints(type.id)` in its existing `useEffect`), grouped by `stepOutput`, each row showing the text and a delete button. Exists so hints stay visible and prunable rather than a write-only influence on behavior — matches `CLAUDE.md`'s framing of rules as "inspectable/editable by users."

## Deferred / accepted gaps

- **Type merge/rename doesn't migrate hints.** If a type is merged into another or renamed, hints stay attached to the old `typeId` and stop being looked up. Not built here; flagged rather than silently handled.
- **No structured condition matching.** A hint like "for this partner…" is applied at the model's discretion, not enforced by a condition language. Explicitly rejected above as disproportionate.
- **Rerun never touches task state.** A rerun (single-step or with downstream dependents) that produces a worse result than before has no undo beyond the human manually fixing it or writing another hint and rerunning again — same recovery path as any other manual correction today.
- **Dependent detection doesn't cross a `call_rule` boundary.** A step in a *called* type's rule that depends on the changed key won't be found by `findDependentSteps`. Flagged rather than built, matching the same "which type owns this step" boundary already accepted elsewhere in this spec.
- **`mcp_tool`/`branch` dependents are warned about, never auto-rerun.** The human has to notice the warning and handle those manually (e.g. by hand-editing whatever the stale tool call produced) — there's no assisted path for that in v1.

## Testing

TDD per layer, matching how items 6-10 were built this session:

- `tests/repo/hints.test.ts` — CRUD round-trip.
- `tests/rule/executor.test.ts` — hint injection appends the notes block only when hints exist; `rerunStep` finds a step by output key (including inside a branch and inside a called sub-rule), overwrites only that context key, throws when the step no longer exists in the active rule.
- `tests/rule/dependents.test.ts` — `findDependentSteps` finds a direct `ai`/`agent` dependent, follows a transitive chain (A → B → C), classifies an `mcp_tool` dependent and a `branch` whose `on` matches as `unsafe`, ignores steps not in `ranOutputs`, ignores steps inside an un-taken branch case.
- `tests/orchestrator.test.ts` — `rerunStep` persists the patch without disturbing task state or other context keys.
- `tests/api/server.test.ts` — the five new routes.
- `tests/client/` — none planned; the UI pieces are thin enough to verify live via Playwright against the running dev server, same as items 9 and 10.

Full `bun run typecheck` + `bun test` clean before considering any task in the resulting plan done, per this repo's standing convention.
