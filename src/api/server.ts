import { Hono, type Context } from "hono";
import { findTaskBySource, getTask, insertTask, listTasks } from "../repo/tasks";
import { getTaskType, listTaskTypes, mergeTaskType, updateTaskType } from "../repo/taskTypes";
import { getActivePipeline, getPipeline, listPipelines } from "../repo/pipelines";
import {
  activateTypePipeline,
  completeTask,
  confirmTaskType,
  reopenTask,
  onboardType,
  onTaskIngested,
  skipOnboarding,
  type AppDeps,
} from "../orchestrator";

/** Parsed body, or null when the client sent something that is not JSON. */
async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

export function createServer(deps: AppDeps, extraRoutes?: Hono): Hono {
  const app = new Hono();
  if (extraRoutes) app.route("/", extraRoutes);

  app.get("/api/tasks", (c) => c.json({ tasks: listTasks(deps.db) }));

  // Inject a task by hand: the quickest way to exercise triage and pipelines
  // without waiting for a real source to poll.
  app.post("/api/tasks", async (c) => {
    const input = await readJson<{
      title?: string;
      body?: string;
      url?: string;
      sourceId?: string;
      externalId?: string;
      metadata?: Record<string, unknown>;
    }>(c);

    if (!input) return c.json({ error: "body must be valid JSON" }, 400);
    if (!input.title?.trim()) return c.json({ error: "title is required" }, 400);

    const sourceId = input.sourceId?.trim() || "manual";
    const externalId = input.externalId?.trim() || crypto.randomUUID();
    if (findTaskBySource(deps.db, sourceId, externalId)) {
      return c.json({ error: "a task with that source and external id already exists" }, 409);
    }

    const task = insertTask(deps.db, {
      sourceId,
      externalId,
      url: input.url ?? null,
      title: input.title,
      body: input.body ?? "",
      metadata: input.metadata ?? {},
    });

    try {
      return c.json({ task: await onTaskIngested(deps, task) }, 201);
    } catch (error) {
      // The task is stored either way; report why triage could not run.
      return c.json(
        { task, error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
  });

  app.get("/api/types", (c) =>
    c.json({
      types: listTaskTypes(deps.db).map((type) => ({
        ...type,
        activePipelineId: getActivePipeline(deps.db, type.id)?.id ?? null,
        pipelines: listPipelines(deps.db, type.id).map((p) => ({
          id: p.id,
          version: p.version,
          status: p.status,
        })),
      })),
    }),
  );

  app.get("/api/pipelines/:id", (c) => {
    const pipeline = getPipeline(deps.db, c.req.param("id"));
    return pipeline ? c.json({ pipeline }) : c.json({ error: "unknown pipeline" }, 404);
  });

  app.post("/api/tasks/:id/type", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    const input = await readJson<{ typeId?: string }>(c);
    if (!input?.typeId) return c.json({ error: "typeId is required" }, 400);
    const typeId = input.typeId;
    if (!getTaskType(deps.db, typeId)) return c.json({ error: "unknown type" }, 404);
    return c.json({ task: await confirmTaskType(deps, id, typeId) });
  });

  app.post("/api/tasks/:id/complete", async (c) => {
    const id = c.req.param("id");
    const task = getTask(deps.db, id);
    if (!task) return c.json({ error: "unknown task" }, 404);
    if (task.state === "done") return c.json({ task });

    const input = await readJson<{ note?: string }>(c);
    return c.json({ task: completeTask(deps, id, input?.note) });
  });

  app.post("/api/tasks/:id/reopen", (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    return c.json({ task: reopenTask(deps, id) });
  });

  app.post("/api/tasks/:id/skip-onboarding", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    return c.json({ task: await skipOnboarding(deps, id) });
  });

  app.patch("/api/types/:id", async (c) => {
    const id = c.req.param("id");
    if (!getTaskType(deps.db, id)) return c.json({ error: "unknown type" }, 404);
    const patch = await readJson<{
      name?: string;
      description?: string;
      mergeInto?: string;
    }>(c);
    if (!patch) return c.json({ error: "body must be valid JSON" }, 400);
    if (patch.mergeInto) {
      if (!getTaskType(deps.db, patch.mergeInto)) return c.json({ error: "unknown target" }, 404);
      mergeTaskType(deps.db, id, patch.mergeInto);
      return c.json({ merged: true });
    }
    return c.json({ type: updateTaskType(deps.db, id, patch) });
  });

  app.post("/api/types/:id/onboard", async (c) => {
    const id = c.req.param("id");
    if (!getTaskType(deps.db, id)) return c.json({ error: "unknown type" }, 404);
    const input = await readJson<{ description?: string }>(c);
    if (!input?.description?.trim()) return c.json({ error: "description is required" }, 400);
    const description = input.description;
    try {
      return c.json({ pipeline: await onboardType(deps, id, description) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/pipelines/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (!getPipeline(deps.db, id)) return c.json({ error: "unknown pipeline" }, 404);
    // Waiting tasks are processed after the response; the board shows them move.
    return c.json({ pipeline: await activateTypePipeline(deps, id, { background: true }) });
  });

  return app;
}
