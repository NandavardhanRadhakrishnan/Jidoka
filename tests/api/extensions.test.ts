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
import { pollSource, type PollHooks } from "../../src/sources/poller";
import { loadOneExtensionSource } from "../../src/extensions/runtime";
import { getItemRow } from "../../src/repo/sourceItems";
import { listTasks } from "../../src/repo/tasks";
import { getResolvedIdentity, setResolvedIdentity } from "../../src/repo/extensions";
import { addIdentity, createPerson, ensureRosterDefaults, getPerson, getSelf } from "../../src/repo/roster";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-ext-routes-"));
}

async function writeManifest(dir: string, id: string, manifest: unknown): Promise<void> {
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
}

function recordingHooks(): PollHooks {
  return { async onCreated() {}, async onChanged() {} };
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
  ensureRosterDefaults(db);
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
    pollHooks: recordingHooks(),
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
    pollHooks: recordingHooks(),
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
    async list({ since }) {
      return { items: [], failures: [] };
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

test("test-poll runs list({ since: null }) for real without creating tasks or storing a cursor", async () => {
  const { fetch, dir, db } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource(deps) {
      return {
        async list({ since }) {
          const token = await deps.getToken();
          return { items: [{ key: "1", occurredAt: "2026-10-20T10:00:00.000Z", title: "via " + token + " since " + since, body: "" }] };
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
  const body = (await response.json()) as { items: { title: string }[] };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.title).toBe("via secret since null");

  expect(listTasks(db)).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM source_items").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM source_polls").get()).toEqual({ n: 0 });
});

const KEYED_FAIL = "<fail@x.example>";
const BAD_TITLE = "<bad-title@x.example>";
const GOOD = "<good@x.example>";

const pollingSource = `export function createSource(deps) {
  return {
    async list({ since }) {
      globalThis.__lists = (globalThis.__lists ?? []).concat([since]);
      return {
        items: [
          { key: ${JSON.stringify(GOOD)}, occurredAt: "2026-10-20T10:00:00.000Z", title: "good", body: "b" },
          { key: ${JSON.stringify(BAD_TITLE)}, occurredAt: "2026-10-20T11:00:00.000Z", title: "  ", body: "b" },
        ],
        failures: [{ key: ${JSON.stringify(KEYED_FAIL)}, error: "could not parse" }],
      };
    },
  };
}`;

async function pollingSetup() {
  const ctx = await setup();
  await writeManifest(ctx.dir, "notion", apiKeyManifest);
  await writeFile(join(ctx.dir, "notion", "source.ts"), pollingSource);
  await discoverExtensions(ctx.db, ctx.dir);
  ctx.vault.saveApiKey("notion", "k");
  const source = await loadOneExtensionSource(ctx.db, ctx.dir, ctx.vault, "notion");
  await pollSource(ctx.db, source, recordingHooks());
  return ctx;
}

const post = (path: string) => new Request(`http://localhost/api/extensions/notion/${path}`, { method: "POST" });

test("test-poll previews items, source failures and check failures, writing nothing", async () => {
  const { fetch, dir, db, vault } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await writeFile(join(dir, "notion", "source.ts"), pollingSource);
  await discoverExtensions(db, dir);
  vault.saveApiKey("notion", "k");

  const response = await fetch(post("test-poll"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: unknown[]; failures: unknown[]; checkFailures: unknown[] };
  expect(body.items).toHaveLength(1);
  expect(body.failures).toHaveLength(1);
  expect(body.checkFailures).toHaveLength(1);
  expect(listTasks(db)).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM source_items").get()).toEqual({ n: 0 });
});

test("polls, failures, dismiss, retry, rescan and delete", async () => {
  const { fetch, db } = await pollingSetup();
  (globalThis as { __lists?: unknown[] }).__lists = undefined;

  const polls = (await (await fetch(new Request("http://localhost/api/extensions/notion/polls"))).json()) as {
    polls: { outcome: string }[];
  };
  expect(polls.polls).toHaveLength(1);
  expect(polls.polls[0]?.outcome).toBe("ok");

  const failures = async () =>
    (
      (await (await fetch(new Request("http://localhost/api/extensions/notion/failures"))).json()) as {
        failures: { key: string; failedWindow: string | null }[];
      }
    ).failures;
  expect(await failures()).toHaveLength(2);

  const listed = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { failedCount: number; lastPoll: { kind: string } | null }[];
  };
  expect(listed.extensions[0]?.failedCount).toBe(2);
  expect(listed.extensions[0]?.lastPoll?.kind).toBe("poll");

  const dismissed = await fetch(post(`failures/${encodeURIComponent(BAD_TITLE)}/dismiss`));
  expect(await dismissed.json()).toEqual({ dismissed: true });
  const remaining = await failures();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.key).toBe(KEYED_FAIL);

  const window = remaining[0]?.failedWindow;
  const retry = await fetch(post(`failures/${encodeURIComponent(KEYED_FAIL)}/retry`));
  expect(retry.status).toBe(200);
  const retried = (await retry.json()) as { poll: { kind: string } };
  expect(retried.poll.kind).toBe("retry");
  expect((globalThis as { __lists?: unknown[] }).__lists).toEqual([window]);

  const rescan = await fetch(post("rescan"));
  expect(rescan.status).toBe(200);
  const rescanned = (await rescan.json()) as { recovered: number; poll: { kind: string } };
  expect(rescanned.recovered).toBe(0);
  expect(rescanned.poll.kind).toBe("rescan");

  expect(getItemRow(db, "notion", GOOD)).not.toBeNull();
  const del = await fetch(post("delete"));
  expect(await del.json()).toEqual({ deleted: true });
  for (const table of ["source_items", "source_polls", "source_horizons"]) {
    expect(db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id = 'notion'`).get()).toEqual({ n: 0 });
  }
});

test("retry on an unknown or dismissed key is a 404", async () => {
  const { fetch } = await pollingSetup();
  expect((await fetch(post(`failures/${encodeURIComponent("<nope@x>")}/retry`))).status).toBe(404);
  await fetch(post(`failures/${encodeURIComponent(BAD_TITLE)}/dismiss`));
  expect((await fetch(post(`failures/${encodeURIComponent(BAD_TITLE)}/retry`))).status).toBe(404);
});

test("polling routes: unknown extension is 404, not connected is 400", async () => {
  const { fetch, dir, db } = await setup();
  expect((await fetch(new Request("http://localhost/api/extensions/ghost/polls"))).status).toBe(404);
  expect((await fetch(new Request("http://localhost/api/extensions/ghost/failures"))).status).toBe(404);
  await writeManifest(dir, "notion", apiKeyManifest);
  await discoverExtensions(db, dir);
  expect((await fetch(post("rescan"))).status).toBe(400);
  expect((await fetch(post("failures/k/retry"))).status).toBe(400);
});

test("test-poll surfaces a not-connected error without throwing", async () => {
  const { fetch, dir, db } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource() { return { async list() { return { items: [] }; } }; }`,
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

test("fix reads the current files and stages a corrected draft under the same id", async () => {
  const fixedManifest = { ...apiKeyManifest, id: "renamed-by-model" };
  const fixedSource = `export function createSource(deps) {
    return { async list({ since }) { return { items: [] }; } };
  }`;
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply(fixedManifest, fixedSource), toolCalls: [] };
    },
  };

  const { fetch, dir, db } = await setup({ runAgent });
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource() { return { async list() { throw new Error("bad url"); } }; }`,
  );
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "bad url" }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { generationId: string; manifest: { id: string } };
  expect(body.manifest.id).toBe("notion");

  const approved = await fetch(
    new Request(`http://localhost/api/extensions/generate/${body.generationId}/approve`, {
      method: "POST",
    }),
  );
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({ extensionId: "notion" });

  const sourceAfterFix = await readFile(join(dir, "notion", "source.ts"), "utf8");
  expect(sourceAfterFix).toContain("list({ since })");
  expect(sourceAfterFix).not.toContain("bad url");
});

test("fix requires a non-empty error", async () => {
  const { fetch, dir, db } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource() { return { async list() { return { items: [] }; } }; }`,
  );
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toBe(400);
});

test("fix on an unknown extension is a 404", async () => {
  const { fetch } = await setup();
  const response = await fetch(
    new Request("http://localhost/api/extensions/ghost/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "x" }),
    }),
  );
  expect(response.status).toBe(404);
});

test("approving a fix that changes auth.mode disconnects the stale credential, falling back to not_connected", async () => {
  const fixedManifest = {
    ...apiKeyManifest,
    auth: {
      mode: "oauth2-auth-code-pkce",
      authorizeUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      clientId: "client-1",
      scopes: ["read"],
    },
  };
  const fixedSource = `export function createSource() {
    return { async list({ since }) { return { items: [] }; } };
  }`;
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply(fixedManifest, fixedSource), toolCalls: [] };
    },
  };

  const { fetch, dir, db } = await setup({ runAgent });
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource() { return { async list() { throw new Error("needs oauth"); } }; }`,
  );
  await discoverExtensions(db, dir);
  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "k" }),
    }),
  );

  const fixResponse = await fetch(
    new Request("http://localhost/api/extensions/notion/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "needs oauth" }),
    }),
  );
  const { generationId } = (await fixResponse.json()) as { generationId: string };

  const approved = await fetch(
    new Request(`http://localhost/api/extensions/generate/${generationId}/approve`, {
      method: "POST",
    }),
  );
  expect(approved.status).toBe(200);

  const list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { id: string; status: string }[];
  };
  expect(list.extensions.find((e) => e.id === "notion")?.status).toBe("not_connected");
});

test("approving a fix that keeps the same auth.mode leaves an existing connection intact", async () => {
  const fixedSource = `export function createSource() {
    return { async list({ since }) { return { items: [] }; } };
  }`;
  const runAgent: AgentRunner = {
    id: "stub",
    async run() {
      return { text: fencedReply(apiKeyManifest, fixedSource), toolCalls: [] };
    },
  };

  const { fetch, dir, db } = await setup({ runAgent });
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource() { return { async list() { throw new Error("bad url"); } }; }`,
  );
  await discoverExtensions(db, dir);
  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "k" }),
    }),
  );

  const fixResponse = await fetch(
    new Request("http://localhost/api/extensions/notion/fix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "bad url" }),
    }),
  );
  const { generationId } = (await fixResponse.json()) as { generationId: string };

  const approved = await fetch(
    new Request(`http://localhost/api/extensions/generate/${generationId}/approve`, {
      method: "POST",
    }),
  );
  expect(approved.status).toBe(200);

  const list = (await (await fetch(new Request("http://localhost/api/extensions"))).json()) as {
    extensions: { id: string; status: string }[];
  };
  expect(list.extensions.find((e) => e.id === "notion")?.status).toBe("connected");
});

async function writeIdentitySource(dir: string, id: string, getIdentityBody: string): Promise<void> {
  await writeFile(
    join(dir, id, "source.ts"),
    `export function createSource() { return { id: "${id}", async list() { return { items: [] }; } }; }
     export async function getIdentity(deps) { ${getIdentityBody} }`,
  );
}

test("connecting with an api key resolves and stores the source's identity", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await writeIdentitySource(dir, "notion", `return "me@" + (await deps.getToken());`);
  await discoverExtensions(db, dir);

  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "secret-1" }),
    }),
  );

  expect(getResolvedIdentity(db, "notion")).toBe("me@secret-1");
});

test("a failing getIdentity neither fails the connect nor clears a previously stored identity", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await writeIdentitySource(dir, "notion", `throw new Error("network down");`);
  await discoverExtensions(db, dir);
  setResolvedIdentity(db, "notion", "earlier-identity");

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "secret-1" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(getResolvedIdentity(db, "notion")).toBe("earlier-identity");
});

test("completing a device-code connect also resolves the identity", async () => {
  const fakeFetch: HttpFetch = async (input) => {
    if (String(input).includes("devicecode")) {
      return jsonResponse({ user_code: "A", device_code: "dc-1", verification_uri: "https://e.com", expires_in: 900, interval: 5 });
    }
    return jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  };
  const { dir, db, fetch } = await setup({ fetch: fakeFetch, now: () => 0 });
  await writeManifest(dir, "outlook2", deviceCodeManifest);
  await writeIdentitySource(dir, "outlook2", `return "mailbox-" + (await deps.getToken());`);
  await discoverExtensions(db, dir);

  await fetch(new Request("http://localhost/api/extensions/outlook2/connect/device/start", { method: "POST" }));
  await fetch(
    new Request("http://localhost/api/extensions/outlook2/connect/device/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "dc-1" }),
    }),
  );

  expect(getResolvedIdentity(db, "outlook2")).toBe("mailbox-at-1");
});

test("a namespaced identity from getIdentity lands on Me; a bare one doesn't", async () => {
  const { dir, db, fetch } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await writeIdentitySource(dir, "notion", `return "github:Octo";`);
  await discoverExtensions(db, dir);

  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "secret-1" }),
    }),
  );
  expect(getSelf(db).identities).toEqual(["github:Octo"]);

  await writeIdentitySource(dir, "notion", `return "plain-login";`);
  await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "secret-2" }),
    }),
  );
  expect(getResolvedIdentity(db, "notion")).toBe("plain-login");
  expect(getSelf(db).identities).toEqual(["github:Octo"]);
});

test("an identity someone else owns doesn't fail the connect or move", async () => {
  const { dir, db, fetch } = await setup();
  const bob = createPerson(db, { name: "Bob", orgId: null });
  addIdentity(db, bob.id, "github:octo");
  await writeManifest(dir, "notion", apiKeyManifest);
  await writeIdentitySource(dir, "notion", `return "github:octo";`);
  await discoverExtensions(db, dir);

  const response = await fetch(
    new Request("http://localhost/api/extensions/notion/connect/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "secret-1" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(getPerson(db, bob.id)?.identities).toEqual(["github:octo"]);
  expect(getSelf(db).identities).toEqual([]);
});
