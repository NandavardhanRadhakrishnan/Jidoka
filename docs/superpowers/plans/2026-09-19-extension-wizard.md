# Extension Vault Routes & Wizard (Path A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the extension vault a real entry point: HTTP routes over discovery and the `Vault`, and a wizard UI for installing an already-present extension folder (Review → Connect → Activate; no Config step, no agent-generation path — both deferred).

**Architecture:** New `src/api/extensions.ts` routes, mirroring `src/api/auth.ts`'s shape exactly (a `createExtensionRoutes(deps)` factory, a PKCE start/callback pair reusing the same pending-state-in-memory pattern). `main.ts` wires a `Vault` and runs discovery once at startup. A new `Extensions.tsx` client component, styled and structured like the existing `SignIn.tsx` widget, drives the routes from a header-opened dialog.

**Tech Stack:** Bun (`bun:sqlite`, `bun:test`), Hono, React (no router — conditional rendering, matching the rest of `src/client/`).

**Spec:** `docs/superpowers/specs/2026-09-19-extension-wizard-design.md`

## Global Constraints

- Bun only. No test hits a network: every HTTP call the vault makes takes an injectable `fetch`; route tests inject it through `VaultDeps`.
- `bun run typecheck` (`tsc --noEmit`) must stay clean after every task.
- No Config step, no `config` field persistence, no poller wiring, no agent-authored generation (Path B) — all explicitly out of scope per the spec.
- Every route 404s with `{ error: "unknown extension" }` for an id `extensionsRepo.get` doesn't find, before calling the vault.
- `src/client/` has no router; new UI is conditional rendering added to `App.tsx`, matching `SignIn`/`Onboarding`/`TypeConfirm`.
- This codebase has no `.tsx` test files; the UI task is verified manually via the `run` skill, not with new test infrastructure.

---

## Task 1: Extension HTTP routes

**Files:**
- Create: `src/api/extensions.ts`
- Test: `tests/api/extensions.test.ts`

**Interfaces:**
- Consumes: `extensionsRepo.get/list/setEnabled` (`src/repo/extensions.ts`, existing); `discoverExtensions` (`src/extensions/discovery.ts`, existing); `Vault`, `createVault`, `AuthPendingError` (`src/vault/vault.ts`, existing); `HttpFetch` (`src/vault/deviceCode.ts`, existing, for tests).
- Produces: `ExtensionRoutesDeps` type (`{ db: Database, vault: Vault, extensionsDir: string }`), `createExtensionRoutes(deps): Hono`. Response shapes: `GET /api/extensions` → `{ extensions: ExtensionListItem[] }` where `ExtensionListItem = { id, name, summary, readOnly, auth: ExtensionAuth, enabled, valid, error, status }`; `POST .../rescan` → `{ discovered: { valid: string[], invalid: { id, error }[] } }`; `POST .../connect/api-key` → `{ connected: true }`; `POST .../connect/device/start` → `DeviceLogin` shape (`{ userCode, verificationUri, deviceCode, expiresIn, interval }`); `POST .../connect/device/complete` → `{ connected: true }` (200) or `{ pending: true }` (202); `GET .../connect/pkce/start` → 302 redirect; `GET .../connect/pkce/callback` → 302 to `/` or an HTML error page; `POST .../disconnect` → `{ disconnected: true }`; `POST .../enable` → `{ enabled: true }`; `POST .../disable` → `{ enabled: false }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/api/extensions.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/api/extensions.test.ts`
Expected: FAIL — `src/api/extensions.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/api/extensions.ts
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import { discoverExtensions } from "../extensions/discovery";
import { AuthPendingError, type Vault } from "../vault/vault";

export interface ExtensionRoutesDeps {
  db: Database;
  vault: Vault;
  extensionsDir: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (ch) =>
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : "&quot;",
  );
}

function callbackUrl(requestUrl: string, id: string): string {
  return new URL(`/api/extensions/${id}/connect/pkce/callback`, requestUrl).toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createExtensionRoutes(deps: ExtensionRoutesDeps): Hono {
  const app = new Hono();

  function list() {
    return extensionsRepo.list(deps.db).map((record) => ({
      id: record.id,
      name: record.name,
      summary: record.summary,
      readOnly: record.readOnly,
      auth: record.auth,
      enabled: record.enabled,
      valid: record.valid,
      error: record.error,
      status: deps.vault.status(record.id),
    }));
  }

  app.get("/api/extensions", (c) => c.json({ extensions: list() }));

  app.post("/api/extensions/rescan", async (c) => {
    const discovered = await discoverExtensions(deps.db, deps.extensionsDir);
    return c.json({ discovered });
  });

  app.post("/api/extensions/:id/connect/api-key", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    let body: { apiKey?: string } | null;
    try {
      body = (await c.req.json()) as { apiKey?: string };
    } catch {
      body = null;
    }
    if (!body?.apiKey?.trim()) return c.json({ error: "apiKey is required" }, 400);
    try {
      deps.vault.saveApiKey(id, body.apiKey);
      return c.json({ connected: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/extensions/:id/connect/device/start", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    try {
      return c.json(await deps.vault.startDeviceConnect(id));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/extensions/:id/connect/device/complete", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    let body: { deviceCode?: string } | null;
    try {
      body = (await c.req.json()) as { deviceCode?: string };
    } catch {
      body = null;
    }
    if (!body?.deviceCode) return c.json({ error: "deviceCode is required" }, 400);
    try {
      await deps.vault.completeDeviceConnect(id, body.deviceCode);
      return c.json({ connected: true });
    } catch (error) {
      if (error instanceof AuthPendingError) return c.json({ pending: true }, 202);
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/extensions/:id/connect/pkce/start", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    try {
      const { url } = await deps.vault.startAuthCodeConnect(id, callbackUrl(c.req.url, id));
      return c.redirect(url, 302);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/extensions/:id/connect/pkce/callback", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);

    const error = c.req.query("error");
    if (error) {
      const description = c.req.query("error_description") ?? "";
      return c.html(
        `<h1>Connection failed</h1><p>${escapeHtml(error)} ${escapeHtml(description)}</p><p><a href="/">Back to the board</a></p>`,
        400,
      );
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "code and state are required" }, 400);

    try {
      await deps.vault.completeAuthCodeConnect(id, code, state);
    } catch (e) {
      return c.html(
        `<h1>Connection failed</h1><p>${escapeHtml(errorMessage(e))}</p><p><a href="/">Back to the board</a></p>`,
        400,
      );
    }

    return c.redirect("/", 302);
  });

  app.post("/api/extensions/:id/disconnect", (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    deps.vault.disconnect(id);
    return c.json({ disconnected: true });
  });

  app.post("/api/extensions/:id/enable", (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    if (deps.vault.status(id) !== "connected") {
      return c.json({ error: `extension "${id}" is not connected` }, 400);
    }
    extensionsRepo.setEnabled(deps.db, id, true);
    return c.json({ enabled: true });
  });

  app.post("/api/extensions/:id/disable", (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    extensionsRepo.setEnabled(deps.db, id, false);
    return c.json({ enabled: false });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/api/extensions.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 6: Commit**

```bash
git add src/api/extensions.ts tests/api/extensions.test.ts
git commit -m "feat: add HTTP routes over extension discovery and the vault"
```

---

## Task 2: Config + `main.ts` wiring

**Files:**
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Modify: `tests/main.smoke.test.ts`

**Interfaces:**
- Consumes: `createExtensionRoutes` (Task 1); `createVault` (`src/vault/vault.ts`, existing); `discoverExtensions` (`src/extensions/discovery.ts`, existing).
- Produces: `Config.extensionsDir: string`.

- [ ] **Step 1: Add `extensionsDir` to `Config` and `loadConfig`**

In `src/config.ts`, add to the `Config` interface (after `sampleDir`):

```typescript
  /** Folder scanned for extension manifests. Always on — a missing/empty directory is a no-op. */
  extensionsDir: string;
```

And in `loadConfig`, add (after the `sampleDir` line):

```typescript
    extensionsDir: env.JIDOKA_EXTENSIONS_DIR ?? "./extensions",
```

- [ ] **Step 2: Update the two existing full `Config` literals in `tests/main.smoke.test.ts`**

Add `extensionsDir: "./does-not-exist-in-tests",` to both `createApp({...})` calls in `tests/main.smoke.test.ts` (next to the existing `outlook: { tenant: "common" },` line in each). This is required for the file to compile once `extensionsDir` is a required `Config` field — `discoverExtensions` treats a missing directory as "discovered nothing," so the path is safe to use as-is.

- [ ] **Step 3: Run the smoke tests to confirm they still pass with the added field**

Run: `bun test tests/main.smoke.test.ts`
Expected: PASS (2 tests) — this step only proves the compile fix; the new route isn't wired yet.

- [ ] **Step 4: Wire the vault and extension routes into `createApp`**

In `src/main.ts`, add imports:

```typescript
import { createVault } from "./vault/vault";
import { createExtensionRoutes } from "./api/extensions";
import { discoverExtensions } from "./extensions/discovery";
```

Inside `createApp`, after the `mcp`/`provider`/`runAgent`/`deps` setup and before `const extraRoutes = createAuthRoutes(authDeps);`, add:

```typescript
  const vault = createVault({ db });
```

Then extend the `extraRoutes` chain (currently `createAuthRoutes(authDeps)` followed by `.route("/", createHandoffRoutes({...}))`) with one more mount:

```typescript
  extraRoutes.route(
    "/",
    createExtensionRoutes({ db, vault, extensionsDir: config.extensionsDir }),
  );
```

placed right after the existing `createHandoffRoutes` mount.

- [ ] **Step 5: Run discovery once at startup**

In the `import.meta.main` block in `src/main.ts`, after `await app.mcp.connectAll(config.mcpServers);` and before the `const sources: TaskSource[] = [];` line, add:

```typescript
    const discovered = await discoverExtensions(app.deps.db, config.extensionsDir);
    console.log(
      `${discovered.valid.length} extension(s) discovered` +
        (discovered.invalid.length ? ` (${discovered.invalid.length} invalid)` : ""),
    );
```

- [ ] **Step 6: Add a smoke test confirming the routes are mounted**

Add to `tests/main.smoke.test.ts`:

```typescript
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
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/main.ts tests/main.smoke.test.ts
git commit -m "feat: wire the extension vault and discovery into main"
```

---

## Task 3: Wizard UI

**Files:**
- Modify: `src/client/api.ts`
- Create: `src/client/Extensions.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/index.html`

**Interfaces:**
- Consumes: `/api/extensions` and its sub-routes (Task 1/2); `ExtensionAuth` type (`src/domain/extension.ts`, existing — already importable from client code the same way `Task`/`TaskType`/`Pipeline` are).
- Produces: `ExtensionListItem` type and `api.extensions/rescanExtensions/connectApiKey/startDeviceConnect/completeDeviceConnect/disconnectExtension/enableExtension/disableExtension` (`src/client/api.ts`); `Extensions` component (`src/client/Extensions.tsx`).

No automated tests for this task — this codebase has no `.tsx` test files (`SignIn`/`Onboarding` weren't tested that way either). Verification is manual, in the browser, per the last step.

- [ ] **Step 1: Add extension types and API calls to `src/client/api.ts`**

Add near the top, with the other type imports:

```typescript
import type { ExtensionAuth } from "../domain/extension";
```

Add this type near `TypeWithPipelines`:

```typescript
export interface ExtensionListItem {
  id: string;
  name: string;
  summary: string;
  readOnly: boolean;
  auth: ExtensionAuth;
  enabled: boolean;
  valid: boolean;
  error: string | null;
  status: "connected" | "not_connected" | "needs_reauth" | "unknown" | "invalid";
}
```

Add these entries to the `api` object:

```typescript
  extensions: () => json<{ extensions: ExtensionListItem[] }>("/api/extensions").then((r) => r.extensions),
  rescanExtensions: () =>
    json<{ discovered: { valid: string[]; invalid: { id: string; error: string }[] } }>(
      "/api/extensions/rescan",
      { method: "POST" },
    ),
  connectApiKey: (id: string, apiKey: string) =>
    json<{ connected: true }>(`/api/extensions/${id}/connect/api-key`, {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    }),
  startDeviceConnect: (id: string) =>
    json<{
      userCode: string;
      verificationUri: string;
      deviceCode: string;
      expiresIn: number;
      interval: number;
    }>(`/api/extensions/${id}/connect/device/start`, { method: "POST" }),
  completeDeviceConnect: (id: string, deviceCode: string) =>
    json<{ connected?: true; pending?: true }>(`/api/extensions/${id}/connect/device/complete`, {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    }),
  disconnectExtension: (id: string) =>
    json<{ disconnected: true }>(`/api/extensions/${id}/disconnect`, { method: "POST" }),
  enableExtension: (id: string) =>
    json<{ enabled: true }>(`/api/extensions/${id}/enable`, { method: "POST" }),
  disableExtension: (id: string) =>
    json<{ enabled: false }>(`/api/extensions/${id}/disable`, { method: "POST" }),
```

- [ ] **Step 2: Add CSS for the extensions panel to `src/client/index.html`**

Add these rules to the `<style>` block, after the existing `.handoff` rules:

```css
      .dot.warn { background: goldenrod; }
      .dialog.extensions button { display: inline-block; width: auto; margin: 4px 8px 4px 0; }
      .extension-row { border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: 10px 0; }
      .extension-row p { font-size: 12px; opacity: 0.7; margin: 4px 0; }
      .extension-row .connect-form, .extension-row .device-code { margin-top: 6px; }
```

- [ ] **Step 3: Create `src/client/Extensions.tsx`**

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ExtensionListItem } from "./api";

interface DeviceSession {
  id: string;
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  deadline: number;
}

export function Extensions() {
  const [open, setOpen] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionListItem[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [device, setDevice] = useState<DeviceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setExtensions(await api.extensions());
    } catch {
      setExtensions([]);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  async function rescan() {
    setError(null);
    try {
      await api.rescanExtensions();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveApiKey(id: string) {
    setError(null);
    try {
      await api.connectApiKey(id, apiKeyValue);
      setConnectingId(null);
      setApiKeyValue("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function startDevice(id: string) {
    setError(null);
    api
      .startDeviceConnect(id)
      .then((login) => {
        const deadline = Date.now() + login.expiresIn * 1000;
        setDevice({
          id,
          userCode: login.userCode,
          verificationUri: login.verificationUri,
          deviceCode: login.deviceCode,
          deadline,
        });
        stopPolling();
        pollTimer.current = setInterval(async () => {
          if (Date.now() > deadline) {
            stopPolling();
            setDevice(null);
            setError("Device code expired — try connecting again.");
            return;
          }
          try {
            const result = await api.completeDeviceConnect(id, login.deviceCode);
            if (result.connected) {
              stopPolling();
              setDevice(null);
              setConnectingId(null);
              await refresh();
            }
          } catch (e) {
            stopPolling();
            setDevice(null);
            setError(e instanceof Error ? e.message : String(e));
          }
        }, login.interval * 1000);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  async function activate(id: string) {
    setError(null);
    try {
      await api.enableExtension(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function disable(id: string) {
    await api.disableExtension(id);
    await refresh();
  }

  async function disconnect(id: string) {
    await api.disconnectExtension(id);
    await refresh();
  }

  function dotClass(status: ExtensionListItem["status"]): string {
    if (status === "connected") return "dot on";
    if (status === "needs_reauth") return "dot warn";
    return "dot off";
  }

  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>
        Extensions
      </button>

      {open && (
        <div className="dialog extensions">
          <h2>Extensions</h2>
          <button onClick={rescan}>Rescan</button>
          {error && <p className="error">{error}</p>}

          {extensions.length === 0 && <p className="meta">No extensions discovered.</p>}

          {extensions.map((ext) => (
            <div key={ext.id} className="extension-row">
              <span className={dotClass(ext.status)} /> <strong>{ext.name}</strong>
              <p>{ext.summary}</p>

              {!ext.valid && <p className="error">{ext.error}</p>}

              {ext.valid && (ext.status === "not_connected" || ext.status === "needs_reauth") &&
                connectingId !== ext.id && (
                  <button className="link" onClick={() => setConnectingId(ext.id)}>
                    {ext.status === "needs_reauth" ? "Reconnect" : "Connect"}
                  </button>
                )}

              {connectingId === ext.id && ext.auth.mode === "api-key" && (
                <div className="connect-form">
                  <label>
                    {ext.auth.label}
                    <input value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)} />
                  </label>
                  <button onClick={() => saveApiKey(ext.id)}>Save</button>
                </div>
              )}

              {connectingId === ext.id && ext.auth.mode === "oauth2-auth-code-pkce" && (
                <a className="link" href={`/api/extensions/${ext.id}/connect/pkce/start`}>
                  Continue in browser
                </a>
              )}

              {connectingId === ext.id && ext.auth.mode === "oauth2-device-code" && !device && (
                <button onClick={() => startDevice(ext.id)}>Connect</button>
              )}

              {device?.id === ext.id && (
                <div className="device-code">
                  <p>
                    Go to{" "}
                    <a href={device.verificationUri} target="_blank" rel="noreferrer">
                      {device.verificationUri}
                    </a>{" "}
                    and enter code <strong>{device.userCode}</strong>
                  </p>
                </div>
              )}

              {ext.status === "connected" && !ext.enabled && (
                <button className="link" onClick={() => activate(ext.id)}>
                  Activate
                </button>
              )}

              {ext.enabled && (
                <>
                  <button className="link" onClick={() => disable(ext.id)}>
                    Disable
                  </button>
                  <button className="link" onClick={() => disconnect(ext.id)}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
          ))}

          <button className="secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Wire `Extensions` into `App.tsx`**

In `src/client/App.tsx`, add the import:

```typescript
import { Extensions } from "./Extensions";
```

Add `<Extensions />` inside the `<div className="actions">` block, next to `<SignIn />`:

```typescript
        <div className="actions">
          <SignIn />
          <Extensions />
          <NewTask onCreated={refresh} />
          <button onClick={() => void refresh()}>Refresh</button>
        </div>
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 6: Manual verification**

Run: `bun run dev`, open `http://localhost:3000`.

Create a temporary extensions folder (outside the repo, or under a gitignored path) and point `JIDOKA_EXTENSIONS_DIR` at it — e.g. `mkdir -p /tmp/jidoka-extensions/demo-key && JIDOKA_EXTENSIONS_DIR=/tmp/jidoka-extensions bun run dev`, with `/tmp/jidoka-extensions/demo-key/manifest.json`:

```json
{
  "id": "demo-key",
  "name": "Demo API Key Extension",
  "version": "1.0.0",
  "summary": "A manual test fixture with no real backend.",
  "readOnly": true,
  "auth": { "mode": "api-key", "label": "Fake Token" }
}
```

Verify in the browser:
- The "Extensions" button appears in the header, and opening it shows "Demo API Key Extension" with a gray (not-connected) dot.
- Clicking "Connect" shows the "Fake Token" field; entering any value and clicking Save flips the dot green and shows "Activate".
- Clicking "Activate" shows "Disable"/"Disconnect".
- "Disconnect" reverts the row to not-connected; "Rescan" after adding a second manifest folder picks it up without restarting.

For `oauth2-device-code` and `oauth2-auth-code-pkce` modes: add manifests using placeholder URLs (e.g. `https://example.com/...`) and verify only what's reachable without a real provider — device-code's "Connect" shows a user code and verification link (the actual token exchange already has automated coverage from Task 1's injected-fetch tests), and PKCE's "Continue in browser" link navigates to the configured `authorizeUrl` with the correct `redirect_uri`. Full end-to-end completion of these two modes against a real provider is out of scope for manual verification here.

- [ ] **Step 7: Commit**

```bash
git add src/client/api.ts src/client/Extensions.tsx src/client/App.tsx src/client/index.html
git commit -m "feat: add the extensions wizard UI"
```
