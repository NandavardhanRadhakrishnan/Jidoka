import { test, expect } from "bun:test";
import { createApp, createRoutes } from "../src/main";

test("createApp wires the API and serves an empty board", async () => {
  const app = createApp({
    dbPath: ":memory:",
    port: 0,
    pollIntervalMs: 60_000,
    ai: { provider: "anthropic", apiKey: "test-key" },
    outlook: { tenant: "common" },
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
