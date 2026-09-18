import type { Database } from "bun:sqlite";
import type { AiProvider, ToolSpec } from "./ai/provider";
import type { Task } from "./domain/task";
import type { Pipeline } from "./domain/pipeline";
import { getTask, listTasks, updateTask } from "./repo/tasks";
import {
  getTaskType,
  insertTaskType,
  listTaskTypes,
  updateTaskType,
} from "./repo/taskTypes";
import {
  activatePipeline,
  getActivePipeline,
  getPipeline,
  insertPipeline,
  listPipelines,
} from "./repo/pipelines";
import { triageTask } from "./triage/triage";
import { runPipeline, type ToolCaller } from "./pipeline/executor";
import type { AgentRunner } from "./agent/runner";
import { buildPipeline } from "./pipeline/builder";

export interface AppDeps {
  db: Database;
  provider: AiProvider;
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
  const pipeline = getActivePipeline(deps.db, task.typeId);
  if (!pipeline) return updateTask(deps.db, task.id, { state: "needs_onboarding" });
  return runPipelineForTask(deps, task, pipeline);
}

export async function runPipelineForTask(
  deps: AppDeps,
  task: Task,
  pipeline?: Pipeline,
): Promise<Task> {
  if (!task.typeId) throw new Error(`runPipelineForTask: task ${task.id} has no type`);
  const active = pipeline ?? getActivePipeline(deps.db, task.typeId);
  if (!active) return updateTask(deps.db, task.id, { state: "needs_onboarding" });

  const running = updateTask(deps.db, task.id, { state: "processing" });

  try {
    const result = await runPipeline(
      {
        provider: deps.provider,
        callTool: deps.mcp.callTool,
        listTools: () => deps.mcp.listTools(),
        ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
        loadPipeline: (typeId, version) =>
          listPipelines(deps.db, typeId).find((p) => p.version === version)?.definition ?? null,
        self: { typeId: active.typeId, version: active.version },
      },
      active.definition,
      running,
    );

    return updateTask(deps.db, task.id, {
      context: {
        ...result.context,
        pipelineLog: result.log,
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
): Promise<Pipeline> {
  const type = getTaskType(deps.db, typeId);
  if (!type) throw new Error(`onboardType: unknown type ${typeId}`);

  const definition = await buildPipeline(deps.provider, {
    type,
    description,
    tools: deps.mcp.listTools(),
  });
  return insertPipeline(deps.db, { typeId, definition });
}

/** Runs the newly active pipeline over every task of its type that was waiting. */
export async function processWaitingTasks(deps: AppDeps, pipeline: Pipeline): Promise<void> {
  for (const task of listTasks(deps.db)) {
    if (task.typeId === pipeline.typeId && task.state === "needs_onboarding") {
      await runPipelineForTask(deps, task, pipeline);
    }
  }
}

export async function activateTypePipeline(
  deps: AppDeps,
  pipelineId: string,
  options: { background?: boolean } = {},
): Promise<Pipeline> {
  const pipeline = getPipeline(deps.db, pipelineId);
  if (!pipeline) throw new Error(`activateTypePipeline: unknown pipeline ${pipelineId}`);

  const active = activatePipeline(deps.db, pipelineId);
  updateTaskType(deps.db, pipeline.typeId, { status: "active" });

  // A pipeline with an agent step can run for minutes, far longer than an HTTP
  // request should be held open, so callers over HTTP process in the background
  // and watch the board for the tasks to move.
  if (options.background) {
    void processWaitingTasks(deps, active).catch((error) => {
      console.error(`[orchestrator] processing tasks for ${pipeline.typeId} failed:`, error);
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
