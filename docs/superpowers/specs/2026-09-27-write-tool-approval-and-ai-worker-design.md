# Write-tool approval gate + a worker for `assigned_ai`

## Motivation

Two gaps, deliberately built together because the second creates a new instance of the first:

1. **No forcing function for write-tool grants.** `ToolSpec.annotations.readOnlyHint` (`src/ai/provider.ts`) already flows from MCP servers (`src/mcp/manager.ts`) through to the rule editor's read/write badges (`RuleFlow.tsx`'s `AgentToolTags`/`toolPerm`, `StepList.tsx`). A human can still hit "Activate" (`RuleEditor.tsx`'s `activate()` → `POST /api/rules/:id/activate` → `activateTypeRule` → `activateRule`) without ever being made to look at which write actions the rule is about to be allowed to take, and nothing stops a raw API call from doing the same.
2. **`assigned_ai` is a dead end.** `runRuleForTask` (`src/orchestrator.ts`) sets a task's state to `assigned_ai` when a rule's `assign` step has `to: "ai"`, but no code ever acts on that state afterward — confirmed by grepping every `assigned_ai` reference in `orchestrator.ts`: it's only ever written, never read except by `reopenTask`. Building the worker that finally does something with `assigned_ai` means an `assign` step needs a way to say *what* the AI should do — and that's a second place (besides `agent` steps) where a rule can grant write-tool access, so it has to go through the same gate as (1).

## Part 1 — Approval gate for write tools

**Decision (given, not re-litigated here): grants are approved once, at activation time**, not per call at runtime. The rest of this section is the mechanism.

### The write-tool set is a pure, shared computation

New module `src/rule/writeTools.ts`, zero runtime dependencies beyond `../domain/rule` and `../ai/provider` types (both already type-only imports in client code, so this file is safe to run on both the server and in the browser bundle — no duplicated logic between the enforcement path and the UI that previews it):

```ts
export function computeWriteTools(definition: RuleDefinition, tools: ToolSpec[]): string[]
```

Walks `definition.steps`, including inside `branch` cases and `default`, collecting:
- `agent` step `tools` arrays
- `mcp_tool` step `server`+`tool` pairs (joined with `TOOL_SEPARATOR`, matching how `src/mcp/manager.ts` names tools)
- `assign` step `agentTask.tools` arrays (Part 2's new field — see below)

For each referenced tool name, looks it up in the live `tools` catalogue and keeps it if `annotations?.readOnlyHint !== true` — i.e. an explicit write annotation *or* no annotation at all (unknown is treated as write, not as safe-by-default: a tool Jidoka can't vouch for gets the same scrutiny as one it knows writes). Returns the deduped, sorted list.

**`call_rule` steps are not expanded.** A called rule is separately versioned, separately activated, and its own write-tool set was already acknowledged (or found empty) at *its* activation. Expanding it here would mean re-deriving another rule's already-gated permissions on every activation of this one, and would have to deal with the executor's own loop detection (`call_rule` can point back into a cycle) just to compute a list — a called rule's grants are that rule's business, checked when it was activated. This is the one deliberate scope boundary in an otherwise-exhaustive walk.

### Server-side enforcement — the actual gate

`POST /api/rules/:id/activate` (`src/api/server.ts`):

```ts
app.post("/api/rules/:id/activate", async (c) => {
  const rule = getRule(deps.db, id);
  if (!rule) return c.json({ error: "unknown rule" }, 404);

  const required = computeWriteTools(rule.definition, deps.mcp.listTools());
  if (required.length > 0) {
    const input = await readJson<{ acknowledgedWriteTools?: string[] }>(c);
    const acknowledged = new Set(input?.acknowledgedWriteTools ?? []);
    const missing = required.filter((t) => !acknowledged.has(t));
    const extra = [...acknowledged].filter((t) => !required.includes(t));
    if (missing.length || extra.length) {
      return c.json({ error: "...", required, missing, extra }, 400);
    }
  }
  return c.json({ rule: await activateTypeRule(deps, id, { background: true }) });
});
```

When `required` is empty the body is never even read — activating a rule with no write tools behaves exactly as it does today (the existing test at `tests/api/server.test.ts:216` posts `activate` with no body at all and must keep passing unchanged). When it isn't empty, the caller must send the *exact* set — not a superset, not a subset — or get a 400 naming what's missing and what's extra. This is what makes the gate real: there is no path (UI, curl, another integration) that activates a rule with unacknowledged write tools, because the check lives on the mutation itself, not in a client screen that a client can skip.

### Client-side UX

`RuleEditor.tsx` imports `computeWriteTools` directly and calls it locally with its already-loaded `definition` and `tools` (`api.mcpTools()`) state — no new endpoint, no response-shape changes to `onboard`/`saveRule`/`rule`, because the computation is a pure shared function rather than something only the server knows how to do.

- `writeTools = definition ? computeWriteTools(definition, tools) : []`
- When non-empty: a checkbox above the Activate button — "I've reviewed the write actions this rule can take:" followed by the tool list, styled with the existing `.tag-outline`/`.perm-badge`/`.perm-write` classes `RuleFlow.tsx` already uses for the same badges elsewhere, so no new visual language and no CSS changes.
- Activate button `disabled` gains `|| (writeTools.length > 0 && !ackWriteTools)`.
- The checkbox resets to unchecked whenever `definition` changes (a fresh build, a saved-as-new-version, or a hand-edit in the step editor) — re-review is required after any change, not just the first time.
- `activate()` now calls `api.activate(draftId, writeTools)`; `api.activate` always sends `{ acknowledgedWriteTools }` (empty array when there are none), which the server-side "required.length > 0" gate makes a no-op for tool-free rules.
- When there are no write tools, none of this renders — activation has zero extra friction, per the given design.

### Covering Part 2's new grant path

`computeWriteTools` already walks `assign` steps' `agentTask.tools` (above), so a rule that assigns to AI with tools attached is gated exactly the same way an `agent` step is — one computation, one enforcement point, both grant paths.

## Part 2 — A worker for `assigned_ai`

### The missing piece: what should the AI actually do?

`AssignStep` (`src/domain/rule.ts`) has no execution definition for `to: "ai"` today — `open` is documented as human-only. Resolution: add an optional `agentTask` field reusing `AgentStep`'s shape, because it's the same `AgentRunner` machinery either way:

```ts
const AgentTaskSpec = z.object({
  prompt: z.string(),
  tools: z.array(z.string()).default([]),
  maxIterations: z.number().int().min(1).max(20).default(6),
  model: z.string().optional(),
});

const AssignStep = z.object({
  id: z.string(),
  type: z.literal("assign"),
  to: z.enum(["ai", "human"]),
  note: z.string().optional(),
  open: z.array(HandoffTargetSchema).optional(),
  agentTask: AgentTaskSpec.optional(),   // only meaningful when to === "ai"
});
```

Not a new step type, and not `AgentStep` reused verbatim: `AgentStep` carries `id`/`output`/`resumeSessionFrom` because it's addressable mid-rule (branches read its output, hints attach to its id, a later step can resume its session). An `assign` step's AI work has none of that — it's terminal, nothing downstream reads its result inside the rule — so it gets the four fields that actually transfer (`prompt`, `tools`, `maxIterations`, `model`) without dragging in fields that would be meaningless here.

**Fallback when `agentTask` is absent:** the executor synthesizes `{ prompt: "Complete this task.\n\nTitle: {{task.title}}\n\nDetails:\n{{task.body}}", tools: [], maxIterations: 3 }`. Zero tools means a rule author who assigns to AI without describing the work never grants anything Part 1 needs to gate — the safe default is also the ungated one.

### Where resolution happens: the executor, not the worker

The executor (`src/rule/executor.ts`) already renders every other step's templates against `scopeFor(task, state)` before handing off. The `assign` case now does the same for `agentTask`: when `step.to === "ai"`, it resolves (real `agentTask` or the fallback above) and renders `prompt` through `renderTemplate`, storing the result on `RunResult.agentTask: ResolvedAgentTask`. This is safe to do at assign-time specifically because `validateReferences` (`src/rule/builder.ts`) already requires every branch to end on an `assign` step — nothing in the rule runs after it, so the context used to render the prompt is already final.

This mirrors `resolveHandoff` for the human path exactly: the rule run *resolves what to do*, it does not *do it*. Rule execution stays deterministic-shaped (per `runRule`'s existing contract) and the actual AI work — the only genuinely long-running, non-deterministic part — happens afterward, out of band, the same separation the codebase already draws between "an agent step ran" and "a human picks up the handoff."

### Wiring: one choke point, fire-and-forget

`orchestrator.ts` is "the only module that changes a task's state" (per `CLAUDE.md`), and `runRuleForTask` is the single place that writes `assigned_ai` — every caller (`processTask`'s triage flow, `confirmTaskType`, `processWaitingTasks` under `activateTypeRule`, `onTaskChanged`'s reopen-and-rerun) funnels through it. So the trigger goes there, immediately after the state-changing `updateTask` call, in the same fire-and-forget style `activateTypeRule` already uses for `processWaitingTasks`:

```ts
const updated = updateTask(deps.db, task.id, { ...; state: result.assignee === "ai" ? "assigned_ai" : "assigned_human" });

if (updated.state === "assigned_ai" && result.agentTask) {
  void completeAiAssignedTask(deps, updated, result.agentTask).catch((error) =>
    console.error(`[orchestrator] AI completion for task ${updated.id} failed:`, error),
  );
}
return updated;
```

No new poller, no interval loop — consistent with how triage already fires from `onTaskIngested` in `src/api/server.ts` and how `activateTypeRule` already backgrounds `processWaitingTasks`.

`completeAiAssignedTask` picks the runner exactly like the executor's `agent` step does (`deps.runAgent ?? createInProcessRunner(...)`), runs it with the resolved `agentTask`, and on completion re-reads the task fresh (`getTask`) before writing, since the run can take as long as an `agent` step's `maxTurns` allows and something else could have touched the row meanwhile:

- **Success:** `state: "done"`, `context: { ...current.context, completedAt: <now>, ...(text.trim() ? { completionNote: text.trim() } : {}) }` — the exact shape `completeTask` already writes for a human completion, so `TaskDetail.tsx`'s existing done-state rendering (which already reads `completionNote` generically) needs no changes. The AI's final text becomes the completion note.
- **Failure:** `state: "failed"`, `context: { ...current.context, error: message }` — the exact shape the rule-execution failure path in `runRuleForTask` already writes, which `TaskDetail.tsx` already renders generically via `task.context.error`.

Errors inside the run are caught inside `completeAiAssignedTask` itself (so the failure is always recorded on the task, not just logged); the outer `.catch` in the fire-and-forget call is a last-resort net for something failing *outside* that try/catch (e.g. the `getTask`/`updateTask` calls themselves), matching how `activateTypeRule`'s own background call is guarded.

### Deferred / accepted gaps

- **`reopenTask` does not re-trigger the worker.** Reopening a completed task back to `assigned_ai` (`reopenTask` in `orchestrator.ts`) restores state/assignee only, the same as it does for `assigned_human` today; it doesn't run the rule again and so doesn't re-invoke `completeAiAssignedTask`. Fixing that is a reopen-flow question orthogonal to "give `assigned_ai` a worker at all," and is left for whoever next touches `reopenTask`.
- **No mid-run cancellation.** Once `completeAiAssignedTask` starts, there's no way to interrupt it short of the process exiting — the same limitation an `agent` rule step already has.
- **No retry policy on failure** beyond a human noticing the task is `failed` and re-running the type's rule from scratch — there's no per-task "retry the AI completion" affordance, mirroring how a failed rule run today has no automatic retry either.

## Testing

TDD per layer:

- `tests/domain/rule.test.ts` (new file) — `AssignStep` accepts an optional `agentTask` with `AgentStep`-shaped defaults/bounds; a `to: "human"` step doesn't require one.
- `tests/rule/writeTools.test.ts` (new file) — `computeWriteTools`: agent-step tools, mcp_tool pairs, assign `agentTask.tools`, nested branch cases, `readOnlyHint: true` excluded, `false`/missing annotation included, unreferenced tools ignored, `call_rule` steps not expanded, dedup + sort.
- `tests/rule/executor.test.ts` — an `assign to: "ai"` step with an explicit `agentTask` renders its prompt template into `RunResult.agentTask`; one with no `agentTask` gets the title/body fallback with no tools and a low iteration cap.
- `tests/orchestrator.test.ts` — a rule assigning to AI with a stub `AgentRunner` lands the task in `done` with `completionNote` set from the run's text; a stub that throws lands the task in `failed` with `context.error` set; the default-fallback path (no `agentTask`) still gets picked up and completes.
- `tests/api/server.test.ts` — activation of a rule with write tools (via an `agent` step, and separately via an assign step's `agentTask`) rejects a missing/mismatched `acknowledgedWriteTools`, accepts the exact set, and the existing no-body activation test for a tool-free rule keeps passing unchanged.

Full `bun run typecheck` + `bun test` clean before considering any part done.

## Note on Part 3 (real MCP smoke test)

Best-effort, after Parts 1–2 are green: wire the filesystem MCP server via `JIDOKA_MCP_SERVERS` against a real `bun run dev`, build a type whose rule assigns to AI with a real `agentTask` using a real filesystem write tool, and confirm the checkbox gates activation and the task lands in `done`. If real AI credentials aren't available in this environment, that will be reported as a code-reasoning walkthrough instead of a live run, explicitly labeled as such.
