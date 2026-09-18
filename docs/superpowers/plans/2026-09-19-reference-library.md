# Reference Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let pipeline prompts pull in named, user-maintained JSON context (e.g. a team roster) via `{{data.<id>}}`, backed by a new "Reference Library" — a CRUD entity independent of any task source or MCP server.

**Architecture:** A new domain type + SQLite table + repo module (`reference_data`), read once per pipeline run and merged into the existing template scope under a new `data` key, plus a thin CRUD API and a board panel for authoring sets as raw JSON.

**Tech Stack:** Bun, `bun:sqlite`, Hono, React, Zod (unchanged — no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-19-reference-data-sets-design.md`

## Global Constraints

- Bun is the only runtime — no Node, no Docker.
- `bun run typecheck` (`tsc --noEmit`) must stay clean after every task.
- Tests use stub providers and injected `fetch`/`McpLike` seams — no test hits a network.
- Timestamps are ISO-8601 UTC (`new Date().toISOString()`).
- **Deviation from the project's usual ID convention:** every other entity uses `crypto.randomUUID()` for its id. A reference data set's `id` is instead a user-chosen slug (e.g. `team-roster`), because it's the key prompt authors type into `{{data.<id>}}` — a uuid would be unusable there. This is spec'd, not an oversight.

---

## Discovered during planning: the template engine's path regex must allow hyphens

The spec's canonical example id is `team-roster`, but `src/pipeline/template.ts`'s
current regex — `/\{\{\s*([\w.]+)\s*\}\}/g` — only allows `\w` (letters, digits,
underscore) and `.` inside `{{...}}`. A hyphen breaks the match entirely, so
`{{data.team-roster}}` would silently pass through unrendered. Task 2 below
widens the regex to `/\{\{\s*([\w.-]+)\s*\}\}/g` — purely additive, since no
existing template path uses a hyphen — as a required part of making
`{{data.<id>}}` work at all.

---

### Task 1: Domain type, migration, and repo module for reference data

**Files:**
- Create: `src/domain/referenceData.ts`
- Create: `src/repo/referenceData.ts`
- Modify: `src/db/migrations.ts:41-47` (insert a new table entry before the closing `];`)
- Test: `tests/repo/referenceData.test.ts`

**Interfaces:**
- Produces: `ReferenceDataSet { id: string; name: string; data: unknown; createdAt: string; updatedAt: string }`, `NewReferenceDataSet { id: string; name: string; data: unknown }`, `ReferenceDataSetPatch { name?: string; data?: unknown }`, `REFERENCE_DATA_ID_PATTERN: RegExp` (all from `src/domain/referenceData.ts`).
- Produces: `insertReferenceData(db, input: NewReferenceDataSet): ReferenceDataSet`, `getReferenceData(db, id: string): ReferenceDataSet | null`, `listReferenceData(db): ReferenceDataSet[]`, `updateReferenceData(db, id, patch: ReferenceDataSetPatch): ReferenceDataSet`, `deleteReferenceData(db, id: string): void` (all from `src/repo/referenceData.ts`) — these are consumed directly by Task 3 (orchestrator) and Task 4 (API routes).

- [ ] **Step 1: Write the failing test**

Create `tests/repo/referenceData.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import {
  insertReferenceData,
  getReferenceData,
  listReferenceData,
  updateReferenceData,
  deleteReferenceData,
} from "../../src/repo/referenceData";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("insertReferenceData stores a set and getReferenceData reads it back", () => {
  const db = freshDb();
  const set = insertReferenceData(db, {
    id: "team-roster",
    name: "Team roster",
    data: { rows: [{ name: "Alice", role: "senior" }] },
  });

  expect(set.id).toBe("team-roster");
  expect(getReferenceData(db, "team-roster")).toEqual(set);
});

test("insertReferenceData rejects an invalid id and a duplicate id", () => {
  const db = freshDb();
  expect(() =>
    insertReferenceData(db, { id: "Team Roster", name: "n", data: {} }),
  ).toThrow(/invalid reference data id/);

  insertReferenceData(db, { id: "team-roster", name: "n", data: {} });
  expect(() =>
    insertReferenceData(db, { id: "team-roster", name: "n2", data: {} }),
  ).toThrow(/already exists/);
});

test("listReferenceData orders by name", () => {
  const db = freshDb();
  insertReferenceData(db, { id: "b-set", name: "Bravo", data: {} });
  insertReferenceData(db, { id: "a-set", name: "Alpha", data: {} });

  expect(listReferenceData(db).map((s) => s.name)).toEqual(["Alpha", "Bravo"]);
});

test("updateReferenceData replaces name and data", () => {
  const db = freshDb();
  insertReferenceData(db, { id: "team-roster", name: "Team roster", data: { rows: [] } });

  const updated = updateReferenceData(db, "team-roster", {
    name: "Team roster (v2)",
    data: { rows: [{ name: "Bob" }] },
  });

  expect(updated.name).toBe("Team roster (v2)");
  expect(updated.data).toEqual({ rows: [{ name: "Bob" }] });
  expect(getReferenceData(db, "team-roster")).toEqual(updated);
});

test("updateReferenceData rejects an unknown id", () => {
  const db = freshDb();
  expect(() => updateReferenceData(db, "missing", { name: "x" })).toThrow(
    /unknown reference data/,
  );
});

test("deleteReferenceData removes the set", () => {
  const db = freshDb();
  insertReferenceData(db, { id: "team-roster", name: "Team roster", data: {} });
  deleteReferenceData(db, "team-roster");
  expect(getReferenceData(db, "team-roster")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/repo/referenceData.test.ts`
Expected: FAIL — `Cannot find module '../../src/repo/referenceData'` (the module doesn't exist yet).

- [ ] **Step 3: Add the migration**

In `src/db/migrations.ts`, insert a new entry into the `MIGRATIONS` array right after the `oauth_tokens` table (currently lines 41-46) and before the closing `];`:

```ts
  `CREATE TABLE IF NOT EXISTS reference_data (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
```

- [ ] **Step 4: Create the domain type**

Create `src/domain/referenceData.ts`:

```ts
export interface ReferenceDataSet {
  id: string;
  name: string;
  data: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface NewReferenceDataSet {
  id: string;
  name: string;
  data: unknown;
}

export interface ReferenceDataSetPatch {
  name?: string;
  data?: unknown;
}

/** A user-chosen slug: this is the template key ({{data.<id>}}), not a uuid. */
export const REFERENCE_DATA_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
```

- [ ] **Step 5: Create the repo module**

Create `src/repo/referenceData.ts`:

```ts
import type { Database } from "bun:sqlite";
import type {
  NewReferenceDataSet,
  ReferenceDataSet,
  ReferenceDataSetPatch,
} from "../domain/referenceData";
import { REFERENCE_DATA_ID_PATTERN } from "../domain/referenceData";

interface Row {
  id: string;
  name: string;
  data: string;
  created_at: string;
  updated_at: string;
}

function toSet(row: Row): ReferenceDataSet {
  return {
    id: row.id,
    name: row.name,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertReferenceData(
  db: Database,
  input: NewReferenceDataSet,
): ReferenceDataSet {
  if (!REFERENCE_DATA_ID_PATTERN.test(input.id)) {
    throw new Error(`invalid reference data id: ${input.id}`);
  }
  if (getReferenceData(db, input.id)) {
    throw new Error(`reference data id already exists: ${input.id}`);
  }
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO reference_data (id, name, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.id, input.name, JSON.stringify(input.data), now, now);
  const set = getReferenceData(db, input.id);
  if (!set) throw new Error(`insertReferenceData: set ${input.id} vanished`);
  return set;
}

export function getReferenceData(db: Database, id: string): ReferenceDataSet | null {
  const row = db.query("SELECT * FROM reference_data WHERE id = ?").get(id) as Row | null;
  return row ? toSet(row) : null;
}

export function listReferenceData(db: Database): ReferenceDataSet[] {
  const rows = db.query("SELECT * FROM reference_data ORDER BY name").all() as Row[];
  return rows.map(toSet);
}

export function updateReferenceData(
  db: Database,
  id: string,
  patch: ReferenceDataSetPatch,
): ReferenceDataSet {
  const current = getReferenceData(db, id);
  if (!current) throw new Error(`updateReferenceData: unknown reference data ${id}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.query(`UPDATE reference_data SET name = ?, data = ?, updated_at = ? WHERE id = ?`).run(
    next.name,
    JSON.stringify(next.data),
    next.updatedAt,
    id,
  );
  return next;
}

export function deleteReferenceData(db: Database, id: string): void {
  db.query("DELETE FROM reference_data WHERE id = ?").run(id);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/repo/referenceData.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add src/domain/referenceData.ts src/repo/referenceData.ts src/db/migrations.ts tests/repo/referenceData.test.ts
git commit -m "feat: add reference data domain type, table, and repo module"
```

---

### Task 2: Wire reference data into the template scope

**Files:**
- Modify: `src/pipeline/template.ts:1-4` (widen the path regex, add `data` to `TemplateScope`)
- Modify: `src/pipeline/executor.ts:15-28` (`ExecutorDeps`), `:101-113` (`scopeFor`), `:122` (call site)
- Modify: `tests/pipeline/template.test.ts`
- Modify: `tests/pipeline/handoff.test.ts:24-27` (typecheck-only fix, no behavior change)
- Modify: `tests/pipeline/executor.test.ts`

**Interfaces:**
- Consumes: `ReferenceDataSet` from `src/domain/referenceData.ts` (Task 1).
- Produces: `TemplateScope.data: Record<string, unknown>`; `ExecutorDeps.listReferenceData?: () => ReferenceDataSet[]` — consumed by Task 3 (`src/orchestrator.ts`).

- [ ] **Step 1: Write the failing test**

Replace the contents of `tests/pipeline/template.test.ts`:

```ts
import { test, expect } from "bun:test";
import { renderTemplate, renderInput } from "../../src/pipeline/template";

const scope = {
  task: { title: "Where is my order?", body: "Not arrived", metadata: { from: "a@b.com" } },
  context: { summary: "Customer chasing delivery" },
  data: { "team-roster": { rows: [{ name: "Alice", role: "senior" }] } },
};

test("renderTemplate substitutes task and context paths", () => {
  expect(renderTemplate("Subject: {{task.title}} / {{context.summary}}", scope)).toBe(
    "Subject: Where is my order? / Customer chasing delivery",
  );
});

test("renderTemplate substitutes nested metadata and leaves unknown paths empty", () => {
  expect(renderTemplate("From {{task.metadata.from}}|{{context.missing}}", scope)).toBe(
    "From a@b.com|",
  );
});

test("renderInput walks objects and arrays", () => {
  expect(
    renderInput({ query: "from:{{task.metadata.from}}", tags: ["{{context.summary}}", 3] }, scope),
  ).toEqual({ query: "from:a@b.com", tags: ["Customer chasing delivery", 3] });
});

test("renderTemplate substitutes a reference data set by its hyphenated id", () => {
  expect(renderTemplate("Roster: {{data.team-roster}}", scope)).toBe(
    'Roster: {"rows":[{"name":"Alice","role":"senior"}]}',
  );
});

test("renderTemplate leaves an unknown reference data id empty", () => {
  expect(renderTemplate("{{data.missing-set}}", scope)).toBe("");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/pipeline/template.test.ts`
Expected: the first three tests PASS; `renderTemplate substitutes a reference data set by its hyphenated id` FAILS — the regex doesn't match the hyphen, so the template is returned unrendered (`"Roster: {{data.team-roster}}"` instead of the JSON).

- [ ] **Step 3: Implement the regex fix and the `data` scope field**

In `src/pipeline/template.ts`, replace lines 1-4 and the `renderTemplate` regex:

```ts
export interface TemplateScope {
  task: Record<string, unknown>;
  context: Record<string, unknown>;
  data: Record<string, unknown>;
}
```

```ts
export function renderTemplate(input: string, scope: TemplateScope): string {
  return input.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookup(scope, path);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
```

(Only the regex literal changes — `[\w.]+` becomes `[\w.-]+`. `lookup`, `renderInput`, and the rest of the file are unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/pipeline/template.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing executor test**

Append to `tests/pipeline/executor.test.ts` (after the existing tests, using the existing `task`, `scriptedProvider`, `noTools`, `noPipelines` from that file):

```ts
test("an ai step's prompt can pull in a reference data set via {{data.<id>}}", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Roster: {{data.team-roster}}", output: "note" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const provider = scriptedProvider(["noted"]);

  await runPipeline(
    {
      provider,
      callTool: noTools,
      loadPipeline: noPipelines,
      listReferenceData: () => [
        {
          id: "team-roster",
          name: "Team roster",
          data: { rows: [{ name: "Alice", role: "senior" }] },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    definition,
    task,
  );

  expect(provider.prompts[0]).toBe('Roster: {"rows":[{"name":"Alice","role":"senior"}]}');
});

test("a reference data path renders empty when listReferenceData is omitted", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Roster: {{data.team-roster}}", output: "note" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  const provider = scriptedProvider(["noted"]);

  await runPipeline({ provider, callTool: noTools, loadPipeline: noPipelines }, definition, task);

  expect(provider.prompts[0]).toBe("Roster: ");
});
```

- [ ] **Step 6: Run the test to verify the first new test fails**

Run: `bun test tests/pipeline/executor.test.ts`
Expected: `an ai step's prompt can pull in a reference data set via {{data.<id>}}` FAILS (`provider.prompts[0]` is `"Roster: "`, since nothing merges `listReferenceData` into the scope yet). `a reference data path renders empty when listReferenceData is omitted` already PASSES.

- [ ] **Step 7: Implement the executor wiring**

In `src/pipeline/executor.ts`, add the import at the top of the file:

```ts
import type { ReferenceDataSet } from "../domain/referenceData";
```

Add a field to `ExecutorDeps` (currently lines 15-28):

```ts
export interface ExecutorDeps {
  provider: AiProvider;
  callTool: ToolCaller;
  loadPipeline: PipelineLoader;
  /** Tool catalogue for agent steps; names are `server__tool`. */
  listTools?: () => ToolSpec[];
  /**
   * Backend for `agent` steps. Defaults to the in-process loop over `provider`
   * and `callTool`; set it to the Agent SDK runner to use subscription auth.
   */
  runAgent?: AgentRunner;
  /** The pipeline being run, so that a self-call is detected as a loop. */
  self?: { typeId: string; version: number };
  /** Every reference data set, exposed to templates as {{data.<id>}}. */
  listReferenceData?: () => ReferenceDataSet[];
}
```

Replace `scopeFor` (currently lines 101-113):

```ts
function scopeFor(task: Task, state: RunState, deps: ExecutorDeps): TemplateScope {
  const data: Record<string, unknown> = {};
  for (const set of deps.listReferenceData?.() ?? []) data[set.id] = set.data;

  return {
    task: {
      id: task.id,
      title: task.title,
      body: task.body,
      url: task.url,
      metadata: task.metadata,
      sourceId: task.sourceId,
    },
    context: state.context,
    data,
  };
}
```

Update the one call site inside `runSteps` (currently line 122) from `const scope = scopeFor(task, state);` to:

```ts
    const scope = scopeFor(task, state, deps);
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test tests/pipeline/executor.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 9: Fix the handoff test for the now-required `data` field**

`TemplateScope.data` is required, and `tests/pipeline/handoff.test.ts:24-27` builds a `scope` object passed to `resolveHandoff` without one. This doesn't affect runtime (bun test doesn't type-check), but it must be fixed to keep `bun run typecheck` clean. Update the `scope` const in `tests/pipeline/handoff.test.ts`:

```ts
const scope = {
  task: { title: "Where is my order?", url: "https://example.com/m1" },
  context: { reply: "We are checking with the courier.", brief_session: "sess-99", blank: "" },
  data: {},
};
```

- [ ] **Step 10: Verify typecheck and the whole suite are clean**

Run: `bun run typecheck`
Expected: no errors.

Run: `bun test`
Expected: all tests PASS (no regressions elsewhere).

- [ ] **Step 11: Commit**

```bash
git add src/pipeline/template.ts src/pipeline/executor.ts tests/pipeline/template.test.ts tests/pipeline/executor.test.ts tests/pipeline/handoff.test.ts
git commit -m "feat: expose reference data sets to templates as {{data.<id>}}"
```

---

### Task 3: Wire the orchestrator to load reference data for every pipeline run

**Files:**
- Modify: `src/orchestrator.ts:1-30` (import), `:80-92` (`runPipelineForTask`'s `runPipeline` call)
- Modify: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `listReferenceData(db): ReferenceDataSet[]` (Task 1), `ExecutorDeps.listReferenceData` (Task 2).
- Produces: nothing new consumed by later tasks — this closes the loop end-to-end for the executor/template work.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestrator.test.ts` (it already imports `insertTask`, `insertTaskType`, `insertPipeline`, `activatePipeline`, `onTaskIngested`, and `AiProvider`; add one more import line at the top: `import { insertReferenceData } from "../src/repo/referenceData";`):

```ts
test("a pipeline step can pull in a reference data set via {{data.<id>}}", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activatePipeline(
    db,
    insertPipeline(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "Roster: {{data.team-roster}}", output: "note" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  insertReferenceData(db, {
    id: "team-roster",
    name: "Team roster",
    data: { rows: [{ name: "Alice", role: "senior" }] },
  });
  const task = insertTask(db, sample);

  const prompts: string[] = [];
  let i = 0;
  const replies = [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
    "noted",
  ];
  const provider: AiProvider = {
    id: "stub",
    async complete(req) {
      const last = req.messages.at(-1);
      if (last && "content" in last) prompts.push(last.content);
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
  const app = { db, provider, mcp: { listTools: () => [], callTool: async () => "" } };

  const result = await onTaskIngested(app, task);

  expect(result.context.note).toBe("noted");
  expect(prompts[1]).toBe('Roster: {"rows":[{"name":"Alice","role":"senior"}]}');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/orchestrator.test.ts -t "reference data set"`
Expected: FAIL — `prompts[1]` is `"Roster: "`, since `runPipelineForTask` doesn't pass `listReferenceData` yet.

- [ ] **Step 3: Implement the orchestrator wiring**

In `src/orchestrator.ts`, add to the repo import block (near the top, alongside the `taskTypes`/`pipelines` imports):

```ts
import { listReferenceData } from "./repo/referenceData";
```

In `runPipelineForTask`, add one line to the `runPipeline` call's first argument (currently lines 80-92):

```ts
    const result = await runPipeline(
      {
        provider: deps.provider,
        callTool: deps.mcp.callTool,
        listTools: () => deps.mcp.listTools(),
        ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
        loadPipeline: (typeId, version) =>
          listPipelines(deps.db, typeId).find((p) => p.version === version)?.definition ?? null,
        listReferenceData: () => listReferenceData(deps.db),
        self: { typeId: active.typeId, version: active.version },
      },
      active.definition,
      running,
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/orchestrator.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: load reference data for every pipeline run"
```

---

### Task 4: CRUD API routes for reference data

**Files:**
- Modify: `src/api/server.ts:1-14` (import), insert routes before `return app;` (currently line 160)
- Modify: `tests/api/server.test.ts`

**Interfaces:**
- Consumes: `insertReferenceData`, `getReferenceData`, `listReferenceData`, `updateReferenceData`, `deleteReferenceData` (Task 1).
- Produces: `GET /api/reference-data`, `POST /api/reference-data`, `PATCH /api/reference-data/:id`, `DELETE /api/reference-data/:id` — consumed by Task 5 (`src/client/api.ts`).

- [ ] **Step 1: Write the failing test**

Append to `tests/api/server.test.ts` (it already has the `app(replies)` helper defined at the top of the file):

```ts
test("reference data: create, list, update, and delete a set", async () => {
  const { fetch } = app([]);

  const create = await fetch(
    new Request("http://localhost/api/reference-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "team-roster", name: "Team roster", data: { rows: [] } }),
    }),
  );
  expect(create.status).toBe(201);

  const list = await fetch(new Request("http://localhost/api/reference-data"));
  const listBody = (await list.json()) as { sets: { id: string }[] };
  expect(listBody.sets.map((s) => s.id)).toEqual(["team-roster"]);

  const update = await fetch(
    new Request("http://localhost/api/reference-data/team-roster", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { rows: [{ name: "Alice" }] } }),
    }),
  );
  const updateBody = (await update.json()) as { set: { data: unknown } };
  expect(updateBody.set.data).toEqual({ rows: [{ name: "Alice" }] });

  const del = await fetch(
    new Request("http://localhost/api/reference-data/team-roster", { method: "DELETE" }),
  );
  expect(del.status).toBe(204);

  const afterDelete = await fetch(
    new Request("http://localhost/api/reference-data/team-roster", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    }),
  );
  expect(afterDelete.status).toBe(404);
});

test("reference data: rejects a duplicate id and a missing name", async () => {
  const { fetch } = app([]);
  await fetch(
    new Request("http://localhost/api/reference-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "team-roster", name: "Team roster", data: {} }),
    }),
  );

  const dupe = await fetch(
    new Request("http://localhost/api/reference-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "team-roster", name: "Again", data: {} }),
    }),
  );
  expect(dupe.status).toBe(409);

  const noName = await fetch(
    new Request("http://localhost/api/reference-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "another-set" }),
    }),
  );
  expect(noName.status).toBe(400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/server.test.ts -t "reference data"`
Expected: FAIL — 404 "not found" (the routes don't exist yet).

- [ ] **Step 3: Implement the routes**

In `src/api/server.ts`, add to the import block at the top of the file:

```ts
import {
  deleteReferenceData,
  getReferenceData,
  insertReferenceData,
  listReferenceData,
  updateReferenceData,
} from "../repo/referenceData";
```

Add these routes right before the final `return app;` (currently line 160):

```ts
  app.get("/api/reference-data", (c) => c.json({ sets: listReferenceData(deps.db) }));

  app.post("/api/reference-data", async (c) => {
    const input = await readJson<{ id?: string; name?: string; data?: unknown }>(c);
    if (!input) return c.json({ error: "body must be valid JSON" }, 400);
    if (!input.id?.trim()) return c.json({ error: "id is required" }, 400);
    if (!input.name?.trim()) return c.json({ error: "name is required" }, 400);
    try {
      const set = insertReferenceData(deps.db, {
        id: input.id,
        name: input.name,
        data: input.data ?? {},
      });
      return c.json({ set }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.patch("/api/reference-data/:id", async (c) => {
    const id = c.req.param("id");
    if (!getReferenceData(deps.db, id)) return c.json({ error: "unknown reference data" }, 404);
    const patch = await readJson<{ name?: string; data?: unknown }>(c);
    if (!patch) return c.json({ error: "body must be valid JSON" }, 400);
    return c.json({ set: updateReferenceData(deps.db, id, patch) });
  });

  app.delete("/api/reference-data/:id", (c) => {
    const id = c.req.param("id");
    if (!getReferenceData(deps.db, id)) return c.json({ error: "unknown reference data" }, 404);
    deleteReferenceData(deps.db, id);
    return c.body(null, 204);
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/server.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat: add CRUD API routes for reference data"
```

---

### Task 5: Reference Library board panel

**Files:**
- Modify: `src/client/api.ts` (add `ReferenceDataSet` type and four `api.*` functions)
- Create: `src/client/ReferenceData.tsx`
- Modify: `src/client/App.tsx:1-9` (import), state hooks, header actions, modal render section

**Interfaces:**
- Consumes: the four routes from Task 4.
- Produces: `<ReferenceData onClose={() => void} />`, consumed by `App.tsx`.

No new automated tests: there's no existing precedent in `tests/client/` for rendering a React component (`columns.test.ts` covers pure logic only), and none of `TypeConfirm.tsx`/`Onboarding.tsx`/`TaskDetail.tsx` have render tests either. This task ends with manual verification (Step 4) instead of a test run.

- [ ] **Step 1: Add the client API functions**

In `src/client/api.ts`, add near the other interfaces at the top of the file:

```ts
export interface ReferenceDataSet {
  id: string;
  name: string;
  data: unknown;
  createdAt: string;
  updatedAt: string;
}
```

Add to the `api` object (the `json<T>` helper and `api` export already exist in this file):

```ts
  referenceData: () =>
    json<{ sets: ReferenceDataSet[] }>("/api/reference-data").then((r) => r.sets),
  createReferenceData: (input: { id: string; name: string; data: unknown }) =>
    json<{ set: ReferenceDataSet }>("/api/reference-data", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.set),
  updateReferenceData: (id: string, patch: { name?: string; data?: unknown }) =>
    json<{ set: ReferenceDataSet }>(`/api/reference-data/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.set),
  deleteReferenceData: async (id: string) => {
    const response = await fetch(`/api/reference-data/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`request failed: ${response.status}`);
  },
```

(`deleteReferenceData` uses raw `fetch` rather than the shared `json<T>` helper because a `204 No Content` response has no body to parse.)

- [ ] **Step 2: Create the panel**

Create `src/client/ReferenceData.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api, type ReferenceDataSet } from "./api";

export function ReferenceData({ onClose }: { onClose: () => void }) {
  const [sets, setSets] = useState<ReferenceDataSet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [json, setJson] = useState("{}");
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setSets(await api.referenceData());
  }

  useEffect(() => {
    void refresh();
  }, []);

  function select(set: ReferenceDataSet) {
    setSelectedId(set.id);
    setName(set.name);
    setJson(JSON.stringify(set.data, null, 2));
    setError(null);
  }

  function startNew() {
    setSelectedId(null);
    setNewId("");
    setName("");
    setJson("{}");
    setError(null);
  }

  async function save() {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      setError("data must be valid JSON");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (selectedId) {
        await api.updateReferenceData(selectedId, { name, data });
      } else {
        if (!newId.trim()) {
          setError("id is required");
          return;
        }
        await api.createReferenceData({ id: newId.trim(), name, data });
      }
      await refresh();
      startNew();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.deleteReferenceData(id);
      await refresh();
      if (selectedId === id) startNew();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog">
      <h2>Reference Library</h2>
      <p className="subject">
        Structured context, like a team roster, that pipeline prompts can pull in with
        {" "}
        <code>{"{{data.<id>}}"}</code>.
      </p>

      <ul>
        {sets.map((set) => (
          <li key={set.id}>
            <button className="secondary" onClick={() => select(set)}>
              {set.name} ({set.id})
            </button>
            <button className="secondary" disabled={busy} onClick={() => remove(set.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      <h3>{selectedId ? `Edit ${selectedId}` : "New set"}</h3>
      {!selectedId && (
        <label>
          Id
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="team-roster"
          />
        </label>
      )}
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Data (JSON)
        <textarea rows={10} value={json} onChange={(e) => setJson(e.target.value)} />
      </label>

      {error && <p className="error">{error}</p>}

      <button disabled={busy} onClick={save}>
        {selectedId ? "Save" : "Create"}
      </button>
      {selectedId && (
        <button className="secondary" disabled={busy} onClick={startNew}>
          New set instead
        </button>
      )}
      <button className="secondary" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `App.tsx`**

In `src/client/App.tsx`, add the import alongside the other component imports (currently lines 1-9):

```ts
import { ReferenceData } from "./ReferenceData";
```

Add state next to the existing `selected` state:

```ts
  const [showReferenceData, setShowReferenceData] = useState(false);
```

Add a button in the header's `.actions` div, alongside `SignIn`/`NewTask`/`Refresh`:

```tsx
          <button onClick={() => setShowReferenceData(true)}>Reference Library</button>
```

Add the panel's conditional render, alongside the other modals (`TypeConfirm`/`Onboarding`/`TaskDetail`) — it isn't scoped to `selected`, so it renders independently:

```tsx
      {showReferenceData && <ReferenceData onClose={() => setShowReferenceData(false)} />}
```

- [ ] **Step 4: Verify typecheck, then verify manually**

Run: `bun run typecheck`
Expected: no errors.

Run: `JIDOKA_DB=./manual-check.db JIDOKA_SAMPLE_DIR=./samples bun run dev`, then in a browser open `http://localhost:3000`:
1. Click "Reference Library". The panel opens with an empty list and a "New set" form.
2. Enter id `team-roster`, name `Team roster`, data `{"rows":[{"name":"Alice","role":"senior"}]}`, click "Create". It appears in the list.
3. Click it, change the name, click "Save". Close the panel, reopen it — the new name persisted.
4. Click "Delete". It disappears from the list.
5. Stop the dev server (Ctrl+C) and delete `manual-check.db`.

- [ ] **Step 5: Commit**

```bash
git add src/client/api.ts src/client/ReferenceData.tsx src/client/App.tsx
git commit -m "feat: add Reference Library panel for managing reference data sets"
```
