import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import { createVault } from "../../src/vault/vault";
import { discoverExtensions } from "../../src/extensions/discovery";
import { createExtensionRoutes } from "../../src/api/extensions";
import type { HttpFetch } from "../../src/vault/deviceCode";
import type { AgentRunner } from "../../src/agent/runner";
import { getCursor } from "../../src/repo/sourceState";
import { listTasks } from "../../src/repo/tasks";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-ext-routes-"));
}

async function writeManifest(dir: string, id: string, manifest: unknown): Promise<void> {
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
}

async function setup(
  options: {
    fetch?: HttpFetch;
    now?: () => number;
    runAgent?: AgentRunner;
    listTools?: () => { name: string; description: string; inputSchema: Record<string, unknown> }[];
  } = {},
) {
  const db = openDb(":memory:");
  migrate(db);
  const dir = await freshDir();
  const vault = createVault({ db, fetch: options.fetch, now: options.now });
  const runAgent: AgentRunner =
    options.runAgent ?? {
      id: "unused",
      async run() {
        throw new Error("runAgent should not be called in this test");
      },
    };
  const app = createExtensionRoutes({
    db,
    vault,
    extensionsDir: dir,
    runAgent,
    listTools: options.listTools ?? (() => []),
  });
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

test("rescan returns a 500 with a JSON error when extensionsDir is not a directory", async () => {
  const db = openDb(":memory:");
  migrate(db);
  const parent = await freshDir();
  const notADir = join(parent, "not-a-directory");
  await writeFile(notADir, "just a file");
  const vault = createVault({ db });
  const app = createExtensionRoutes({
    db,
    vault,
    extensionsDir: notADir,
    runAgent: {
      id: "unused",
      async run() {
        throw new Error("runAgent should not be called in this test");
      },
    },
    listTools: () => [],
  });

  const response = await app.fetch(
    new Request("http://localhost/api/extensions/rescan", { method: "POST" }),
  );
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as { error?: string };
  expect(typeof body.error).toBe("string");
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
    extensions: { status: string; enabled: boolean }[];
  };
  expect(list.extensions[0]?.status).toBe("not_connected");
  expect(list.extensions[0]?.enabled).toBe(false);
});

test("disconnect clears enabled flag even when not previously disabled", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);

  // Connect the extension
  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "k" }),
    }),
  );

  // Enable it
  await fetch(new Request("http://localhost/api/extensions/notion/enable", { method: "POST" }));

  // Verify it's enabled before disconnect
  let list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { status: string; enabled: boolean }[];
  };
  expect(list.extensions[0]?.enabled).toBe(true);

  // Now disconnect without disabling first
  const disconnected = await fetch(
    new Request("http://localhost/api/extensions/notion/disconnect", { method: "POST" }),
  );
  expect(await disconnected.json()).toEqual({ disconnected: true });

  // Verify enabled is false after disconnect
  list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { status: string; enabled: boolean }[];
  };
  expect(list.extensions[0]?.status).toBe("not_connected");
  expect(list.extensions[0]?.enabled).toBe(false);
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

function fencedReply(manifest: Record<string, unknown>, source: string): string {
  return `\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\`\n\`\`\`typescript\n${source}\n\`\`\``;
}

const demoManifest = {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  summary: "Reads demo items.",
  readOnly: true,
  auth: { mode: "api-key", label: "Token" },
};

const demoSource = `export function createSource(deps) {
  return {
    async poll(cursor) {
      return { items: [], cursor };
    },
  };
}`;

test("generate stages a draft without touching extensionsDir until approved", async () => {
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply(demoManifest, demoSource), toolCalls: [] };
    },
  };
  const { fetch, dir } = await setup({ runAgent });

  const response = await fetch(
    new Request("http://localhost/api/extensions/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "A demo integration" }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { generationId: string; manifest: { id: string } };
  expect(body.manifest.id).toBe("demo");
  expect(body.generationId).toBeTruthy();

  // Verify the real filesystem is untouched: stageDraft should only write to temp, not extensionsDir
  const contents = await readdir(dir);
  expect(contents).toEqual([]);

  const list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: unknown[];
  };
  expect(list.extensions).toEqual([]);
});

test("generate returns 502 when the model fails after retries", async () => {
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: "nope", toolCalls: [] };
    },
  };
  const { fetch } = await setup({ runAgent });

  const response = await fetch(
    new Request("http://localhost/api/extensions/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "d" }),
    }),
  );

  expect(response.status).toBe(502);
});

test("generate requires a non-empty description", async () => {
  const { fetch } = await setup();
  const response = await fetch(
    new Request("http://localhost/api/extensions/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toBe(400);
});

test("approve writes the draft into extensionsDir and it appears in the list", async () => {
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply(demoManifest, demoSource), toolCalls: [] };
    },
  };
  const { fetch } = await setup({ runAgent });

  const generated = (await (
    await fetch(
      new Request("http://localhost/api/extensions/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "d" }),
      }),
    )
  ).json()) as { generationId: string };

  const approved = await fetch(
    new Request(`http://localhost/api/extensions/generate/${generated.generationId}/approve`, {
      method: "POST",
    }),
  );
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({ extensionId: "demo" });

  const list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { id: string }[];
  };
  expect(list.extensions.map((e) => e.id)).toEqual(["demo"]);
});

test("generate auto-suffixes a colliding id", async () => {
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply({ ...demoManifest, id: "notion" }, demoSource), toolCalls: [] };
    },
  };
  const { fetch, dir, db } = await setup({ runAgent });
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);

  const generated = (await (
    await fetch(
      new Request("http://localhost/api/extensions/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "d" }),
      }),
    )
  ).json()) as { manifest: { id: string } };

  expect(generated.manifest.id).toBe("notion-2");
});

test("approve is rejected if a colliding folder appeared after generation", async () => {
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply(demoManifest, demoSource), toolCalls: [] };
    },
  };
  const { fetch, dir, db } = await setup({ runAgent });

  const generated = (await (
    await fetch(
      new Request("http://localhost/api/extensions/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "d" }),
      }),
    )
  ).json()) as { generationId: string };

  // Simulate a collision appearing after generation but before approval —
  // approve's check is a bare filesystem stat(), so it's enough that the
  // folder exists; discovery doesn't need to run over it.
  await writeManifest(dir, "demo", demoManifest);

  const approved = await fetch(
    new Request(`http://localhost/api/extensions/generate/${generated.generationId}/approve`, {
      method: "POST",
    }),
  );
  expect(approved.status).toBe(409);
});

test("discard removes the staged draft and a later approve 404s", async () => {
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply(demoManifest, demoSource), toolCalls: [] };
    },
  };
  const { fetch } = await setup({ runAgent });

  const generated = (await (
    await fetch(
      new Request("http://localhost/api/extensions/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "d" }),
      }),
    )
  ).json()) as { generationId: string };

  const discarded = await fetch(
    new Request(`http://localhost/api/extensions/generate/${generated.generationId}/discard`, {
      method: "POST",
    }),
  );
  expect(await discarded.json()).toEqual({ discarded: true });

  const approveAfterDiscard = await fetch(
    new Request(`http://localhost/api/extensions/generate/${generated.generationId}/approve`, {
      method: "POST",
    }),
  );
  expect(approveAfterDiscard.status).toBe(404);
});

test("test-poll runs poll() for real without creating tasks or storing a cursor", async () => {
  const { fetch, dir, db } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource(deps) {
      return {
        async poll(cursor) {
          const token = await deps.getToken();
          return { items: [{ externalId: "1", title: "via " + token, body: "" }], cursor: "next" };
        },
      };
    }`,
  );
  await discoverExtensions(db, dir);
  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "secret" }),
    }),
  );

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/test-poll", { method: "POST" }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { itemCount: number; sample: { title: string }[] };
  expect(body.itemCount).toBe(1);
  expect(body.sample[0]?.title).toBe("via secret");

  expect(getCursor(db, "notion")).toBeNull();
  expect(listTasks(db)).toEqual([]);
});

test("test-poll surfaces a not-connected error without throwing", async () => {
  const { fetch, dir, db } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource() { return { async poll() { return { items: [], cursor: null }; } }; }`,
  );
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/test-poll", { method: "POST" }),
  );
  expect(response.status).toBe(400);
});

test("delete removes the credential, the db row, and the on-disk folder", async () => {
  const { fetch, dir, db } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);
  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "k" }),
    }),
  );

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/delete", { method: "POST" }),
  );
  expect(await response.json()).toEqual({ deleted: true });

  const afterDelete = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { id: string }[];
  };
  expect(afterDelete.extensions).toEqual([]);

  await discoverExtensions(db, dir);
  const afterRescan = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { id: string }[];
  };
  expect(afterRescan.extensions).toEqual([]);
});

test("delete of an unknown extension is a 404", async () => {
  const { fetch } = await setup();
  const response = await fetch(
    new Request("http://localhost/api/extensions/ghost/delete", { method: "POST" }),
  );
  expect(response.status).toBe(404);
});
