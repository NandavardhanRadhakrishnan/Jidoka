import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { getTask, insertTask, updateTask, deleteTask } from "../../src/repo/tasks";
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
  const deps: AppDeps = {
    db,
    provider,
    modelProvider: "anthropic",
    mcp: { listTools: () => [], callTool: async () => "" },
  };
  const server = createServer(deps);
  return { deps, fetch: async (req) => server.fetch(req) };
}

test("POST /api/tasks responds immediately, then triages in the background", async () => {
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

  // The response must not wait on triage — it reports the freshly ingested
  // task so the request (and any UI holding it open) never blocks on an AI call.
  expect(response.status).toBe(201);
  const body = (await response.json()) as { task: { id: string; sourceId: string; state: string; typeId: string | null } };
  expect(body.task.sourceId).toBe("manual");
  expect(body.task.state).toBe("ingested");
  expect(body.task.typeId).toBeNull();

  await Bun.sleep(10);
  const settled = getTask(deps.db, body.task.id);
  expect(settled?.state).toBe("needs_onboarding");
  expect(settled?.typeId).not.toBeNull();
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

test("a malformed JSON body is a 400, not a crash", async () => {
  const { deps, fetch } = app([]);
  const type = insertTaskType(deps.db, { name: "Email query", description: "d" });

  const inject = await fetch(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    }),
  );
  expect(inject.status).toBe(400);

  const onboard = await fetch(
    new Request(`http://localhost/api/types/${type.id}/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    }),
  );
  expect(onboard.status).toBe(400);
});

test("a human can complete a task and reopen it", async () => {
  const { deps, fetch } = app();
  const task = insertTask(deps.db, {
    sourceId: "manual",
    externalId: "m9",
    title: "Call the supplier",
    body: "b",
  });
  deps.db.query("UPDATE tasks SET state = 'assigned_human', assignee = 'human' WHERE id = ?").run(
    task.id,
  );

  const done = (await (
    await fetch(
      new Request(`http://localhost/api/tasks/${task.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "supplier agreed to credit it" }),
      }),
    )
  ).json()) as { task: { state: string; context: Record<string, unknown> } };

  expect(done.task.state).toBe("done");
  expect(done.task.context.completionNote).toBe("supplier agreed to credit it");
  expect(done.task.context.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  const reopened = (await (
    await fetch(new Request(`http://localhost/api/tasks/${task.id}/reopen`, { method: "POST" }))
  ).json()) as { task: { state: string; assignee: string; context: Record<string, unknown> } };

  expect(reopened.task.state).toBe("assigned_human");
  expect(reopened.task.assignee).toBe("human");
  expect(reopened.task.context.completedAt).toBeUndefined();
  expect(reopened.task.context.completionNote).toBeUndefined();
});

test("completing without a note works, completing twice is a no-op, unknown ids 404", async () => {
  const { deps, fetch } = app();
  const task = insertTask(deps.db, { sourceId: "manual", externalId: "m10", title: "T", body: "" });

  const first = (await (
    await fetch(
      new Request(`http://localhost/api/tasks/${task.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
  ).json()) as { task: { state: string; context: Record<string, unknown> } };
  expect(first.task.state).toBe("done");
  expect(first.task.context.completionNote).toBeUndefined();

  const again = (await (
    await fetch(new Request(`http://localhost/api/tasks/${task.id}/complete`, { method: "POST" }))
  ).json()) as { task: { state: string; context: { completedAt: string } } };
  expect(again.task.state).toBe("done");
  expect(again.task.context.completedAt).toBe(first.task.context.completedAt as string);

  expect(
    (await fetch(new Request("http://localhost/api/tasks/ghost/complete", { method: "POST" }))).status,
  ).toBe(404);
  expect(
    (await fetch(new Request("http://localhost/api/tasks/ghost/reopen", { method: "POST" }))).status,
  ).toBe(404);
});

test("GET /api/tasks returns tasks", async () => {
  const { deps, fetch } = app();
  insertTask(deps.db, { sourceId: "outlook", externalId: "m1", title: "One", body: "b" });

  const response = await fetch(new Request("http://localhost/api/tasks"));

  expect(response.status).toBe(200);
  const body = (await response.json()) as { tasks: { title: string }[] };
  expect(body.tasks.map((t) => t.title)).toEqual(["One"]);
});

test("GET /api/types returns types with their active rule", async () => {
  const { deps, fetch } = app();
  insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const body = (await (await fetch(new Request("http://localhost/api/types"))).json()) as {
    types: { name: string; activeRuleId: string | null }[];
  };

  expect(body.types).toEqual([
    expect.objectContaining({ name: "Customer email", activeRuleId: null }),
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

test("POST /api/types/:id/onboard builds a draft rule and activate publishes it", async () => {
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
  ).json()) as { rule: { id: string; status: string } };

  expect(draft.rule.status).toBe("draft");

  const activated = (await (
    await fetch(
      new Request(`http://localhost/api/rules/${draft.rule.id}/activate`, {
        method: "POST",
      }),
    )
  ).json()) as { rule: { status: string } };

  expect(activated.rule.status).toBe("active");

  // Waiting tasks are processed after the response, so the route must not block.
  await Bun.sleep(10);
});

test("a request for an unknown task returns 404", async () => {
  const { fetch } = app();

  const response = await fetch(
    new Request("http://localhost/api/tasks/nope/skip-onboarding", { method: "POST" }),
  );

  expect(response.status).toBe(404);
});

test("GET /api/models returns the configured provider's catalog", async () => {
  const { fetch } = app();

  const body = (await (await fetch(new Request("http://localhost/api/models"))).json()) as {
    provider: string;
    models: { id: string; label: string }[];
  };

  expect(body.provider).toBe("anthropic");
  expect(body.models.map((m) => m.id)).toContain("claude-sonnet-5");
});

test("GET /api/mcp/tools returns the configured tool catalog", async () => {
  const db = openDb(":memory:");
  migrate(db);
  const deps: AppDeps = {
    db,
    provider: { id: "stub", async complete() { return { text: "", toolCalls: [] }; } },
    modelProvider: "anthropic",
    mcp: {
      listTools: () => [{ name: "outlook__get_thread", description: "Fetch a thread", inputSchema: { type: "object" } }],
      callTool: async () => "",
    },
  };
  const server = createServer(deps);

  const body = (await (
    await server.fetch(new Request("http://localhost/api/mcp/tools"))
  ).json()) as { tools: { name: string }[] };

  expect(body.tools.map((t) => t.name)).toEqual(["outlook__get_thread"]);
});

test("POST /api/types/:id/rules saves a hand-edited definition as a new draft version", async () => {
  const { deps, fetch } = app();
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const response = await fetch(
    new Request(`http://localhost/api/types/${type.id}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        definition: {
          steps: [
            { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
            { id: "s2", type: "assign", to: "human" },
          ],
        },
      }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { rule: { version: number; status: string } };
  expect(body.rule).toMatchObject({ version: 1, status: "draft" });
});

test("POST /api/types/:id/rules rejects a definition with no terminal assign step with 400", async () => {
  const { deps, fetch } = app();
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const response = await fetch(
    new Request(`http://localhost/api/types/${type.id}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        definition: { steps: [{ id: "s1", type: "ai", prompt: "x", output: "o" }] },
      }),
    }),
  );

  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain("assign");
});

test("POST /api/types/:id/rules rejects an invalid definition with 400", async () => {
  const { deps, fetch } = app();
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const response = await fetch(
    new Request(`http://localhost/api/types/${type.id}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition: { steps: [{ id: "s1", type: "teleport" }] } }),
    }),
  );

  expect(response.status).toBe(400);
});

test("POST /api/tasks/:id/dedup confirms a duplicate, deletes it, and records the merge on the target", async () => {
  const { deps, fetch } = app([]);
  const target = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });
  updateTask(deps.db, dup.id, { state: "needs_dedup_confirmation", dedupCandidateId: target.id });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/dedup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { merged: boolean; intoTaskId: string };
  expect(body.merged).toBe(true);
  expect(body.intoTaskId).toBe(target.id);
  expect(getTask(deps.db, dup.id)).toBeNull();
  expect(getTask(deps.db, target.id)?.context.mergedFrom).toBeDefined();
});

test("POST /api/tasks/:id/dedup on a task with no pending candidate is rejected", async () => {
  const { deps, fetch } = app([]);
  const task = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Solo", body: "b" });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/dedup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );

  expect(response.status).toBe(400);
});

test("POST /api/tasks/:id/dedup with isDuplicate false succeeds even with no pending candidate, so a dangling reference is never a dead end", async () => {
  const { deps, fetch } = app([
    JSON.stringify({ scores: [], proposal: { name: "Solo type", description: "d", rationale: "r" } }),
  ]);
  const task = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Solo", body: "b" });
  updateTask(deps.db, task.id, { state: "needs_dedup_confirmation", dedupCandidateId: null });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/dedup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: false }),
    }),
  );

  expect(response.status).toBe(200);
});

test("POST /api/tasks/:id/dedup on an unknown task 404s", async () => {
  const { fetch } = app([]);
  const response = await fetch(
    new Request("http://localhost/api/tasks/ghost/dedup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );
  expect(response.status).toBe(404);
});

test("POST /api/tasks/:id/dedup surfaces a 409, not a crash, when the candidate task is gone", async () => {
  const { deps, fetch } = app([]);
  const candidate = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });
  updateTask(deps.db, dup.id, { state: "needs_dedup_confirmation", dedupCandidateId: candidate.id });
  deleteTask(deps.db, candidate.id);

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/dedup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDuplicate: true }),
    }),
  );

  expect(response.status).toBe(409);
});

test("POST /api/tasks/:id/mark-duplicate merges into a chosen target of any state", async () => {
  const { deps, fetch } = app([]);
  const target = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  updateTask(deps.db, target.id, { state: "done" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: target.id }),
    }),
  );

  expect(response.status).toBe(200);
  expect(getTask(deps.db, dup.id)).toBeNull();
});

test("POST /api/tasks/:id/mark-duplicate rejects an unknown target, self-reference, and a processing duplicate", async () => {
  const { deps, fetch } = app([]);
  const target = insertTask(deps.db, { sourceId: "outlook", externalId: "t0", title: "Original", body: "b" });
  const dup = insertTask(deps.db, { sourceId: "github", externalId: "t1", title: "Duplicate", body: "b" });

  const unknownTarget = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: "ghost" }),
    }),
  );
  expect(unknownTarget.status).toBe(404);

  const selfMerge = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: dup.id }),
    }),
  );
  expect(selfMerge.status).toBe(400);

  updateTask(deps.db, dup.id, { state: "processing" });
  const whileProcessing = await fetch(
    new Request(`http://localhost/api/tasks/${dup.id}/mark-duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ofTaskId: target.id }),
    }),
  );
  expect(whileProcessing.status).toBe(409);
});
