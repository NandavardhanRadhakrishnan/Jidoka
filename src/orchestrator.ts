import type { Database } from "bun:sqlite";
import type { AiProvider, ToolSpec } from "./ai/provider";
import type { ModelProviderId } from "./ai/models";
import { modelCatalog } from "./ai/models";
import type { Assignee, Task, TaskState } from "./domain/task";
import type { Rule } from "./domain/rule";
import { resolvePriority, type Priority } from "./domain/priority";
import { getTask, listTasks, updateTask, deleteTask } from "./repo/tasks";
import { recordMergedSourceItem } from "./repo/mergedSourceItems";
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
import type { RawItem } from "./sources/types";

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

export async function onTaskIngested(deps: AppDeps, task: Task): Promise<Task> {
  const candidates = listTasks(deps.db)
    .filter((t) => t.id !== task.id && !["done", "failed", "needs_dedup_confirmation"].includes(t.state))
    .slice(0, 30);

  const match = await checkForDuplicate(deps.provider, task, candidates);
  if (match) {
    return updateTask(deps.db, task.id, {
      state: "needs_dedup_confirmation",
      dedupCandidateId: match.taskId,
      context: { ...task.context, dedupRationale: match.rationale },
    });
  }

  return triageAndAssign(deps, task);
}

/** Applies a fresh `triageTask` outcome to a task, unconditionally — used both
 *  for a brand new task (which has no prior classification to compare against)
 *  and, via `retriageTask` below, for an already-classified one whose triage
 *  outcome turned out to differ from what it already had. */
async function applyTriageOutcome(deps: AppDeps, task: Task, result: TriageResult): Promise<Task> {
  const { outcome, deadline } = result;
  const context = withUrgency(task.context, result.urgency);

  if (outcome.kind === "ambiguous") {
    return updateTask(deps.db, task.id, {
      state: "needs_type_confirmation",
      typeCandidates: outcome.candidateTypeIds,
      deadline,
      context,
      priority: autoPriority(deps, { ...task, typeId: null, context }),
    });
  }

  if (outcome.kind === "new_type") {
    const type = insertTaskType(deps.db, {
      name: outcome.proposal.name,
      description: outcome.proposal.description,
    });
    return updateTask(deps.db, task.id, {
      typeId: type.id,
      typeCandidates: null,
      state: "needs_onboarding",
      deadline,
      context,
      priority: autoPriority(deps, { ...task, typeId: type.id, context }),
    });
  }

  const matched = updateTask(deps.db, task.id, {
    typeId: outcome.typeId,
    typeCandidates: null,
    deadline,
    context,
    priority: autoPriority(deps, { ...task, typeId: outcome.typeId, context }),
  });
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

  if (priority === "auto") {
    const { priorityOverride: _pin, ...context } = task.context;
    return updateTask(deps.db, taskId, { context, priority: autoPriority(deps, { ...task, context }) });
  }
  return updateTask(deps.db, taskId, {
    priority,
    context: { ...task.context, priorityOverride: true },
  });
}

/** Runs when a type's default priority changes (or tasks are merged into
 *  it): every open, non-pinned task of that type is re-derived. Done tasks
 *  keep the priority they closed with. */
export function refreshPriorityForType(deps: AppDeps, typeId: string): void {
  for (const task of listTasks(deps.db)) {
    if (task.typeId !== typeId || task.state === "done") continue;
    const priority = autoPriority(deps, task);
    if (priority !== task.priority) updateTask(deps.db, task.id, { priority });
  }
}

async function triageAndAssign(deps: AppDeps, task: Task): Promise<Task> {
  const result = await triageTask(deps.provider, task, listTaskTypes(deps.db));
  return applyTriageOutcome(deps, task, result);
}

/** Re-runs real triage for a task that was already classified once, e.g.
 *  because its type's description changed. Unlike `triageAndAssign`, a
 *  `matched` outcome that confirms the task's *current* type is a deliberate
 *  no-op: re-triage is meant to catch drift, not to force every open task
 *  under a type through a fresh rule run whenever its description is edited. */
export async function retriageTask(deps: AppDeps, task: Task): Promise<Task> {
  const result = await triageTask(deps.provider, task, listTaskTypes(deps.db));
  if (result.outcome.kind === "matched" && result.outcome.typeId === task.typeId) {
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
    context: { isFollowUp: "false", ...task.context },
  });

  try {
    const result = await runRule(executorDepsForRule(deps, active), active.definition, running);

    const updated = updateTask(deps.db, task.id, {
      context: {
        ...result.context,
        ruleLog: result.log,
        ...(result.handoff ? { handoff: result.handoff } : {}),
      },
      assignee: result.assignee,
      state: result.assignee === "ai" ? "assigned_ai" : "assigned_human",
    });

    // An agent step can run for minutes, so this — like triage and rule
    // activation elsewhere in this file — fires in the background rather
    // than holding up whatever caller is waiting on the rule run itself.
    if (updated.state === "assigned_ai" && result.agentTask) {
      void completeAiAssignedTask(deps, updated, result.agentTask).catch((error) => {
        console.error(`[orchestrator] AI completion for task ${updated.id} failed:`, error);
      });
    }

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return updateTask(deps.db, task.id, {
      state: "failed",
      context: { ...running.context, error: message },
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
    // rule run.
    if (!current || current.state !== "assigned_ai") return;
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
    if (!current || current.state !== "assigned_ai") return;
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
  options: { background?: boolean } = {},
): Promise<Rule> {
  const rule = getRule(deps.db, ruleId);
  if (!rule) throw new Error(`activateTypeRule: unknown rule ${ruleId}`);

  const active = activateRule(deps.db, ruleId);
  updateTaskType(deps.db, rule.typeId, { status: "active" });

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

/** A source reports a revision change on a task that already passed through
 *  a rule at least once (done, or currently assigned): archive the pass that
 *  just closed and run the current active rule again over the refreshed
 *  content, so a rule's `agent` steps can resume their prior session and ask
 *  a follow-up instead of starting cold. */
export async function onTaskChanged(deps: AppDeps, task: Task, item: RawItem): Promise<Task> {
  if (!task.typeId) {
    // Every REOPENABLE_STATES entry implies a type was assigned — defensive
    // only, not a real path.
    return updateTask(deps.db, task.id, { context: { ...task.context, revision: item.revision } });
  }

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
    title: item.title,
    body: item.body,
    metadata: item.metadata ?? {},
    state: "processing",
    assignee: null,
    context: {
      ...restContext,
      revision: item.revision,
      isFollowUp: "true",
      thread: [...asThreadArray(task.context.thread), pass],
    },
  });

  return runRuleForTask(deps, reopened);
}

export async function skipOnboarding(deps: AppDeps, taskId: string): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`skipOnboarding: unknown task ${taskId}`);
  return updateTask(deps.db, taskId, { state: "assigned_human", assignee: "human" });
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
  // Tombstone the source item, not just the task row: a re-listing source
  // (one that returns the same items every poll regardless of cursor, like
  // the bundled sample folder source) would otherwise rediscover it on the
  // next tick and re-ingest it as a brand-new task, undoing the merge.
  recordMergedSourceItem(deps.db, duplicate.sourceId, duplicate.externalId);
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

  const cleared = updateTask(deps.db, task.id, { dedupCandidateId: null });
  return triageAndAssign(deps, cleared);
}

/** A human manually tagging any task as a duplicate of any other, independent of detection. */
export function markDuplicate(deps: AppDeps, taskId: string, ofTaskId: string): Task {
  if (taskId === ofTaskId) throw new Error("markDuplicate: a task cannot be a duplicate of itself");
  return mergeTasks(deps, taskId, ofTaskId);
}
