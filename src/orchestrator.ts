import type { Database } from "bun:sqlite";
import type { AiProvider, ToolSpec } from "./ai/provider";
import type { ModelProviderId } from "./ai/models";
import { modelCatalog } from "./ai/models";
import type { Task } from "./domain/task";
import type { Rule } from "./domain/rule";
import { getTask, listTasks, updateTask } from "./repo/tasks";
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
import { triageTask } from "./triage/triage";
import { runRule, type ToolCaller } from "./rule/executor";
import type { AgentRunner } from "./agent/runner";
import { buildRule } from "./rule/builder";

export interface AppDeps {
  db: Database;
  provider: AiProvider;
  modelProvider: ModelProviderId;
  mcp: { listTools(): ToolSpec[]; callTool: ToolCaller };
  /** Backend for `agent` steps; the executor's in-process loop when unset. */
  runAgent?: AgentRunner;
}

export async function onTaskIngested(deps: AppDeps, task: Task): Promise<Task> {
  const outcome = await triageTask(deps.provider, task, listTaskTypes(deps.db));

  if (outcome.kind === "ambiguous") {
    return updateTask(deps.db, task.id, {
      state: "needs_type_confirmation",
      typeCandidates: outcome.candidateTypeIds,
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
    });
  }

  const matched = updateTask(deps.db, task.id, {
    typeId: outcome.typeId,
    typeCandidates: null,
  });
  return processTask(deps, matched);
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

  const running = updateTask(deps.db, task.id, { state: "processing" });

  try {
    const result = await runRule(
      {
        provider: deps.provider,
        callTool: deps.mcp.callTool,
        listTools: () => deps.mcp.listTools(),
        ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
        loadRule: (typeId, version) =>
          listRules(deps.db, typeId).find((p) => p.version === version)?.definition ?? null,
        self: { typeId: active.typeId, version: active.version },
      },
      active.definition,
      running,
    );

    return updateTask(deps.db, task.id, {
      context: {
        ...result.context,
        ruleLog: result.log,
        ...(result.handoff ? { handoff: result.handoff } : {}),
      },
      assignee: result.assignee,
      state: result.assignee === "ai" ? "assigned_ai" : "assigned_human",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return updateTask(deps.db, task.id, {
      state: "failed",
      context: { ...running.context, error: message },
    });
  }
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
  const updated = updateTask(deps.db, taskId, { typeId, typeCandidates: null });
  return processTask(deps, updated);
}

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

export async function skipOnboarding(deps: AppDeps, taskId: string): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`skipOnboarding: unknown task ${taskId}`);
  return updateTask(deps.db, taskId, { state: "assigned_human", assignee: "human" });
}
