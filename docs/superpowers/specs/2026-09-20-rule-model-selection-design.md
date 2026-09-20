# Rules (formerly pipelines): per-step model selection, and an editing UI

**Status:** design approved, not yet planned/implemented.

## Problem

Every model call in Jidoka goes through one `AiProvider`, configured once at startup with a single model for everything — triage, the pipeline builder, and every `ai`/`agent` step in every pipeline run the same model regardless of how simple or demanding the step is. There is also no way to see or edit a pipeline once it's built: `TypeWithPipelines` carries the data and `GET /api/pipelines/:id` exists, but nothing in the client renders it except a raw `JSON.stringify` dump in the one-shot `Onboarding` dialog (open item #5 in the project's tracked gaps). Finally, "pipeline" reads as more formal/pretentious than the feature needs — "rule" is the name going forward.

This plan does three things together, because they share the same touch points (the domain schema, the builder, the executor, and the one UI surface that renders a definition):

1. Rename pipeline → rule throughout the codebase, DB, API, and docs.
2. Let each `ai`/`agent` step declare which model it runs on, auto-picked by the rule-building LLM from a provider-specific catalog and freely overridable.
3. Build the missing UI: an entry point that lists every type's rules, and an editor that renders a rule as a box per step (with a model dropdown on model-bearing steps) and can save edits as a new version.

## Scope

**In scope:** the rename; a per-provider model catalog and a `GET /api/models` route; `model` on `ai`/`agent` steps in the schema, builder, and executor/agent-runner plumbing; a `Rules` panel and a shared `RuleEditor` used both there and by (renamed) `Onboarding`; a route to save a hand-edited definition as a new draft version without going through the LLM; a route exposing the MCP tool catalog over HTTP (`GET /api/mcp/tools`) so the editor can render agent-step tool pickers and `mcp_tool` step editors.

**Explicitly out of scope** (per the brainstorming decisions):
1. **Switching or connecting the AI provider from the UI.** The active provider (`anthropic` / `openai` / `agent-sdk`) stays env-configured exactly as today. This plan only adds model choice *within* whichever provider is already active.
2. **A deterministic model-selection rule.** Model auto-pick is entirely the rule-building LLM's judgment, given the catalog in its prompt — no code-side heuristic (e.g. "agent steps always get X") is introduced.
3. **Preserving old `pipelines` table data.** Existing rows are test data; the migration renames the table outright (`CREATE TABLE ... rules` + `DROP TABLE IF EXISTS pipelines`), no data-preserving rename logic.
4. **A verified, exhaustive OpenAI model catalog.** The OpenAI entries are a small best-effort starting list, clearly meant to be hand-edited in one file as OpenAI's lineup changes — this plan does not attempt to track that lineup accurately.
5. **General config-field editing, MCP-server installation from the UI, approval gates before write tools**, and the other items already tracked as open — untouched by this plan.

## 1. Rename: pipeline → rule

Mechanical rename across:
- `src/domain/pipeline.ts` → `src/domain/rule.ts`. `Pipeline`→`Rule`, `PipelineStatus`→`RuleStatus`, `PipelineStep`→`RuleStep`, `PipelineStepSchema`→`RuleStepSchema`, `PipelineDefinition(Schema)`→`RuleDefinition(Schema)`, `NewPipeline`→`NewRule`. `HandoffTargetSchema`/`HandoffTarget` keep their names (not pipeline-specific).
- `src/repo/pipelines.ts` → `src/repo/rules.ts`: `insertPipeline`→`insertRule`, `getPipeline`→`getRule`, `getActivePipeline`→`getActiveRule`, `listPipelines`→`listRules`, `activatePipeline`→`activateRule`.
- `src/pipeline/` → `src/rule/` (`builder.ts`, `executor.ts`, `template.ts`). `buildPipeline`→`buildRule`, `runPipeline`→`runRule`, `PipelineLoader`→`RuleLoader`, `ExecutorDeps.loadPipeline`→`loadRule`. `BUILDER_SYSTEM` → `RULE_BUILDER_SYSTEM`.
- `src/orchestrator.ts`: `runPipelineForTask`→`runRuleForTask`, `activateTypePipeline`→`activateTypeRule`, `processWaitingTasks` signature takes a `Rule`, `pipelineLog` context key → `ruleLog` (bump the one place `TaskDetail.tsx` reads it too).
- `src/api/server.ts`: `/api/pipelines/:id` → `/api/rules/:id`, `/api/pipelines/:id/activate` → `/api/rules/:id/activate`, `/api/types/:id/onboard` keeps its path (onboarding a *type*) but its response key `pipeline`→`rule`.
- `src/client/api.ts`: `Pipeline` import → `Rule`, `TypeWithPipelines`→`TypeWithRules` (`pipelines`→`rules` array, `activePipelineId`→`activeRuleId`), `api.pipeline()`→`api.rule()`, `api.onboard()`/`api.activate()` keep their names but return/accept `Rule`.
- `src/client/Onboarding.tsx`, `TypeConfirm.tsx`, `TaskDetail.tsx`, `App.tsx`: update imports and user-visible copy ("Build pipeline" → "Build rule", "Proposed pipeline" → "Proposed rule", "What the pipeline produced" → "What the rule produced", etc.).
- `CLAUDE.md`: the code-map bullet for `src/pipeline/` becomes `src/rule/`, and the "Per-type pipelines" section and every other body reference to "pipeline" is reworded to "rule" — this is product terminology now, not just internal code.
- All eight test files under `tests/pipeline/`, `tests/repo/pipelines.test.ts`, and pipeline references in `tests/orchestrator.test.ts`/`tests/api/server.test.ts` move/rename in lockstep (`tests/pipeline/` → `tests/rule/`).

**DB:** in `src/db/migrations.ts`, rename the `CREATE TABLE IF NOT EXISTS pipelines (...)` statement's table name to `rules` (columns unchanged), and add `DROP TABLE IF EXISTS pipelines` as the next migration entry to clean up the old table. Per the user, existing rows are test data — no data migration needed.

## 2. Model catalog

New `src/ai/models.ts`:

```typescript
export interface ModelOption {
  id: string;
  label: string;
  blurb: string; // one line: when to pick it
}

/** `agent-sdk` is still Claude, just via the CLI — same catalog as `anthropic`. */
export function modelCatalog(provider: "anthropic" | "openai" | "agent-sdk"): ModelOption[] {
  if (provider === "openai") {
    return [
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", blurb: "fastest, cheapest — simple classification or extraction" },
      { id: "gpt-4.1", label: "GPT-4.1", blurb: "balanced default — most drafting and judgment steps" },
    ];
  }
  return [
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", blurb: "fastest, cheapest — simple classification or extraction" },
    { id: "claude-sonnet-5", label: "Sonnet 5", blurb: "balanced default — most drafting and judgment steps" },
    { id: "claude-opus-5", label: "Opus 5", blurb: "most capable — nuanced judgment or complex multi-tool agent steps" },
  ];
}
```

New route in `src/api/server.ts`:
- `GET /api/models` → `{ provider: config.ai.provider, models: modelCatalog(config.ai.provider) }`.

New route reusing existing server-side capability:
- `GET /api/mcp/tools` → `{ tools: deps.mcp.listTools() }` — a thin wrapper; `listTools()` already exists on `AppDeps.mcp` and is already used by `onboardType`, it just never had an HTTP route.

## 3. Rule schema: `model` on ai/agent steps

In `src/domain/rule.ts`:

```typescript
const AiStep = z.object({
  id: z.string(),
  type: z.literal("ai"),
  prompt: z.string(),
  /** Catalog id from src/ai/models.ts. Unset = fall back to config.ai.model. */
  model: z.string().optional(),
  output: z.string(),
});

const AgentStep = z.object({
  id: z.string(),
  type: z.literal("agent"),
  prompt: z.string(),
  tools: z.array(z.string()).default([]),
  maxIterations: z.number().int().min(1).max(20).default(6),
  /** Catalog id from src/ai/models.ts. Unset = fall back to config.agent.model. */
  model: z.string().optional(),
  output: z.string(),
});
```

`mcp_tool`, `assign`, `branch`, and `call_pipeline` steps get no `model` field — they're logic, not model calls. The editor renders a plain "no model — logic" badge for these rather than a dropdown, driven purely by `step.type`.

## 4. Builder: LLM picks the model

`RULE_BUILDER_SYSTEM` (renamed `BUILDER_SYSTEM`) gains a models section, and `BuildInput` gains a `models: ModelOption[]` field (passed by the caller, from `modelCatalog(config.ai.provider)`):

```
Available models (set "model" on every "ai" and "agent" step to the best-fit id below; omit it only if truly indifferent):
- claude-haiku-4-5-20251001 — fastest, cheapest — simple classification or extraction
- claude-sonnet-5 — balanced default — most drafting and judgment steps
- claude-opus-5 — most capable — nuanced judgment or complex multi-tool agent steps
```

`validateReferences` gains a check: for every `ai`/`agent` step with a `model` set, it must be one of the catalog ids passed in — same retry-with-feedback loop already used for unknown tool names (up to 2 attempts, feedback fed back verbatim on retry).

## 5. Plumbing: model override through to the provider/runner

- `CompleteRequest` (`src/ai/provider.ts`) gains `model?: string`.
- `anthropic.ts` / `openai.ts` / `agentSdkProvider.ts`: each `complete()` uses `req.model ?? model` (the provider's own startup-configured default) when calling its SDK — no new client instances, this is a per-call override on the already-built client.
- `AgentRunInput` (`src/agent/runner.ts`) gains `model?: string`.
- `createInProcessRunner`: passes `model: input.model` into its `deps.provider.complete()` call.
- `createAgentSdkRunner` (`src/agent/claudeAgentSdk.ts`): `queryOptions.model = input.model ?? options.model` (was `options.model` only).
- `src/rule/executor.ts`: the `"ai"` case passes `model: step.model` in its `complete()` call; the `"agent"` case passes `model: step.model` in its `runner.run()` call. No other executor change — it already forwards whatever's on the step.

## 6. UI

**Entry point — new `Rules.tsx`** panel, opened from the header next to `Extensions` (same styling family as `Extensions.tsx`/`SignIn.tsx`). Lists every task type with its rule status — active vN, draft pending review, or none — sourced from the existing `GET /api/types` (`TypeWithRules`). Selecting a type opens `RuleEditor` for it.

**Shared `RuleEditor`** (new component), given a type and an optional existing `Rule`:
- A description textarea + "Generate" button — calls `POST /api/types/:id/onboard` exactly as today, decoupled from requiring a waiting task.
- Renders the resulting/loaded definition as an ordered list of **step boxes** via a recursive `StepList` component (`branch` steps nest a `StepList` per case plus one for `default` — the only recursive shape in `RuleStepSchema`).
- Each box: step-type label, inline-editable fields for that type —
  - `ai`: prompt (textarea), output (context-key input), model dropdown.
  - `agent`: prompt (textarea), tools (multi-select sourced from `GET /api/mcp/tools`), maxIterations (number), output, model dropdown.
  - `mcp_tool`: server+tool (dropdown from `GET /api/mcp/tools`), input (raw JSON textarea — no key/value builder, kept simple), output.
  - `assign`: to (ai/human), note (textarea), handoff targets (small list editor: kind dropdown + the 1-2 fields each kind needs).
  - `branch`: on (context-key input), plus its nested `StepList`s per case/default.
  - `call_pipeline`: typeId + version (dropdowns from `GET /api/types`).
  - Model dropdown (populated from `GET /api/models`) only on `ai`/`agent` boxes, pre-filled with whatever the LLM set and labeled "auto-picked" until touched; every other box shows a static "no model — logic" badge instead.
- Two save paths:
  - **Regenerate** — edits the description, re-runs `POST /api/types/:id/onboard`, replaces the whole step list with a fresh LLM-authored draft (including fresh auto-picked models).
  - **Save as new version** — takes the current, possibly hand-edited definition as-is and posts it directly, no LLM involved. New route `POST /api/types/:id/rules` (body: `{ definition: RuleDefinition }`) → validates with `RuleDefinitionSchema.safeParse`, 400 with issues on failure, else `insertRule` (same "new draft version" path `insertPipeline` already implements — version auto-increments per type).
- **Activate** on any non-active version — existing `POST /api/rules/:id/activate`.
- A compact version history list (id, version, status) — already available from `GET /api/types`'s `rules` array, no new data needed.

**`Onboarding.tsx`** becomes a thin wrapper around `RuleEditor`: adds the task banner ("First task: …") and the "Skip — assign to a human for now" button, otherwise delegates entirely to `RuleEditor`. This means task-triggered onboarding and proactive rule authoring/editing share one implementation instead of two.

## Testing

- `tests/ai/models.test.ts` — `modelCatalog` returns the right list per provider id, agent-sdk and anthropic share a catalog.
- `tests/rule/builder.test.ts` (renamed from `tests/pipeline/builder.test.ts`) extended: a stub provider response with a valid-catalog `model` on an `ai` step round-trips; an invalid `model` id triggers the retry-with-feedback path and a corrected second response succeeds.
- `tests/ai/provider.test.ts` / existing anthropic/openai provider tests extended: `req.model` overrides the client call's model argument when set, falls back to the configured default when absent.
- `tests/agent/runner.test.ts` and the agent-sdk runner's tests: `AgentRunInput.model` is forwarded to the stubbed `provider.complete()` / `queryFn` call respectively.
- `tests/rule/executor.test.ts` (renamed): a step with `model` set produces a `complete()`/`run()` call carrying that model; a step without one omits it (falls back downstream).
- `tests/api/server.test.ts` extended: `GET /api/models` shape for each configured provider; `GET /api/mcp/tools` returns the stub MCP's catalog; `POST /api/types/:id/rules` happy path (creates a new draft version, versions increment correctly alongside an existing onboarded one) and its schema-validation-failure 400 path.
- `tests/db/migrations.test.ts` (or wherever migrations are exercised): the `rules` table exists post-migration and `pipelines` does not.
