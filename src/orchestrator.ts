import type { Database } from "bun:sqlite";
import type { AiProvider, ToolSpec } from "./ai/provider";
import type { ModelProviderId } from "./ai/models";
import { modelCatalog } from "./ai/models";
import type { Assignee, Task, TaskState } from "./domain/task";
import type { Rule } from "./domain/rule";
import { resolvePriority, type Priority } from "./domain/priority";
import { getTask, listTasks, updateTask, deleteTask } from "./repo/tasks";
import { getItemRow, repointTask } from "./repo/sourceItems";
import { moveParticipants } from "./repo/participants";
import { recordAudit } from "./repo/audit";
import { getResolvedIdentity } from "./repo/extensions";
import {
  getTaskType,
  insertTaskType,
  listTaskTypes,
  updateTaskType,
} from "./repo/taskTypes";
import {
  activateRule,
  getActiveRule,
  getRule,
  insertRule,
  listRules,
} from "./repo/rules";
import { triageTask, type TriageResult, type UrgencySignal } from "./triage/triage";
import { assessReopenRelevance } from "./triage/reopenRelevance";
import { checkForDuplicate } from "./dedup/dedup";
import {
  runRule,
  rerunStep as rerunRuleStep,
  type ResolvedAgentTask,
  type ResolvedHandoffTarget,
  type StepLogEntry,
  type ToolCaller,
} from "./rule/executor";
import { findDependentSteps } from "./rule/dependents";
import { createInProcessRunner, type AgentRunner } from "./agent/runner";
import { buildRule } from "./rule/builder";
import { listHintsForRule, listHintsForStep } from "./repo/hints";
import type { SourceItem } from "./sources/types";

export interface AppDeps {
  db: Database;
  provider: AiProvider;
  modelProvider: ModelProviderId;
  mcp: { listTools(): ToolSpec[]; callTool: ToolCaller };
  /** Backend for `agent` steps; the executor's in-process loop when unset. */
  runAgent?: AgentRunner;
}

function executorDepsForRule(deps: AppDeps, active: Rule) {
  return {
    provider: deps.provider,
    callTool: deps.mcp.callTool,
    listTools: () => deps.mcp.listTools(),
    ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
    loadRule: (typeId: string, version: number) => {
      const found = listRules(deps.db, typeId).find((p) => p.version === version);
      return found ? { id: found.id, definition: found.definition } : null;
    },
    self: { typeId: active.typeId, version: active.version, ruleId: active.id },
    getHints: (ruleId: string, stepId: string) =>
      listHintsForStep(deps.db, ruleId, stepId).map((h) => h.text),
  };
}

function ruleLogFromContext(context: Record<string, unknown>): StepLogEntry[] {
  return (context.ruleLog as StepLogEntry[] | undefined) ?? [];
}

function pendingKeys(context: Record<string, unknown>): string[] {
  const value = context.pendingChange;
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : [];
}

/** A change can be recorded in `context.pendingChange` while a caller is
 *  holding an older snapshot of the task (across a triage call or a rule
 *  run). Whole-context writes made from that snapshot go through here, so the
 *  stored flag is carried forward instead of being overwritten. */
function carryPendingChange(deps: AppDeps, taskId: string, context: Record<string, unknown>): Record<string, unknown> {
  const { pendingChange: _snapshot, ...rest } = context;
  const stored = getTask(deps.db, taskId);
  const keys = stored ? pendingKeys(stored.context) : [];
  return keys.length ? { ...rest, pendingChange: keys } : rest;
}

/** `drainPendingChange` for callers that must not fail because a deferred
 *  follow-up did: the caller's own state change has already been saved. */
async function drainQuietly(deps: AppDeps, task: Task): Promise<Task> {
  try {
    return await drainPendingChange(deps, task);
  } catch (error) {
    console.error(`[orchestrator] pending change for task ${task.id} failed:`, error);
    return getTask(deps.db, task.id) ?? task;
  }
}

export async function onTaskIngested(deps: AppDeps, task: Task): Promise<Task> {
  const candidates = listTasks(deps.db)
    .filter((t) => t.id !== task.id && !["done", "failed", "dismissed", "needs_dedup_confirmation"].includes(t.state))
    .slice(0, 30);

  const match = await checkForDuplicate(deps.provider, task, candidates);
  if (match) {
    return updateTask(deps.db, task.id, {
      state: "needs_dedup_confirmation",
      dedupCandidateId: match.taskId,
      context: { ...carryPendingChange(deps, task.id, task.context), dedupRationale: match.rationale },
    });
  }

  return triageAndAssign(deps, task);
}

/** Applies a fresh `triageTask` outcome to a task, unconditionally — used both
 *  for a brand new task (which has no prior classification to compare against)
 *  and, via `retriageTask` below, for an already-classified one whose triage
 *  outcome turned out to differ from what it already had. */
function auditTriage(deps: AppDeps, task: Task, result: TriageResult, extra: Record<string, unknown> = {}): void {
  recordAudit(deps.db, {
    kind: "triaged",
    actor: "system",
    taskId: task.id,
    typeId: task.typeId,
    data: {
      outcome: result.outcome,
      deadline: result.deadline,
      urgency: result.urgency,
      priority: task.priority,
      ...extra,
    },
  });
}

async function applyTriageOutcome(deps: AppDeps, task: Task, result: TriageResult): Promise<Task> {
  const { outcome, deadline } = result;
  const context = withUrgency(carryPendingChange(deps, task.id, task.context), result.urgency);

  if (outcome.kind === "not_relevant") {
    const dismissed = updateTask(deps.db, task.id, { state: "dismissed", typeCandidates: null, deadline, context });
    auditTriage(deps, dismissed, result);
    // A reply that came in during triage may be what makes it relevant.
    return drainQuietly(deps, dismissed);
  }

  if (outcome.kind === "ambiguous") {
    const waiting = updateTask(deps.db, task.id, {
      state: "needs_type_confirmation",
      typeCandidates: outcome.candidateTypeIds,
      deadline,
      context,
      priority: autoPriority(deps, { ...task, typeId: null, context }),
    });
    auditTriage(deps, waiting, result);
    return waiting;
  }

  if (outcome.kind === "new_type") {
    const type = insertTaskType(deps.db, {
      name: outcome.proposal.name,
      description: outcome.proposal.description,
    });
    const proposed = updateTask(deps.db, task.id, {
      typeId: type.id,
      typeCandidates: null,
      state: "needs_onboarding",
      deadline,
      context,
      priority: autoPriority(deps, { ...task, typeId: type.id, context }),
    });
    auditTriage(deps, proposed, result);
    return proposed;
  }

  const matched = updateTask(deps.db, task.id, {
    typeId: outcome.typeId,
    typeCandidates: null,
    deadline,
    context,
    priority: autoPriority(deps, { ...task, typeId: outcome.typeId, context }),
  });
  auditTriage(deps, matched, result);
  return processTask(deps, matched);
}

/** Keeps the latest triage urgency signal on the task, so a later type
 *  confirmation or type-default change can recompute priority without
 *  another AI call. A null signal clears any stale one. */
function withUrgency(context: Record<string, unknown>, urgency: UrgencySignal | null): Record<string, unknown> {
  const { urgency: _stale, ...rest } = context;
  return urgency ? { ...rest, urgency } : rest;
}

/** The priority a task should have right now, unless a human pinned it by
 *  hand (context.priorityOverride), in which case that pin always wins. */
function autoPriority(deps: AppDeps, task: Pick<Task, "typeId" | "context" | "priority">): Priority {
  if (task.context.priorityOverride === true) return task.priority;
  const type = task.typeId ? getTaskType(deps.db, task.typeId) : null;
  const signal = (task.context.urgency as UrgencySignal | undefined)?.level ?? null;
  return resolvePriority(type?.defaultPriority ?? "normal", signal);
}

/** A human sets a task's priority by hand, pinning it against re-triage and
 *  type-default changes; "auto" drops the pin and recomputes it. */
export function setTaskPriority(deps: AppDeps, taskId: string, priority: Priority | "auto"): Task {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`setTaskPriority: unknown task ${taskId}`);

  let updated: Task;
  if (priority === "auto") {
    const { priorityOverride: _pin, ...context } = task.context;
    updated = updateTask(deps.db, taskId, { context, priority: autoPriority(deps, { ...task, context }) });
  } else {
    updated = updateTask(deps.db, taskId, {
      priority,
      context: { ...task.context, priorityOverride: true },
    });
  }
  recordAudit(deps.db, {
    kind: "priority_set",
    actor: "human",
    taskId,
    typeId: task.typeId,
    data: { from: task.priority, to: updated.priority, ...(priority === "auto" ? { auto: true } : {}) },
  });
  return updated;
}

/** Runs when a type's default priority changes (or tasks are merged into
 *  it): every open, non-pinned task of that type is re-derived. Done tasks
 *  keep the priority they closed with. */
export function refreshPriorityForType(deps: AppDeps, typeId: string): void {
  for (const task of listTasks(deps.db)) {
    if (task.typeId !== typeId || task.state === "done" || task.state === "dismissed") continue;
    const priority = autoPriority(deps, task);
    if (priority !== task.priority) updateTask(deps.db, task.id, { priority });
  }
}

async function triageAndAssign(deps: AppDeps, task: Task): Promise<Task> {
  const result = await triageTask(deps.provider, task, listTaskTypes(deps.db), getResolvedIdentity(deps.db, task.sourceId));
  return applyTriageOutcome(deps, task, result);
}

/** Re-runs real triage for a task that was already classified once, e.g.
 *  because its type's description changed. Unlike `triageAndAssign`, a
 *  `matched` outcome that confirms the task's *current* type is a deliberate
 *  no-op: re-triage is meant to catch drift, not to force every open task
 *  under a type through a fresh rule run whenever its description is edited. */
export async function retriageTask(deps: AppDeps, task: Task): Promise<Task> {
  const result = await triageTask(deps.provider, task, listTaskTypes(deps.db), getResolvedIdentity(deps.db, task.sourceId));
  if (result.outcome.kind === "matched" && result.outcome.typeId === task.typeId) {
    auditTriage(deps, task, result, { retriage: true, unchanged: true });
    return task;
  }
  return applyTriageOutcome(deps, task, result);
}

/** States a task can still move out of; `done` is terminal (per CLAUDE.md,
 *  "completed tasks keep their original type") and `processing` is skipped so
 *  a concurrent re-triage never races the whole-context write a running
 *  rule makes when it finishes (the same hazard `mergeTasks` already guards
 *  against for a single task). */
const OPEN_FOR_RETRIAGE = new Set<TaskState>([
  "ingested",
  "needs_type_confirmation",
  "needs_onboarding",
  "needs_dedup_confirmation",
  "assigned_ai",
  "assigned_human",
  "failed",
]);

/** Runs when a type's description changes: only its *open* tasks are
 *  reconsidered (see `OPEN_FOR_RETRIAGE`). A merge or a pure rename never
 *  reaches this function — see `docs/superpowers/specs/2026-09-27-retriage-on-type-change-design.md`
 *  for why those two don't need a real triage call. */
export async function retriageOpenTasksForType(deps: AppDeps, typeId: string): Promise<void> {
  const targets = listTasks(deps.db).filter(
    (t) => t.typeId === typeId && OPEN_FOR_RETRIAGE.has(t.state),
  );
  for (const task of targets) {
    await retriageTask(deps, task);
  }
}

async function processTask(deps: AppDeps, task: Task): Promise<Task> {
  if (!task.typeId) throw new Error(`processTask: task ${task.id} has no type`);
  const rule = getActiveRule(deps.db, task.typeId);
  if (!rule) return updateTask(deps.db, task.id, { state: "needs_onboarding" });
  return runRuleForTask(deps, task, rule);
}

export async function runRuleForTask(
  deps: AppDeps,
  task: Task,
  rule?: Rule,
): Promise<Task> {
  if (!task.typeId) throw new Error(`runRuleForTask: task ${task.id} has no type`);
  const active = rule ?? getActiveRule(deps.db, task.typeId);
  if (!active) return updateTask(deps.db, task.id, { state: "needs_onboarding" });

  const running = updateTask(deps.db, task.id, {
    state: "processing",
    context: { isFollowUp: "false", ...carryPendingChange(deps, task.id, task.context) },
  });

  try {
    const result = await runRule(executorDepsForRule(deps, active), active.definition, running);

    const updated = updateTask(deps.db, task.id, {
      context: {
        ...carryPendingChange(deps, task.id, result.context),
        ruleLog: result.log,
        ...(result.handoff ? { handoff: result.handoff } : {}),
      },
      assignee: result.assignee,
      state: result.assignee === "ai" ? "assigned_ai" : "assigned_human",
    });
    recordAudit(deps.db, {
      kind: "rule_ran",
      actor: "system",
      taskId: task.id,
      typeId: active.typeId,
      ruleId: active.id,
      data: {
        version: active.version,
        log: result.log,
        assignee: result.assignee,
        ...(result.handoff ? { handoff: result.handoff } : {}),
      },
    });

    // An agent step can run for minutes, so this — like triage and rule
    // activation elsewhere in this file — fires in the background rather
    // than holding up whatever caller is waiting on the rule run itself.
    if (updated.state === "assigned_ai" && result.agentTask) {
      void completeAiAssignedTask(deps, updated, result.agentTask).catch((error) => {
        console.error(`[orchestrator] AI completion for task ${updated.id} failed:`, error);
      });
    }

    // A change that arrived while the rule ran is followed up now that the
    // task has landed somewhere it can be reopened from.
    return await drainQuietly(deps, updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(deps.db, {
      kind: "rule_ran",
      actor: "system",
      taskId: task.id,
      typeId: active.typeId,
      ruleId: active.id,
      data: { version: active.version, error: message },
    });
    // The pending change stays set: `failed` isn't a state the change flow
    // runs from, so `drainPendingChange` picks it up once the task moves on.
    return updateTask(deps.db, task.id, {
      state: "failed",
      context: { ...carryPendingChange(deps, task.id, running.context), error: message },
    });
  }
}

/**
 * The worker for `assigned_ai`: runs the rule's resolved agent task and
 * closes the loop the same way a human closing a task does — `done` with a
 * completion note on success (so TaskDetail's existing rendering needs no
 * changes), `failed` with `context.error` on failure (the same shape a
 * failing rule run already uses in `runRuleForTask`).
 */
async function completeAiAssignedTask(
  deps: AppDeps,
  task: Task,
  agentTask: ResolvedAgentTask,
): Promise<void> {
  const runner =
    deps.runAgent ??
    createInProcessRunner({
      provider: deps.provider,
      listTools: () => deps.mcp.listTools(),
      callTool: deps.mcp.callTool,
    });

  try {
    const result = await runner.run({
      prompt: agentTask.prompt,
      allowedTools: agentTask.tools,
      maxTurns: agentTask.maxIterations,
      ...(agentTask.model ? { model: agentTask.model } : {}),
    });

    const current = getTask(deps.db, task.id);
    // The run can take as long as maxIterations allows; if the task moved on
    // to something else in the meantime (a human closed it by hand, a merge,
    // a reopen from the source), this background write must not clobber that
    // — the same hazard mergeTasks already guards against for a concurrent
    // rule run. A reopen that re-ran the rule and landed back in `assigned_ai`
    // is a newer pass with its own completion, so this one stands down too.
    if (!current || current.state !== "assigned_ai" || !samePass(current, task)) return;
    recordAudit(deps.db, {
      kind: "completed",
      actor: "ai",
      taskId: task.id,
      typeId: current.typeId,
      data: { note: result.text.trim() || null },
    });
    updateTask(deps.db, task.id, {
      state: "done",
      context: {
        ...current.context,
        completedAt: new Date().toISOString(),
        ...(result.text.trim() ? { completionNote: result.text.trim() } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = getTask(deps.db, task.id);
    if (!current || current.state !== "assigned_ai" || !samePass(current, task)) return;
    updateTask(deps.db, task.id, {
      state: "failed",
      context: { ...current.context, error: message },
    });
  }
}

export async function rerunStep(deps: AppDeps, taskId: string, stepId: string): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`rerunStep: unknown task ${taskId}`);
  if (!task.typeId) throw new Error(`rerunStep: task ${taskId} has no type`);
  const active = getActiveRule(deps.db, task.typeId);
  if (!active) throw new Error(`rerunStep: no active rule for type ${task.typeId}`);

  const result = await rerunRuleStep(
    executorDepsForRule(deps, active),
    active.definition,
    task,
    stepId,
  );

  recordAudit(deps.db, {
    kind: "step_rerun",
    actor: "human",
    taskId,
    typeId: task.typeId,
    ruleId: active.id,
    data: { stepId, version: active.version, log: result.log },
  });
  return updateTask(deps.db, taskId, {
    context: {
      ...task.context,
      ...result.context,
      ruleLog: [...ruleLogFromContext(task.context), result.log],
    },
  });
}

export function getDependents(
  deps: AppDeps,
  taskId: string,
  stepId: string,
): { safe: string[]; unsafe: string[] } {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`getDependents: unknown task ${taskId}`);
  if (!task.typeId) throw new Error(`getDependents: task ${taskId} has no type`);
  const active = getActiveRule(deps.db, task.typeId);
  if (!active) throw new Error(`getDependents: no active rule for type ${task.typeId}`);

  const ranStepIds = new Set(ruleLogFromContext(task.context).map((entry) => entry.stepId));
  return findDependentSteps(active.definition, ranStepIds, stepId);
}

export async function confirmTaskType(
  deps: AppDeps,
  taskId: string,
  typeId: string,
): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`confirmTaskType: unknown task ${taskId}`);
  const type = getTaskType(deps.db, typeId);
  if (!type) throw new Error(`confirmTaskType: unknown type ${typeId}`);

  updateTaskType(deps.db, typeId, { examples: [...type.examples, task.title] });
  recordAudit(deps.db, {
    kind: "type_confirmed",
    actor: "human",
    taskId,
    typeId,
    data: { typeId, candidates: task.typeCandidates },
  });
  const updated = updateTask(deps.db, taskId, {
    typeId,
    typeCandidates: null,
    priority: autoPriority(deps, { ...task, typeId }),
  });
  return processTask(deps, updated);
}

export async function onboardType(
  deps: AppDeps,
  typeId: string,
  description: string,
): Promise<Rule> {
  const type = getTaskType(deps.db, typeId);
  if (!type) throw new Error(`onboardType: unknown type ${typeId}`);

  const active = getActiveRule(deps.db, typeId);
  const buildInput = {
    type,
    description,
    tools: deps.mcp.listTools(),
    models: modelCatalog(deps.modelProvider),
    ...(active
      ? { previousRule: { definition: active.definition, hints: listHintsForRule(deps.db, active.id) } }
      : {}),
  };

  const definition = await buildRule(deps.provider, buildInput);
  return insertRule(deps.db, { typeId, definition });
}

/** Runs the newly active rule over every task of its type that was waiting. */
export async function processWaitingTasks(deps: AppDeps, rule: Rule): Promise<void> {
  for (const task of listTasks(deps.db)) {
    if (task.typeId === rule.typeId && task.state === "needs_onboarding") {
      await runRuleForTask(deps, task, rule);
    }
  }
}

export async function activateTypeRule(
  deps: AppDeps,
  ruleId: string,
  options: { background?: boolean; acknowledgedWriteTools?: string[] } = {},
): Promise<Rule> {
  const rule = getRule(deps.db, ruleId);
  if (!rule) throw new Error(`activateTypeRule: unknown rule ${ruleId}`);

  const active = activateRule(deps.db, ruleId);
  updateTaskType(deps.db, rule.typeId, { status: "active" });
  recordAudit(deps.db, {
    kind: "rule_activated",
    actor: "human",
    typeId: rule.typeId,
    ruleId,
    data: { version: active.version, acknowledgedWriteTools: options.acknowledgedWriteTools ?? [] },
  });

  // A rule with an agent step can run for minutes, far longer than an HTTP
  // request should be held open, so callers over HTTP process in the background
  // and watch the board for the tasks to move.
  if (options.background) {
    void processWaitingTasks(deps, active).catch((error) => {
      console.error(`[orchestrator] processing tasks for ${rule.typeId} failed:`, error);
    });
  } else {
    await processWaitingTasks(deps, active);
  }

  return active;
}

/** A human marks the task finished; the note is kept with the task's context. */
export function completeTask(deps: AppDeps, taskId: string, note?: string): Task {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`completeTask: unknown task ${taskId}`);
  recordAudit(deps.db, {
    kind: "completed",
    actor: "human",
    taskId,
    typeId: task.typeId,
    data: { note: note?.trim() || null },
  });

  return updateTask(deps.db, taskId, {
    state: "done",
    context: {
      ...task.context,
      completedAt: new Date().toISOString(),
      ...(note?.trim() ? { completionNote: note.trim() } : {}),
    },
  });
}

/** Undo a completion: back to whoever it was assigned to, or to a human. */
export function reopenTask(deps: AppDeps, taskId: string): Task {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`reopenTask: unknown task ${taskId}`);
  recordAudit(deps.db, { kind: "reopened", actor: "human", taskId, typeId: task.typeId, data: {} });

  const { completedAt: _completedAt, completionNote: _note, ...context } = task.context;
  return updateTask(deps.db, taskId, {
    state: task.assignee === "ai" ? "assigned_ai" : "assigned_human",
    assignee: task.assignee ?? "human",
    context,
  });
}

interface ThreadPass {
  /** Snapshot of that pass's produced context values — context[key] gets
   *  overwritten by the next pass, so the archive carries the values, not
   *  just which steps ran. */
  outputs: Record<string, unknown>;
  /** Tells the UI which step type (ai/agent/mcp_tool) produced each output
   *  key, for the kind badge — the values themselves live in `outputs`. */
  ruleLog: StepLogEntry[];
  handoff?: ResolvedHandoffTarget[];
  assignee: Assignee | null;
  completedAt?: string;
  completionNote?: string;
  closedAt: string;
}

function asThreadArray(value: unknown): ThreadPass[] {
  return Array.isArray(value) ? (value as ThreadPass[]) : [];
}

/** Whether two snapshots of a task are from the same rule pass: every reopen
 *  archives the pass it closes into `context.thread`. */
function samePass(a: Task, b: Task): boolean {
  return asThreadArray(a.context.thread).length === asThreadArray(b.context.thread).length;
}

/** States where a change can't be followed up yet: a rule is running, or the
 *  task hasn't been through triage and a rule. The change waits in
 *  `context.pendingChange` until `drainPendingChange` picks it up. */
const DEFER_CHANGE_STATES = new Set<TaskState>([
  "processing",
  "ingested",
  "needs_type_confirmation",
  "needs_onboarding",
  "needs_dedup_confirmation",
]);

/** States the change flow runs from. */
const REOPENABLE_STATES = new Set<TaskState>(["done", "assigned_ai", "assigned_human", "dismissed"]);

/** New items joined a task's thread, or a known item changed. The poller has
 *  already rebuilt the task's title, body, url and metadata from its items;
 *  this only decides what follows. A task that already passed through a rule
 *  (done, or currently assigned) gets its closed pass archived and the
 *  current active rule run again, so a rule's `agent` steps can resume their
 *  prior session and ask a follow-up instead of starting cold. */
export async function onTaskChanged(deps: AppDeps, task: Task, newItems: SourceItem[]): Promise<Task> {
  // Decide on the stored row, not the caller's snapshot: the task may have
  // moved on (or gained a pending change) since the snapshot was taken.
  task = getTask(deps.db, task.id) ?? task;
  if (DEFER_CHANGE_STATES.has(task.state)) {
    const keys = [...new Set([...pendingKeys(task.context), ...newItems.map((item) => item.key)])];
    return updateTask(deps.db, task.id, { context: { ...task.context, pendingChange: keys } });
  }

  // A dismissed item gets a fresh full triage on the new content — what was
  // side-chatter may now be addressed to the user. Triage's own relevance
  // judgment decides; the user's own activity is simply dismissed again.
  if (task.state === "dismissed") return triageAndAssign(deps, task);

  const identity = getResolvedIdentity(deps.db, task.sourceId);
  const type = task.typeId ? getTaskType(deps.db, task.typeId) : null;
  if (type) {
    const verdict = await assessReopenRelevance(deps.provider, task, type, newItems, identity);
    if (!verdict.relevant) {
      // State and the rule's outputs stay as they are — this is what stops a
      // rule's own write-back from reopening the task in a loop.
      recordAudit(deps.db, {
        kind: "reopen_skipped",
        actor: "system",
        taskId: task.id,
        typeId: task.typeId,
        data: { keys: newItems.map((item) => item.key), reason: verdict.reason ?? null },
      });
      return task;
    }
  }

  // Every reopenable state but `dismissed` implies a type was assigned —
  // defensive only, not a real path.
  if (!task.typeId) return task;

  const pass: ThreadPass = {
    outputs: Object.fromEntries(
      ruleLogFromContext(task.context)
        .filter((e) => e.output && e.type !== "assign")
        .map((e) => [e.output as string, task.context[e.output as string]]),
    ),
    ruleLog: ruleLogFromContext(task.context),
    handoff: task.context.handoff as ResolvedHandoffTarget[] | undefined,
    assignee: task.assignee,
    completedAt: task.context.completedAt as string | undefined,
    completionNote: task.context.completionNote as string | undefined,
    closedAt: new Date().toISOString(),
  };

  const { completedAt: _completedAt, completionNote: _note, ...restContext } = task.context;

  const reopened = updateTask(deps.db, task.id, {
    state: "processing",
    assignee: null,
    context: {
      ...restContext,
      isFollowUp: "true",
      thread: [...asThreadArray(task.context.thread), pass],
    },
  });

  return runRuleForTask(deps, reopened);
}

/** Runs the change flow once for a change that was deferred while the task
 *  was busy, now that it sits in a state the flow runs from. A no-op
 *  otherwise. Keys with no item row left are skipped. */
export async function drainPendingChange(deps: AppDeps, task: Task): Promise<Task> {
  const current = getTask(deps.db, task.id);
  if (!current) return task;
  const keys = pendingKeys(current.context);
  if (!keys.length || !REOPENABLE_STATES.has(current.state)) return current;

  const { pendingChange: _pending, ...context } = current.context;
  const cleared = updateTask(deps.db, current.id, { context });
  const newItems: SourceItem[] = [];
  for (const key of keys) {
    const row = getItemRow(deps.db, current.sourceId, key);
    if (!row) continue;
    newItems.push({
      key: row.key,
      ...(row.threadKey ? { threadKey: row.threadKey } : {}),
      ...(row.version ? { version: row.version } : {}),
      occurredAt: row.occurredAt ?? row.firstSeenAt,
      title: row.title ?? "",
      body: row.body ?? "",
      ...(row.url ? { url: row.url } : {}),
      metadata: row.metadata,
      participants: row.participants,
    });
  }
  if (!newItems.length) return cleared;
  return onTaskChanged(deps, cleared, newItems);
}

export async function skipOnboarding(deps: AppDeps, taskId: string): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`skipOnboarding: unknown task ${taskId}`);
  recordAudit(deps.db, { kind: "onboarding_skipped", actor: "human", taskId, typeId: task.typeId, data: {} });
  const skipped = updateTask(deps.db, taskId, { state: "assigned_human", assignee: "human" });
  return drainQuietly(deps, skipped);
}

interface MergedFromRecord {
  taskId: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  mergedAt: string;
}

function asMergedFromArray(value: unknown): MergedFromRecord[] {
  return Array.isArray(value) ? (value as MergedFromRecord[]) : [];
}

/** The one place a duplicate task's row goes away: appends its source
 *  reference onto the kept task's context, then deletes it outright. */
export function mergeTasks(deps: AppDeps, duplicateTaskId: string, intoTaskId: string): Task {
  const duplicate = getTask(deps.db, duplicateTaskId);
  const target = getTask(deps.db, intoTaskId);
  if (!duplicate) throw new Error(`mergeTasks: unknown task ${duplicateTaskId}`);
  if (!target) throw new Error(`mergeTasks: unknown task ${intoTaskId}`);
  if (duplicate.state === "processing" || target.state === "processing") {
    // The target side matters too: runRuleForTask snapshots `context` when a
    // rule starts and overwrites the whole column with its own result when
    // it finishes, so a mergedFrom record written mid-run would be silently
    // clobbered right after the duplicate's row is already gone — losing the
    // only trace that the duplicate ever existed.
    throw new Error("mergeTasks: cannot merge while either task is currently processing");
  }

  const record: MergedFromRecord = {
    taskId: duplicate.id,
    sourceId: duplicate.sourceId,
    externalId: duplicate.externalId,
    url: duplicate.url,
    title: duplicate.title,
    mergedAt: new Date().toISOString(),
  };
  const updated = updateTask(deps.db, target.id, {
    context: { ...target.context, mergedFrom: [...asMergedFromArray(target.context.mergedFrom), record] },
  });
  // One entry on each side, so the trail is findable from either task — the
  // duplicate's own entry outlives its row (audit_log has no foreign keys).
  recordAudit(deps.db, {
    kind: "merged",
    actor: "human",
    taskId: duplicate.id,
    typeId: duplicate.typeId,
    data: { intoTaskId: target.id, sourceId: duplicate.sourceId, externalId: duplicate.externalId },
  });
  recordAudit(deps.db, {
    kind: "merged",
    actor: "human",
    taskId: target.id,
    typeId: target.typeId,
    data: { duplicateTaskId: duplicate.id, sourceId: duplicate.sourceId, externalId: duplicate.externalId },
  });
  // Deleting the duplicate cascades its participants away; keep them on the target.
  moveParticipants(deps.db, duplicate.id, target.id);
  // The item record is the routing truth: repointed rows keep a re-listed
  // item from coming back as a new task, and send a later reply on the
  // merged-away conversation to the surviving one.
  repointTask(deps.db, duplicate.id, target.id);
  deleteTask(deps.db, duplicate.id);
  return updated;
}

/** A human resolving an AI-detected `needs_dedup_confirmation` pause.
 *  Dismissal (isDuplicate: false) never requires a live candidate — the
 *  candidate task may since have been deleted (merged away itself, or
 *  removed by hand), and a human must always be able to say "keep this
 *  one" regardless, or the task is stuck with no way forward. */
export async function resolveDuplicate(deps: AppDeps, taskId: string, isDuplicate: boolean): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`resolveDuplicate: unknown task ${taskId}`);

  if (isDuplicate) {
    if (!task.dedupCandidateId) {
      throw new Error(`resolveDuplicate: task ${taskId} has no pending duplicate candidate`);
    }
    return mergeTasks(deps, task.id, task.dedupCandidateId);
  }

  recordAudit(deps.db, {
    kind: "duplicate_dismissed",
    actor: "human",
    taskId,
    typeId: task.typeId,
    data: { candidateTaskId: task.dedupCandidateId },
  });
  const cleared = updateTask(deps.db, task.id, { dedupCandidateId: null });
  return triageAndAssign(deps, cleared);
}

/** A human manually tagging any task as a duplicate of any other, independent of detection. */
export function markDuplicate(deps: AppDeps, taskId: string, ofTaskId: string): Task {
  if (taskId === ofTaskId) throw new Error("markDuplicate: a task cannot be a duplicate of itself");
  return mergeTasks(deps, taskId, ofTaskId);
}
