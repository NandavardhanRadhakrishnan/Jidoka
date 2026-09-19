# Extension Poller Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an enabled, valid extension's `source.ts` actually get polled, live, without restarting Jidoka.

**Architecture:** A new `src/extensions/runtime.ts` dynamically `import()`s each enabled extension's `source.ts`, calling its `createSource(deps)` factory with an injected `getToken()` bound to that extension. `startPoller` gains an optional dynamic-source loader it calls fresh every tick, merging the result with the existing fixed `sources` array. `main.ts` wires this together, exposing the `Vault` on `App` so the CLI entrypoint can reach it.

**Tech Stack:** Bun (`bun:sqlite`, `bun:test`), dynamic `import()` of `.ts` files (no build step — Bun transpiles on the fly).

**Spec:** `docs/superpowers/specs/2026-09-19-extension-poller-wiring-design.md`

## Global Constraints

- Bun only. No test hits a network.
- `bun run typecheck` (`tsc --noEmit`) must stay clean after every task.
- A per-extension load failure (missing `source.ts`, no `createSource` export, a throwing `createSource`) must never prevent any other extension from loading, and must never touch the `extensions` table's `valid`/`error` columns — those describe manifest validity, not runtime code health. Log with `console.error` and skip.
- The loader always uses the database row's `id` for the returned `TaskSource.id`, never whatever the extension module itself claims — this is what keeps a task's `sourceId` correct even if a module is misconfigured.
- No UI changes, no surfacing of load/poll failures beyond server logs, no pruning, no hot-reload of extension code — all explicitly out of scope per the spec.

---

## Task 1: Extension source contract + dynamic loader

**Files:**
- Modify: `src/sources/types.ts`
- Create: `src/extensions/runtime.ts`
- Test: `tests/extensions/runtime.test.ts`

**Interfaces:**
- Consumes: `extensionsRepo.list` (`src/repo/extensions.ts`, existing); `Vault`, `getToken` (`src/vault/vault.ts`, existing); `TaskSource` (`src/sources/types.ts`, existing).
- Produces: `ExtensionSourceDeps` type (`{ getToken(): Promise<string> }`, added to `src/sources/types.ts`); `loadEnabledExtensionSources(db, extensionsDir, vault): Promise<TaskSource[]>` (`src/extensions/runtime.ts`).

- [ ] **Step 1: Add `ExtensionSourceDeps` to `src/sources/types.ts`**

Add to the end of the file:

```typescript
/** What an extension's source.ts receives to authenticate — nothing else. */
export interface ExtensionSourceDeps {
  getToken(): Promise<string>;
}
```

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/extensions/runtime.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import * as extensions from "../../src/repo/extensions";
import { createVault } from "../../src/vault/vault";
import { loadEnabledExtensionSources } from "../../src/extensions/runtime";
import type { ExtensionManifest } from "../../src/domain/extension";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-ext-runtime-"));
}

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function manifest(id: string): ExtensionManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    summary: "test fixture",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  };
}

async function writeSource(dir: string, id: string, code: string): Promise<void> {
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source.ts"), code);
}

test("a valid, enabled extension's source loads and its poll() runs with an injected token", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("good"));
  extensions.setEnabled(db, "good", true);
  await writeSource(
    dir,
    "good",
    `export function createSource(deps) {
      return {
        id: "wrong-id",
        async poll(cursor) {
          const token = await deps.getToken();
          return { items: [{ externalId: "1", title: "via " + token, body: "" }], cursor: "next-cursor" };
        },
      };
    }`,
  );
  const vault = createVault({ db });
  vault.saveApiKey("good", "secret-token");

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toHaveLength(1);
  expect(sources[0]?.id).toBe("good");
  const result = await sources[0]!.poll(null);
  expect(result.items).toEqual([{ externalId: "1", title: "via secret-token", body: "" }]);
  expect(result.cursor).toBe("next-cursor");
});

test("a disabled extension is excluded even if its source.ts is valid", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("off"));
  await writeSource(
    dir,
    "off",
    `export function createSource() {
      return { id: "off", async poll() { return { items: [], cursor: null }; } };
    }`,
  );
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("an invalid extension is excluded even if somehow marked enabled", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertInvalid(db, "broken-manifest", "bad manifest");
  extensions.setEnabled(db, "broken-manifest", true);
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("a missing source.ts is skipped without throwing", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("ghost"));
  extensions.setEnabled(db, "ghost", true);
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("a source.ts with no createSource export is skipped without throwing", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("no-export"));
  extensions.setEnabled(db, "no-export", true);
  await writeSource(dir, "no-export", `export const notCreateSource = 1;`);
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("a createSource that throws is skipped, and a good extension alongside it still loads", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("throws"));
  extensions.setEnabled(db, "throws", true);
  await writeSource(dir, "throws", `export function createSource() { throw new Error("boom"); }`);

  extensions.upsertValid(db, manifest("good2"));
  extensions.setEnabled(db, "good2", true);
  await writeSource(
    dir,
    "good2",
    `export function createSource() {
      return { id: "good2", async poll() { return { items: [], cursor: null }; } };
    }`,
  );

  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources.map((s) => s.id)).toEqual(["good2"]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/extensions/runtime.test.ts`
Expected: FAIL — `src/extensions/runtime.ts` does not exist.

- [ ] **Step 4: Write the implementation**

```typescript
// src/extensions/runtime.ts
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import type { Vault } from "../vault/vault";
import type { ExtensionSourceDeps, TaskSource } from "../sources/types";

export async function loadEnabledExtensionSources(
  db: Database,
  extensionsDir: string,
  vault: Vault,
): Promise<TaskSource[]> {
  const records = extensionsRepo.list(db).filter((record) => record.enabled && record.valid);

  const sources: TaskSource[] = [];
  for (const record of records) {
    try {
      const modulePath = pathToFileURL(join(extensionsDir, record.id, "source.ts")).href;
      const mod = (await import(modulePath)) as {
        createSource?: (deps: ExtensionSourceDeps) => TaskSource;
      };
      if (typeof mod.createSource !== "function") {
        console.error(`[extensions] ${record.id}: source.ts does not export createSource()`);
        continue;
      }
      const source = mod.createSource({ getToken: () => vault.getToken(record.id) });
      sources.push({ id: record.id, poll: source.poll });
    } catch (error) {
      console.error(`[extensions] failed to load source for ${record.id}:`, error);
    }
  }
  return sources;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/extensions/runtime.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 7: Commit**

```bash
git add src/sources/types.ts src/extensions/runtime.ts tests/extensions/runtime.test.ts
git commit -m "feat: load enabled extensions' source.ts at runtime"
```

---

## Task 2: Poller wiring

**Files:**
- Modify: `src/sources/poller.ts`
- Test: `tests/sources/poller.test.ts`

**Interfaces:**
- Consumes: `TaskSource` (`src/sources/types.ts`, existing).
- Produces: `startPoller`'s new optional 5th parameter, `loadDynamicSources?: () => Promise<TaskSource[]>`.

This task does not know anything about extensions specifically — `startPoller` only gains a generic way to merge in a dynamically-produced list of sources each tick. Task 1's `loadEnabledExtensionSources` is *a* function matching this shape; `startPoller` doesn't import or reference it.

- [ ] **Step 1: Write the failing test**

Add to `tests/sources/poller.test.ts` (alongside the existing `pollOnce` tests — add the needed imports too: `startPoller` from `../../src/sources/poller`, `type Task` is already imported):

```typescript
test("startPoller merges a dynamic source's items into each tick", async () => {
  const db = freshDb();
  const dynamicSource: TaskSource = {
    id: "dyn",
    async poll() {
      return { items: [{ externalId: "d1", title: "Dynamic", body: "" }], cursor: "dyn-cursor" };
    },
  };
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [],
    async (task) => {
      resolveSeen(task);
    },
    60_000,
    async () => [dynamicSource],
  );

  const task = await seenPromise;
  poller.stop();

  expect(task.title).toBe("Dynamic");
  expect(getCursor(db, "dyn")).toBe("dyn-cursor");
});

test("a failing loadDynamicSources does not stop the static sources from polling", async () => {
  const db = freshDb();
  const staticSource: TaskSource = {
    id: "static",
    async poll() {
      return { items: [{ externalId: "s1", title: "Static", body: "" }], cursor: "static-cursor" };
    },
  };
  let resolveSeen!: (task: Task) => void;
  const seenPromise = new Promise<Task>((resolve) => {
    resolveSeen = resolve;
  });

  const poller = startPoller(
    db,
    [staticSource],
    async (task) => {
      resolveSeen(task);
    },
    60_000,
    async () => {
      throw new Error("loader exploded");
    },
  );

  const task = await seenPromise;
  poller.stop();

  expect(task.title).toBe("Static");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/sources/poller.test.ts`
Expected: FAIL — `startPoller` does not accept a 5th argument yet (or the dynamic source is never polled).

- [ ] **Step 3: Write the implementation**

Replace `startPoller` in `src/sources/poller.ts` with:

```typescript
export function startPoller(
  db: Database,
  sources: TaskSource[],
  onTask: OnTask,
  intervalMs: number,
  loadDynamicSources?: () => Promise<TaskSource[]>,
): { stop(): void } {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;

    let dynamicSources: TaskSource[] = [];
    if (loadDynamicSources) {
      try {
        dynamicSources = await loadDynamicSources();
      } catch (error) {
        console.error("[poller] loadDynamicSources failed:", error);
      }
    }

    for (const source of [...sources, ...dynamicSources]) {
      try {
        await pollOnce(db, source, onTask);
      } catch (error) {
        console.error(`[poller] ${source.id} failed:`, error);
      }
    }
    running = false;
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/sources/poller.test.ts`
Expected: PASS (5 tests — 3 existing `pollOnce` tests plus the 2 new `startPoller` tests)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 6: Commit**

```bash
git add src/sources/poller.ts tests/sources/poller.test.ts
git commit -m "feat: let the poller merge in dynamically-loaded sources each tick"
```

---

## Task 3: `main.ts` wiring

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/main.smoke.test.ts`

**Interfaces:**
- Consumes: `loadEnabledExtensionSources` (Task 1); `startPoller`'s new 5th parameter (Task 2); `Vault`, `createVault` (`src/vault/vault.ts`, existing, already used in `createApp`).
- Produces: `App.vault: Vault` (new field on the existing `App` interface).

- [ ] **Step 1: Expose `vault` on `App`**

In `src/main.ts`, change the import of `createVault` to also bring in the type:

```typescript
import { createVault, type Vault } from "./vault/vault";
```

Add `vault: Vault;` to the `App` interface:

```typescript
export interface App {
  deps: AppDeps;
  mcp: McpManager;
  vault: Vault;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
```

In `createApp`'s return statement, add `vault` (it's already constructed earlier in the function as `const vault = createVault({ db });`):

```typescript
  return {
    deps,
    mcp,
    vault,
    fetch: async (request) => api.fetch(request),
    async close() {
      await mcp.close();
      db.close();
    },
  };
```

- [ ] **Step 2: Add a smoke test for the exposed vault**

Add to `tests/main.smoke.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the smoke tests to confirm this passes**

Run: `bun test tests/main.smoke.test.ts`
Expected: PASS (4 tests — 3 existing plus the new one)

- [ ] **Step 4: Wire the dynamic loader into `startPoller`'s call in the CLI block**

In `src/main.ts`, add the import:

```typescript
import { loadEnabledExtensionSources } from "./extensions/runtime";
```

In the `import.meta.main` block, replace the existing `if (sources.length) { startPoller(...); } else { console.warn(...); }` with:

```typescript
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
      config.pollIntervalMs,
      () => loadEnabledExtensionSources(app.deps.db, config.extensionsDir, app.vault),
    );
    if (!sources.length) {
      console.warn(
        "No static sources configured — set JIDOKA_OUTLOOK_CLIENT_ID or JIDOKA_SAMPLE_DIR, " +
          "install an extension, or add tasks from the board",
      );
    }
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 6: Commit**

```bash
git add src/main.ts tests/main.smoke.test.ts
git commit -m "feat: wire enabled extensions into the running poller"
```
