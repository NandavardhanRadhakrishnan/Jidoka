import { Hono } from "hono";
import { getTask, listTasks } from "../repo/tasks";
import { getTaskType, listTaskTypes, mergeTaskType, updateTaskType } from "../repo/taskTypes";
import { getActivePipeline, getPipeline, listPipelines } from "../repo/pipelines";
import {
  activateTypePipeline,
  confirmTaskType,
  onboardType,
  skipOnboarding,
  type AppDeps,
} from "../orchestrator";

export function createServer(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/tasks", (c) => c.json({ tasks: listTasks(deps.db) }));

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
    const { typeId } = (await c.req.json()) as { typeId: string };
    if (!getTaskType(deps.db, typeId)) return c.json({ error: "unknown type" }, 404);
    return c.json({ task: await confirmTaskType(deps, id, typeId) });
  });

  app.post("/api/tasks/:id/skip-onboarding", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    return c.json({ task: await skipOnboarding(deps, id) });
  });

  app.patch("/api/types/:id", async (c) => {
    const id = c.req.param("id");
    if (!getTaskType(deps.db, id)) return c.json({ error: "unknown type" }, 404);
    const patch = (await c.req.json()) as {
      name?: string;
      description?: string;
      mergeInto?: string;
    };
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
    const { description } = (await c.req.json()) as { description: string };
    try {
      return c.json({ pipeline: await onboardType(deps, id, description) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/pipelines/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (!getPipeline(deps.db, id)) return c.json({ error: "unknown pipeline" }, 404);
    return c.json({ pipeline: await activateTypePipeline(deps, id) });
  });

  return app;
}
