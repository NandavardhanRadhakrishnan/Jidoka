# Settings Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-edited `.env` for Jidoka's generic runtime config (AI provider/model/key, agent runner, MCP servers, source folders, poll interval, handoff terminal launcher) with a persisted, in-app settings menu.

**Architecture:** A new `settings` table stores a single JSON blob. `applySettings(baseConfig, settings)` overlays saved values onto the env-derived `Config` per field (settings wins only where a field was actually saved — an unset field falls through to the env var, then the built-in default). `main.ts` computes this merged config once, after opening the db, and both `AppDeps`/routes and the server's own startup side effects (MCP connections, extension discovery, the poller, sources) use it from then on. A new `GET`/`PATCH /api/settings` pair exposes the current effective values and lets the client save changes; a new `Settings.tsx` panel is the UI. Nothing here makes settings take effect without a restart — that's explicitly deferred follow-up work.

**Tech Stack:** Bun, TypeScript, Zod (unused here — no new schema needed), Hono, React 19, `bun:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-20-settings-menu-design.md`

## Global Constraints

- Bun is the only runtime — no Node, no Docker. `bun run typecheck` (tsc --noEmit) must stay clean. `bun test` is the test command.
- Single user, no auth. IDs are `crypto.randomUUID()` where relevant; this feature's single settings row uses a fixed id, not a generated one.
- `ai.apiKey` must never be echoed back over HTTP as plaintext, in either the `settings` or `effective` part of a response — only a boolean `apiKeyConfigured`.
- Out of scope (do not implement in this plan): `dbPath`, `port`, any self-restart mechanism, live-reloading any field without a restart, Outlook's `clientId`/`tenant`, and the OAuth app-registration config (`JIDOKA_OAUTH_PROVIDERS`).
- Client-side, mirror server types as plain local interfaces in `src/client/api.ts` rather than importing server modules directly — this already-established pattern is why `ModelOption`/`HandoffTarget`/`Rule` are duplicated/re-exported there instead of imported from `src/ai/models.ts`/`src/domain/rule.ts` types directly for every field.

---

## Task 1: `settings` table, domain type, repo module

**Files:**
- Modify: `src/db/migrations.ts`
- Create: `src/domain/settings.ts`
- Create: `src/repo/settings.ts`
- Test: `tests/repo/settings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Settings` (from `src/domain/settings.ts`) — the partial, every-field-optional shape every later task reads/writes. `getSettings(db): Settings`, `saveSettings(db, patch: Settings): Settings` (from `src/repo/settings.ts`), consumed by Task 2 (`applySettings`) and Task 3 (the API routes).

- [ ] **Step 1: Write the failing tests**

Create `tests/repo/settings.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { getSettings, saveSettings } from "../../src/repo/settings";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("getSettings on an empty db returns {}", () => {
  const db = freshDb();
  expect(getSettings(db)).toEqual({});
});

test("saveSettings persists and round-trips", () => {
  const db = freshDb();
  const saved = saveSettings(db, { sampleDir: "./samples", ai: { model: "claude-sonnet-5" } });

  expect(saved).toEqual({ sampleDir: "./samples", ai: { model: "claude-sonnet-5" } });
  expect(getSettings(db)).toEqual(saved);
});

test("saveSettings merges into an existing section instead of replacing it", () => {
  const db = freshDb();
  saveSettings(db, { ai: { apiKey: "sk-test", model: "claude-sonnet-5" } });

  const updated = saveSettings(db, { ai: { model: "claude-opus-5" } });

  expect(updated.ai).toEqual({ apiKey: "sk-test", model: "claude-opus-5" });
});

test("saveSettings replaces whole-value fields like mcpServers rather than merging them", () => {
  const db = freshDb();
  saveSettings(db, { mcpServers: [{ name: "a", command: "a", args: [] }] });

  const updated = saveSettings(db, { mcpServers: [{ name: "b", command: "b", args: [] }] });

  expect(updated.mcpServers).toEqual([{ name: "b", command: "b", args: [] }]);
});

test("saveSettings leaves a section untouched when the patch omits it", () => {
  const db = freshDb();
  saveSettings(db, { ai: { model: "claude-sonnet-5" }, sampleDir: "./samples" });

  const updated = saveSettings(db, { extensionsDir: "./extensions" });

  expect(updated.ai).toEqual({ model: "claude-sonnet-5" });
  expect(updated.sampleDir).toBe("./samples");
  expect(updated.extensionsDir).toBe("./extensions");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/repo/settings.test.ts`
Expected: FAIL — `src/repo/settings.ts` does not exist.

- [ ] **Step 3: Add the `settings` table**

In `src/db/migrations.ts`, add a new entry to the `MIGRATIONS` array, after the `extension_credentials` table:

```typescript
  `CREATE TABLE IF NOT EXISTS settings (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
```

- [ ] **Step 4: Create the domain type**

Create `src/domain/settings.ts`:

```typescript
import type { ModelProviderId } from "../ai/models";
import type { McpServerConfig } from "../config";

/**
 * A partial overlay onto Config: presence of a field means "override the env
 * var/default for this", absence means "fall through". Persisted as one JSON
 * blob (see src/repo/settings.ts) — never partially-typed at the DB layer,
 * only here.
 */
export interface Settings {
  ai?: {
    provider?: ModelProviderId;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  agent?: {
    runner?: "in-process" | "agent-sdk";
    model?: string;
    concurrency?: number;
    maxBudgetUsd?: number;
  };
  mcpServers?: McpServerConfig[];
  sampleDir?: string;
  extensionsDir?: string;
  pollIntervalMs?: number;
  terminalCommand?: string;
}
```

(`import type` on both lines — `src/config.ts` will import `Settings` back from this module in Task 2, and a type-only import on both sides means neither creates a runtime circular dependency.)

- [ ] **Step 5: Create the repo module**

Create `src/repo/settings.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { Settings } from "../domain/settings";

function mergeSection<T extends object>(current: T | undefined, patch: T | undefined): T | undefined {
  if (!current && !patch) return undefined;
  return { ...current, ...patch };
}

export function getSettings(db: Database): Settings {
  const row = db.query("SELECT data FROM settings WHERE id = 'global'").get() as { data: string } | null;
  return row ? (JSON.parse(row.data) as Settings) : {};
}

export function saveSettings(db: Database, patch: Settings): Settings {
  const current = getSettings(db);
  const merged: Settings = {
    ai: mergeSection(current.ai, patch.ai),
    agent: mergeSection(current.agent, patch.agent),
    mcpServers: patch.mcpServers ?? current.mcpServers,
    sampleDir: patch.sampleDir ?? current.sampleDir,
    extensionsDir: patch.extensionsDir ?? current.extensionsDir,
    pollIntervalMs: patch.pollIntervalMs ?? current.pollIntervalMs,
    terminalCommand: patch.terminalCommand ?? current.terminalCommand,
  };
  const clean = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as Settings;

  db.query(
    `INSERT INTO settings (id, data) VALUES ('global', ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
  ).run(JSON.stringify(clean));

  return clean;
}
```

(The `Object.fromEntries` filter keeps the stored JSON free of `"ai": undefined`-shaped noise — `JSON.stringify` would already drop `undefined` values, but filtering explicitly keeps `merged`/`clean`/the return value identical, which the round-trip test above depends on.)

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `bun test tests/repo/settings.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass (244 pre-existing + 5 new = 249).

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations.ts src/domain/settings.ts src/repo/settings.ts tests/repo/settings.test.ts
git commit -m "$(cat <<'EOF'
feat: add persisted settings storage

A settings table plus a Settings domain type and repo module — a
partial overlay onto Config, merged one section deep so saving one
field never drops a sibling already-saved one. Nothing reads or
writes this yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `applySettings` and startup wiring

**Files:**
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `Settings` (Task 1).
- Produces: `applySettings(base: Config, settings: Settings): Config` (from `src/config.ts`), consumed by Task 3's API routes. `App.config: Config` (the merged config), consumed by `main.ts`'s own startup block (this task) and available to any future caller of `createApp`.

- [ ] **Step 1: Write the failing tests**

Create `tests/config.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { loadConfig, applySettings } from "../src/config";

test("applySettings overrides a field the settings actually set", () => {
  const base = loadConfig({ JIDOKA_AI_MODEL: "claude-haiku-4-5-20251001" });

  const merged = applySettings(base, { ai: { model: "claude-opus-5" } });

  expect(merged.ai.model).toBe("claude-opus-5");
});

test("applySettings falls through to the base value when settings omit a field", () => {
  const base = loadConfig({ JIDOKA_AI_MODEL: "claude-haiku-4-5-20251001" });

  const merged = applySettings(base, { sampleDir: "./samples" });

  expect(merged.ai.model).toBe("claude-haiku-4-5-20251001");
  expect(merged.sampleDir).toBe("./samples");
});

test("applySettings merges ai/agent one level deep rather than replacing the whole section", () => {
  const base = loadConfig({ ANTHROPIC_API_KEY: "sk-from-env" });

  const merged = applySettings(base, { ai: { model: "claude-opus-5" } });

  expect(merged.ai.apiKey).toBe("sk-from-env");
  expect(merged.ai.model).toBe("claude-opus-5");
});

test("applySettings never touches dbPath or port", () => {
  const base = loadConfig({ JIDOKA_DB: "./real.db", JIDOKA_PORT: "4000" });

  const merged = applySettings(base, {});

  expect(merged.dbPath).toBe("./real.db");
  expect(merged.port).toBe(4000);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `applySettings` is not exported from `src/config.ts`.

- [ ] **Step 3: Add `applySettings` to `config.ts`**

In `src/config.ts`, add the import:

```typescript
import type { Settings } from "./domain/settings";
```

Add the function (anywhere after the `Config` interface, e.g. right after `loadConfig`):

```typescript
export function applySettings(base: Config, settings: Settings): Config {
  return {
    ...base,
    ai: { ...base.ai, ...settings.ai },
    agent: { ...base.agent, ...settings.agent },
    mcpServers: settings.mcpServers ?? base.mcpServers,
    sampleDir: settings.sampleDir ?? base.sampleDir,
    extensionsDir: settings.extensionsDir ?? base.extensionsDir,
    pollIntervalMs: settings.pollIntervalMs ?? base.pollIntervalMs,
    terminalCommand: settings.terminalCommand ?? base.terminalCommand,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test tests/config.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Wire it into `createApp` and expose the merged config**

Read `src/main.ts` as it currently exists before editing — this step changes several call sites.

Add the imports:

```typescript
import { getSettings } from "./repo/settings";
import { applySettings } from "./config";
```

(`applySettings` joins the existing `import { loadConfig, type Config } from "./config";` line — change it to `import { loadConfig, applySettings, type Config } from "./config";`.)

Change the `App` interface to expose the merged config:

```typescript
export interface App {
  deps: AppDeps;
  mcp: McpManager;
  vault: Vault;
  config: Config;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
```

Change `createApp`'s signature and its first lines — the parameter is renamed `baseConfig` (the env-only config), and a merged `config` is computed right after `migrate(db)`, before anything else in the function uses `config`:

```typescript
export function createApp(baseConfig: Config): App {
  const db = openDb(baseConfig.dbPath);
  migrate(db);
  const config = applySettings(baseConfig, getSettings(db));

  const authDeps = { db, providers: config.oauth };
```

(Every other line inside `createApp` already reads `config.*` — since the local variable is still named `config` after this change, none of those lines need editing.)

Add `config` to `createApp`'s returned object:

```typescript
  return {
    deps,
    mcp,
    vault,
    config,
    fetch: async (request) => api.fetch(request),
    async close() {
      await mcp.close();
      db.close();
    },
  };
```

- [ ] **Step 6: Use the merged config for the server's own startup side effects**

In the `if (import.meta.main)` block at the bottom of `main.ts`, every reference to the outer `config` variable — **except** the initial `const config = loadConfig();` line itself and the `loginOutlook(config)` call (that path never calls `createApp` and settings don't apply to it) — changes to `app.config`, since `app` now carries the merged values. Replace the whole `else` branch with:

```typescript
  } else {
    const app = createApp(config);
    console.log(
      `AI provider: ${app.config.ai.provider} (${app.config.ai.model ?? "default model"}), ` +
        `credentials: ${describeCredentials(app.config)}`,
    );
    console.log(
      `Agent steps: ${app.config.agent.runner}` +
        (app.config.agent.runner === "agent-sdk" ? " (Claude Code CLI login)" : " (AiProvider)") +
        `, max ${app.config.agent.concurrency} at a time`,
    );
    await app.mcp.connectAll(app.config.mcpServers);

    try {
      const discovered = await discoverExtensions(app.deps.db, app.config.extensionsDir);
      console.log(
        `${discovered.valid.length} extension(s) discovered` +
          (discovered.invalid.length ? ` (${discovered.invalid.length} invalid)` : ""),
      );
    } catch (error) {
      console.warn(
        `Extension discovery failed for "${app.config.extensionsDir}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const sources: TaskSource[] = [];
    if (app.config.outlook.clientId) {
      sources.push(
        createOutlookSource({
          db: app.deps.db,
          clientId: app.config.outlook.clientId,
          tenant: app.config.outlook.tenant,
        }),
      );
    }
    if (app.config.sampleDir) {
      sources.push(createSampleFolderSource({ dir: app.config.sampleDir }));
      console.log(`Sample source watching ${app.config.sampleDir}`);
    }

    startPoller(
      app.deps.db,
      sources,
      async (task) => {
        try {
          await onTaskIngested(app.deps, task);
        } catch (error) {
          console.error(`[orchestrator] task ${task.id} failed:`, error);
        }
      },
      app.config.pollIntervalMs,
      () => loadEnabledExtensionSources(app.deps.db, app.config.extensionsDir, app.vault),
    );
    if (!sources.length) {
      console.warn(
        "No static sources configured — set JIDOKA_OUTLOOK_CLIENT_ID or JIDOKA_SAMPLE_DIR, " +
          "install an extension, or add tasks from the board",
      );
    }

    Bun.serve({
      port: app.config.port,
      // Model calls keep a request open for a long time with no bytes flowing;
      // the default idle timeout closes such a connection mid-call.
      idleTimeout: 255,
      routes: createRoutes(app),
    });
    console.log(`Jidoka on http://localhost:${app.config.port}`);
  }
```

(`app.config.outlook.clientId`/`tenant` stay because `applySettings` never touches `outlook` — this is just reading the same env-derived values through the merged config object instead of the pre-merge one, not a behavior change for Outlook.)

- [ ] **Step 7: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass (249 pre-existing + 4 new = 253).

- [ ] **Step 8: Manual sanity check**

Run: `JIDOKA_SAMPLE_DIR=./samples bun run dev`
Expected: starts exactly as before (same console output shape), confirming the `app.config`-based startup path works. Stop the server when done.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/main.ts tests/config.test.ts
git commit -m "$(cat <<'EOF'
feat: merge saved settings into the config the server actually uses

applySettings overlays a Settings partial onto the env-derived Config,
one field at a time, so saving only ai.model doesn't drop an
env-configured ai.apiKey. main.ts now computes this once at startup
and uses it everywhere — including its own MCP-connect, extension-
discovery, source-construction, and poller-interval side effects,
which previously only ever saw the pre-settings config.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `GET`/`PATCH /api/settings`

**Files:**
- Create: `src/api/settings.ts`
- Modify: `src/main.ts`
- Test: `tests/api/settings.test.ts`

**Interfaces:**
- Consumes: `getSettings`/`saveSettings` (Task 1), `applySettings` (Task 2).
- Produces: `createSettingsRoutes(deps: { db: Database; baseConfig: Config }): Hono`, mounted in Task 2's `createApp`. The `GET`/`PATCH /api/settings` response shape `{ settings, effective }`, consumed by Task 4's client.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/settings.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { loadConfig } from "../../src/config";
import { createSettingsRoutes } from "../../src/api/settings";

function freshApp() {
  const db = openDb(":memory:");
  migrate(db);
  const baseConfig = loadConfig({});
  const server = createSettingsRoutes({ db, baseConfig });
  return { fetch: (req: Request) => server.fetch(req) };
}

test("GET /api/settings returns effective defaults with no api key leaked", async () => {
  const { fetch } = freshApp();

  const response = await fetch(new Request("http://localhost/api/settings"));
  const body = (await response.json()) as {
    effective: { ai: { provider: string; apiKeyConfigured: boolean } };
  };

  expect(response.status).toBe(200);
  expect(body.effective.ai.provider).toBe("anthropic");
  expect(body.effective.ai.apiKeyConfigured).toBe(false);
});

test("PATCH /api/settings persists and a later GET reflects it", async () => {
  const { fetch } = freshApp();

  const patchResponse = await fetch(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sampleDir: "./samples", ai: { model: "claude-sonnet-5" } }),
    }),
  );
  const patched = (await patchResponse.json()) as {
    effective: { sampleDir?: string; ai: { model?: string } };
  };
  expect(patched.effective.sampleDir).toBe("./samples");
  expect(patched.effective.ai.model).toBe("claude-sonnet-5");

  const getResponse = await fetch(new Request("http://localhost/api/settings"));
  const body = (await getResponse.json()) as {
    settings: { sampleDir?: string };
    effective: { sampleDir?: string };
  };
  expect(body.settings.sampleDir).toBe("./samples");
  expect(body.effective.sampleDir).toBe("./samples");
});

test("an api key is never echoed back as plaintext, only as apiKeyConfigured", async () => {
  const { fetch } = freshApp();

  const response = await fetch(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ai: { apiKey: "sk-super-secret" } }),
    }),
  );
  const raw = await response.text();
  const body = JSON.parse(raw) as {
    settings: { ai: { apiKeyConfigured: boolean } };
    effective: { ai: { apiKeyConfigured: boolean } };
  };

  expect(body.settings.ai.apiKeyConfigured).toBe(true);
  expect(body.effective.ai.apiKeyConfigured).toBe(true);
  expect(raw).not.toContain("sk-super-secret");
});

test("PATCH with an invalid JSON body is a 400, not a crash", async () => {
  const { fetch } = freshApp();

  const response = await fetch(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
  );

  expect(response.status).toBe(400);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/api/settings.test.ts`
Expected: FAIL — `src/api/settings.ts` does not exist.

- [ ] **Step 3: Create the route module**

Create `src/api/settings.ts`:

```typescript
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getSettings, saveSettings } from "../repo/settings";
import type { Settings } from "../domain/settings";
import { applySettings, type Config } from "../config";

export interface SettingsRoutesDeps {
  db: Database;
  baseConfig: Config;
}

interface MaskedAi {
  provider?: string;
  apiKeyConfigured: boolean;
  model?: string;
  baseUrl?: string;
}

interface EffectiveSettings {
  ai: MaskedAi;
  agent: {
    runner: Config["agent"]["runner"];
    model?: string;
    concurrency: number;
    maxBudgetUsd?: number;
  };
  mcpServers: Config["mcpServers"];
  sampleDir?: string;
  extensionsDir: string;
  pollIntervalMs: number;
  terminalCommand?: string;
}

function maskAi(ai: Settings["ai"]): MaskedAi | undefined {
  if (!ai) return undefined;
  return { provider: ai.provider, apiKeyConfigured: Boolean(ai.apiKey), model: ai.model, baseUrl: ai.baseUrl };
}

function effectiveOf(config: Config): EffectiveSettings {
  return {
    ai: {
      provider: config.ai.provider,
      apiKeyConfigured: Boolean(config.ai.apiKey),
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
    },
    agent: {
      runner: config.agent.runner,
      model: config.agent.model,
      concurrency: config.agent.concurrency,
      maxBudgetUsd: config.agent.maxBudgetUsd,
    },
    mcpServers: config.mcpServers,
    sampleDir: config.sampleDir,
    extensionsDir: config.extensionsDir,
    pollIntervalMs: config.pollIntervalMs,
    terminalCommand: config.terminalCommand,
  };
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
  const app = new Hono();

  app.get("/api/settings", (c) => {
    const settings = getSettings(deps.db);
    const effective = applySettings(deps.baseConfig, settings);
    return c.json({
      settings: { ...settings, ai: maskAi(settings.ai) },
      effective: effectiveOf(effective),
    });
  });

  app.patch("/api/settings", async (c) => {
    let patch: Settings;
    try {
      patch = (await c.req.json()) as Settings;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const settings = saveSettings(deps.db, patch);
    const effective = applySettings(deps.baseConfig, settings);
    return c.json({
      settings: { ...settings, ai: maskAi(settings.ai) },
      effective: effectiveOf(effective),
    });
  });

  return app;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test tests/api/settings.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Mount the routes in `main.ts`**

Add the import:

```typescript
import { createSettingsRoutes } from "./api/settings";
```

In `createApp`, add alongside the other `extraRoutes.route("/", ...)` calls:

```typescript
  extraRoutes.route("/", createSettingsRoutes({ db, baseConfig }));
```

- [ ] **Step 6: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: all pass (253 pre-existing + 4 new = 257).

- [ ] **Step 7: Commit**

```bash
git add src/api/settings.ts src/main.ts tests/api/settings.test.ts
git commit -m "$(cat <<'EOF'
feat: expose GET/PATCH /api/settings

Returns both the raw saved settings (so a client can tell which
fields are user-set) and the fully resolved effective values. ai.apiKey
never appears as plaintext in either — only apiKeyConfigured.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Settings panel UI

No automated tests exist for React components in this codebase (`tests/client/columns.test.ts` tests a plain data function, not a component) — this task's verification is `bun run typecheck` plus a manual walkthrough with the dev server, matching the convention `Rules.tsx`/`Extensions.tsx` already follow.

**Files:**
- Modify: `src/client/api.ts`
- Create: `src/client/Settings.tsx`
- Modify: `src/client/App.tsx`

**Interfaces:**
- Consumes: `GET`/`PATCH /api/settings` (Task 3).
- Produces: `Settings` component, mounted in the header — no other task depends on this one.

- [ ] **Step 1: Add the client API methods and types**

In `src/client/api.ts`, add these two interfaces (anywhere near the other type definitions, e.g. after `ModelOption`):

```typescript
export interface EffectiveSettings {
  ai: { provider: string; apiKeyConfigured: boolean; model?: string; baseUrl?: string };
  agent: { runner: string; model?: string; concurrency: number; maxBudgetUsd?: number };
  mcpServers: { name: string; command: string; args: string[] }[];
  sampleDir?: string;
  extensionsDir: string;
  pollIntervalMs: number;
  terminalCommand?: string;
}

export interface SettingsPatch {
  ai?: { provider?: string; apiKey?: string; model?: string; baseUrl?: string };
  agent?: { runner?: string; model?: string; concurrency?: number; maxBudgetUsd?: number };
  mcpServers?: { name: string; command: string; args: string[] }[];
  sampleDir?: string;
  extensionsDir?: string;
  pollIntervalMs?: number;
  terminalCommand?: string;
}
```

Add two entries to the `api` object:

```typescript
  settingsGet: () => json<{ settings: unknown; effective: EffectiveSettings }>("/api/settings"),
  saveSettings: (patch: SettingsPatch) =>
    json<{ settings: unknown; effective: EffectiveSettings }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.effective),
```

- [ ] **Step 2: Create the Settings panel**

Create `src/client/Settings.tsx`:

```typescript
import { useEffect, useState } from "react";
import { api, type EffectiveSettings, type SettingsPatch } from "./api";

interface McpServerRow {
  name: string;
  command: string;
  args: string;
}

function toRows(servers: EffectiveSettings["mcpServers"]): McpServerRow[] {
  return servers.map((s) => ({ name: s.name, command: s.command, args: s.args.join(" ") }));
}

function fromRows(rows: McpServerRow[]): { name: string; command: string; args: string[] }[] {
  return rows
    .filter((r) => r.name.trim() && r.command.trim())
    .map((r) => ({
      name: r.name.trim(),
      command: r.command.trim(),
      args: r.args.trim() ? r.args.trim().split(/\s+/) : [],
    }));
}

export function Settings() {
  const [open, setOpen] = useState(false);
  const [effective, setEffective] = useState<EffectiveSettings | null>(null);
  const [aiProvider, setAiProvider] = useState("anthropic");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [agentRunner, setAgentRunner] = useState("in-process");
  const [agentModel, setAgentModel] = useState("");
  const [agentConcurrency, setAgentConcurrency] = useState(1);
  const [agentMaxBudget, setAgentMaxBudget] = useState("");
  const [mcpRows, setMcpRows] = useState<McpServerRow[]>([]);
  const [sampleDir, setSampleDir] = useState("");
  const [extensionsDir, setExtensionsDir] = useState("");
  const [pollIntervalMs, setPollIntervalMs] = useState(60000);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    const { effective } = await api.settingsGet();
    setEffective(effective);
    setAiProvider(effective.ai.provider);
    setAiApiKey("");
    setAiModel(effective.ai.model ?? "");
    setAiBaseUrl(effective.ai.baseUrl ?? "");
    setAgentRunner(effective.agent.runner);
    setAgentModel(effective.agent.model ?? "");
    setAgentConcurrency(effective.agent.concurrency);
    setAgentMaxBudget(effective.agent.maxBudgetUsd?.toString() ?? "");
    setMcpRows(toRows(effective.mcpServers));
    setSampleDir(effective.sampleDir ?? "");
    setExtensionsDir(effective.extensionsDir);
    setPollIntervalMs(effective.pollIntervalMs);
    setTerminalCommand(effective.terminalCommand ?? "");
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const patch: SettingsPatch = {
        ai: {
          provider: aiProvider,
          ...(aiApiKey.trim() ? { apiKey: aiApiKey.trim() } : {}),
          ...(aiModel.trim() ? { model: aiModel.trim() } : {}),
          ...(aiBaseUrl.trim() ? { baseUrl: aiBaseUrl.trim() } : {}),
        },
        agent: {
          runner: agentRunner,
          ...(agentModel.trim() ? { model: agentModel.trim() } : {}),
          concurrency: agentConcurrency,
          ...(agentMaxBudget.trim() ? { maxBudgetUsd: Number(agentMaxBudget) } : {}),
        },
        mcpServers: fromRows(mcpRows),
        ...(sampleDir.trim() ? { sampleDir: sampleDir.trim() } : {}),
        extensionsDir: extensionsDir.trim(),
        pollIntervalMs,
        ...(terminalCommand.trim() ? { terminalCommand: terminalCommand.trim() } : {}),
      };
      const nextEffective = await api.saveSettings(patch);
      setEffective(nextEffective);
      setAiApiKey("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>
        Settings
      </button>

      {open && (
        <div className="dialog extensions">
          <h2>Settings</h2>

          {!effective ? (
            <p className="meta">Loading…</p>
          ) : (
            <>
              <h3>AI provider</h3>
              <label>
                Provider
                <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
                  <option value="anthropic">anthropic</option>
                  <option value="openai">openai</option>
                  <option value="agent-sdk">agent-sdk</option>
                </select>
              </label>
              <label>
                API key {effective.ai.apiKeyConfigured ? "(configured — leave blank to keep it)" : ""}
                <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} />
              </label>
              <label>
                Model
                <input value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
              </label>
              <label>
                Base URL
                <input value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} />
              </label>

              <h3>Agent runner</h3>
              <label>
                Runner
                <select value={agentRunner} onChange={(e) => setAgentRunner(e.target.value)}>
                  <option value="in-process">in-process</option>
                  <option value="agent-sdk">agent-sdk</option>
                </select>
              </label>
              <label>
                Model
                <input value={agentModel} onChange={(e) => setAgentModel(e.target.value)} />
              </label>
              <label>
                Concurrency
                <input
                  type="number"
                  min={1}
                  value={agentConcurrency}
                  onChange={(e) => setAgentConcurrency(Number(e.target.value))}
                />
              </label>
              <label>
                Max budget (USD)
                <input value={agentMaxBudget} onChange={(e) => setAgentMaxBudget(e.target.value)} />
              </label>

              <h3>MCP servers</h3>
              {mcpRows.map((row, index) => (
                <div key={index} className="extension-row">
                  <label>
                    Name
                    <input
                      value={row.name}
                      onChange={(e) =>
                        setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
                      }
                    />
                  </label>
                  <label>
                    Command
                    <input
                      value={row.command}
                      onChange={(e) =>
                        setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, command: e.target.value } : r)))
                      }
                    />
                  </label>
                  <label>
                    Args (space-separated)
                    <input
                      value={row.args}
                      onChange={(e) =>
                        setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, args: e.target.value } : r)))
                      }
                    />
                  </label>
                  <button className="link" onClick={() => setMcpRows(mcpRows.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </div>
              ))}
              <button className="link" onClick={() => setMcpRows([...mcpRows, { name: "", command: "", args: "" }])}>
                Add server
              </button>

              <h3>Sources</h3>
              <label>
                Sample folder
                <input value={sampleDir} onChange={(e) => setSampleDir(e.target.value)} />
              </label>
              <label>
                Extensions folder
                <input value={extensionsDir} onChange={(e) => setExtensionsDir(e.target.value)} />
              </label>
              <label>
                Poll interval (ms)
                <input
                  type="number"
                  min={1000}
                  value={pollIntervalMs}
                  onChange={(e) => setPollIntervalMs(Number(e.target.value))}
                />
              </label>

              <h3>Handoff</h3>
              <label>
                Terminal launcher
                <input value={terminalCommand} onChange={(e) => setTerminalCommand(e.target.value)} />
              </label>

              {error && <p className="error">{error}</p>}
              {saved && <p className="meta">Saved — restart the server for this to take effect.</p>}

              <button disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </button>
            </>
          )}

          <button className="secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Mount it in the header**

In `src/client/App.tsx`, add the import:

```typescript
import { Settings } from "./Settings";
```

Add it to the header's actions, next to the other panel buttons:

```typescript
        <div className="actions">
          <SignIn />
          <Rules />
          <Extensions />
          <Settings />
          <NewTask onCreated={refresh} />
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification with the dev server**

Run: `JIDOKA_SAMPLE_DIR=./samples bun run dev`, then in a browser at `http://localhost:3000`:
1. Click "Settings" in the header — the panel opens, loads, and shows the current effective values (e.g. `ai.provider` should show whatever `JIDOKA_AI_PROVIDER`/default currently resolves to).
2. Change `sampleDir` to a different value, add an MCP server row, click "Save" — the "Saved — restart the server..." message appears, no error.
3. Close the panel and reopen it — the changed values are still there (confirms the round trip through `GET`/`PATCH`).
4. Confirm via `curl -s http://localhost:3000/api/settings` (or the Bash tool) that the response never contains a plaintext API key even after setting one through the form.
5. Restart the dev server and reopen Settings — the saved values are still shown as effective (confirms they now come from the `settings` table, not just the env vars).

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add src/client/api.ts src/client/Settings.tsx src/client/App.tsx
git commit -m "$(cat <<'EOF'
feat: add a Settings panel for generic runtime config

Covers AI provider/model/key/base URL, agent runner/model/concurrency/
budget, the MCP server list, sample/extensions folders, poll interval,
and the handoff terminal launcher — replacing hand-edited .env for all
of these. Saving persists immediately; applying still needs a restart,
shown plainly after save.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
