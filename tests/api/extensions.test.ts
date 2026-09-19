import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import { createVault } from "../../src/vault/vault";
import { discoverExtensions } from "../../src/extensions/discovery";
import { createExtensionRoutes } from "../../src/api/extensions";
import type { HttpFetch } from "../../src/vault/deviceCode";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-ext-routes-"));
}

async function writeManifest(dir: string, id: string, manifest: unknown): Promise<void> {
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
}

async function setup(options: { fetch?: HttpFetch; now?: () => number } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const dir = await freshDir();
  const vault = createVault({ db, ...options });
  const app = createExtensionRoutes({ db, vault, extensionsDir: dir });
  return { db, dir, vault, fetch: async (req: Request) => app.fetch(req) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const apiKeyManifest = {
  id: "notion",
  name: "Notion",
  version: "1.0.0",
  summary: "Reads pages.",
  readOnly: true,
  auth: { mode: "api-key", label: "Token" },
};

const deviceCodeManifest = {
  id: "outlook2",
  name: "Outlook",
  version: "1.0.0",
  summary: "Reads mail.",
  readOnly: true,
  auth: {
    mode: "oauth2-device-code",
    deviceCodeUrl: "https://example.com/devicecode",
    tokenUrl: "https://example.com/token",
    clientId: "client-1",
    scopes: ["Mail.Read"],
  },
};

const pkceManifest = {
  id: "slack",
  name: "Slack",
  version: "1.0.0",
  summary: "Reads messages.",
  readOnly: true,
  auth: {
    mode: "oauth2-auth-code-pkce",
    authorizeUrl: "https://example.com/authorize",
    tokenUrl: "https://example.com/token",
    clientId: "client-1",
    scopes: ["channels:read"],
  },
};

test("list returns discovered extensions with their vault status", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);

  const response = await fetch(new Request("http://localhost/api/extensions"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { extensions: { id: string; status: string }[] };
  expect(body.extensions).toEqual([
    expect.objectContaining({ id: "notion", status: "not_connected", enabled: false }),
  ]);
});

test("rescan discovers a newly-written folder without a restart", async () => {
  const { dir, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);

  const response = await fetch(new Request("http://localhost/api/extensions/rescan", { method: "POST" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ discovered: { valid: ["notion"], invalid: [] } });
});

test("connecting with an api key stores it, then shows connected", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "secret-1" }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ connected: true });

  const list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { id: string; status: string }[];
  };
  expect(list.extensions[0]?.status).toBe("connected");
});

test("connect/api-key requires a non-empty apiKey", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toBe(400);
});

test("device-code connect: start then complete", async () => {
  const fakeFetch: HttpFetch = async (input) => {
    if (String(input).includes("devicecode")) {
      return jsonResponse({
        user_code: "ABCD",
        device_code: "dc-1",
        verification_uri: "https://example.com/activate",
        expires_in: 900,
        interval: 5,
      });
    }
    return jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  };
  const { dir, db, fetch } = await setup({ fetch: fakeFetch, now: () => 0 });
  await writeManifest(dir, "outlook2", deviceCodeManifest);
  await discoverExtensions(db, dir);

  const start = await fetch(
    new Request("http://localhost/api/extensions/outlook2/connect/device/start", { method: "POST" }),
  );
  expect(start.status).toBe(200);
  const login = (await start.json()) as { deviceCode: string };
  expect(login.deviceCode).toBe("dc-1");

  const complete = await fetch(
    new Request("http://localhost/api/extensions/outlook2/connect/device/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: login.deviceCode }),
    }),
  );
  expect(complete.status).toBe(200);
  expect(await complete.json()).toEqual({ connected: true });
});

test("device-code complete maps AuthPendingError to a 202 pending response", async () => {
  const fakeFetch: HttpFetch = async () => jsonResponse({ error: "authorization_pending" }, 400);
  const { dir, db, fetch } = await setup({ fetch: fakeFetch });
  await writeManifest(dir, "outlook2", deviceCodeManifest);
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/outlook2/connect/device/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "dc-1" }),
    }),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ pending: true });
});

test("PKCE start redirects to the authorize URL with the callback as redirect_uri", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "slack", pkceManifest);
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/slack/connect/pkce/start", { redirect: "manual" }),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://example.com/authorize");
  expect(location.searchParams.get("redirect_uri")).toBe(
    "http://localhost/api/extensions/slack/connect/pkce/callback",
  );
});

test("PKCE callback completes the connection and redirects home", async () => {
  const fakeFetch: HttpFetch = async () =>
    jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  const { dir, db, fetch } = await setup({ fetch: fakeFetch });
  await writeManifest(dir, "slack", pkceManifest);
  await discoverExtensions(db, dir);

  const start = await fetch(
    new Request("http://localhost/api/extensions/slack/connect/pkce/start", { redirect: "manual" }),
  );
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

  const callback = await fetch(
    new Request(
      `http://localhost/api/extensions/slack/connect/pkce/callback?code=auth-code-1&state=${state}`,
      { redirect: "manual" },
    ),
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");
});

test("PKCE callback with an unknown state shows an error page instead of exchanging", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "slack", pkceManifest);
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/slack/connect/pkce/callback?code=c&state=never-issued"),
  );
  expect(response.status).toBe(400);
});

test("enable requires the extension to be connected first", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);

  const rejected = await fetch(
    new Request("http://localhost/api/extensions/notion/enable", { method: "POST" }),
  );
  expect(rejected.status).toBe(400);

  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "k" }),
    }),
  );
  const accepted = await fetch(
    new Request("http://localhost/api/extensions/notion/enable", { method: "POST" }),
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ enabled: true });
});

test("disable and disconnect", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);
  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "k" }),
    }),
  );
  await fetch(new Request("http://localhost/api/extensions/notion/enable", { method: "POST" }));

  const disabled = await fetch(
    new Request("http://localhost/api/extensions/notion/disable", { method: "POST" }),
  );
  expect(await disabled.json()).toEqual({ enabled: false });

  const disconnected = await fetch(
    new Request("http://localhost/api/extensions/notion/disconnect", { method: "POST" }),
  );
  expect(await disconnected.json()).toEqual({ disconnected: true });

  const list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { status: string }[];
  };
  expect(list.extensions[0]?.status).toBe("not_connected");
});

test("an unknown extension id is a 404, not a vault call", async () => {
  const { fetch } = await setup();
  expect(
    (
      await fetch(
        new Request("http://localhost/api/extensions/ghost/connect/device/start", { method: "POST" }),
      )
    ).status,
  ).toBe(404);
  expect(
    (await fetch(new Request("http://localhost/api/extensions/ghost/enable", { method: "POST" }))).status,
  ).toBe(404);
});
