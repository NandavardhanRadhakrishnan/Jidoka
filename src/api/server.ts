import { Hono, type Context } from "hono";
import { modelCatalog } from "../ai/models";
import { RuleDefinitionSchema } from "../domain/rule";
import { validateReferences } from "../rule/builder";
import { findTaskBySource, getTask, insertTask, listTasks } from "../repo/tasks";
import { getTaskType, listTaskTypes, mergeTaskType, updateTaskType } from "../repo/taskTypes";
import { getActiveRule, getRule, insertRule, listRules } from "../repo/rules";
import {
  activateTypeRule,
  completeTask,
  confirmTaskType,
  reopenTask,
  onboardType,
  onTaskIngested,
  skipOnboarding,
  resolveDuplicate,
  markDuplicate,
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

  app.get("/api/models", (c) =>
    c.json({ provider: deps.modelProvider, models: modelCatalog(deps.modelProvider) }),
  );

  // Inject a task by hand: the quickest way to exercise triage and rules
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

    // Triage can run for seconds (a real AI call), and an agent-step rule for
    // minutes — far longer than this request should be held open. Respond as
    // soon as the task is stored and let the board poll for "triage running…"
    // to resolve, the same way a polled source's ingestion already works.
    void onTaskIngested(deps, task).catch((error) => {
      console.error(`[api] triage for task ${task.id} failed:`, error);
    });

    return c.json({ task }, 201);
  });

  app.get("/api/types", (c) =>
    c.json({
      types: listTaskTypes(deps.db).map((type) => ({
        ...type,
        activeRuleId: getActiveRule(deps.db, type.id)?.id ?? null,
        rules: listRules(deps.db, type.id).map((p) => ({
          id: p.id,
          version: p.version,
          status: p.status,
        })),
      })),
    }),
  );

  app.get("/api/rules/:id", (c) => {
    const rule = getRule(deps.db, c.req.param("id"));
    return rule ? c.json({ rule }) : c.json({ error: "unknown rule" }, 404);
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

  app.post("/api/tasks/:id/dedup", async (c) => {
    const id = c.req.param("id");
    const task = getTask(deps.db, id);
    if (!task) return c.json({ error: "unknown task" }, 404);
    const input = await readJson<{ isDuplicate?: boolean }>(c);
    if (typeof input?.isDuplicate !== "boolean") return c.json({ error: "isDuplicate is required" }, 400);
    if (input.isDuplicate && !task.dedupCandidateId) {
      return c.json({ error: "this task has no pending duplicate candidate" }, 400);
    }

    try {
      const result = await resolveDuplicate(deps, id, input.isDuplicate);
      return input.isDuplicate
        ? c.json({ merged: true, intoTaskId: task.dedupCandidateId })
        : c.json({ task: result });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post("/api/tasks/:id/mark-duplicate", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    const input = await readJson<{ ofTaskId?: string }>(c);
    if (!input?.ofTaskId) return c.json({ error: "ofTaskId is required" }, 400);
    if (input.ofTaskId === id) return c.json({ error: "a task cannot be a duplicate of itself" }, 400);
    if (!getTask(deps.db, input.ofTaskId)) return c.json({ error: "unknown target task" }, 404);

    try {
      markDuplicate(deps, id, input.ofTaskId);
      return c.json({ merged: true, intoTaskId: input.ofTaskId });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
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
      return c.json({ rule: await onboardType(deps, id, description) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/rules/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (!getRule(deps.db, id)) return c.json({ error: "unknown rule" }, 404);
    // Waiting tasks are processed after the response; the board shows them move.
    return c.json({ rule: await activateTypeRule(deps, id, { background: true }) });
  });

  app.get("/api/mcp/tools", (c) => c.json({ tools: deps.mcp.listTools() }));

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

    const problems = validateReferences(parsed.data, deps.mcp.listTools(), modelCatalog(deps.modelProvider));
    if (problems.length) {
      return c.json({ error: problems.join("; ") }, 400);
    }

    return c.json({ rule: insertRule(deps.db, { typeId: id, definition: parsed.data }) });
  });

  return app;
}
