# Agentic rule regeneration

## Motivation

Regenerating a rule today (`onboardType` → `buildRule`, `src/orchestrator.ts:200` / `src/rule/builder.ts`) is a single completion call: the whole current definition and every hint on it get pasted into one prompt (`previousRuleSection`), the human retypes a full description of how the type should be handled, and the model replies with a brand-new `{ steps: [...] }` JSON blob that's supposed to preserve whatever didn't need to change. Three real gaps came out of live-testing the `abhi_product_configuration` rule (item 11a in `jidoka-redesign-testing-backlog` memory):

1. **The description box is always empty**, even when editing an already-onboarded type (`RuleEditor.tsx:57`). Fixing one thing means re-describing the entire workflow, not just what's wrong.
2. **It's a full rebuild, not a patch.** Diffing two real rule versions showed steps that had nothing to do with the fix getting rewritten anyway — the model has no structural guarantee it left an untouched step alone, only a prompt instruction asking it to.
3. **Hints only cover step-output corrections.** They can't express "add a branch for this sub-case," "use a different tool," or any other structural change — that whole class of fix still requires retyping the full description today.

This spec closes the gap: describe only what's wrong, and a tool-using agent fetches the current rule and relevant hints itself, then patches exactly the steps that need to change — surgically, across as many steps as the fix actually touches, not a full-rule guess. Split out of `2026-09-25-learned-hints-design.md`'s brainstorming (backlog item 11) since it depends on hints existing and touches a shared abstraction, `AgentRunner`, well beyond that feature's footprint.

Brand-new type onboarding (`Onboarding.tsx`, no active rule yet) is unaffected — there's nothing to patch yet, so it keeps today's full-description `buildRule` flow.

## Why this needs real tool use, not a bigger prompt

An alternative was considered and rejected: keep `buildRule` as a single completion call, just also paste the fix description in alongside today's full previous-rule-and-hints context. That was turned down in favor of an actual agent loop, for reasons beyond preference:

- **A lean initial prompt.** The agent's starting prompt is just the fix description plus the type/tool/model catalogs — not the whole rule and every hint on it whether relevant or not. It decides what it needs to see.
- **Scoped hint lookups.** `get_hints(stepId)` pulls corrections for the one step the agent is about to touch, not a wall of hints for the whole rule — the same shape of context-gathering an `agent` rule step already does for its own task.
- **A structural patch, not prose restraint.** The output is a sequence of tool calls that mutate specific steps, so steps the agent never touches are mechanically untouched — not merely asked, in English, to be left alone.

## Architecture & data flow

`onboardType` (`src/orchestrator.ts:200`) already branches on whether an active rule exists to decide what context to build; it now branches on what to *call*:

```ts
const active = getActiveRule(deps.db, typeId);
const definition = active
  ? await patchRule(deps.runAgent, {
      type,
      description,             // now means "the fix", not "the whole workflow"
      activeRuleId: active.id,
      activeDefinition: active.definition,
      tools: deps.mcp.listTools(),
      models: modelCatalog(deps.modelProvider),
      getHints: (stepId) => listHintsForStep(deps.db, active.id, stepId).map((h) => h.text),
    })
  : await buildRule(deps.provider, { type, description, tools, models });
return insertRule(deps.db, { typeId, definition });
```

```ts
export interface PatchRuleInput {
  type: TaskType;
  description: string;          // the fix, not the whole workflow
  activeRuleId: string;
  activeDefinition: RuleDefinition;
  tools: ToolSpec[];
  models: ModelOption[];
  getHints: (stepId: string) => string[];
}

export async function patchRule(runAgent: AgentRunner, input: PatchRuleInput): Promise<RuleDefinition>
```

`patchRule`:

1. Clones the active rule's `RuleDefinition` into a mutable `draft` held in a closure. This is the working copy every tool call reads or mutates for the rest of the run.
2. Builds 5 tool handlers closed over `draft` and the `getHints` callback: `get_rule`, `get_hints`, `set_step`, `insert_step`, `remove_step` (below).
3. Calls `runAgent.run({ systemPrompt: PATCH_SYSTEM, prompt: userMessage, allowedTools: [the 5 local tool names], localTools: [...], maxTurns: 12 })`. `userMessage` carries the type description, the fix description, and the same tool/model catalog text `buildRule` already builds via `toolCatalog`/`modelCatalogText` — reused as-is. It does **not** include the rule definition or any hints; the agent must call `get_rule`/`get_hints` to see them.
4. When the run ends, validates `draft` with the *existing* `validateReferences()` + `endsAssigned()` checks from `builder.ts`, unchanged. On failure, calls `runAgent.run` again with the problems appended as feedback (`Your changes still have these problems: ...`) — same 2-attempt retry idiom `buildRule` already uses, except the *same* `draft` carries forward into the retry rather than starting over, so a partially-correct patch isn't discarded.
5. Returns the validated `draft` as the new `RuleDefinition`. `onboardType` inserts it via `insertRule` exactly as today; draft/active status, the reconciliation picker, and activation are all unchanged.

## The 5 tools

All 5 validate their `step` input against the existing `RuleStepSchema` (`src/domain/rule.ts:83`) — no new schema is authored for step shape.

- **`get_rule()`** — no input. Returns `JSON.stringify(draft)`.
- **`get_hints({ stepId: string })`** — returns that step's hint texts via the injected `getHints(stepId)` callback (same shape as the executor's own `getHints`, `2026-09-25-learned-hints-design.md`'s runtime section), so the agent pulls in exactly what's relevant to a step it's about to touch.
- **`set_step({ stepId: string, step: RuleStepSchema })`** — replaces an existing step's full definition, wherever it lives in the tree (top level or nested inside a branch's `cases`/`default`), using the same `collectSteps` traversal `builder.ts` already has for `validateReferences`. Adding a new case to an existing branch step is just `set_step` on that branch step with an updated `cases` map — a branch's cases are its own data, not separately addressable. Errors on an unknown `stepId`.
- **`insert_step({ afterId: string | null, step: RuleStepSchema })`** — splices a new step into whichever list contains `afterId` (`null` prepends to the top-level list). Errors if `afterId` is non-null and not found.
- **`remove_step({ stepId: string })`** — removes a step from wherever it lives. No pre-check for "don't remove the last assign in a branch" — that's caught by the post-run `endsAssigned` validation and fed back through the same retry loop as any other structural mistake, not special-cased here.

A tool-call error (bad `stepId`, a `step` that fails `RuleStepSchema`) comes back to the agent as a tool-result error within its own turn budget, the same as a failed MCP call does today in `createInProcessRunner` — including its existing "fails twice on the same tool → throw" rule.

## `AgentRunner` generalization

`AgentRunInput` (`src/agent/runner.ts`) gains one additive field:

```ts
export interface LocalToolDefinition {
  /** Reserved prefix, e.g. "jidoka__set_step" — can't collide with a real MCP server name. */
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: Record<string, unknown>) => Promise<string>;
}

export interface AgentRunInput {
  // ...existing fields unchanged
  localTools?: LocalToolDefinition[];
}
```

Existing `agent` rule steps (`src/rule/executor.ts`) and `generateExtension` (`src/extensions/generator.ts`) never set it — fully backward-compatible, no changes needed there.

**`createInProcessRunner`** (`src/agent/runner.ts`): merges `input.localTools` into the tool specs handed to `AiProvider.complete`, converting each `inputSchema` to JSON Schema via Zod 4's native `z.toJSONSchema()` (already a dependency — `zod ^4.1.0`, no new package). In the dispatch loop, a call whose `server` (from `splitToolName`) matches the reserved local-tool prefix is routed to the matching handler instead of `deps.callTool`.

**`createAgentSdkRunner`** (`src/agent/claudeAgentSdk.ts`): confirmed via the installed `@anthropic-ai/claude-agent-sdk` package (`sdk.d.ts`) that it supports in-process MCP servers — `createSdkMcpServer({ name, version, tools })` plus the `tool(name, description, zodShape, handler)` helper produce an `McpSdkServerConfigWithInstance` that needs no subprocess, distinct from the `McpStdioServerConfig` shape the runner currently only builds from `options.mcpServers`. When `input.localTools` is set, the runner wraps them via `createSdkMcpServer` and merges that server into the call's `mcpServers`/`sdkAllowedTools`, alongside whatever real stdio servers the rest of `allowedTools` names. This resolves the coupling flagged when this item was split out: internal, non-MCP tools now work through both backends without faking a stdio process or forking a bespoke loop, and rule-patching stays on whichever backend (API-key or Claude Code subscription) the deployment already has configured for everything else.

## UI

`RuleEditor.tsx` branches on `type.activeRuleId` — not on `initialRule` — so the client agrees with the server's own `getActiveRule` check even while a draft happens to be loaded in the editor:

- **Set** (an active rule exists): the description box becomes "What's wrong, and what should happen instead?", the button reads "Apply fix". Still calls `api.onboard(type.id, description)` unchanged — no new route.
- **Unset** (brand-new type, `Onboarding.tsx`'s path): unchanged, today's "How should these be handled?" / "Build rule" flow.

No other `RuleEditor.tsx` behavior changes — `saveAsNewVersion`, the hints list, and the reconciliation picker all operate on whatever `definition` comes back exactly as they do today, regardless of which path produced it.

## Deferred / accepted gaps

- **No reordering tool.** `insert_step` + `remove_step` cover reordering if ever needed; a dedicated `move_step` wasn't judged worth the extra tool surface.
- **The patch agent has no access to real MCP tools**, only the 5 internal ones — it reasons about `mcp_tool` steps from the existing tool-catalog text (`toolCatalog`, reused from `buildRule`), the same information `buildRule` already gives the model today, not by calling them.
- **No cap on turns spent exploring vs. patching.** `maxTurns: 12` is a starting budget; if real usage shows the agent burning turns before it starts patching, this is a tuning knob, not a redesign.
- **Retry feedback is textual**, same as `buildRule`'s existing retry — the agent isn't shown a diff of what changed between attempts, just the validation problems.

## Testing

TDD per layer, matching how the hints feature (item 11) was built:

- `tests/rule/patchRule.test.ts` — a fake `AgentRunner` whose `run()` invokes the `localTools` handlers it's given, scripted per test, to simulate real multi-turn tool use. Cases: single-step patch; multi-step patch in one run (`set_step` on two different steps); `insert_step` at the top level and inside a branch case; `remove_step`; a validation failure that triggers the retry-with-feedback path (e.g. removing the terminal assign) and confirms the *same* draft carries into the retry; a bad `stepId` surfacing as a tool error.
- `tests/agent/runner.test.ts` — `createInProcessRunner` dispatches a `localTools` call to its handler instead of `deps.callTool`, and JSON-Schema-converts its `inputSchema` correctly.
- `tests/agent/claudeAgentSdk.test.ts` — `createAgentSdkRunner` wires `createSdkMcpServer`/`tool()` from `localTools` and merges it into the call's `mcpServers`, via the existing `queryFn` injection seam.
- `tests/orchestrator.test.ts` — `onboardType` calls `patchRule` when an active rule exists, `buildRule` when it doesn't.
- `tests/client/` — none planned; verified live via `bun run dev` (copy in both `activeRuleId` states; a real fix against a real rule producing a real multi-step patch), matching how prior UI-only items in the backlog were verified.

Full `bun run typecheck` + `bun test` clean before considering any task in the resulting plan done, per this repo's standing convention.
