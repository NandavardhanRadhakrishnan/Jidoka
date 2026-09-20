import { test, expect } from "bun:test";
import { createApp, createRoutes } from "../src/main";

test("createApp wires the API and serves an empty board", async () => {
  const app = createApp({
    dbPath: ":memory:",
    port: 0,
    pollIntervalMs: 60_000,
    ai: { provider: "anthropic", apiKey: "test-key" },
    outlook: { tenant: "common" },
    extensionsDir: "./does-not-exist-in-tests",
    agent: { runner: "in-process", concurrency: 2 },
    oauth: {},
    mcpServers: [],
  });

  const tasks = await app.fetch(new Request("http://localhost/api/tasks"));
  expect(tasks.status).toBe(200);
  expect(await tasks.json()).toEqual({ tasks: [] });

  const types = await app.fetch(new Request("http://localhost/api/types"));
  expect(types.status).toBe(200);
  expect(await types.json()).toEqual({ types: [] });

  await app.close();
});

test("the served routes send /api to the API and everything else to the page", async () => {
  const app = createApp({
    dbPath: ":memory:",
    port: 0,
    pollIntervalMs: 60_000,
    ai: { provider: "anthropic", apiKey: "test-key" },
    outlook: { tenant: "common" },
    extensionsDir: "./does-not-exist-in-tests",
    agent: { runner: "in-process", concurrency: 2 },
    oauth: {},
    mcpServers: [],
  });
  const server = Bun.serve({ port: 0, routes: createRoutes(app) });

  try {
    const api = await fetch(`${server.url}api/tasks`);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(await api.json()).toEqual({ tasks: [] });

    const page = await fetch(`${server.url}`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('id="root"');
  } finally {
    await server.stop(true);
    await app.close();
  }
});

test("the extension routes are mounted and reachable through createApp", async () => {
  const app = createApp({
    dbPath: ":memory:",
    port: 0,
    pollIntervalMs: 60_000,
    ai: { provider: "anthropic", apiKey: "test-key" },
    outlook: { tenant: "common" },
    extensionsDir: "./does-not-exist-in-tests",
    agent: { runner: "in-process", concurrency: 2 },
    oauth: {},
    mcpServers: [],
  });

  const response = await app.fetch(new Request("http://localhost/api/extensions"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ extensions: [] });

  await app.close();
});

test("the settings routes are mounted and reachable through createApp", async () => {
  const app = createApp({
    dbPath: ":memory:",
    port: 0,
    pollIntervalMs: 60_000,
    ai: { provider: "anthropic", apiKey: "test-key" },
    outlook: { tenant: "common" },
    extensionsDir: "./does-not-exist-in-tests",
    agent: { runner: "in-process", concurrency: 2 },
    oauth: {},
    mcpServers: [],
  });

  const response = await app.fetch(new Request("http://localhost/api/settings"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { effective: { ai: { provider: string } } };
  expect(body.effective.ai.provider).toBe("anthropic");

  await app.close();
});

test("createApp applies a pre-saved setting onto app.config", async () => {
  const { Database } = await import("bun:sqlite");
  const { migrate } = await import("../src/db");
  const dbPath = `./test-smoke-${crypto.randomUUID()}.db`;
  const seedDb = new Database(dbPath);
  migrate(seedDb);
  seedDb.query(
    `INSERT INTO settings (id, data) VALUES ('global', ?)`,
  ).run(JSON.stringify({ ai: { model: "claude-opus-5" } }));
  seedDb.close();

  const app = createApp({
    dbPath,
    port: 0,
    pollIntervalMs: 60_000,
    ai: { provider: "anthropic", apiKey: "test-key" },
    outlook: { tenant: "common" },
    extensionsDir: "./does-not-exist-in-tests",
    agent: { runner: "in-process", concurrency: 2 },
    oauth: {},
    mcpServers: [],
  });

  expect(app.config.ai.model).toBe("claude-opus-5");

  await app.close();
  try {
    const fs = await import("node:fs");
    fs.unlinkSync(dbPath);
    try {
      fs.unlinkSync(`${dbPath}-wal`);
    } catch {}
    try {
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {}
  } catch {}
});

test("createApp exposes a vault for the CLI entrypoint to wire into the poller", async () => {
  const app = createApp({
    dbPath: ":memory:",
    port: 0,
    pollIntervalMs: 60_000,
    ai: { provider: "anthropic", apiKey: "test-key" },
    outlook: { tenant: "common" },
    extensionsDir: "./does-not-exist-in-tests",
    agent: { runner: "in-process", concurrency: 2 },
    oauth: {},
    mcpServers: [],
  });

  expect(app.vault.status("nonexistent")).toBe("unknown");

  await app.close();
});
