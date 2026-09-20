# Rule rename + per-step model selection: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename "pipeline" to "rule" everywhere, let each `ai`/`agent` step declare a provider-scoped model (auto-picked by the rule-building LLM, freely overridable), and build the missing UI to list, view, and edit rules.

**Architecture:** A mechanical, whole-codebase rename (Task 1) establishes the new vocabulary before any new behavior is added. A small `src/ai/models.ts` catalog plus a `model?: string` field threaded through `CompleteRequest`/`AgentRunInput`/`RuleStep` lets the executor pass a per-step model override down to whichever provider/runner is already configured (Tasks 2–6), with no new provider instances or config surface. Two small new routes expose the MCP tool catalog and a direct (non-LLM) way to save an edited definition as a new draft version (Task 7). The client gets a `Rules` entry point and a shared `RuleEditor`/`StepList` pair that both it and `Onboarding` use (Task 8).

**Tech Stack:** Bun, TypeScript, Zod, Hono, React 19. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-rule-model-selection-design.md`

## Global Constraints

- Bun is the only runtime — no Node, no Docker. Run tests with `bun test`, typecheck with `bun run typecheck`.
- Every LLM call goes through `AiProvider`; Anthropic defaults to `claude-opus-5` and must never send `budget_tokens` or `thinking`.
- Tests use stub providers and injected `fetch`/`McpLike` seams — no test hits a network.
- Single user, no auth. IDs are `crypto.randomUUID()`, timestamps are ISO-8601 UTC.
- No backwards-compatibility shims: this is a rename, not a deprecation — old names are deleted, not re-exported.
- `src/pipeline/pipelines` table data is test data and may be dropped outright (user's explicit instruction) — no data-preserving migration.

---

## Task 1: Rename pipeline → rule throughout the codebase, DB, and docs

This is a pure mechanical rename with no behavior change, so it skips the usual red/green TDD cycle — the existing test suite (renamed in place) is the correctness check. Do not run this task's shell steps piecemeal; run them in order, then verify once at the end.

**Files:**
- Move: `src/domain/pipeline.ts` → `src/domain/rule.ts`
- Move: `src/repo/pipelines.ts` → `src/repo/rules.ts`
- Move: `src/pipeline/` → `src/rule/` (`builder.ts`, `executor.ts`, `template.ts`)
- Move: `tests/repo/pipelines.test.ts` → `tests/repo/rules.test.ts`
- Move: `tests/pipeline/` → `tests/rule/` (`builder.test.ts`, `executor.test.ts`, `handoff.test.ts`, `template.test.ts`, `toollessAgent.test.ts`)
- Modify (content only, in place): `src/orchestrator.ts`, `src/api/server.ts`, `src/api/handoff.ts`, `src/client/api.ts`, `src/client/App.tsx`, `src/client/Onboarding.tsx`, `src/client/TypeConfirm.tsx`, `src/client/TaskDetail.tsx`, `src/agent/runner.ts`, `src/agent/claudeAgentSdk.ts`, `src/ai/agentSdkProvider.ts`, `src/db/migrations.ts`, `CLAUDE.md`, `README.md`, `docs/try-it.md`, `docs/postman/jidoka.postman_collection.json`, `tests/orchestrator.test.ts`, `tests/api/server.test.ts`
- Create: `tests/db/migrations.test.ts`

**Interfaces:**
- Produces (for every later task in this plan): `Rule`, `RuleStatus`, `RuleStep`, `RuleStepSchema`, `RuleDefinition`, `RuleDefinitionSchema`, `NewRule` (from `src/domain/rule.ts`); `insertRule`, `getRule`, `getActiveRule`, `listRules`, `activateRule` (from `src/repo/rules.ts`); `buildRule`, `RULE_BUILDER_SYSTEM`, `BuildInput` (from `src/rule/builder.ts`); `runRule`, `RuleLoader`, `ExecutorDeps` (with `loadRule`), `resolveHandoff` (from `src/rule/executor.ts`); `runRuleForTask`, `onboardType`, `activateTypeRule`, `AppDeps` (from `src/orchestrator.ts`, `modelProvider` field added in Task 2, not here).

- [ ] **Step 1: Move the renamed files and directories**

```bash
cd "D:/projects/Jidoka"
git mv src/domain/pipeline.ts src/domain/rule.ts
git mv src/repo/pipelines.ts src/repo/rules.ts
git mv src/pipeline src/rule
git mv tests/repo/pipelines.test.ts tests/repo/rules.test.ts
git mv tests/pipeline tests/rule
```

- [ ] **Step 2: Run the ordered rename across every affected file**

The token list below is ordered longest-match-first so no earlier replacement can corrupt a later, shorter one nested inside it (e.g. `PipelineDefinitionSchema` is renamed whole before the bare `Pipeline` pass ever runs). `src/db/migrations.ts` is deliberately excluded — it's handled by hand in Step 3, because the automated `pipelines` → `rules` swap would also rewrite the `DROP TABLE` statement that Step 3 adds.

```bash
cd "D:/projects/Jidoka"

FILES=(
  src/domain/rule.ts
  src/repo/rules.ts
  src/rule/builder.ts
  src/rule/executor.ts
  src/rule/template.ts
  src/orchestrator.ts
  src/api/server.ts
  src/api/handoff.ts
  src/client/api.ts
  src/client/App.tsx
  src/client/Onboarding.tsx
  src/client/TypeConfirm.tsx
  src/client/TaskDetail.tsx
  src/agent/runner.ts
  src/agent/claudeAgentSdk.ts
  src/ai/agentSdkProvider.ts
  CLAUDE.md
  README.md
  docs/try-it.md
  docs/postman/jidoka.postman_collection.json
  tests/repo/rules.test.ts
  tests/rule/builder.test.ts
  tests/rule/executor.test.ts
  tests/rule/handoff.test.ts
  tests/rule/toollessAgent.test.ts
  tests/rule/template.test.ts
  tests/orchestrator.test.ts
  tests/api/server.test.ts
)

OLD=(PipelineDefinitionSchema activateTypePipeline TypeWithPipelines runPipelineForTask CallPipelineStep PipelineStepSchema getActivePipeline activePipelineId PipelineDefinition activatePipeline noPipelines insertPipeline PipelineLoader listPipelines buildPipeline loadPipeline toPipeline runPipeline getPipeline PipelineStatus call_pipeline pipelineLog pipelineId PipelineStep NewPipeline PIPELINE Pipelines Pipeline pipelines pipeline)
NEW=(RuleDefinitionSchema activateTypeRule TypeWithRules runRuleForTask CallRuleStep RuleStepSchema getActiveRule activeRuleId RuleDefinition activateRule noRules insertRule RuleLoader listRules buildRule loadRule toRule runRule getRule RuleStatus call_rule ruleLog ruleId RuleStep NewRule RULE Rules Rule rules rule)

for f in "${FILES[@]}"; do
  for i in "${!OLD[@]}"; do
    sed -i -E "s/\\b${OLD[$i]}\\b/${NEW[$i]}/g" "$f"
  done
done
```

- [ ] **Step 3: Hand-edit the DB migration**

Read `src/db/migrations.ts`, then apply:

```typescript
  `CREATE TABLE IF NOT EXISTS rules (
     id TEXT PRIMARY KEY,
     type_id TEXT NOT NULL REFERENCES task_types(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     status TEXT NOT NULL,
     definition TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (type_id, version)
   )`,
  `DROP TABLE IF EXISTS pipelines`,
```

(replacing the old `CREATE TABLE IF NOT EXISTS pipelines (...)` entry, and inserting the `DROP TABLE` entry immediately after it, in the same position in the `MIGRATIONS` array.)

- [ ] **Step 4: Add a migration test confirming the table rename**

Create `tests/db/migrations.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";

test("migrate creates the rules table and drops the old pipelines table", () => {
  const db = openDb(":memory:");
  migrate(db);

  const names = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);

  expect(names).toContain("rules");
  expect(names).not.toContain("pipelines");
});
```

Run: `bun test tests/db/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and fix anything the automated pass missed**

Run: `bun run typecheck`
Expected: no errors. If there are errors, they'll name an old identifier that survived (e.g. a call site not in the `FILES` list) — fix those specific spots by hand with the same old→new mapping from Step 2, then re-run.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: every test passes, and no test name or assertion still contains the word "pipeline" (spot-check with `grep -ri pipeline tests/` — expect no output).

- [ ] **Step 7: Confirm no stray references remain anywhere in the tracked repo**

Run: `grep -ril pipeline --include='*.ts' --include='*.tsx' --include='*.md' --include='*.json' -- src tests docs CLAUDE.md README.md`
Expected: no output. (Do not touch `.claude/worktrees/` — it's a separate git worktree on another branch, out of scope.)

- [ ] **Step 8: Commit**

```bash
git add -A -- src tests docs CLAUDE.md README.md tests/db/migrations.test.ts
git commit -m "$(cat <<'EOF'
refactor: rename pipeline to rule throughout the codebase

"Pipeline" read as more formal than the feature needs. Renames the
domain type, DB table, repo module, executor/builder, API routes, and
every doc reference to "rule" — no behavior change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Model catalog module, `AppDeps.modelProvider`, and `GET /api/models`

**Files:**
- Create: `src/ai/models.ts`
- Test: `tests/ai/models.test.ts`
- Modify: `src/config.ts` (reuse the new `ModelProviderId` type instead of duplicating the union)
- Modify: `src/orchestrator.ts` (`AppDeps` gains `modelProvider`)
- Modify: `src/main.ts` (pass `config.ai.provider` into `AppDeps`)
- Modify: `src/api/server.ts` (add `GET /api/models`)
- Modify: `tests/orchestrator.test.ts` (its `deps()` helper builds `AppDeps`)
- Modify: `tests/api/server.test.ts` (its `app()` helper builds `AppDeps`; add a test for the new route)

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `ModelProviderId` (`"anthropic" | "openai" | "agent-sdk"`), `ModelOption { id: string; label: string; blurb: string }`, `modelCatalog(provider: ModelProviderId): ModelOption[]` — all from `src/ai/models.ts`, used by Task 5 (builder) and Task 8 (client).

- [ ] **Step 1: Write the failing test**

Create `tests/ai/models.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { modelCatalog } from "../../src/ai/models";

test("anthropic and agent-sdk share the Claude catalog", () => {
  const anthropic = modelCatalog("anthropic");
  const agentSdk = modelCatalog("agent-sdk");

  expect(anthropic).toEqual(agentSdk);
  expect(anthropic.map((m) => m.id)).toEqual([
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
    "claude-opus-5",
  ]);
});

test("openai has its own, smaller catalog", () => {
  const openai = modelCatalog("openai");
  expect(openai.map((m) => m.id)).toEqual(["gpt-4.1-mini", "gpt-4.1"]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test tests/ai/models.test.ts`
Expected: FAIL — `src/ai/models.ts` does not exist.

- [ ] **Step 3: Create the catalog module**

Create `src/ai/models.ts`:

```typescript
export type ModelProviderId = "anthropic" | "openai" | "agent-sdk";

export interface ModelOption {
  id: string;
  label: string;
  blurb: string;
}

const CLAUDE_MODELS: ModelOption[] = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    blurb: "fastest, cheapest — simple classification or extraction",
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    blurb: "balanced default — most drafting and judgment steps",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    blurb: "most capable — nuanced judgment or complex multi-tool agent steps",
  },
];

const OPENAI_MODELS: ModelOption[] = [
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    blurb: "fastest, cheapest — simple classification or extraction",
  },
  { id: "gpt-4.1", label: "GPT-4.1", blurb: "balanced default — most drafting and judgment steps" },
];

/** `agent-sdk` is still Claude, just run through the CLI — same catalog as `anthropic`. */
export function modelCatalog(provider: ModelProviderId): ModelOption[] {
  return provider === "openai" ? OPENAI_MODELS : CLAUDE_MODELS;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test tests/ai/models.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `ModelProviderId` into `Config`**

In `src/config.ts`, add the import and replace the inline union:

```typescript
import type { ModelProviderId } from "./ai/models";
```

Change:
```typescript
    provider: "anthropic" | "openai" | "agent-sdk";
```
to:
```typescript
    provider: ModelProviderId;
```

- [ ] **Step 6: Add `modelProvider` to `AppDeps`**

In `src/orchestrator.ts`, add the import and field:

```typescript
import type { ModelProviderId } from "./ai/models";
```

```typescript
export interface AppDeps {
  db: Database;
  provider: AiProvider;
  modelProvider: ModelProviderId;
  mcp: { listTools(): ToolSpec[]; callTool: ToolCaller };
  runAgent?: AgentRunner;
}
```

- [ ] **Step 7: Wire it in `main.ts`**

In `src/main.ts`, change the `deps` construction:

```typescript
  const deps: AppDeps = {
    db,
    runAgent,
    provider,
    modelProvider: config.ai.provider,
    mcp: {
      listTools: () => mcp.listTools(),
      callTool: (server, tool, input) => mcp.callTool(server, tool, input),
    },
  };
```

- [ ] **Step 8: Add `GET /api/models`**

In `src/api/server.ts`, add the import:

```typescript
import { modelCatalog } from "../ai/models";
```

Add the route (anywhere alongside the other `GET` routes):

```typescript
  app.get("/api/models", (c) =>
    c.json({ provider: deps.modelProvider, models: modelCatalog(deps.modelProvider) }),
  );
```

- [ ] **Step 9: Fix the two test helpers that build `AppDeps`**

In `tests/orchestrator.test.ts`, in the `deps()` helper, add the new field:

```typescript
  return {
    db,
    provider,
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };
```

In `tests/api/server.test.ts`, in the `app()` helper, add the same field:

```typescript
  const deps: AppDeps = {
    db,
    provider,
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };
```

- [ ] **Step 10: Write the route test**

Add to `tests/api/server.test.ts`:

```typescript
test("GET /api/models returns the configured provider's catalog", async () => {
  const { fetch } = app();

  const body = (await (await fetch(new Request("http://localhost/api/models"))).json()) as {
    provider: string;
    models: { id: string; label: string }[];
  };

  expect(body.provider).toBe("anthropic");
  expect(body.models.map((m) => m.id)).toContain("claude-sonnet-5");
});
```

- [ ] **Step 11: Run the full suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add src/ai/models.ts src/config.ts src/orchestrator.ts src/main.ts src/api/server.ts tests/ai/models.test.ts tests/orchestrator.test.ts tests/api/server.test.ts
git commit -m "$(cat <<'EOF'
feat: add a provider-scoped model catalog and GET /api/models

Adds the Claude and OpenAI model options rules will be able to pick
per step, and a route for the client to read the active provider's
catalog. No behavior change yet — nothing consumes a chosen model.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `CompleteRequest.model` override on every `AiProvider`

**Files:**
- Modify: `src/ai/provider.ts`
- Modify: `src/ai/anthropic.ts`
- Modify: `src/ai/openai.ts`
- Modify: `src/ai/agentSdkProvider.ts`
- Test: `tests/ai/agentSdkProvider.test.ts` (the only one of the three with an existing seam for asserting what reaches the "wire")

**Interfaces:**
- Consumes: nothing new.
- Produces: `CompleteRequest.model?: string` — an optional per-call override, consumed by `src/rule/executor.ts` in Task 6.

- [ ] **Step 1: Write the failing test**

Add to `tests/ai/agentSdkProvider.test.ts`:

```typescript
test("a per-request model overrides the provider's configured default", async () => {
  const seen: { options?: Record<string, unknown> } = {};
  const provider = createAgentSdkProvider({
    model: "claude-sonnet-5",
    queryFn: fakeQuery([success], seen),
  });

  await provider.complete({ messages: [{ role: "user", content: "x" }], model: "claude-opus-5" });

  expect(seen.options?.model).toBe("claude-opus-5");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test tests/ai/agentSdkProvider.test.ts -t "overrides the provider's configured default"`
Expected: FAIL — `complete` accepts no `model` field yet (a TypeScript error at the call site, since `CompleteRequest` doesn't declare it).

- [ ] **Step 3: Add `model` to `CompleteRequest`**

In `src/ai/provider.ts`:

```typescript
export interface CompleteRequest {
  system?: string;
  messages: AiMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  model?: string;
}
```

- [ ] **Step 4: Honor it in `anthropic.ts`**

In `src/ai/anthropic.ts`, inside `complete()`, change:

```typescript
      const response = await client.messages.create({
        model,
```
to:
```typescript
      const response = await client.messages.create({
        model: req.model ?? model,
```

- [ ] **Step 5: Honor it in `openai.ts`**

In `src/ai/openai.ts`, inside `complete()`, change:

```typescript
      const response = await client.chat.completions.create({
        model,
```
to:
```typescript
      const response = await client.chat.completions.create({
        model: req.model ?? model,
```

- [ ] **Step 6: Honor it in `agentSdkProvider.ts`**

In `src/ai/agentSdkProvider.ts`, inside `complete()`, change:

```typescript
      if (options.model) queryOptions.model = options.model;
```
to:
```typescript
      const model = req.model ?? options.model;
      if (model) queryOptions.model = model;
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `bun test tests/ai/agentSdkProvider.test.ts`
Expected: PASS (all tests in the file, including the existing "system prompt and model are passed" one, which is unaffected since it doesn't set `req.model`).

- [ ] **Step 8: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass. (`anthropic.ts`/`openai.ts` have no dedicated unit tests today — same as before this change — so their correctness here rests on the type change plus this manual review: both now read `req.model ?? model` in place of the bare `model` they read before.)

- [ ] **Step 9: Commit**

```bash
git add src/ai/provider.ts src/ai/anthropic.ts src/ai/openai.ts src/ai/agentSdkProvider.ts tests/ai/agentSdkProvider.test.ts
git commit -m "$(cat <<'EOF'
feat: let a single completion request override the provider's model

CompleteRequest.model, when set, wins over whatever model the
provider was configured with at startup — a per-call override, not a
new client instance. Nothing sets it yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `AgentRunInput.model` override on both agent runners

**Files:**
- Modify: `src/agent/runner.ts`
- Modify: `src/agent/claudeAgentSdk.ts`
- Test: `tests/agent/claudeAgentSdk.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentRunInput.model?: string` — consumed by `src/rule/executor.ts` in Task 6. (`createInProcessRunner`'s forwarding of it is verified in Task 6, which already stubs `provider.complete()` for an agent step — `runner.ts` has no dedicated test file today; agent-step behavior is tested through the executor, and this plan follows that existing pattern rather than introducing a new one.)

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/claudeAgentSdk.test.ts`:

```typescript
test("a per-run model overrides the runner's configured default", async () => {
  let captured: CapturedParams | undefined;
  const runner = createAgentSdkRunner({
    mcpServers: {},
    model: "claude-sonnet-5",
    queryFn: capturingQuery([successResult("done")], (params) => {
      captured = params;
    }),
  });

  await runner.run(baseInput({ model: "claude-opus-5" }));

  expect(captured?.options?.model).toBe("claude-opus-5");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test tests/agent/claudeAgentSdk.test.ts -t "overrides the runner's configured default"`
Expected: FAIL — `baseInput`'s `AgentRunInput` has no `model` field yet.

- [ ] **Step 3: Add `model` to `AgentRunInput`**

In `src/agent/runner.ts`:

```typescript
export interface AgentRunInput {
  prompt: string;
  systemPrompt?: string;
  allowedTools: string[];
  maxTurns: number;
  model?: string;
}
```

- [ ] **Step 4: Forward it in the in-process runner**

In `src/agent/runner.ts`, inside `createInProcessRunner`'s `run()`, change:

```typescript
        const result = await deps.provider.complete({
          ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
          messages,
          tools: specs,
          maxTokens: 8000,
        });
```
to:
```typescript
        const result = await deps.provider.complete({
          ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
          ...(input.model ? { model: input.model } : {}),
          messages,
          tools: specs,
          maxTokens: 8000,
        });
```

- [ ] **Step 5: Forward it in the Agent SDK runner**

In `src/agent/claudeAgentSdk.ts`, inside `run()`, change:

```typescript
      if (options.model) queryOptions.model = options.model;
```
to:
```typescript
      const model = input.model ?? options.model;
      if (model) queryOptions.model = model;
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `bun test tests/agent/claudeAgentSdk.test.ts`
Expected: PASS (all tests, including the existing "maxBudgetUsd and model are passed through when set" one).

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/agent/runner.ts src/agent/claudeAgentSdk.ts tests/agent/claudeAgentSdk.test.ts
git commit -m "$(cat <<'EOF'
feat: let a single agent run override the runner's configured model

AgentRunInput.model, when set, wins over the runner's startup default
in both backends. Nothing sets it yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `model` on `ai`/`agent` steps — schema, builder auto-pick, orchestrator wiring

**Files:**
- Modify: `src/domain/rule.ts` (schema)
- Modify: `src/rule/builder.ts` (prompt + validation)
- Modify: `src/orchestrator.ts` (pass the catalog into `buildRule`)
- Test: `tests/rule/builder.test.ts`

**Interfaces:**
- Consumes: `ModelOption`, `modelCatalog` (Task 2).
- Produces: `AiStep.model?: string`, `AgentStep.model?: string` on `RuleStep`, consumed by `src/rule/executor.ts` in Task 6. `BuildInput.models: ModelOption[]`, consumed by `onboardType` (this task) and by the client-side `RuleEditor` for its dropdown catalog is `GET /api/models`, not this — this field only feeds the LLM prompt.

- [ ] **Step 1: Write the failing tests**

Add to `tests/rule/builder.test.ts` (adjust the existing `valid`/calls to also pass `models: []` where `buildRule` is already called — see Step 2 note below):

```typescript
import { modelCatalog } from "../../src/ai/models";

const models = modelCatalog("anthropic");

test("buildRule keeps a model the response sets on an ai/agent step", async () => {
  const withModel = JSON.stringify({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", model: "claude-haiku-4-5-20251001", output: "summary" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const provider = scripted([withModel]);

  const definition = await buildRule(provider, { type, description: "d", tools: [], models });

  expect(definition.steps[0]).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  expect(provider.prompts[0]).toContain("claude-haiku-4-5-20251001");
});

test("buildRule retries when the response sets an unknown model id", async () => {
  const provider = scripted([
    JSON.stringify({
      steps: [
        { id: "s1", type: "ai", prompt: "x", model: "gpt-nonexistent", output: "o" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
    valid,
  ]);

  const definition = await buildRule(provider, { type, description: "d", tools: [], models });

  expect(definition.steps).toHaveLength(2);
  expect(provider.prompts[1]).toContain("gpt-nonexistent");
});
```

Also update every existing call to `buildRule(provider, { type, description: ..., tools: ... })` in this file to include `models` (use `models: []` for the three pre-existing tests, since they don't exercise model selection).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/rule/builder.test.ts`
Expected: FAIL — `BuildInput` has no `models` field, `AiStep` has no `model` field, and nothing validates it.

- [ ] **Step 3: Add `model` to the schema**

In `src/domain/rule.ts`, change `AiStep` and the `AgentStep` (the names are already `RuleStep`-family after Task 1's rename — the local `const` names `AiStep`/`AgentStep` are unaffected by that rename, they were never "Pipeline"-prefixed):

```typescript
const AiStep = z.object({
  id: z.string(),
  type: z.literal("ai"),
  prompt: z.string(),
  /** Catalog id from src/ai/models.ts. Unset falls back to config.ai.model. */
  model: z.string().optional(),
  output: z.string(),
});

const AgentStep = z.object({
  id: z.string(),
  type: z.literal("agent"),
  prompt: z.string(),
  tools: z.array(z.string()).default([]),
  maxIterations: z.number().int().min(1).max(20).default(6),
  /** Catalog id from src/ai/models.ts. Unset falls back to config.agent.model. */
  model: z.string().optional(),
  output: z.string(),
});
```

- [ ] **Step 4: Add the model catalog to the builder prompt and `BuildInput`**

In `src/rule/builder.ts`, add the import:

```typescript
import type { ModelOption } from "../ai/models";
```

Add `models` to `BuildInput`:

```typescript
export interface BuildInput {
  type: TaskType;
  description: string;
  tools: ToolSpec[];
  models: ModelOption[];
}
```

Add a catalog-formatting helper and include it in the user message:

```typescript
function modelCatalogText(models: ModelOption[]): string {
  return models.map((m) => `- ${m.id} — ${m.blurb}`).join("\n");
}
```

In `userMessage`, add a section:

```typescript
function userMessage(input: BuildInput): string {
  return `Task type: ${input.type.name}
Type description: ${input.type.description}

How the user wants these tasks handled:
${input.description}

Available MCP tools:
${toolCatalog(input.tools)}

Available models (set "model" on every "ai" and "agent" step to the best-fit id below; omit only if truly indifferent):
${modelCatalogText(input.models)}`;
}
```

Update `RULE_BUILDER_SYSTEM`'s `ai`/`agent` step shape lines to mention `model`:

```
- { "id": "s1", "type": "ai", "prompt": "<prompt, may use {{task.title}}, {{task.body}}, {{task.metadata.<key>}}, {{context.<key>}}>", "model": "<catalog id, or omit>", "output": "<context key>" }
- { "id": "s1b", "type": "agent", "prompt": "<what to find out and what to produce>", "tools": ["<server>__<tool>", ...], "maxIterations": 6, "model": "<catalog id, or omit>", "output": "<context key>" }
```

(replacing the two existing lines with the same content plus the new `"model"` field.)

- [ ] **Step 5: Validate the model id in `validateReferences`**

In `src/rule/executor.ts` — no wait, in `src/rule/builder.ts`'s `validateReferences`, change its signature and add the check:

```typescript
function validateReferences(definition: RuleDefinition, tools: ToolSpec[], models: ModelOption[]): string[] {
  const available = new Set(tools.map((t) => t.name));
  const availableModels = new Set(models.map((m) => m.id));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const step of collectSteps(definition.steps)) {
    if (seen.has(step.id)) problems.push(`duplicate step id: ${step.id}`);
    seen.add(step.id);

    if (step.type === "mcp_tool") {
      const name = `${step.server}${TOOL_SEPARATOR}${step.tool}`;
      if (!available.has(name)) {
        problems.push(`unknown tool "${step.server}/${step.tool}" — it is not in the available tool list`);
      }
    }

    if (step.type === "agent") {
      for (const name of step.tools) {
        if (!available.has(name)) {
          problems.push(`unknown tool "${name}" — it is not in the available tool list`);
        }
      }
    }

    if ((step.type === "ai" || step.type === "agent") && step.model && !availableModels.has(step.model)) {
      problems.push(`unknown model "${step.model}" — it is not in the available model list`);
    }
  }

  const endsAssigned = (steps: RuleStep[]): boolean => {
    const last = steps.at(-1);
    if (!last) return false;
    if (last.type === "assign") return true;
    if (last.type === "branch") {
      const branches = [...Object.values(last.cases), last.default ?? []];
      return branches.every((branch) => endsAssigned(branch));
    }
    return false;
  };
  if (!endsAssigned(definition.steps)) {
    problems.push("the rule must end on an assign step in every branch");
  }

  return problems;
}
```

Update its one call site inside `buildRule`:

```typescript
    const problems = validateReferences(parsed.data, input.tools, input.models);
```

- [ ] **Step 6: Wire the catalog into `onboardType`**

In `src/orchestrator.ts`, add the import:

```typescript
import { modelCatalog } from "./ai/models";
```

Change `onboardType`:

```typescript
export async function onboardType(
  deps: AppDeps,
  typeId: string,
  description: string,
): Promise<Rule> {
  const type = getTaskType(deps.db, typeId);
  if (!type) throw new Error(`onboardType: unknown type ${typeId}`);

  const definition = await buildRule(deps.provider, {
    type,
    description,
    tools: deps.mcp.listTools(),
    models: modelCatalog(deps.modelProvider),
  });
  return insertRule(deps.db, { typeId, definition });
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `bun test tests/rule/builder.test.ts`
Expected: PASS, all tests in the file (including the three pre-existing ones updated in Step 1 to pass `models: []`).

- [ ] **Step 8: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/domain/rule.ts src/rule/builder.ts src/orchestrator.ts tests/rule/builder.test.ts
git commit -m "$(cat <<'EOF'
feat: let the rule builder pick a model per ai/agent step

The builder's system prompt now carries the active provider's model
catalog and is asked to set "model" on every ai/agent step; an
unknown model id retries with feedback exactly like an unknown tool
does. Nothing runs a step on its chosen model yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Executor forwards `step.model` to the provider/runner

**Files:**
- Modify: `src/rule/executor.ts`
- Test: `tests/rule/executor.test.ts`

**Interfaces:**
- Consumes: `RuleStep.model` (Task 5), `CompleteRequest.model` (Task 3), `AgentRunInput.model` (Task 4).
- Produces: nothing new — this is the last link in the chain; a rule authored with per-step models now actually runs on them.

- [ ] **Step 1: Write the failing tests**

Add to `tests/rule/executor.test.ts`:

```typescript
test("an ai step with a model set passes it to the provider", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", model: "claude-haiku-4-5-20251001", output: "summary" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const seenModels: (string | undefined)[] = [];
  const provider = {
    id: "stub",
    async complete(req: { model?: string }) {
      seenModels.push(req.model);
      return { text: "done", toolCalls: [] };
    },
  };

  await runRule({ provider, callTool: noTools, loadRule: noRules }, definition, task);

  expect(seenModels).toEqual(["claude-haiku-4-5-20251001"]);
});

test("an ai step with no model set passes none", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const seenModels: (string | undefined)[] = [];
  const provider = {
    id: "stub",
    async complete(req: { model?: string }) {
      seenModels.push(req.model);
      return { text: "done", toolCalls: [] };
    },
  };

  await runRule({ provider, callTool: noTools, loadRule: noRules }, definition, task);

  expect(seenModels).toEqual([undefined]);
});

test("an agent step with a model set passes it through the in-process runner", async () => {
  const definition = RuleDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Go",
        tools: [],
        model: "claude-opus-5",
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const seenModels: (string | undefined)[] = [];
  const provider = {
    id: "stub",
    async complete(req: { model?: string }) {
      seenModels.push(req.model);
      return { text: "done", toolCalls: [] };
    },
  };

  await runRule(
    { provider, callTool: noTools, loadRule: noRules, listTools: () => [] },
    definition,
    task,
  );

  expect(seenModels).toEqual(["claude-opus-5"]);
});
```

(`noTools` and `noRules` are the file's existing stub helpers — `noRules` is `noPipelines` after Task 1's automated rename.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/rule/executor.test.ts -t "model"`
Expected: FAIL — every `req.model`/forwarded model comes back `undefined` regardless of what the step sets, because the executor never reads `step.model`.

- [ ] **Step 3: Forward the model in the `"ai"` case**

In `src/rule/executor.ts`, inside `runSteps`, change:

```typescript
      case "ai": {
        const result = await deps.provider.complete({
          messages: [{ role: "user", content: renderTemplate(step.prompt, scope) }],
          maxTokens: 4000,
        });
```
to:
```typescript
      case "ai": {
        const result = await deps.provider.complete({
          messages: [{ role: "user", content: renderTemplate(step.prompt, scope) }],
          maxTokens: 4000,
          ...(step.model ? { model: step.model } : {}),
        });
```

- [ ] **Step 4: Forward the model in the `"agent"` case**

In the same function, change:

```typescript
        let result;
        try {
          result = await runner.run({
            prompt: renderTemplate(step.prompt, scope),
            allowedTools: step.tools,
            maxTurns: step.maxIterations,
          });
```
to:
```typescript
        let result;
        try {
          result = await runner.run({
            prompt: renderTemplate(step.prompt, scope),
            allowedTools: step.tools,
            maxTurns: step.maxIterations,
            ...(step.model ? { model: step.model } : {}),
          });
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bun test tests/rule/executor.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/rule/executor.ts tests/rule/executor.test.ts
git commit -m "$(cat <<'EOF'
feat: run each ai/agent step on the model it was authored with

Closes the loop: a step's model (builder-chosen or hand-set) now
reaches the provider/runner call the executor already makes for that
step, with no model set falling back to the existing config default.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `GET /api/mcp/tools` and `POST /api/types/:id/rules`

**Files:**
- Modify: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

**Interfaces:**
- Consumes: `RuleDefinitionSchema`, `insertRule` (already imported/available post-Task-1).
- Produces: `GET /api/mcp/tools` → `{ tools: ToolSpec[] }`; `POST /api/types/:id/rules` → `{ rule: Rule }` on success, `{ error: string }` (400) on a schema failure — both consumed by the client in Task 8.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/server.test.ts`:

```typescript
test("GET /api/mcp/tools returns the configured tool catalog", async () => {
  const db = openDb(":memory:");
  migrate(db);
  const deps: AppDeps = {
    db,
    provider: { id: "stub", async complete() { return { text: "", toolCalls: [] }; } },
    modelProvider: "anthropic",
    mcp: {
      listTools: () => [{ name: "outlook__get_thread", description: "Fetch a thread", inputSchema: { type: "object" } }],
      callTool: async () => "",
    },
  };
  const server = createServer(deps);

  const body = (await (
    await server.fetch(new Request("http://localhost/api/mcp/tools"))
  ).json()) as { tools: { name: string }[] };

  expect(body.tools.map((t) => t.name)).toEqual(["outlook__get_thread"]);
});

test("POST /api/types/:id/rules saves a hand-edited definition as a new draft version", async () => {
  const { deps, fetch } = app();
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const response = await fetch(
    new Request(`http://localhost/api/types/${type.id}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        definition: {
          steps: [
            { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
            { id: "s2", type: "assign", to: "human" },
          ],
        },
      }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { rule: { version: number; status: string } };
  expect(body.rule).toMatchObject({ version: 1, status: "draft" });
});

test("POST /api/types/:id/rules rejects an invalid definition with 400", async () => {
  const { deps, fetch } = app();
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const response = await fetch(
    new Request(`http://localhost/api/types/${type.id}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition: { steps: [{ id: "s1", type: "teleport" }] } }),
    }),
  );

  expect(response.status).toBe(400);
});
```

(Add `openDb, migrate` to this test file's existing `bun:sqlite`/db imports if not already present — check the top of the file first; it already imports them via `../../src/db` for its own `app()` helper, so reuse that import rather than adding a duplicate.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/api/server.test.ts -t "api/mcp/tools\|api/types/:id/rules"`
Expected: FAIL — both routes 404.

- [ ] **Step 3: Add the imports**

In `src/api/server.ts`, add:

```typescript
import { RuleDefinitionSchema } from "../domain/rule";
```

(`insertRule` should already be imported from `../repo/rules` alongside `getActiveRule`, `getRule`, `listRules` after Task 1 — add it to that same import line if it isn't already there.)

- [ ] **Step 4: Add `GET /api/mcp/tools`**

```typescript
  app.get("/api/mcp/tools", (c) => c.json({ tools: deps.mcp.listTools() }));
```

- [ ] **Step 5: Add `POST /api/types/:id/rules`**

```typescript
  app.post("/api/types/:id/rules", async (c) => {
    const id = c.req.param("id");
    if (!getTaskType(deps.db, id)) return c.json({ error: "unknown type" }, 404);
    const input = await readJson<{ definition?: unknown }>(c);
    if (!input?.definition) return c.json({ error: "definition is required" }, 400);

    const parsed = RuleDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        400,
      );
    }

    return c.json({ rule: insertRule(deps.db, { typeId: id, definition: parsed.data }) });
  });
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `bun test tests/api/server.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "$(cat <<'EOF'
feat: expose the MCP tool catalog and a direct rule-save route

GET /api/mcp/tools lets the client render tool pickers without going
through onboarding. POST /api/types/:id/rules saves a definition the
user hand-edited as a new draft version, with no LLM involved — the
same "new draft version" path onboarding already uses.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Client UI — `Rules` entry point, `RuleEditor`, `StepList`

No automated tests exist for React components in this codebase (`tests/client/columns.test.ts` tests a plain data function, not a component) — this task's verification is `bun run typecheck` plus a manual walkthrough with the dev server, per this project's UI convention.

**Files:**
- Create: `src/client/StepList.tsx`
- Create: `src/client/RuleEditor.tsx`
- Create: `src/client/Rules.tsx`
- Modify: `src/client/api.ts` (add `models`, `mcpTools`, `saveRule`)
- Modify: `src/client/Onboarding.tsx` (delegate to `RuleEditor`)
- Modify: `src/client/App.tsx` (mount `Rules` in the header)
- Modify: `src/client/index.html` (a few new CSS rules for step boxes)

**Interfaces:**
- Consumes: `api.rule`, `api.onboard`, `api.activate` (existing, renamed in Task 1); `GET /api/models`, `GET /api/mcp/tools`, `POST /api/types/:id/rules` (Task 7 and Task 2); `Rule`, `RuleDefinition`, `RuleStep` types (Task 1/5); `ModelOption` type (Task 2); `ToolSpec` type (existing).
- Produces: `RuleEditor` component, reused by both `Onboarding.tsx` and `Rules.tsx` — no other task depends on this one.

- [ ] **Step 1: Add the three new API client methods**

In `src/client/api.ts`, add the imports:

```typescript
import type { RuleDefinition } from "../domain/rule";
import type { ToolSpec } from "../ai/provider";
```

Add the `ModelOption` type (mirrors `src/ai/models.ts` — kept as a plain client-side type rather than importing the server module, matching how `HandoffTarget` is already duplicated here rather than imported):

```typescript
export interface ModelOption {
  id: string;
  label: string;
  blurb: string;
}
```

Add three entries to the `api` object:

```typescript
  models: () => json<{ provider: string; models: ModelOption[] }>("/api/models"),
  mcpTools: () => json<{ tools: ToolSpec[] }>("/api/mcp/tools").then((r) => r.tools),
  saveRule: (typeId: string, definition: RuleDefinition) =>
    json<{ rule: Rule }>(`/api/types/${typeId}/rules`, {
      method: "POST",
      body: JSON.stringify({ definition }),
    }).then((r) => r.rule),
```

- [ ] **Step 2: Create the recursive step-list renderer**

Create `src/client/StepList.tsx`:

```typescript
import type { RuleStep } from "../domain/rule";
import type { ModelOption, TypeWithRules } from "./api";
import type { ToolSpec } from "../ai/provider";

let nextId = 1;
function freshStepId(): string {
  return `s${Date.now()}_${nextId++}`;
}

function defaultStep(type: RuleStep["type"]): RuleStep {
  const id = freshStepId();
  switch (type) {
    case "ai":
      return { id, type: "ai", prompt: "", output: "" };
    case "agent":
      return { id, type: "agent", prompt: "", tools: [], maxIterations: 6, output: "" };
    case "mcp_tool":
      return { id, type: "mcp_tool", server: "", tool: "", input: {}, output: "" };
    case "assign":
      return { id, type: "assign", to: "human" };
    case "branch":
      return { id, type: "branch", on: "", cases: {} };
    case "call_rule":
      return { id, type: "call_rule", typeId: "", version: 1 };
  }
}

const STEP_TYPES: RuleStep["type"][] = ["ai", "agent", "mcp_tool", "branch", "assign", "call_rule"];

interface Ctx {
  models: ModelOption[];
  tools: ToolSpec[];
  types: TypeWithRules[];
}

function ModelPicker({
  value,
  onChange,
  ctx,
}: {
  value: string | undefined;
  onChange: (model: string | undefined) => void;
  ctx: Ctx;
}) {
  return (
    <label>
      Model {value === undefined ? "(auto — none set)" : ""}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(unset — falls back to the default)</option>
        {ctx.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} — {m.blurb}
          </option>
        ))}
      </select>
    </label>
  );
}

function StepBox({
  step,
  onChange,
  onRemove,
  ctx,
}: {
  step: RuleStep;
  onChange: (step: RuleStep) => void;
  onRemove: () => void;
  ctx: Ctx;
}) {
  return (
    <div className="rule-step">
      <div className="rule-step-header">
        <strong>{step.type}</strong>
        <button className="link" onClick={onRemove}>
          Remove
        </button>
      </div>

      {step.type === "ai" && (
        <>
          <label>
            Prompt
            <textarea rows={2} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
          </label>
          <label>
            Output key
            <input value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </label>
          <ModelPicker value={step.model} onChange={(model) => onChange({ ...step, model })} ctx={ctx} />
        </>
      )}

      {step.type === "agent" && (
        <>
          <label>
            Prompt
            <textarea rows={2} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
          </label>
          <label>
            Tools
            <select
              multiple
              value={step.tools}
              onChange={(e) =>
                onChange({ ...step, tools: Array.from(e.target.selectedOptions, (o) => o.value) })
              }
            >
              {ctx.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Max iterations
            <input
              type="number"
              min={1}
              max={20}
              value={step.maxIterations}
              onChange={(e) => onChange({ ...step, maxIterations: Number(e.target.value) })}
            />
          </label>
          <label>
            Output key
            <input value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </label>
          <ModelPicker value={step.model} onChange={(model) => onChange({ ...step, model })} ctx={ctx} />
        </>
      )}

      {step.type === "mcp_tool" && (
        <>
          <label>
            Tool
            <select
              value={step.server && step.tool ? `${step.server}__${step.tool}` : ""}
              onChange={(e) => {
                const [server, tool] = e.target.value.split("__");
                onChange({ ...step, server: server ?? "", tool: tool ?? "" });
              }}
            >
              <option value="">(choose a tool)</option>
              {ctx.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Input (JSON)
            <textarea
              rows={2}
              value={JSON.stringify(step.input)}
              onChange={(e) => {
                try {
                  onChange({ ...step, input: JSON.parse(e.target.value) });
                } catch {
                  // ignore invalid JSON while the user is still typing
                }
              }}
            />
          </label>
          <label>
            Output key
            <input value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </label>
          <p className="meta">no model — logic</p>
        </>
      )}

      {step.type === "assign" && (
        <>
          <label>
            Assign to
            <select value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value as "ai" | "human" })}>
              <option value="ai">ai</option>
              <option value="human">human</option>
            </select>
          </label>
          <label>
            Note
            <input value={step.note ?? ""} onChange={(e) => onChange({ ...step, note: e.target.value })} />
          </label>
          <p className="meta">no model — logic</p>
        </>
      )}

      {step.type === "branch" && (
        <>
          <label>
            Branch on context key
            <input value={step.on} onChange={(e) => onChange({ ...step, on: e.target.value })} />
          </label>
          <p className="meta">no model — logic</p>
          {Object.entries(step.cases).map(([value, caseSteps]) => (
            <div key={value} className="rule-branch-case">
              <div className="rule-step-header">
                <span>case "{value}"</span>
                <button
                  className="link"
                  onClick={() => {
                    const { [value]: _removed, ...rest } = step.cases;
                    onChange({ ...step, cases: rest });
                  }}
                >
                  Remove case
                </button>
              </div>
              <StepList
                steps={caseSteps}
                onChange={(next) => onChange({ ...step, cases: { ...step.cases, [value]: next } })}
                ctx={ctx}
              />
            </div>
          ))}
          <button
            className="link"
            onClick={() => {
              const value = window.prompt("Case value?");
              if (!value) return;
              onChange({ ...step, cases: { ...step.cases, [value]: [] } });
            }}
          >
            Add case
          </button>
          <div className="rule-branch-case">
            <span className="meta">default</span>
            <StepList
              steps={step.default ?? []}
              onChange={(next) => onChange({ ...step, default: next })}
              ctx={ctx}
            />
          </div>
        </>
      )}

      {step.type === "call_rule" && (
        <>
          <label>
            Type
            <select value={step.typeId} onChange={(e) => onChange({ ...step, typeId: e.target.value })}>
              <option value="">(choose a type)</option>
              {ctx.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version
            <input
              type="number"
              min={1}
              value={step.version}
              onChange={(e) => onChange({ ...step, version: Number(e.target.value) })}
            />
          </label>
          <p className="meta">no model — logic</p>
        </>
      )}
    </div>
  );
}

export function StepList({
  steps,
  onChange,
  ctx,
}: {
  steps: RuleStep[];
  onChange: (steps: RuleStep[]) => void;
  ctx: Ctx;
}) {
  return (
    <div className="rule-step-list">
      {steps.map((step, index) => (
        <StepBox
          key={step.id}
          step={step}
          ctx={ctx}
          onChange={(next) => onChange(steps.map((s, i) => (i === index ? next : s)))}
          onRemove={() => onChange(steps.filter((_, i) => i !== index))}
        />
      ))}
      <label>
        Add step
        <select
          value=""
          onChange={(e) => {
            const type = e.target.value as RuleStep["type"];
            if (type) onChange([...steps, defaultStep(type)]);
          }}
        >
          <option value="">(choose a step type)</option>
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
```

- [ ] **Step 3: Create the shared `RuleEditor`**

Create `src/client/RuleEditor.tsx`:

```typescript
import { useEffect, useState } from "react";
import type { RuleDefinition } from "../domain/rule";
import type { ToolSpec } from "../ai/provider";
import { api, type ModelOption, type Rule, type TypeWithRules } from "./api";
import { StepList } from "./StepList";

export function RuleEditor({
  type,
  initialRule,
  onSaved,
}: {
  type: TypeWithRules;
  initialRule?: Rule;
  onSaved: () => Promise<void>;
}) {
  const [description, setDescription] = useState("");
  const [definition, setDefinition] = useState<RuleDefinition | null>(initialRule?.definition ?? null);
  const [draftId, setDraftId] = useState<string | null>(initialRule?.status === "draft" ? initialRule.id : null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [tools, setTools] = useState<ToolSpec[]>([]);
  const [allTypes, setAllTypes] = useState<TypeWithRules[]>([type]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.models().then((r) => setModels(r.models));
    void api.mcpTools().then(setTools);
    void api.types().then(setAllTypes);
  }, []);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      const rule = await api.onboard(type.id, description);
      setDefinition(rule.definition);
      setDraftId(rule.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAsNewVersion() {
    if (!definition) return;
    setBusy(true);
    setError(null);
    try {
      const rule = await api.saveRule(type.id, definition);
      setDraftId(rule.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    try {
      await api.activate(draftId);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label>
        How should tasks of this type be handled?
        <textarea
          rows={4}
          value={description}
          placeholder="e.g. Summarize the email, pull the order status, then assign it to a human"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <button disabled={busy || !description.trim()} onClick={regenerate}>
        {busy ? "Building…" : definition ? "Regenerate" : "Build rule"}
      </button>

      {error && <p className="error">{error}</p>}

      {definition && (
        <>
          <h3>Steps</h3>
          <StepList
            steps={definition.steps}
            onChange={(steps) => setDefinition({ ...definition, steps })}
            ctx={{ models, tools, types: allTypes }}
          />
          <button disabled={busy} onClick={saveAsNewVersion}>
            Save as new version
          </button>
          {draftId && (
            <button disabled={busy} onClick={activate}>
              Activate
            </button>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Refactor `Onboarding.tsx` to wrap `RuleEditor`**

Read `src/client/Onboarding.tsx`, then replace its body so it keeps only the task banner, the name/description fields, and the skip button, delegating the rest:

```typescript
import { useState } from "react";
import type { Task } from "../domain/task";
import { api, type TypeWithRules } from "./api";
import { RuleEditor } from "./RuleEditor";

export function Onboarding({
  task,
  type,
  onDone,
  onClose,
}: {
  task: Task;
  type: TypeWithRules;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description);
  const [busy, setBusy] = useState(false);

  async function saveTypeEdits() {
    if (name !== type.name || description !== type.description) {
      await api.patchType(type.id, { name, description });
    }
  }

  return (
    <div className="dialog">
      <h2>New task type: {type.name}</h2>
      <p className="subject">First task: {task.title}</p>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <RuleEditor
        type={{ ...type, name, description }}
        onSaved={async () => {
          await saveTypeEdits();
          await onDone();
          onClose();
        }}
      />

      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await saveTypeEdits();
          await api.skipOnboarding(task.id);
          await onDone();
          onClose();
        }}
      >
        Skip — assign to a human for now
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Create the `Rules` entry point**

Create `src/client/Rules.tsx`:

```typescript
import { useCallback, useEffect, useState } from "react";
import { api, type Rule, type TypeWithRules } from "./api";
import { RuleEditor } from "./RuleEditor";

export function Rules() {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<TypeWithRules[]>([]);
  const [selected, setSelected] = useState<TypeWithRules | null>(null);
  const [selectedRule, setSelectedRule] = useState<Rule | null>(null);
  const [loadingRule, setLoadingRule] = useState(false);

  const refresh = useCallback(async () => {
    setTypes(await api.types());
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function select(type: TypeWithRules) {
    setSelected(type);
    setSelectedRule(null);
    // Prefer the active version; otherwise load the most recent draft to edit.
    const toLoad = type.activeRuleId ?? type.rules.at(-1)?.id;
    if (!toLoad) return;
    setLoadingRule(true);
    try {
      setSelectedRule(await api.rule(toLoad));
    } finally {
      setLoadingRule(false);
    }
  }

  function statusOf(type: TypeWithRules): string {
    if (type.activeRuleId) {
      const active = type.rules.find((r) => r.id === type.activeRuleId);
      return `active v${active?.version ?? "?"}`;
    }
    if (type.rules.length) return "draft pending review";
    return "no rule yet";
  }

  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>
        Rules
      </button>

      {open && !selected && (
        <div className="dialog extensions">
          <h2>Rules</h2>
          {types.length === 0 && <p className="meta">No task types yet.</p>}
          {types.map((type) => (
            <div key={type.id} className="extension-row">
              <strong>{type.name}</strong>
              <p className="meta">{statusOf(type)}</p>
              <button className="link" onClick={() => void select(type)}>
                {type.rules.length ? "Edit" : "Create"}
              </button>
            </div>
          ))}
          <button className="secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}

      {open && selected && (
        <div className="dialog extensions">
          <h2>{selected.name}</h2>
          {loadingRule ? (
            <p className="meta">Loading…</p>
          ) : (
            <RuleEditor
              key={selected.id}
              type={selected}
              initialRule={selectedRule ?? undefined}
              onSaved={async () => {
                await refresh();
              }}
            />
          )}
          <button className="secondary" onClick={() => setSelected(null)}>
            Back to rules
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 6: Mount `Rules` in the header**

In `src/client/App.tsx`, add the import and render it next to `Extensions`:

```typescript
import { Rules } from "./Rules";
```

```typescript
        <div className="actions">
          <SignIn />
          <Rules />
          <Extensions />
          <NewTask onCreated={refresh} />
```

- [ ] **Step 7: Add CSS for step boxes**

In `src/client/index.html`, inside the existing `<style>` block, add (near the `.extension-row` rules):

```css
      .rule-step {
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 10px 12px;
        margin: 8px 0;
        background: var(--surface-2);
      }
      .rule-step-header { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; }
      .rule-branch-case { border-left: 2px solid var(--border); padding-left: 12px; margin: 8px 0 8px 12px; }
      .rule-step-list select[multiple] { height: auto; min-height: 60px; }
```

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 9: Manual verification with the dev server**

Run: `JIDOKA_SAMPLE_DIR=./samples bun run dev` (background it or run in a separate terminal), then in a browser at `http://localhost:3000`:
1. Click "Rules" in the header — the panel opens and lists every task type with its status.
2. Pick a type with no rule, type a description, click "Build rule" — step boxes render, each `ai`/`agent` box shows a model dropdown pre-filled with the builder's pick.
3. Change a step's model in the dropdown, click "Save as new version", then "Activate" — the panel doesn't error and the type's status updates on "Back to rules".
4. Open `Onboarding` from a task in `needs_onboarding` (inject one via `POST /api/tasks` if none exists) and confirm it still works end to end (build, review steps, activate or skip).

Stop the dev server when done.

- [ ] **Step 10: Commit**

```bash
git add src/client/StepList.tsx src/client/RuleEditor.tsx src/client/Rules.tsx src/client/api.ts src/client/Onboarding.tsx src/client/App.tsx src/client/index.html
git commit -m "$(cat <<'EOF'
feat: add a Rules entry point and a shared step-box editor

Rules.tsx lists every type's rule status and opens RuleEditor to
build, hand-edit (including per-step model overrides), save as a new
version, or activate one. Onboarding.tsx now delegates to the same
editor instead of duplicating it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
