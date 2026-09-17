import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTask } from "../../src/repo/tasks";
import { insertTaskType } from "../../src/repo/taskTypes";
import { createServer } from "../../src/api/server";
import type { AppDeps } from "../../src/orchestrator";
import type { AiProvider } from "../../src/ai/provider";

function app(replies: string[] = []): { deps: AppDeps; fetch: (req: Request) => Promise<Response> } {
  const db = openDb(":memory:");
  migrate(db);
  let i = 0;
  const provider: AiProvider = {
    id: "stub",
    async complete() {
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
  const deps: AppDeps = { db, provider, mcp: { listTools: () => [], callTool: async () => "" } };
  const server = createServer(deps);
  return { deps, fetch: async (req) => server.fetch(req) };
}

test("POST /api/tasks injects a task and runs triage on it", async () => {
  const { deps, fetch } = app([
    JSON.stringify({
      scores: [],
      proposal: { name: "Manual note", description: "Typed in by hand", rationale: "first" },
    }),
  ]);

  const response = await fetch(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Check the invoice", body: "Totals differ by 30" }),
    }),
  );

  expect(response.status).toBe(201);
  const body = (await response.json()) as { task: { sourceId: string; state: string; typeId: string } };
  expect(body.task.sourceId).toBe("manual");
  expect(body.task.state).toBe("needs_onboarding");
  expect(body.task.typeId).not.toBeNull();
});

test("POST /api/tasks rejects a missing title and a duplicate external id", async () => {
  const { deps, fetch } = app([]);
  insertTask(deps.db, { sourceId: "manual", externalId: "dupe", title: "One", body: "b" });

  const noTitle = await fetch(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "no title here" }),
    }),
  );
  expect(noTitle.status).toBe(400);

  const duplicate = await fetch(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Again", externalId: "dupe" }),
    }),
  );
  expect(duplicate.status).toBe(409);
});

test("GET /api/tasks returns tasks", async () => {
  const { deps, fetch } = app();
  insertTask(deps.db, { sourceId: "outlook", externalId: "m1", title: "One", body: "b" });

  const response = await fetch(new Request("http://localhost/api/tasks"));

  expect(response.status).toBe(200);
  const body = (await response.json()) as { tasks: { title: string }[] };
  expect(body.tasks.map((t) => t.title)).toEqual(["One"]);
});

test("GET /api/types returns types with their active pipeline", async () => {
  const { deps, fetch } = app();
  insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const body = (await (await fetch(new Request("http://localhost/api/types"))).json()) as {
    types: { name: string; activePipelineId: string | null }[];
  };

  expect(body.types).toEqual([
    expect.objectContaining({ name: "Customer email", activePipelineId: null }),
  ]);
});

test("POST /api/tasks/:id/type confirms an ambiguous task", async () => {
  const { deps, fetch } = app();
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });
  const task = insertTask(deps.db, { sourceId: "outlook", externalId: "m1", title: "One", body: "b" });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/type`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeId: type.id }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { task: { typeId: string; state: string } };
  expect(body.task.typeId).toBe(type.id);
  expect(body.task.state).toBe("needs_onboarding");
});

test("POST /api/types/:id/onboard builds a draft pipeline and activate publishes it", async () => {
  const { deps, fetch } = app([
    JSON.stringify({
      steps: [
        { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
  ]);
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const draft = (await (
    await fetch(
      new Request(`http://localhost/api/types/${type.id}/onboard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "Summarize then hand to a human" }),
      }),
    )
  ).json()) as { pipeline: { id: string; status: string } };

  expect(draft.pipeline.status).toBe("draft");

  const activated = (await (
    await fetch(
      new Request(`http://localhost/api/pipelines/${draft.pipeline.id}/activate`, {
        method: "POST",
      }),
    )
  ).json()) as { pipeline: { status: string } };

  expect(activated.pipeline.status).toBe("active");
});

test("a request for an unknown task returns 404", async () => {
  const { fetch } = app();

  const response = await fetch(
    new Request("http://localhost/api/tasks/nope/skip-onboarding", { method: "POST" }),
  );

  expect(response.status).toBe(404);
});
