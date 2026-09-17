# Jidoka Skeleton + Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Jidoka end-to-end — Outlook polling, AI triage that discovers task types, agent-built per-type pipelines with an executor, MCP tool calls, and a kanban UI with onboarding — as a single Bun executable.

**Architecture:** One Bun process owns everything: a poller that turns Outlook messages into tasks, an orchestrator that runs AI triage and then the task type's pipeline, an MCP client that exposes external tools to AI steps, a Hono HTTP API, and a React UI served from the same process. State lives in one SQLite file via `bun:sqlite`. Every LLM call goes through an `AiProvider` interface so Claude and OpenAI are interchangeable.

**Tech Stack:** Bun 1.2+, TypeScript (strict), `bun:sqlite`, Hono, Zod, `@anthropic-ai/sdk`, `openai`, `@modelcontextprotocol/sdk`, React 19, `bun test`.

**Spec:** `CLAUDE.md` (project root) — the architecture section is the spec this plan implements.

## Global Constraints

- Runtime is **Bun only**. No Node-specific APIs, no Docker, no Electron. `bun run`, `bun test`, `bun build --compile`.
- **Single user, no auth.** No `user_id` columns, no sessions.
- **Storage is `bun:sqlite`**, one file at `JIDOKA_DB` (default `./jidoka.db`). All SQL lives in `src/db/`; no other file imports `bun:sqlite`.
- **TypeScript strict mode** (`"strict": true`, `"noUncheckedIndexedAccess": true`).
- **No vendor SDK outside `src/ai/`.** `@anthropic-ai/sdk` may only be imported by `src/ai/anthropic.ts`; `openai` only by `src/ai/openai.ts`. Everything else depends on the `AiProvider` interface. (This is the spec's bring-your-own-AI rule; the OpenAI adapter is deliberately non-Anthropic code.)
- **Anthropic defaults:** model `claude-opus-5`, `max_tokens: 16000`, adaptive thinking omitted (on by default on Opus 5). Never pass `budget_tokens` — it 400s on this model.
- **IDs** are `crypto.randomUUID()`. **Timestamps** are ISO-8601 UTC strings (`new Date().toISOString()`).
- **Task states**, exactly: `ingested`, `needs_type_confirmation`, `needs_onboarding`, `processing`, `assigned_ai`, `assigned_human`, `done`, `failed`.
- Tests are colocated under `tests/`, mirroring `src/`. Run one file with `bun test tests/path/file.test.ts`, one case with `bun test tests/path/file.test.ts -t "case name"`.
- Commit after every task with a `feat:`/`chore:`/`test:` prefix.

---

## File Structure

```
src/
  main.ts                    entry: config, migrate, MCP connect, poller, serve
  config.ts                  env parsing (AI provider/key/model, Outlook, MCP servers, db path)
  db/
    index.ts                 openDb(), migrate()
    migrations.ts            ordered SQL statements as string constants
  domain/
    task.ts                  Task, TaskState, Assignee
    taskType.ts              TaskType
    pipeline.ts              Pipeline, PipelineDefinition, Zod schema
  repo/
    tasks.ts                 insert/get/list/find/update
    taskTypes.ts             insert/get/list/update/merge
    pipelines.ts             insert/getActive/listByType/activate
    sourceState.ts           per-source cursor persistence
  ai/
    provider.ts              AiProvider interface, AiMessage, ToolSpec, completeJson()
    anthropic.ts             Anthropic adapter (@anthropic-ai/sdk)
    openai.ts                OpenAI adapter (openai)
    index.ts                 createProvider(config)
  sources/
    types.ts                 TaskSource interface, RawItem
    poller.ts                pollOnce(), startPoller()
    outlook/
      auth.ts                device-code flow + token refresh
      source.ts              Graph polling -> RawItem[]
  triage/
    triage.ts                triageTask()
    prompt.ts                system prompt + JSON schema
  mcp/
    manager.ts               McpManager: connect, listTools, callTool
  pipeline/
    executor.ts              runPipeline()
    template.ts              renderTemplate()
    builder.ts               buildPipeline() — the agent that writes pipelines
  orchestrator.ts            onTaskIngested(), onTypeConfirmed(), runPipelineForTask()
  api/
    server.ts                Hono app + routes
  client/
    index.html               entry (imported by main.ts, bundled by Bun)
    main.tsx                 React root
    api.ts                   typed fetch wrappers
    Board.tsx                kanban columns
    TypeConfirm.tsx          ambiguous-triage dialog
    Onboarding.tsx           type review + description + pipeline review
tests/                       mirrors src/
```

---

### Task 1: Project scaffold, database, task repository

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/db/migrations.ts`, `src/db/index.ts`, `src/domain/task.ts`, `src/repo/tasks.ts`
- Test: `tests/repo/tasks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `openDb(path: string): Database`, `migrate(db: Database): void`, `Task`, `TaskState`, `Assignee`, `NewTask`, and from `src/repo/tasks.ts`: `insertTask(db, input: NewTask): Task`, `getTask(db, id: string): Task | null`, `listTasks(db): Task[]`, `findTaskBySource(db, sourceId: string, externalId: string): Task | null`, `updateTask(db, id: string, patch: TaskPatch): Task`.

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "jidoka",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/main.ts",
    "start": "bun src/main.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "build": "bun build --compile --outfile jidoka src/main.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.70.0",
    "@modelcontextprotocol/sdk": "^1.22.0",
    "hono": "^4.10.0",
    "openai": "^6.10.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "typescript": "^5.9.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`.gitignore`:

```
node_modules/
*.db
*.db-wal
*.db-shm
jidoka
jidoka.exe
.env
```

Run: `bun install`

- [ ] **Step 2: Write the failing test**

`tests/repo/tasks.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import {
  insertTask,
  getTask,
  listTasks,
  findTaskBySource,
  updateTask,
} from "../../src/repo/tasks";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const sample = {
  sourceId: "outlook",
  externalId: "msg-1",
  url: "https://outlook.office.com/mail/id/msg-1",
  title: "Invoice question",
  body: "Can you confirm the amount on invoice 42?",
  metadata: { from: "a@example.com" },
};

test("insertTask stores a task in the ingested state", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  expect(task.id).toMatch(/[0-9a-f-]{36}/);
  expect(task.state).toBe("ingested");
  expect(task.typeId).toBeNull();
  expect(task.assignee).toBeNull();
  expect(task.metadata).toEqual({ from: "a@example.com" });
  expect(getTask(db, task.id)).toEqual(task);
});

test("findTaskBySource finds by source and external id", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  expect(findTaskBySource(db, "outlook", "msg-1")?.id).toBe(task.id);
  expect(findTaskBySource(db, "outlook", "msg-2")).toBeNull();
});

test("insertTask rejects a duplicate source item", () => {
  const db = freshDb();
  insertTask(db, sample);

  expect(() => insertTask(db, sample)).toThrow();
});

test("updateTask patches state, type, assignee and context", () => {
  const db = freshDb();
  const task = insertTask(db, sample);

  const updated = updateTask(db, task.id, {
    state: "assigned_human",
    typeId: "type-1",
    assignee: "human",
    context: { summary: "Asks about invoice 42" },
  });

  expect(updated.state).toBe("assigned_human");
  expect(updated.typeId).toBe("type-1");
  expect(updated.assignee).toBe("human");
  expect(updated.context).toEqual({ summary: "Asks about invoice 42" });
  expect(updated.updatedAt >= task.updatedAt).toBe(true);
  expect(listTasks(db)).toHaveLength(1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/repo/tasks.test.ts`
Expected: FAIL — cannot resolve `../../src/db`.

- [ ] **Step 4: Write the implementation**

`src/domain/task.ts`:

```typescript
export type TaskState =
  | "ingested"
  | "needs_type_confirmation"
  | "needs_onboarding"
  | "processing"
  | "assigned_ai"
  | "assigned_human"
  | "done"
  | "failed";

export type Assignee = "ai" | "human";

export interface Task {
  id: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  typeId: string | null;
  typeCandidates: string[] | null;
  state: TaskState;
  assignee: Assignee | null;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  sourceId: string;
  externalId: string;
  url?: string | null;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface TaskPatch {
  state?: TaskState;
  typeId?: string | null;
  typeCandidates?: string[] | null;
  assignee?: Assignee | null;
  context?: Record<string, unknown>;
}
```

`src/db/migrations.ts` — all tables are created here in Task 1 so that later tasks never edit this file concurrently:

```typescript
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL,
     external_id TEXT NOT NULL,
     url TEXT,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     metadata TEXT NOT NULL DEFAULT '{}',
     type_id TEXT,
     type_candidates TEXT,
     state TEXT NOT NULL,
     assignee TEXT,
     context TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (source_id, external_id)
   )`,
  `CREATE TABLE IF NOT EXISTS task_types (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     examples TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS pipelines (
     id TEXT PRIMARY KEY,
     type_id TEXT NOT NULL REFERENCES task_types(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     status TEXT NOT NULL,
     definition TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (type_id, version)
   )`,
  `CREATE TABLE IF NOT EXISTS source_state (
     source_id TEXT PRIMARY KEY,
     cursor TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
     provider TEXT PRIMARY KEY,
     access_token TEXT NOT NULL,
     refresh_token TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
];
```

`src/db/index.ts`:

```typescript
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./migrations";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db: Database): void {
  for (const sql of MIGRATIONS) db.exec(sql);
}

export type { Database };
```

`src/repo/tasks.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { NewTask, Task, TaskPatch } from "../domain/task";

interface Row {
  id: string;
  source_id: string;
  external_id: string;
  url: string | null;
  title: string;
  body: string;
  metadata: string;
  type_id: string | null;
  type_candidates: string | null;
  state: string;
  assignee: string | null;
  context: string;
  created_at: string;
  updated_at: string;
}

function toTask(row: Row): Task {
  return {
    id: row.id,
    sourceId: row.source_id,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    body: row.body,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    typeId: row.type_id,
    typeCandidates: row.type_candidates
      ? (JSON.parse(row.type_candidates) as string[])
      : null,
    state: row.state as Task["state"],
    assignee: row.assignee as Task["assignee"],
    context: JSON.parse(row.context) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertTask(db: Database, input: NewTask): Task {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO tasks (id, source_id, external_id, url, title, body, metadata,
                        type_id, type_candidates, state, assignee, context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'ingested', NULL, '{}', ?, ?)`,
  ).run(
    id,
    input.sourceId,
    input.externalId,
    input.url ?? null,
    input.title,
    input.body,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  const task = getTask(db, id);
  if (!task) throw new Error(`insertTask: task ${id} vanished`);
  return task;
}

export function getTask(db: Database, id: string): Task | null {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null;
  return row ? toTask(row) : null;
}

export function listTasks(db: Database): Task[] {
  const rows = db
    .query("SELECT * FROM tasks ORDER BY created_at DESC")
    .all() as Row[];
  return rows.map(toTask);
}

export function findTaskBySource(
  db: Database,
  sourceId: string,
  externalId: string,
): Task | null {
  const row = db
    .query("SELECT * FROM tasks WHERE source_id = ? AND external_id = ?")
    .get(sourceId, externalId) as Row | null;
  return row ? toTask(row) : null;
}

export function updateTask(db: Database, id: string, patch: TaskPatch): Task {
  const current = getTask(db, id);
  if (!current) throw new Error(`updateTask: unknown task ${id}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.query(
    `UPDATE tasks SET state = ?, type_id = ?, type_candidates = ?, assignee = ?,
                      context = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.state,
    next.typeId,
    next.typeCandidates ? JSON.stringify(next.typeCandidates) : null,
    next.assignee,
    JSON.stringify(next.context),
    next.updatedAt,
    id,
  );
  return next;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/repo/tasks.test.ts`
Expected: PASS (4 tests). Also run `bun run typecheck` — expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lock src tests
git commit -m "feat: scaffold Bun project with SQLite task repository"
```

---

### Task 2: Task type and pipeline repositories

**Files:**
- Create: `src/domain/taskType.ts`, `src/domain/pipeline.ts`, `src/repo/taskTypes.ts`, `src/repo/pipelines.ts`
- Test: `tests/repo/taskTypes.test.ts`, `tests/repo/pipelines.test.ts`

**Interfaces:**
- Consumes: `openDb`, `migrate`, `updateTask` from Task 1.
- Produces: `TaskType`, `Pipeline`, `PipelineDefinition` (placeholder shape here, schema in Task 7), and
  `insertTaskType(db, input: NewTaskType): TaskType`, `getTaskType(db, id): TaskType | null`, `listTaskTypes(db): TaskType[]`, `updateTaskType(db, id, patch: TaskTypePatch): TaskType`, `mergeTaskType(db, fromId, intoId): void`,
  `insertPipeline(db, input: NewPipeline): Pipeline`, `getPipeline(db, id): Pipeline | null`, `getActivePipeline(db, typeId): Pipeline | null`, `activatePipeline(db, id): Pipeline`, `listPipelines(db, typeId): Pipeline[]`.

- [ ] **Step 1: Write the failing tests**

`tests/repo/taskTypes.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTask, getTask } from "../../src/repo/tasks";
import {
  insertTaskType,
  getTaskType,
  listTaskTypes,
  updateTaskType,
  mergeTaskType,
} from "../../src/repo/taskTypes";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("insertTaskType stores a proposed type", () => {
  const db = freshDb();
  const type = insertTaskType(db, {
    name: "Email query",
    description: "A question arriving by email",
  });

  expect(type.status).toBe("proposed");
  expect(type.examples).toEqual([]);
  expect(getTaskType(db, type.id)).toEqual(type);
  expect(listTaskTypes(db)).toHaveLength(1);
});

test("updateTaskType renames, edits description, appends examples and activates", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email", description: "email" });

  const updated = updateTaskType(db, type.id, {
    name: "Customer email",
    description: "Question from an external customer",
    examples: ["Where is my order?"],
    status: "active",
  });

  expect(updated.name).toBe("Customer email");
  expect(updated.examples).toEqual(["Where is my order?"]);
  expect(updated.status).toBe("active");
});

test("mergeTaskType repoints tasks and deletes the merged type", () => {
  const db = freshDb();
  const keep = insertTaskType(db, { name: "Email query", description: "d1" });
  const dupe = insertTaskType(db, { name: "Mail question", description: "d2" });
  const task = insertTask(db, {
    sourceId: "outlook",
    externalId: "m1",
    title: "t",
    body: "b",
  });
  updateTaskType(db, dupe.id, { status: "active" });
  const moved = insertTask(db, {
    sourceId: "outlook",
    externalId: "m2",
    title: "t2",
    body: "b2",
  });
  db.query("UPDATE tasks SET type_id = ? WHERE id = ?").run(dupe.id, moved.id);

  mergeTaskType(db, dupe.id, keep.id);

  expect(getTaskType(db, dupe.id)).toBeNull();
  expect(getTask(db, moved.id)?.typeId).toBe(keep.id);
  expect(getTask(db, task.id)?.typeId).toBeNull();
});
```

`tests/repo/pipelines.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTaskType } from "../../src/repo/taskTypes";
import {
  insertPipeline,
  getPipeline,
  getActivePipeline,
  activatePipeline,
  listPipelines,
} from "../../src/repo/pipelines";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const definition = { steps: [{ id: "s1", type: "assign", to: "human" }] };

test("insertPipeline starts as a draft at version 1", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email query", description: "d" });

  const pipeline = insertPipeline(db, { typeId: type.id, definition });

  expect(pipeline.version).toBe(1);
  expect(pipeline.status).toBe("draft");
  expect(getActivePipeline(db, type.id)).toBeNull();
  expect(getPipeline(db, pipeline.id)?.definition).toEqual(definition);
});

test("activatePipeline makes it current and demotes the previous one", () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Email query", description: "d" });
  const v1 = activatePipeline(db, insertPipeline(db, { typeId: type.id, definition }).id);
  const v2 = insertPipeline(db, { typeId: type.id, definition });

  expect(v2.version).toBe(2);
  expect(getActivePipeline(db, type.id)?.id).toBe(v1.id);

  activatePipeline(db, v2.id);

  expect(getActivePipeline(db, type.id)?.id).toBe(v2.id);
  expect(getPipeline(db, v1.id)?.status).toBe("superseded");
  expect(listPipelines(db, type.id)).toHaveLength(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/repo/taskTypes.test.ts tests/repo/pipelines.test.ts`
Expected: FAIL — cannot resolve `../../src/repo/taskTypes`.

- [ ] **Step 3: Write the implementation**

The `task_types` and `pipelines` tables already exist — Task 1 created every table.

`src/domain/taskType.ts`:

```typescript
export type TaskTypeStatus = "proposed" | "active";

export interface TaskType {
  id: string;
  name: string;
  description: string;
  examples: string[];
  status: TaskTypeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewTaskType {
  name: string;
  description: string;
  examples?: string[];
}

export interface TaskTypePatch {
  name?: string;
  description?: string;
  examples?: string[];
  status?: TaskTypeStatus;
}
```

`src/domain/pipeline.ts` (definition typing arrives in Task 7; keep it loose here):

```typescript
export type PipelineStatus = "draft" | "active" | "superseded";

export interface Pipeline {
  id: string;
  typeId: string;
  version: number;
  status: PipelineStatus;
  definition: unknown;
  createdAt: string;
}

export interface NewPipeline {
  typeId: string;
  definition: unknown;
}
```

`src/repo/taskTypes.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { NewTaskType, TaskType, TaskTypePatch } from "../domain/taskType";

interface Row {
  id: string;
  name: string;
  description: string;
  examples: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toType(row: Row): TaskType {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    examples: JSON.parse(row.examples) as string[],
    status: row.status as TaskType["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertTaskType(db: Database, input: NewTaskType): TaskType {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO task_types (id, name, description, examples, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'proposed', ?, ?)`,
  ).run(id, input.name, input.description, JSON.stringify(input.examples ?? []), now, now);
  const type = getTaskType(db, id);
  if (!type) throw new Error(`insertTaskType: type ${id} vanished`);
  return type;
}

export function getTaskType(db: Database, id: string): TaskType | null {
  const row = db.query("SELECT * FROM task_types WHERE id = ?").get(id) as Row | null;
  return row ? toType(row) : null;
}

export function listTaskTypes(db: Database): TaskType[] {
  const rows = db.query("SELECT * FROM task_types ORDER BY name").all() as Row[];
  return rows.map(toType);
}

export function updateTaskType(
  db: Database,
  id: string,
  patch: TaskTypePatch,
): TaskType {
  const current = getTaskType(db, id);
  if (!current) throw new Error(`updateTaskType: unknown type ${id}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.query(
    `UPDATE task_types SET name = ?, description = ?, examples = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(next.name, next.description, JSON.stringify(next.examples), next.status, next.updatedAt, id);
  return next;
}

export function mergeTaskType(db: Database, fromId: string, intoId: string): void {
  if (fromId === intoId) throw new Error("mergeTaskType: cannot merge a type into itself");
  if (!getTaskType(db, intoId)) throw new Error(`mergeTaskType: unknown target ${intoId}`);
  db.transaction(() => {
    db.query("UPDATE tasks SET type_id = ? WHERE type_id = ?").run(intoId, fromId);
    db.query("DELETE FROM task_types WHERE id = ?").run(fromId);
  })();
}
```

`src/repo/pipelines.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { NewPipeline, Pipeline } from "../domain/pipeline";

interface Row {
  id: string;
  type_id: string;
  version: number;
  status: string;
  definition: string;
  created_at: string;
}

function toPipeline(row: Row): Pipeline {
  return {
    id: row.id,
    typeId: row.type_id,
    version: row.version,
    status: row.status as Pipeline["status"],
    definition: JSON.parse(row.definition) as unknown,
    createdAt: row.created_at,
  };
}

export function insertPipeline(db: Database, input: NewPipeline): Pipeline {
  const id = crypto.randomUUID();
  const row = db
    .query("SELECT COALESCE(MAX(version), 0) AS v FROM pipelines WHERE type_id = ?")
    .get(input.typeId) as { v: number };
  db.query(
    `INSERT INTO pipelines (id, type_id, version, status, definition, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(id, input.typeId, row.v + 1, JSON.stringify(input.definition), new Date().toISOString());
  const pipeline = getPipeline(db, id);
  if (!pipeline) throw new Error(`insertPipeline: pipeline ${id} vanished`);
  return pipeline;
}

export function getPipeline(db: Database, id: string): Pipeline | null {
  const row = db.query("SELECT * FROM pipelines WHERE id = ?").get(id) as Row | null;
  return row ? toPipeline(row) : null;
}

export function getActivePipeline(db: Database, typeId: string): Pipeline | null {
  const row = db
    .query("SELECT * FROM pipelines WHERE type_id = ? AND status = 'active'")
    .get(typeId) as Row | null;
  return row ? toPipeline(row) : null;
}

export function listPipelines(db: Database, typeId: string): Pipeline[] {
  const rows = db
    .query("SELECT * FROM pipelines WHERE type_id = ? ORDER BY version")
    .all(typeId) as Row[];
  return rows.map(toPipeline);
}

export function activatePipeline(db: Database, id: string): Pipeline {
  const pipeline = getPipeline(db, id);
  if (!pipeline) throw new Error(`activatePipeline: unknown pipeline ${id}`);
  db.transaction(() => {
    db.query(
      "UPDATE pipelines SET status = 'superseded' WHERE type_id = ? AND status = 'active'",
    ).run(pipeline.typeId);
    db.query("UPDATE pipelines SET status = 'active' WHERE id = ?").run(id);
  })();
  return { ...pipeline, status: "active" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/repo/`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add task type and pipeline repositories"
```

---

### Task 3: AI provider abstraction (Claude + OpenAI)

**Files:**
- Create: `src/ai/provider.ts`, `src/ai/anthropic.ts`, `src/ai/openai.ts`, `src/ai/index.ts`, `src/config.ts`
- Test: `tests/ai/provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AiMessage` — a union so a tool loop can replay turns:
    `{ role: "user"; content: string }` | `{ role: "assistant"; content: string; raw?: unknown }` | `{ role: "tool_results"; results: AiToolResult[] }`
  - `ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }`
  - `AiToolCall = { id: string; name: string; input: Record<string, unknown> }`
  - `CompleteRequest = { system?: string; messages: AiMessage[]; tools?: ToolSpec[]; maxTokens?: number }`
  - `AiToolResult = { callId: string; content: string; isError?: boolean }`
  - `AiResult = { text: string; toolCalls: AiToolCall[]; raw?: unknown }` — `raw` carries the provider's native assistant content so it can be echoed back verbatim on the next turn (Anthropic requires the original `tool_use` blocks). Each adapter round-trips only its own `raw` and never inspects another's.
  - `interface AiProvider { readonly id: string; complete(req: CompleteRequest): Promise<AiResult> }`
  - `completeJson<T>(provider: AiProvider, req: CompleteRequest, schema: ZodType<T>): Promise<T>`
  - `createProvider(config: Config): AiProvider`, `loadConfig(env: Record<string, string | undefined>): Config`

- [ ] **Step 1: Write the failing test**

`tests/ai/provider.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { z } from "zod";
import { completeJson, type AiProvider, type AiResult } from "../../src/ai/provider";

function stubProvider(replies: string[]): AiProvider & { calls: number } {
  let i = 0;
  return {
    id: "stub",
    calls: 0,
    async complete(): Promise<AiResult> {
      this.calls += 1;
      const text = replies[i++] ?? "";
      return { text, toolCalls: [] };
    },
  };
}

const schema = z.object({ verdict: z.string() });

test("completeJson parses a fenced JSON reply", async () => {
  const provider = stubProvider(['```json\n{"verdict":"human"}\n```']);

  const result = await completeJson(provider, { messages: [{ role: "user", content: "x" }] }, schema);

  expect(result).toEqual({ verdict: "human" });
  expect(provider.calls).toBe(1);
});

test("completeJson retries once when the reply does not match the schema", async () => {
  const provider = stubProvider(['{"wrong":1}', '{"verdict":"ai"}']);

  const result = await completeJson(provider, { messages: [{ role: "user", content: "x" }] }, schema);

  expect(result).toEqual({ verdict: "ai" });
  expect(provider.calls).toBe(2);
});

test("completeJson throws after the retry fails", async () => {
  const provider = stubProvider(["nope", "still nope"]);

  await expect(
    completeJson(provider, { messages: [{ role: "user", content: "x" }] }, schema),
  ).rejects.toThrow(/valid JSON/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/ai/provider.test.ts`
Expected: FAIL — cannot resolve `../../src/ai/provider`.

- [ ] **Step 3: Write the implementation**

`src/ai/provider.ts`:

```typescript
import type { ZodType } from "zod";

export type AiMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; raw?: unknown }
  | { role: "tool_results"; results: AiToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export interface CompleteRequest {
  system?: string;
  messages: AiMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export interface AiResult {
  text: string;
  toolCalls: AiToolCall[];
  /** Provider-native assistant content, echoed back verbatim on the next turn. */
  raw?: unknown;
}

export interface AiProvider {
  readonly id: string;
  complete(req: CompleteRequest): Promise<AiResult>;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error("no JSON found");
  return JSON.parse(candidate.slice(start));
}

export async function completeJson<T>(
  provider: AiProvider,
  req: CompleteRequest,
  schema: ZodType<T>,
): Promise<T> {
  const system = [req.system, "Reply with JSON only. No prose, no explanation."]
    .filter(Boolean)
    .join("\n\n");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages =
      attempt === 0
        ? req.messages
        : [
            ...req.messages,
            {
              role: "user" as const,
              content: `Your previous reply was not valid JSON for the required schema: ${lastError}. Reply with JSON only.`,
            },
          ];
    const result = await provider.complete({ ...req, system, messages });
    try {
      return schema.parse(extractJson(result.text));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Model did not return valid JSON after a retry: ${lastError}`);
}
```

`src/ai/anthropic.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider, AiResult, CompleteRequest } from "./provider";

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
}

export function createAnthropicProvider(options: AnthropicOptions = {}): AiProvider {
  const client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
  const model = options.model ?? "claude-opus-5";

  return {
    id: "anthropic",
    async complete(req: CompleteRequest): Promise<AiResult> {
      const messages: Anthropic.MessageParam[] = req.messages.map((m) => {
        if (m.role === "tool_results") {
          return {
            role: "user" as const,
            content: m.results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.callId,
              content: r.content,
              is_error: r.isError ?? false,
            })),
          };
        }
        if (m.role === "assistant" && m.raw) {
          return { role: "assistant" as const, content: m.raw as Anthropic.ContentBlockParam[] };
        }
        return { role: m.role, content: m.content };
      });

      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 16000,
        ...(req.system ? { system: req.system } : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
        messages,
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        }));

      return { text, toolCalls, raw: response.content };
    },
  };
}
```

`src/ai/openai.ts`:

```typescript
import OpenAI from "openai";
import type { AiProvider, AiResult, CompleteRequest } from "./provider";

export interface OpenAiOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function createOpenAiProvider(options: OpenAiOptions = {}): AiProvider {
  const client = new OpenAI({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
  const model = options.model ?? "gpt-4.1";

  return {
    id: "openai",
    async complete(req: CompleteRequest): Promise<AiResult> {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const m of req.messages) {
        if (m.role === "tool_results") {
          for (const r of m.results) {
            messages.push({ role: "tool", tool_call_id: r.callId, content: r.content });
          }
        } else if (m.role === "assistant" && m.raw) {
          messages.push(m.raw as OpenAI.Chat.ChatCompletionAssistantMessageParam);
        } else {
          messages.push({ role: m.role, content: m.content });
        }
      }

      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens ?? 16000,
        messages,
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                },
              })),
            }
          : {}),
      });

      const choice = response.choices[0];
      const toolCalls = (choice?.message.tool_calls ?? []).flatMap((call) =>
        call.type === "function"
          ? [
              {
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments || "{}") as Record<string, unknown>,
              },
            ]
          : [],
      );

      return { text: choice?.message.content ?? "", toolCalls, raw: choice?.message };
    },
  };
}
```

`src/config.ts`:

```typescript
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
}

export interface Config {
  dbPath: string;
  port: number;
  pollIntervalMs: number;
  ai: {
    provider: "anthropic" | "openai";
    apiKey?: string;
    model?: string;
  };
  outlook: {
    clientId?: string;
    tenant: string;
  };
  mcpServers: McpServerConfig[];
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const provider = env.JIDOKA_AI_PROVIDER === "openai" ? "openai" : "anthropic";
  return {
    dbPath: env.JIDOKA_DB ?? "./jidoka.db",
    port: Number(env.JIDOKA_PORT ?? 3000),
    pollIntervalMs: Number(env.JIDOKA_POLL_INTERVAL_MS ?? 60_000),
    ai: {
      provider,
      apiKey: provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY,
      model: env.JIDOKA_AI_MODEL,
    },
    outlook: {
      clientId: env.JIDOKA_OUTLOOK_CLIENT_ID,
      tenant: env.JIDOKA_OUTLOOK_TENANT ?? "common",
    },
    mcpServers: env.JIDOKA_MCP_SERVERS
      ? (JSON.parse(env.JIDOKA_MCP_SERVERS) as McpServerConfig[])
      : [],
  };
}
```

`src/ai/index.ts`:

```typescript
import type { Config } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import type { AiProvider } from "./provider";

export function createProvider(config: Config): AiProvider {
  return config.ai.provider === "openai"
    ? createOpenAiProvider({ apiKey: config.ai.apiKey, model: config.ai.model })
    : createAnthropicProvider({ apiKey: config.ai.apiKey, model: config.ai.model });
}

export type { AiProvider };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/ai/provider.test.ts`
Expected: PASS (3 tests). `bun run typecheck` must also pass — the adapters are typechecked here even though they aren't unit-tested (they're thin wire mappings; they get exercised manually in Task 12).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add provider-agnostic AI abstraction with Claude and OpenAI adapters"
```

---

### Task 4: AI triage

**Files:**
- Create: `src/triage/prompt.ts`, `src/triage/triage.ts`
- Test: `tests/triage/triage.test.ts`

**Interfaces:**
- Consumes: `AiProvider`, `completeJson` (Task 3); `TaskType` (Task 2); `Task` (Task 1).
- Produces:
  - `TriageOutcome = { kind: "matched"; typeId: string } | { kind: "ambiguous"; candidateTypeIds: string[] } | { kind: "new_type"; proposal: { name: string; description: string; rationale: string } }`
  - `triageTask(provider: AiProvider, task: Task, types: TaskType[]): Promise<TriageOutcome>`
  - Constants `MIN_CONFIDENCE = 0.6`, `AMBIGUITY_MARGIN = 0.15`.

Triage rules, implemented exactly:
1. No existing types → `new_type`.
2. Model returns a confidence per existing type plus an optional new-type proposal.
3. Top confidence ≥ `MIN_CONFIDENCE` and beats the runner-up by more than `AMBIGUITY_MARGIN` → `matched`.
4. Top confidence ≥ `MIN_CONFIDENCE` but the margin is too small → `ambiguous` with both candidates.
5. Top confidence < `MIN_CONFIDENCE` and a proposal exists → `new_type`; if no proposal, `ambiguous` with the top two (the user decides).

- [ ] **Step 1: Write the failing test**

`tests/triage/triage.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { triageTask } from "../../src/triage/triage";
import type { AiProvider } from "../../src/ai/provider";
import type { Task } from "../../src/domain/task";
import type { TaskType } from "../../src/domain/taskType";

function stub(reply: unknown): AiProvider {
  return {
    id: "stub",
    async complete() {
      return { text: JSON.stringify(reply), toolCalls: [] };
    },
  };
}

const task: Task = {
  id: "t1",
  sourceId: "outlook",
  externalId: "m1",
  url: null,
  title: "Where is my order?",
  body: "I ordered last week and it has not arrived.",
  metadata: {},
  typeId: null,
  typeCandidates: null,
  state: "ingested",
  assignee: null,
  context: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function type(id: string, name: string): TaskType {
  return {
    id,
    name,
    description: `${name} description`,
    examples: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("no existing types means a new type proposal", async () => {
  const provider = stub({
    scores: [],
    proposal: { name: "Customer email", description: "External question", rationale: "first task" },
  });

  const outcome = await triageTask(provider, task, []);

  expect(outcome).toEqual({
    kind: "new_type",
    proposal: { name: "Customer email", description: "External question", rationale: "first task" },
  });
});

test("a confident, clear winner matches that type", async () => {
  const provider = stub({
    scores: [
      { typeId: "a", confidence: 0.92 },
      { typeId: "b", confidence: 0.2 },
    ],
    proposal: null,
  });

  const outcome = await triageTask(provider, task, [type("a", "Customer email"), type("b", "Recon")]);

  expect(outcome).toEqual({ kind: "matched", typeId: "a" });
});

test("two close candidates are ambiguous and go to the user", async () => {
  const provider = stub({
    scores: [
      { typeId: "a", confidence: 0.7 },
      { typeId: "b", confidence: 0.62 },
    ],
    proposal: null,
  });

  const outcome = await triageTask(provider, task, [type("a", "Customer email"), type("b", "Recon")]);

  expect(outcome).toEqual({ kind: "ambiguous", candidateTypeIds: ["a", "b"] });
});

test("low confidence with a proposal yields a new type", async () => {
  const provider = stub({
    scores: [{ typeId: "a", confidence: 0.3 }],
    proposal: { name: "Reconciliation", description: "Ledger check", rationale: "no fit" },
  });

  const outcome = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(outcome.kind).toBe("new_type");
});

test("unknown type ids from the model are ignored", async () => {
  const provider = stub({
    scores: [
      { typeId: "ghost", confidence: 0.99 },
      { typeId: "a", confidence: 0.81 },
    ],
    proposal: null,
  });

  const outcome = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(outcome).toEqual({ kind: "matched", typeId: "a" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/triage/triage.test.ts`
Expected: FAIL — cannot resolve `../../src/triage/triage`.

- [ ] **Step 3: Write the implementation**

`src/triage/prompt.ts`:

```typescript
import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";

export const TRIAGE_SYSTEM = `You triage incoming work items for a task management system.

You are given a task and the list of known task types. Score how well each existing
type fits the task, from 0 to 1. Prefer an existing type: only propose a new type when
no existing type plausibly fits, and never propose a type that restates an existing one
in different words.

Reply with JSON of this shape:
{
  "scores": [{ "typeId": "<id>", "confidence": <0..1> }],
  "proposal": { "name": "<short name>", "description": "<one sentence>", "rationale": "<why no existing type fits>" } | null
}`;

export function triageUserMessage(task: Task, types: TaskType[]): string {
  const known = types.length
    ? types
        .map(
          (t) =>
            `- id: ${t.id}\n  name: ${t.name}\n  description: ${t.description}` +
            (t.examples.length ? `\n  examples: ${t.examples.join(" | ")}` : ""),
        )
        .join("\n")
    : "(none yet)";

  return `Known task types:\n${known}\n\nTask:\nsource: ${task.sourceId}\ntitle: ${task.title}\nbody:\n${task.body}`;
}
```

`src/triage/triage.ts`:

```typescript
import { z } from "zod";
import { completeJson, type AiProvider } from "../ai/provider";
import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";
import { TRIAGE_SYSTEM, triageUserMessage } from "./prompt";

export const MIN_CONFIDENCE = 0.6;
export const AMBIGUITY_MARGIN = 0.15;

export interface TypeProposal {
  name: string;
  description: string;
  rationale: string;
}

export type TriageOutcome =
  | { kind: "matched"; typeId: string }
  | { kind: "ambiguous"; candidateTypeIds: string[] }
  | { kind: "new_type"; proposal: TypeProposal };

const responseSchema = z.object({
  scores: z.array(z.object({ typeId: z.string(), confidence: z.number().min(0).max(1) })),
  proposal: z
    .object({ name: z.string(), description: z.string(), rationale: z.string() })
    .nullable()
    .optional(),
});

export async function triageTask(
  provider: AiProvider,
  task: Task,
  types: TaskType[],
): Promise<TriageOutcome> {
  const response = await completeJson(
    provider,
    {
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content: triageUserMessage(task, types) }],
      maxTokens: 2000,
    },
    responseSchema,
  );

  const known = new Set(types.map((t) => t.id));
  const scores = response.scores
    .filter((s) => known.has(s.typeId))
    .sort((a, b) => b.confidence - a.confidence);

  const proposal = response.proposal ?? null;
  const top = scores[0];
  const runnerUp = scores[1];

  if (!top) {
    if (proposal) return { kind: "new_type", proposal };
    throw new Error("triage returned no usable type scores and no proposal");
  }

  if (top.confidence >= MIN_CONFIDENCE) {
    if (runnerUp && top.confidence - runnerUp.confidence <= AMBIGUITY_MARGIN) {
      return { kind: "ambiguous", candidateTypeIds: [top.typeId, runnerUp.typeId] };
    }
    return { kind: "matched", typeId: top.typeId };
  }

  if (proposal) return { kind: "new_type", proposal };
  return {
    kind: "ambiguous",
    candidateTypeIds: runnerUp ? [top.typeId, runnerUp.typeId] : [top.typeId],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/triage/triage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add AI triage with type discovery and ambiguity detection"
```

---

### Task 5: Task source interface and poller

**Files:**
- Create: `src/sources/types.ts`, `src/sources/poller.ts`, `src/repo/sourceState.ts`
- Test: `tests/sources/poller.test.ts`

**Interfaces:**
- Consumes: `insertTask`, `findTaskBySource` (Task 1).
- Produces:
  - `RawItem = { externalId: string; title: string; body: string; url?: string; metadata?: Record<string, unknown> }`
  - `interface TaskSource { readonly id: string; poll(cursor: string | null): Promise<{ items: RawItem[]; cursor: string | null }> }`
  - `getCursor(db, sourceId): string | null`, `setCursor(db, sourceId, cursor: string | null): void`
  - `pollOnce(db, source: TaskSource, onTask: (task: Task) => Promise<void>): Promise<Task[]>`
  - `startPoller(db, sources: TaskSource[], onTask, intervalMs): { stop(): void }`

- [ ] **Step 1: Write the failing test**

`tests/sources/poller.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { pollOnce } from "../../src/sources/poller";
import { getCursor } from "../../src/repo/sourceState";
import type { TaskSource, RawItem } from "../../src/sources/types";
import type { Task } from "../../src/domain/task";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function fakeSource(pages: { items: RawItem[]; cursor: string | null }[]): TaskSource & {
  seen: (string | null)[];
} {
  let call = 0;
  return {
    id: "fake",
    seen: [],
    async poll(cursor: string | null) {
      this.seen.push(cursor);
      return pages[call++] ?? { items: [], cursor };
    },
  };
}

test("pollOnce ingests items, stores the cursor and calls back per task", async () => {
  const db = freshDb();
  const source = fakeSource([
    {
      items: [
        { externalId: "m1", title: "One", body: "first" },
        { externalId: "m2", title: "Two", body: "second" },
      ],
      cursor: "2026-01-01T10:00:00Z",
    },
  ]);
  const seen: Task[] = [];

  const created = await pollOnce(db, source, async (task) => {
    seen.push(task);
  });

  expect(created).toHaveLength(2);
  expect(seen.map((t) => t.title)).toEqual(["One", "Two"]);
  expect(getCursor(db, "fake")).toBe("2026-01-01T10:00:00Z");
  expect(source.seen).toEqual([null]);
});

test("pollOnce skips items already ingested and resumes from the stored cursor", async () => {
  const db = freshDb();
  const source = fakeSource([
    { items: [{ externalId: "m1", title: "One", body: "first" }], cursor: "c1" },
    {
      items: [
        { externalId: "m1", title: "One", body: "first" },
        { externalId: "m2", title: "Two", body: "second" },
      ],
      cursor: "c2",
    },
  ]);

  await pollOnce(db, source, async () => {});
  const second = await pollOnce(db, source, async () => {});

  expect(second).toHaveLength(1);
  expect(second[0]?.externalId).toBe("m2");
  expect(source.seen).toEqual([null, "c1"]);
  expect(getCursor(db, "fake")).toBe("c2");
});

test("pollOnce keeps the old cursor when the source throws", async () => {
  const db = freshDb();
  const source: TaskSource = {
    id: "fake",
    async poll() {
      throw new Error("network down");
    },
  };

  await expect(pollOnce(db, source, async () => {})).rejects.toThrow("network down");
  expect(getCursor(db, "fake")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/sources/poller.test.ts`
Expected: FAIL — cannot resolve `../../src/sources/poller`.

- [ ] **Step 3: Write the implementation**

The `source_state` table already exists — Task 1 created every table.

`src/repo/sourceState.ts`:

```typescript
import type { Database } from "bun:sqlite";

export function getCursor(db: Database, sourceId: string): string | null {
  const row = db
    .query("SELECT cursor FROM source_state WHERE source_id = ?")
    .get(sourceId) as { cursor: string | null } | null;
  return row?.cursor ?? null;
}

export function setCursor(db: Database, sourceId: string, cursor: string | null): void {
  db.query(
    `INSERT INTO source_state (source_id, cursor) VALUES (?, ?)
     ON CONFLICT (source_id) DO UPDATE SET cursor = excluded.cursor`,
  ).run(sourceId, cursor);
}
```

`src/sources/types.ts`:

```typescript
export interface RawItem {
  externalId: string;
  title: string;
  body: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface PollResult {
  items: RawItem[];
  cursor: string | null;
}

export interface TaskSource {
  readonly id: string;
  poll(cursor: string | null): Promise<PollResult>;
}
```

`src/sources/poller.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { Task } from "../domain/task";
import { findTaskBySource, insertTask } from "../repo/tasks";
import { getCursor, setCursor } from "../repo/sourceState";
import type { TaskSource } from "./types";

export type OnTask = (task: Task) => Promise<void>;

export async function pollOnce(
  db: Database,
  source: TaskSource,
  onTask: OnTask,
): Promise<Task[]> {
  const cursor = getCursor(db, source.id);
  const result = await source.poll(cursor);

  const created: Task[] = [];
  for (const item of result.items) {
    if (findTaskBySource(db, source.id, item.externalId)) continue;
    created.push(
      insertTask(db, {
        sourceId: source.id,
        externalId: item.externalId,
        url: item.url ?? null,
        title: item.title,
        body: item.body,
        metadata: item.metadata ?? {},
      }),
    );
  }

  setCursor(db, source.id, result.cursor);

  for (const task of created) await onTask(task);
  return created;
}

export function startPoller(
  db: Database,
  sources: TaskSource[],
  onTask: OnTask,
  intervalMs: number,
): { stop(): void } {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    for (const source of sources) {
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/sources/poller.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add task source interface and polling loop with cursors"
```

---

### Task 6: Outlook source (device-code auth + Graph polling)

**Files:**
- Create: `src/sources/outlook/auth.ts`, `src/sources/outlook/source.ts`
- Test: `tests/sources/outlook.test.ts`

**Interfaces:**
- Consumes: `TaskSource`, `RawItem`, `PollResult` (Task 5); `Database` (Task 1).
- Produces:
  - `startDeviceLogin(deps, scopes: string[]): Promise<DeviceLogin>` where `DeviceLogin = { userCode: string; verificationUri: string; deviceCode: string; expiresIn: number; interval: number }`
  - `completeDeviceLogin(deps, deviceCode: string): Promise<TokenSet>` (one poll attempt; throws `AuthPendingError` while the user hasn't finished)
  - `getAccessToken(deps): Promise<string>` (refreshes when expired)
  - `createOutlookSource(deps): TaskSource`
  - `OutlookDeps = { db: Database; clientId: string; tenant: string; fetch?: typeof fetch; now?: () => number }`

- [ ] **Step 1: Write the failing test**

`tests/sources/outlook.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { getAccessToken, saveTokens } from "../../src/sources/outlook/auth";
import { createOutlookSource } from "../../src/sources/outlook/source";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("getAccessToken returns a stored token that has not expired", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 2_000_000 });

  const token = await getAccessToken({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async () => {
      throw new Error("should not refresh");
    },
  });

  expect(token).toBe("at-1");
});

test("getAccessToken refreshes an expired token and stores the new one", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000 });
  const calls: string[] = [];

  const token = await getAccessToken({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async (input, init) => {
      calls.push(String(input));
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
    },
  });

  expect(token).toBe("at-2");
  expect(calls[0]).toContain("/common/oauth2/v2.0/token");

  const again = await getAccessToken({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_001,
    fetch: async () => {
      throw new Error("should not refresh twice");
    },
  });
  expect(again).toBe("at-2");
});

test("the Outlook source maps Graph messages to raw items and advances the cursor", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 9_000_000 });
  let requestedUrl = "";

  const source = createOutlookSource({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        value: [
          {
            id: "AAM=1",
            subject: "Where is my order?",
            body: { content: "<p>It has not arrived</p>", contentType: "html" },
            bodyPreview: "It has not arrived",
            from: { emailAddress: { address: "customer@example.com", name: "A Customer" } },
            receivedDateTime: "2026-01-02T09:30:00Z",
            webLink: "https://outlook.office.com/mail/id/AAM%3D1",
            conversationId: "conv-1",
          },
        ],
      });
    },
  });

  const result = await source.poll("2026-01-01T00:00:00Z");

  expect(source.id).toBe("outlook");
  expect(requestedUrl).toContain("receivedDateTime%20gt%202026-01-01T00%3A00%3A00Z");
  expect(result.items).toEqual([
    {
      externalId: "AAM=1",
      title: "Where is my order?",
      body: "It has not arrived",
      url: "https://outlook.office.com/mail/id/AAM%3D1",
      metadata: {
        from: "customer@example.com",
        fromName: "A Customer",
        receivedAt: "2026-01-02T09:30:00Z",
        conversationId: "conv-1",
      },
    },
  ]);
  expect(result.cursor).toBe("2026-01-02T09:30:00Z");
});

test("an empty Graph page keeps the previous cursor", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 9_000_000 });

  const source = createOutlookSource({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async () => jsonResponse({ value: [] }),
  });

  const result = await source.poll("2026-01-01T00:00:00Z");

  expect(result.items).toEqual([]);
  expect(result.cursor).toBe("2026-01-01T00:00:00Z");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/sources/outlook.test.ts`
Expected: FAIL — cannot resolve `../../src/sources/outlook/auth`.

- [ ] **Step 3: Write the implementation**

The `oauth_tokens` table already exists — Task 1 created every table.

`src/sources/outlook/auth.ts`:

```typescript
import type { Database } from "bun:sqlite";

export const OUTLOOK_SCOPES = ["offline_access", "Mail.Read"];
const PROVIDER = "outlook";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface OutlookDeps {
  db: Database;
  clientId: string;
  tenant: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

export class AuthPendingError extends Error {
  constructor() {
    super("device login is still pending");
  }
}

function http(deps: OutlookDeps): typeof fetch {
  return deps.fetch ?? fetch;
}

function clock(deps: OutlookDeps): () => number {
  return deps.now ?? Date.now;
}

function tokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function saveTokens(db: Database, tokens: TokenSet): void {
  db.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at`,
  ).run(PROVIDER, tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
}

export function loadTokens(db: Database): TokenSet | null {
  const row = db
    .query("SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?")
    .get(PROVIDER) as
    | { access_token: string; refresh_token: string; expires_at: number }
    | null;
  return row
    ? {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function startDeviceLogin(deps: OutlookDeps): Promise<DeviceLogin> {
  const response = await http(deps)(
    `https://login.microsoftonline.com/${deps.tenant}/oauth2/v2.0/devicecode`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: deps.clientId,
        scope: OUTLOOK_SCOPES.join(" "),
      }).toString(),
    },
  );
  if (!response.ok) throw new Error(`device code request failed: ${response.status}`);
  const body = (await response.json()) as {
    user_code: string;
    device_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  return {
    userCode: body.user_code,
    deviceCode: body.device_code,
    verificationUri: body.verification_uri,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

export async function completeDeviceLogin(
  deps: OutlookDeps,
  deviceCode: string,
): Promise<TokenSet> {
  const response = await http(deps)(tokenUrl(deps.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: deps.clientId,
      device_code: deviceCode,
    }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    if (body.error === "authorization_pending") throw new AuthPendingError();
    throw new Error(`device login failed: ${String(body.error_description ?? body.error)}`);
  }
  const tokens: TokenSet = {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token),
    expiresAt: clock(deps)() + Number(body.expires_in) * 1000,
  };
  saveTokens(deps.db, tokens);
  return tokens;
}

export async function getAccessToken(deps: OutlookDeps): Promise<string> {
  const tokens = loadTokens(deps.db);
  if (!tokens) throw new Error("Outlook is not connected — run the device login first");

  const now = clock(deps)();
  if (tokens.expiresAt - 60_000 > now) return tokens.accessToken;

  const response = await http(deps)(tokenUrl(deps.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: deps.clientId,
      refresh_token: tokens.refreshToken,
      scope: OUTLOOK_SCOPES.join(" "),
    }).toString(),
  });
  if (!response.ok) throw new Error(`token refresh failed: ${response.status}`);
  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const refreshed: TokenSet = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? tokens.refreshToken,
    expiresAt: now + body.expires_in * 1000,
  };
  saveTokens(deps.db, refreshed);
  return refreshed.accessToken;
}
```

`src/sources/outlook/source.ts`:

```typescript
import type { PollResult, RawItem, TaskSource } from "../types";
import { getAccessToken, type OutlookDeps } from "./auth";

interface GraphMessage {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  body?: { content: string; contentType: string } | null;
  from?: { emailAddress?: { address?: string; name?: string } } | null;
  receivedDateTime: string;
  webLink?: string | null;
  conversationId?: string | null;
}

const PAGE_SIZE = 25;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toRawItem(message: GraphMessage): RawItem {
  const html = message.body?.contentType?.toLowerCase() === "html";
  const body = message.body?.content
    ? html
      ? stripHtml(message.body.content)
      : message.body.content.trim()
    : (message.bodyPreview ?? "");

  return {
    externalId: message.id,
    title: message.subject ?? "(no subject)",
    body,
    url: message.webLink ?? undefined,
    metadata: {
      from: message.from?.emailAddress?.address ?? null,
      fromName: message.from?.emailAddress?.name ?? null,
      receivedAt: message.receivedDateTime,
      conversationId: message.conversationId ?? null,
    },
  };
}

export function createOutlookSource(deps: OutlookDeps): TaskSource {
  const http = deps.fetch ?? fetch;

  return {
    id: "outlook",
    async poll(cursor: string | null): Promise<PollResult> {
      const token = await getAccessToken(deps);

      const params = new URLSearchParams({
        $orderby: "receivedDateTime asc",
        $top: String(PAGE_SIZE),
        $select: "id,subject,bodyPreview,body,from,receivedDateTime,webLink,conversationId",
      });
      if (cursor) params.set("$filter", `receivedDateTime gt ${cursor}`);

      const response = await http(
        `https://graph.microsoft.com/v1.0/me/messages?${params.toString()}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw new Error(`Graph request failed: ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as { value: GraphMessage[] };
      const items = body.value.map(toRawItem);
      const last = body.value.at(-1);

      return { items, cursor: last?.receivedDateTime ?? cursor };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/sources/outlook.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add Outlook task source with device-code auth and Graph polling"
```

---

### Task 7: Pipeline definition schema, templating, and executor

**Files:**
- Create: `src/mcp/names.ts`, `src/pipeline/template.ts`, `src/pipeline/executor.ts`
- Modify: `src/domain/pipeline.ts` (add the Zod schema and step types)
- Test: `tests/pipeline/template.test.ts`, `tests/pipeline/executor.test.ts`

**Interfaces:**
- Consumes: `AiProvider` (Task 3), `Task` (Task 1), `Pipeline` repo functions (Task 2).
- Produces:
  - `PipelineDefinitionSchema` (Zod) and `PipelineDefinition`, `PipelineStep` types.
  - `renderTemplate(input: string, scope: TemplateScope): string` and `renderInput(value: unknown, scope): unknown`.
  - `runPipeline(deps: ExecutorDeps, definition: PipelineDefinition, task: Task): Promise<RunResult>` where `RunResult = { context: Record<string, unknown>; assignee: Assignee | null; log: StepLogEntry[] }` and `ExecutorDeps = { provider: AiProvider; callTool: ToolCaller; loadPipeline: PipelineLoader; self?: { typeId: string; version: number } }`. `self` identifies the pipeline being run so a self-call is caught as a loop.
  - `type ToolCaller = (server: string, tool: string, input: Record<string, unknown>) => Promise<string>`
  - `type PipelineLoader = (typeId: string, version: number) => PipelineDefinition | null`

Step types (this is the format the builder agent in Task 9 must emit):

```
{ id, type: "ai",        prompt: string, output: string }
{ id, type: "agent",     prompt: string, tools: string[], maxIterations?: number, output: string }
{ id, type: "mcp_tool",  server: string, tool: string, input: object, output: string }
{ id, type: "branch",    on: string, cases: { [value: string]: Step[] }, default?: Step[] }
{ id, type: "assign",    to: "ai" | "human", note?: string }
{ id, type: "call_pipeline", typeId: string, version: number }
```

`call_pipeline` always pins an exact version (the spec's open question, decided here), and the executor refuses to nest more than 5 deep or to re-enter a pipeline already on the stack.

`agent` is the open-ended step: the model is handed the named MCP tools and loops (call tools → read results → decide again) until it stops calling tools or hits `maxIterations` (default 6). This is what "read the related mails, then summarize" needs — the model chooses how many lookups to make. `ai` is the same thing with no tools and exactly one turn. A tool that throws is fed back to the model once as an error result; a second failure of the same tool fails the step.

- [ ] **Step 1: Write the failing tests**

`tests/pipeline/template.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { renderTemplate, renderInput } from "../../src/pipeline/template";

const scope = {
  task: { title: "Where is my order?", body: "Not arrived", metadata: { from: "a@b.com" } },
  context: { summary: "Customer chasing delivery" },
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
```

`tests/pipeline/executor.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { runPipeline } from "../../src/pipeline/executor";
import { PipelineDefinitionSchema } from "../../src/domain/pipeline";
import type { AiProvider } from "../../src/ai/provider";
import type { Task } from "../../src/domain/task";

const task: Task = {
  id: "t1",
  sourceId: "outlook",
  externalId: "m1",
  url: null,
  title: "Where is my order?",
  body: "I ordered last week.",
  metadata: { from: "customer@example.com" },
  typeId: "type-1",
  typeCandidates: null,
  state: "processing",
  assignee: null,
  context: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function scriptedProvider(replies: string[]): AiProvider & { prompts: string[] } {
  let i = 0;
  return {
    id: "stub",
    prompts: [],
    async complete(req) {
      this.prompts.push(req.messages.at(-1)?.content ?? "");
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
}

const noTools = async () => {
  throw new Error("no MCP in this test");
};
const noPipelines = () => null;

test("an ai step stores its output in the context and can be templated into the next step", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Summarize: {{task.body}}", output: "summary" },
      { id: "s2", type: "ai", prompt: "Classify: {{context.summary}}", output: "category" },
      { id: "s3", type: "assign", to: "human" },
    ],
  });
  const provider = scriptedProvider(["Customer chasing delivery", "external"]);

  const result = await runPipeline(
    { provider, callTool: noTools, loadPipeline: noPipelines },
    definition,
    task,
  );

  expect(provider.prompts[0]).toBe("Summarize: I ordered last week.");
  expect(provider.prompts[1]).toBe("Classify: Customer chasing delivery");
  expect(result.context).toEqual({ summary: "Customer chasing delivery", category: "external" });
  expect(result.assignee).toBe("human");
  expect(result.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s3"]);
});

test("a branch step runs the matching case and falls back to default", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "ai", prompt: "Classify {{task.title}}", output: "category" },
      {
        id: "s2",
        type: "branch",
        on: "category",
        cases: {
          external: [{ id: "s2a", type: "assign", to: "human" }],
          internal: [{ id: "s2b", type: "assign", to: "ai" }],
        },
        default: [{ id: "s2c", type: "assign", to: "human" }],
      },
    ],
  });

  const external = await runPipeline(
    { provider: scriptedProvider(["external"]), callTool: noTools, loadPipeline: noPipelines },
    definition,
    task,
  );
  expect(external.assignee).toBe("human");
  expect(external.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s2a"]);

  const unknown = await runPipeline(
    { provider: scriptedProvider(["something else"]), callTool: noTools, loadPipeline: noPipelines },
    definition,
    task,
  );
  expect(unknown.log.map((e) => e.stepId)).toEqual(["s1", "s2", "s2c"]);
});

test("an mcp_tool step renders its input and stores the tool result", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "mcp_tool",
        server: "outlook",
        tool: "get_thread",
        input: { address: "{{task.metadata.from}}" },
        output: "thread",
      },
      { id: "s2", type: "assign", to: "ai" },
    ],
  });
  const calls: unknown[] = [];

  const result = await runPipeline(
    {
      provider: scriptedProvider([]),
      callTool: async (server, tool, input) => {
        calls.push({ server, tool, input });
        return "thread text";
      },
      loadPipeline: noPipelines,
    },
    definition,
    task,
  );

  expect(calls).toEqual([
    { server: "outlook", tool: "get_thread", input: { address: "customer@example.com" } },
  ]);
  expect(result.context.thread).toBe("thread text");
  expect(result.assignee).toBe("ai");
});

test("an agent step loops over tool calls until the model stops calling tools", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Gather context for {{task.title}}",
        tools: ["outlook__search_messages", "outlook__get_thread"],
        maxIterations: 4,
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  const turns = [
    {
      text: "",
      toolCalls: [
        { id: "c1", name: "outlook__search_messages", input: { from: "customer@example.com" } },
      ],
      raw: [{ type: "tool_use", id: "c1" }],
    },
    {
      text: "",
      toolCalls: [{ id: "c2", name: "outlook__get_thread", input: { id: "m9" } }],
      raw: [{ type: "tool_use", id: "c2" }],
    },
    { text: "Customer asked twice about order 42", toolCalls: [], raw: [] },
  ];
  let turn = 0;
  const seen: unknown[] = [];
  const provider = {
    id: "stub",
    async complete(req: { messages: unknown[]; tools?: { name: string }[] }) {
      seen.push({ messageCount: req.messages.length, tools: req.tools?.map((t) => t.name) });
      return turns[turn++]!;
    },
  };
  const toolCalls: string[] = [];

  const result = await runPipeline(
    {
      provider,
      callTool: async (server, tool) => {
        toolCalls.push(`${server}/${tool}`);
        return "tool output";
      },
      loadPipeline: noPipelines,
      listTools: () => [
        { name: "outlook__search_messages", description: "Search", inputSchema: { type: "object" } },
        { name: "outlook__get_thread", description: "Thread", inputSchema: { type: "object" } },
        { name: "orders__lookup", description: "Orders", inputSchema: { type: "object" } },
      ],
    },
    definition,
    task,
  );

  expect(toolCalls).toEqual(["outlook/search_messages", "outlook/get_thread"]);
  expect(result.context.brief).toBe("Customer asked twice about order 42");
  expect(seen[0]).toEqual({
    messageCount: 1,
    tools: ["outlook__search_messages", "outlook__get_thread"],
  });
  expect(seen[2]).toEqual({
    messageCount: 5,
    tools: ["outlook__search_messages", "outlook__get_thread"],
  });
  expect(result.assignee).toBe("human");
});

test("an agent step stops at maxIterations", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Keep going",
        tools: ["outlook__get_thread"],
        maxIterations: 2,
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });
  let calls = 0;

  await runPipeline(
    {
      provider: {
        id: "stub",
        async complete() {
          calls += 1;
          return {
            text: "still working",
            toolCalls: [{ id: `c${calls}`, name: "outlook__get_thread", input: {} }],
            raw: [],
          };
        },
      },
      callTool: async () => "output",
      loadPipeline: noPipelines,
      listTools: () => [
        { name: "outlook__get_thread", description: "Thread", inputSchema: { type: "object" } },
      ],
    },
    definition,
    task,
  );

  expect(calls).toBe(2);
});

test("an agent step fails when a tool fails twice", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      {
        id: "s1",
        type: "agent",
        prompt: "Try",
        tools: ["outlook__get_thread"],
        output: "brief",
      },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  await expect(
    runPipeline(
      {
        provider: {
          id: "stub",
          async complete() {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "outlook__get_thread", input: {} }],
              raw: [],
            };
          },
        },
        callTool: async () => {
          throw new Error("graph timeout");
        },
        loadPipeline: noPipelines,
        listTools: () => [
          { name: "outlook__get_thread", description: "Thread", inputSchema: { type: "object" } },
        ],
      },
      definition,
      task,
    ),
  ).rejects.toThrow(/failed twice: graph timeout/);
});

test("an agent step refuses tools that are not available", async () => {
  const definition = PipelineDefinitionSchema.parse({
    steps: [
      { id: "s1", type: "agent", prompt: "Go", tools: ["ghost__tool"], output: "brief" },
      { id: "s2", type: "assign", to: "human" },
    ],
  });

  await expect(
    runPipeline(
      {
        provider: scriptedProvider([]),
        callTool: noTools,
        loadPipeline: noPipelines,
        listTools: () => [],
      },
      definition,
      task,
    ),
  ).rejects.toThrow(/unavailable tools ghost__tool/);
});

test("call_pipeline runs the pinned version and merges its context", async () => {
  const child = PipelineDefinitionSchema.parse({
    steps: [{ id: "c1", type: "ai", prompt: "Summarize {{task.title}}", output: "summary" }],
  });
  const parent = PipelineDefinitionSchema.parse({
    steps: [
      { id: "p1", type: "call_pipeline", typeId: "type-2", version: 3 },
      { id: "p2", type: "assign", to: "human" },
    ],
  });
  const asked: string[] = [];

  const result = await runPipeline(
    {
      provider: scriptedProvider(["done"]),
      callTool: noTools,
      loadPipeline: (typeId, version) => {
        asked.push(`${typeId}@${version}`);
        return child;
      },
    },
    parent,
    task,
  );

  expect(asked).toEqual(["type-2@3"]);
  expect(result.context.summary).toBe("done");
});

test("a pipeline that calls itself fails instead of looping", async () => {
  const selfCalling = PipelineDefinitionSchema.parse({
    steps: [{ id: "p1", type: "call_pipeline", typeId: "type-1", version: 1 }],
  });

  await expect(
    runPipeline(
      {
        provider: scriptedProvider([]),
        callTool: noTools,
        loadPipeline: () => selfCalling,
        self: { typeId: "type-1", version: 1 },
      },
      selfCalling,
      task,
    ),
  ).rejects.toThrow(/loop/i);
});

test("the schema rejects an unknown step type", () => {
  expect(() =>
    PipelineDefinitionSchema.parse({ steps: [{ id: "x", type: "teleport" }] }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/pipeline/`
Expected: FAIL — cannot resolve `../../src/pipeline/template`.

- [ ] **Step 3: Write the implementation**

Replace the `definition` typing in `src/domain/pipeline.ts` with the schema (keep `Pipeline`, `NewPipeline`, `PipelineStatus` as they are, but change `Pipeline.definition` to `PipelineDefinition`):

```typescript
import { z } from "zod";

export type PipelineStatus = "draft" | "active" | "superseded";

const AiStep = z.object({
  id: z.string(),
  type: z.literal("ai"),
  prompt: z.string(),
  output: z.string(),
});

const AgentStep = z.object({
  id: z.string(),
  type: z.literal("agent"),
  prompt: z.string(),
  tools: z.array(z.string()).min(1),
  maxIterations: z.number().int().min(1).max(20).default(6),
  output: z.string(),
});

const McpToolStep = z.object({
  id: z.string(),
  type: z.literal("mcp_tool"),
  server: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.string(),
});

const AssignStep = z.object({
  id: z.string(),
  type: z.literal("assign"),
  to: z.enum(["ai", "human"]),
  note: z.string().optional(),
});

const CallPipelineStep = z.object({
  id: z.string(),
  type: z.literal("call_pipeline"),
  typeId: z.string(),
  version: z.number().int().positive(),
});

export type PipelineStep =
  | z.infer<typeof AiStep>
  | z.infer<typeof AgentStep>
  | z.infer<typeof McpToolStep>
  | z.infer<typeof AssignStep>
  | z.infer<typeof CallPipelineStep>
  | { id: string; type: "branch"; on: string; cases: Record<string, PipelineStep[]>; default?: PipelineStep[] };

export const PipelineStepSchema: z.ZodType<PipelineStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    AiStep,
    AgentStep,
    McpToolStep,
    AssignStep,
    CallPipelineStep,
    z.object({
      id: z.string(),
      type: z.literal("branch"),
      on: z.string(),
      cases: z.record(z.string(), z.array(PipelineStepSchema)),
      default: z.array(PipelineStepSchema).optional(),
    }),
  ]),
);

export const PipelineDefinitionSchema = z.object({
  steps: z.array(PipelineStepSchema).min(1),
});

export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

export interface Pipeline {
  id: string;
  typeId: string;
  version: number;
  status: PipelineStatus;
  definition: PipelineDefinition;
  createdAt: string;
}

export interface NewPipeline {
  typeId: string;
  definition: PipelineDefinition;
}
```

In `src/repo/pipelines.ts`, parse on read so stored rows are validated: replace `definition: JSON.parse(row.definition) as unknown` with

```typescript
    definition: PipelineDefinitionSchema.parse(JSON.parse(row.definition)),
```

and add the import `import { PipelineDefinitionSchema } from "../domain/pipeline";`.

`src/mcp/names.ts` (shared so the executor and builder don't depend on the MCP client):

```typescript
/** Tools are exposed to models as `<server>__<tool>`. */
export const TOOL_SEPARATOR = "__";

export function splitToolName(name: string): { server: string; tool: string } {
  const index = name.indexOf(TOOL_SEPARATOR);
  if (index === -1) throw new Error(`tool name is missing a server prefix: ${name}`);
  return {
    server: name.slice(0, index),
    tool: name.slice(index + TOOL_SEPARATOR.length),
  };
}
```

`src/pipeline/template.ts`:

```typescript
export interface TemplateScope {
  task: Record<string, unknown>;
  context: Record<string, unknown>;
}

function lookup(scope: TemplateScope, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = scope as unknown;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function renderTemplate(input: string, scope: TemplateScope): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookup(scope, path);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export function renderInput(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === "string") return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((item) => renderInput(item, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderInput(v, scope)]),
    );
  }
  return value;
}
```

`src/pipeline/executor.ts`:

```typescript
import type { AiMessage, AiProvider, AiToolResult, ToolSpec } from "../ai/provider";
import type { Assignee, Task } from "../domain/task";
import type { PipelineDefinition, PipelineStep } from "../domain/pipeline";
import { TOOL_SEPARATOR } from "../mcp/names";
import { renderInput, renderTemplate, type TemplateScope } from "./template";

export type ToolCaller = (
  server: string,
  tool: string,
  input: Record<string, unknown>,
) => Promise<string>;

export type PipelineLoader = (typeId: string, version: number) => PipelineDefinition | null;

export interface ExecutorDeps {
  provider: AiProvider;
  callTool: ToolCaller;
  loadPipeline: PipelineLoader;
  /** Tool catalogue for agent steps; names are `server__tool`. */
  listTools?: () => ToolSpec[];
  /** The pipeline being run, so that a self-call is detected as a loop. */
  self?: { typeId: string; version: number };
}

export interface StepLogEntry {
  stepId: string;
  type: PipelineStep["type"];
  output?: string;
  error?: string;
}

export interface RunResult {
  context: Record<string, unknown>;
  assignee: Assignee | null;
  log: StepLogEntry[];
}

const MAX_DEPTH = 5;

interface RunState {
  context: Record<string, unknown>;
  assignee: Assignee | null;
  log: StepLogEntry[];
  stack: string[];
}

function scopeFor(task: Task, state: RunState): TemplateScope {
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
  };
}

async function runSteps(
  deps: ExecutorDeps,
  steps: PipelineStep[],
  task: Task,
  state: RunState,
): Promise<void> {
  for (const step of steps) {
    const scope = scopeFor(task, state);

    switch (step.type) {
      case "ai": {
        const result = await deps.provider.complete({
          messages: [{ role: "user", content: renderTemplate(step.prompt, scope) }],
          maxTokens: 4000,
        });
        state.context[step.output] = result.text;
        state.log.push({ stepId: step.id, type: step.type, output: step.output });
        break;
      }
      case "agent": {
        const catalogue = deps.listTools?.() ?? [];
        const specs = catalogue.filter((t) => step.tools.includes(t.name));
        const missing = step.tools.filter((name) => !specs.some((t) => t.name === name));
        if (missing.length) {
          throw new Error(`agent step ${step.id}: unavailable tools ${missing.join(", ")}`);
        }

        const messages: AiMessage[] = [
          { role: "user", content: renderTemplate(step.prompt, scope) },
        ];
        const failures = new Map<string, number>();
        let text = "";

        for (let turn = 0; turn < step.maxIterations; turn++) {
          const result = await deps.provider.complete({
            messages,
            tools: specs,
            maxTokens: 8000,
          });
          if (result.text) text = result.text;
          if (!result.toolCalls.length) break;

          messages.push({ role: "assistant", content: result.text, raw: result.raw });

          const results: AiToolResult[] = [];
          for (const call of result.toolCalls) {
            const index = call.name.indexOf(TOOL_SEPARATOR);
            if (index === -1) throw new Error(`agent step ${step.id}: bad tool name ${call.name}`);
            const server = call.name.slice(0, index);
            const tool = call.name.slice(index + TOOL_SEPARATOR.length);

            try {
              const output = await deps.callTool(server, tool, call.input);
              results.push({ callId: call.id, content: output });
            } catch (error) {
              const count = (failures.get(call.name) ?? 0) + 1;
              failures.set(call.name, count);
              const message = error instanceof Error ? error.message : String(error);
              if (count > 1) {
                throw new Error(`agent step ${step.id}: ${call.name} failed twice: ${message}`);
              }
              results.push({ callId: call.id, content: message, isError: true });
            }
            state.log.push({ stepId: step.id, type: "agent", output: call.name });
          }
          messages.push({ role: "tool_results", results });
        }

        state.context[step.output] = text;
        state.log.push({ stepId: step.id, type: step.type, output: step.output });
        break;
      }
      case "mcp_tool": {
        const input = renderInput(step.input, scope) as Record<string, unknown>;
        const output = await deps.callTool(step.server, step.tool, input);
        state.context[step.output] = output;
        state.log.push({ stepId: step.id, type: step.type, output: step.output });
        break;
      }
      case "assign": {
        state.assignee = step.to;
        if (step.note) state.context[`note:${step.id}`] = renderTemplate(step.note, scope);
        state.log.push({ stepId: step.id, type: step.type });
        break;
      }
      case "branch": {
        const value = state.context[step.on];
        const key = typeof value === "string" ? value : JSON.stringify(value);
        const chosen = step.cases[key] ?? step.default ?? [];
        state.log.push({ stepId: step.id, type: step.type, output: key });
        await runSteps(deps, chosen, task, state);
        break;
      }
      case "call_pipeline": {
        const key = `${step.typeId}@${step.version}`;
        if (state.stack.includes(key)) {
          throw new Error(`pipeline loop detected: ${[...state.stack, key].join(" -> ")}`);
        }
        if (state.stack.length >= MAX_DEPTH) {
          throw new Error(`pipeline nesting deeper than ${MAX_DEPTH}: ${state.stack.join(" -> ")}`);
        }
        const child = deps.loadPipeline(step.typeId, step.version);
        if (!child) throw new Error(`called pipeline not found: ${key}`);
        state.log.push({ stepId: step.id, type: step.type, output: key });
        state.stack.push(key);
        await runSteps(deps, child.steps, task, state);
        state.stack.pop();
        break;
      }
    }
  }
}

export async function runPipeline(
  deps: ExecutorDeps,
  definition: PipelineDefinition,
  task: Task,
): Promise<RunResult> {
  const state: RunState = {
    context: { ...task.context },
    assignee: null,
    log: [],
    stack: deps.self ? [`${deps.self.typeId}@${deps.self.version}`] : [],
  };

  await runSteps(deps, definition.steps, task, state);

  return { context: state.context, assignee: state.assignee, log: state.log };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/pipeline/`
Expected: PASS (13 tests). Then run the whole suite: `bun test` — expected: all green (Task 2's pipeline repo test still passes because its `definition` fixture is schema-valid).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add pipeline schema, templating and executor with branching and sub-pipelines"
```

---

### Task 8: MCP client manager

**Files:**
- Create: `src/mcp/manager.ts`
- Test: `tests/mcp/manager.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig` (Task 3), `ToolSpec` (Task 3).
- Produces: `class McpManager` with `connectAll(configs: McpServerConfig[]): Promise<void>`, `listTools(): ToolSpec[]` (names prefixed `server__tool`), `callTool(server: string, tool: string, input: Record<string, unknown>): Promise<string>`, `callPrefixed(name: string, input): Promise<string>`, `close(): Promise<void>`, plus a test seam `addClient(name: string, client: McpLike)` where `McpLike = { listTools(): Promise<{ tools: { name: string; description?: string; inputSchema: unknown }[] }>; callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>; close(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

`tests/mcp/manager.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { McpManager, type McpLike } from "../../src/mcp/manager";

function fakeClient(): McpLike & { calls: unknown[] } {
  return {
    calls: [],
    async listTools() {
      return {
        tools: [
          {
            name: "get_thread",
            description: "Fetch a mail thread",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          },
        ],
      };
    },
    async callTool(args) {
      this.calls.push(args);
      if (args.name === "boom") {
        return { content: [{ type: "text", text: "tool exploded" }], isError: true };
      }
      return { content: [{ type: "text", text: "thread body" }] };
    },
    async close() {},
  };
}

test("listTools prefixes tool names with the server name", async () => {
  const manager = new McpManager();
  manager.addClient("outlook", fakeClient());

  const tools = await manager.refreshTools();

  expect(tools).toEqual([
    {
      name: "outlook__get_thread",
      description: "Fetch a mail thread",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    },
  ]);
  expect(manager.listTools()).toEqual(tools);
});

test("callTool forwards arguments and returns the text content", async () => {
  const manager = new McpManager();
  const client = fakeClient();
  manager.addClient("outlook", client);

  const output = await manager.callTool("outlook", "get_thread", { id: "m1" });

  expect(output).toBe("thread body");
  expect(client.calls).toEqual([{ name: "get_thread", arguments: { id: "m1" } }]);
});

test("callPrefixed splits the server and tool name", async () => {
  const manager = new McpManager();
  manager.addClient("outlook", fakeClient());

  expect(await manager.callPrefixed("outlook__get_thread", { id: "m1" })).toBe("thread body");
});

test("an unknown server throws a clear error", async () => {
  const manager = new McpManager();

  await expect(manager.callTool("ghost", "x", {})).rejects.toThrow(/unknown MCP server: ghost/);
});

test("a tool error is surfaced as a thrown error", async () => {
  const manager = new McpManager();
  manager.addClient("outlook", fakeClient());

  await expect(manager.callTool("outlook", "boom", {})).rejects.toThrow(/tool exploded/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/mcp/manager.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/manager`.

- [ ] **Step 3: Write the implementation**

`src/mcp/manager.ts`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config";
import type { ToolSpec } from "../ai/provider";
import { TOOL_SEPARATOR, splitToolName } from "./names";

export interface McpLike {
  listTools(): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown }[];
  }>;
  callTool(args: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}

export class McpManager {
  private clients = new Map<string, McpLike>();
  private tools: ToolSpec[] = [];

  addClient(name: string, client: McpLike): void {
    this.clients.set(name, client);
  }

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      const client = new Client({ name: "jidoka", version: "0.1.0" });
      await client.connect(
        new StdioClientTransport({ command: config.command, args: config.args }),
      );
      this.addClient(config.name, client as unknown as McpLike);
    }
    await this.refreshTools();
  }

  async refreshTools(): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    for (const [server, client] of this.clients) {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        specs.push({
          name: `${server}${TOOL_SEPARATOR}${tool.name}`,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        });
      }
    }
    this.tools = specs;
    return specs;
  }

  listTools(): ToolSpec[] {
    return this.tools;
  }

  async callTool(
    server: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`unknown MCP server: ${server}`);

    const result = await client.callTool({ name: tool, arguments: input });
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    if (result.isError) throw new Error(`MCP tool ${server}/${tool} failed: ${text}`);
    return text;
  }

  async callPrefixed(name: string, input: Record<string, unknown>): Promise<string> {
    const { server, tool } = splitToolName(name);
    return this.callTool(server, tool, input);
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) await client.close();
    this.clients.clear();
    this.tools = [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/mcp/manager.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add MCP client manager exposing server tools"
```

---

### Task 9: Pipeline builder agent

**Files:**
- Create: `src/pipeline/builder.ts`
- Test: `tests/pipeline/builder.test.ts`

**Interfaces:**
- Consumes: `AiProvider`, `completeJson` (Task 3); `PipelineDefinitionSchema` (Task 7); `ToolSpec` (Task 3); `TaskType` (Task 2).
- Produces: `buildPipeline(provider: AiProvider, input: BuildInput): Promise<PipelineDefinition>` where `BuildInput = { type: TaskType; description: string; tools: ToolSpec[] }`, and `BUILDER_SYSTEM: string`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline/builder.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { buildPipeline } from "../../src/pipeline/builder";
import type { AiProvider } from "../../src/ai/provider";
import type { TaskType } from "../../src/domain/taskType";

const type: TaskType = {
  id: "type-1",
  name: "Customer email",
  description: "A question from an external customer",
  examples: [],
  status: "proposed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function scripted(replies: string[]): AiProvider & { prompts: string[] } {
  let i = 0;
  return {
    id: "stub",
    prompts: [],
    async complete(req) {
      this.prompts.push(`${req.system ?? ""}\n${req.messages.at(-1)?.content ?? ""}`);
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
}

const valid = JSON.stringify({
  steps: [
    { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
    { id: "s2", type: "assign", to: "human", note: "{{context.summary}}" },
  ],
});

test("buildPipeline returns a validated definition", async () => {
  const provider = scripted([valid]);

  const definition = await buildPipeline(provider, {
    type,
    description: "Summarize the email then give it to a human",
    tools: [
      { name: "outlook__get_thread", description: "Fetch a thread", inputSchema: { type: "object" } },
    ],
  });

  expect(definition.steps).toHaveLength(2);
  expect(definition.steps[0]).toMatchObject({ type: "ai", output: "summary" });
  expect(provider.prompts[0]).toContain("outlook__get_thread");
  expect(provider.prompts[0]).toContain("Summarize the email then give it to a human");
});

test("buildPipeline retries once when the model emits an invalid step", async () => {
  const provider = scripted([
    JSON.stringify({ steps: [{ id: "s1", type: "teleport" }] }),
    valid,
  ]);

  const definition = await buildPipeline(provider, { type, description: "d", tools: [] });

  expect(definition.steps).toHaveLength(2);
  expect(provider.prompts).toHaveLength(2);
});

test("buildPipeline rejects a definition that references an unknown tool", async () => {
  const provider = scripted([
    JSON.stringify({
      steps: [
        { id: "s1", type: "mcp_tool", server: "ghost", tool: "x", input: {}, output: "o" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
    valid,
  ]);

  const definition = await buildPipeline(provider, {
    type,
    description: "d",
    tools: [
      { name: "outlook__get_thread", description: "Fetch a thread", inputSchema: { type: "object" } },
    ],
  });

  expect(definition.steps[0]).toMatchObject({ type: "ai" });
  expect(provider.prompts[1]).toContain("ghost");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/pipeline/builder.test.ts`
Expected: FAIL — cannot resolve `../../src/pipeline/builder`.

- [ ] **Step 3: Write the implementation**

`src/pipeline/builder.ts`:

```typescript
import type { AiProvider, ToolSpec } from "../ai/provider";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
  type PipelineStep,
} from "../domain/pipeline";
import type { TaskType } from "../domain/taskType";
import { TOOL_SEPARATOR } from "../mcp/names";

export const BUILDER_SYSTEM = `You turn a plain-language description of how to handle a kind of task into a pipeline definition.

The pipeline runs automatically for every task of its type. Reply with JSON only:
{ "steps": [ ... ] }

Step shapes:
- { "id": "s1", "type": "ai", "prompt": "<prompt, may use {{task.title}}, {{task.body}}, {{task.metadata.<key>}}, {{context.<key>}}>", "output": "<context key>" }
- { "id": "s1b", "type": "agent", "prompt": "<what to find out and what to produce>", "tools": ["<server>__<tool>", ...], "maxIterations": 6, "output": "<context key>" }
- { "id": "s2", "type": "mcp_tool", "server": "<server>", "tool": "<tool>", "input": { ... }, "output": "<context key>" }
- { "id": "s3", "type": "branch", "on": "<context key>", "cases": { "<value>": [ ...steps ] }, "default": [ ...steps ] }
- { "id": "s4", "type": "assign", "to": "ai" | "human", "note": "<optional note>" }

Rules:
- Use an "ai" step for a single self-contained judgement (summarize, classify, draft) over what the task already contains.
- Use an "agent" step when gathering context needs an unknown number of lookups — "read the related mails", "find the matching order" — and list exactly the tools it may use.
- Use an "mcp_tool" step when the exact call is known in advance.
- Step ids are unique within the pipeline.
- Every pipeline ends on an assign step in every branch — a task must never finish unassigned.
- Only use mcp_tool steps for tools listed as available; use the exact server and tool names given.
- When a step branches on an AI classification, make the ai step's prompt state the exact allowed output values, and use those values as the branch case keys.`;

export interface BuildInput {
  type: TaskType;
  description: string;
  tools: ToolSpec[];
}

function toolCatalog(tools: ToolSpec[]): string {
  if (!tools.length) return "(no MCP tools are configured — do not use mcp_tool steps)";
  return tools
    .map((t) => {
      const index = t.name.indexOf(TOOL_SEPARATOR);
      const server = t.name.slice(0, index);
      const tool = t.name.slice(index + TOOL_SEPARATOR.length);
      return `- server: ${server}, tool: ${tool} — ${t.description}\n  input schema: ${JSON.stringify(t.inputSchema)}`;
    })
    .join("\n");
}

function userMessage(input: BuildInput): string {
  return `Task type: ${input.type.name}
Type description: ${input.type.description}

How the user wants these tasks handled:
${input.description}

Available MCP tools:
${toolCatalog(input.tools)}`;
}

function collectSteps(steps: PipelineStep[]): PipelineStep[] {
  return steps.flatMap((step) =>
    step.type === "branch"
      ? [step, ...collectSteps([...Object.values(step.cases).flat(), ...(step.default ?? [])])]
      : [step],
  );
}

function validateReferences(definition: PipelineDefinition, tools: ToolSpec[]): string[] {
  const available = new Set(tools.map((t) => t.name));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const step of collectSteps(definition.steps)) {
    if (seen.has(step.id)) problems.push(`duplicate step id: ${step.id}`);
    seen.add(step.id);

    if (step.type === "mcp_tool") {
      const name = `${step.server}${TOOL_SEPARATOR}${step.tool}`;
      if (!available.has(name)) {
        problems.push(`unknown tool "${step.server}/${step.tool}" — it is not in the available tool list`);
      }
    }

    if (step.type === "agent") {
      for (const name of step.tools) {
        if (!available.has(name)) {
          problems.push(`unknown tool "${name}" — it is not in the available tool list`);
        }
      }
    }
  }

  const endsAssigned = (steps: PipelineStep[]): boolean => {
    const last = steps.at(-1);
    if (!last) return false;
    if (last.type === "assign") return true;
    if (last.type === "branch") {
      const branches = [...Object.values(last.cases), last.default ?? []];
      return branches.every((branch) => endsAssigned(branch));
    }
    return false;
  };
  if (!endsAssigned(definition.steps)) {
    problems.push("the pipeline must end on an assign step in every branch");
  }

  return problems;
}

export async function buildPipeline(
  provider: AiProvider,
  input: BuildInput,
): Promise<PipelineDefinition> {
  let feedback = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const content = attempt === 0 ? userMessage(input) : `${userMessage(input)}

Your previous attempt was rejected: ${feedback}
Fix it and reply with corrected JSON only.`;

    const result = await provider.complete({
      system: BUILDER_SYSTEM,
      messages: [{ role: "user", content }],
      maxTokens: 8000,
    });

    const parsed = PipelineDefinitionSchema.safeParse(extractJson(result.text));
    if (!parsed.success) {
      feedback = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      continue;
    }

    const problems = validateReferences(parsed.data, input.tools);
    if (problems.length) {
      feedback = problems.join("; ");
      continue;
    }

    return parsed.data;
  }

  throw new Error(`pipeline builder failed after a retry: ${feedback}`);
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error("builder returned no JSON");
  return JSON.parse(candidate.slice(start));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/pipeline/builder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add agent that builds pipelines from natural-language descriptions"
```

---

### Task 10: Orchestrator and HTTP API

**Files:**
- Create: `src/orchestrator.ts`, `src/api/server.ts`
- Test: `tests/orchestrator.test.ts`, `tests/api/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces:
  - `interface AppDeps { db: Database; provider: AiProvider; mcp: { listTools(): ToolSpec[]; callTool: ToolCaller } }`
  - `onTaskIngested(deps: AppDeps, task: Task): Promise<Task>`
  - `confirmTaskType(deps: AppDeps, taskId: string, typeId: string): Promise<Task>`
  - `onboardType(deps: AppDeps, typeId: string, description: string): Promise<Pipeline>` (creates a draft pipeline)
  - `activateTypePipeline(deps: AppDeps, pipelineId: string): Promise<Pipeline>` (activates, sets the type active, then processes every task of that type sitting in `needs_onboarding`)
  - `skipOnboarding(deps: AppDeps, taskId: string): Promise<Task>`
  - `runPipelineForTask(deps: AppDeps, task: Task): Promise<Task>`
  - `createServer(deps: AppDeps): Hono`

State transitions, implemented exactly:
- `matched` + active pipeline → `processing` → executor → `assigned_ai` / `assigned_human` (or `failed` on error).
- `matched` + no active pipeline → `needs_onboarding`.
- `ambiguous` → `needs_type_confirmation`, `typeCandidates` stored.
- `new_type` → insert a proposed `TaskType`, set `typeId`, state `needs_onboarding`.
- `confirmTaskType` appends the task's title to the chosen type's `examples`, then re-enters the matched path.
- `skipOnboarding` → `assigned_human` without running a pipeline; the type stays `proposed`.

- [ ] **Step 1: Write the failing orchestrator test**

`tests/orchestrator.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../src/db";
import { insertTask, getTask } from "../src/repo/tasks";
import { insertTaskType, getTaskType, listTaskTypes } from "../src/repo/taskTypes";
import { insertPipeline, activatePipeline, getActivePipeline } from "../src/repo/pipelines";
import {
  onTaskIngested,
  confirmTaskType,
  skipOnboarding,
  onboardType,
  activateTypePipeline,
  type AppDeps,
} from "../src/orchestrator";
import type { AiProvider } from "../src/ai/provider";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function deps(db: ReturnType<typeof freshDb>, replies: string[]): AppDeps {
  let i = 0;
  const provider: AiProvider = {
    id: "stub",
    async complete() {
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
  return {
    db,
    provider,
    mcp: { listTools: () => [], callTool: async () => "" },
  };
}

const sample = { sourceId: "outlook", externalId: "m1", title: "Where is my order?", body: "…" };

test("an unmatched task creates a proposed type and waits for onboarding", async () => {
  const db = freshDb();
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({
      scores: [],
      proposal: { name: "Customer email", description: "External question", rationale: "first" },
    }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("needs_onboarding");
  const types = listTaskTypes(db);
  expect(types).toHaveLength(1);
  expect(types[0]?.status).toBe("proposed");
  expect(result.typeId).toBe(types[0]!.id);
});

test("an ambiguous task waits for the user and records candidates", async () => {
  const db = freshDb();
  const a = insertTaskType(db, { name: "Customer email", description: "d" });
  const b = insertTaskType(db, { name: "Internal request", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({
      scores: [
        { typeId: a.id, confidence: 0.7 },
        { typeId: b.id, confidence: 0.65 },
      ],
      proposal: null,
    }),
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("needs_type_confirmation");
  expect(result.typeCandidates).toEqual([a.id, b.id]);
});

test("a matched task with an active pipeline runs it and lands assigned", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activatePipeline(
    db,
    insertPipeline(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
    "Customer is chasing a delivery",
  ]);

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("assigned_human");
  expect(result.assignee).toBe("human");
  expect(result.context.summary).toBe("Customer is chasing a delivery");
});

test("a failing pipeline leaves the task in the failed state with the error recorded", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  activatePipeline(
    db,
    insertPipeline(db, {
      typeId: type.id,
      definition: {
        steps: [
          { id: "s1", type: "mcp_tool", server: "ghost", tool: "x", input: {}, output: "o" },
          { id: "s2", type: "assign", to: "human" },
        ],
      },
    }).id,
  );
  const task = insertTask(db, sample);
  const app = {
    ...deps(db, [JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null })]),
    mcp: {
      listTools: () => [],
      callTool: async () => {
        throw new Error("unknown MCP server: ghost");
      },
    },
  };

  const result = await onTaskIngested(app, task);

  expect(result.state).toBe("failed");
  expect(String(result.context.error)).toContain("ghost");
});

test("confirming a type stores an example and continues processing", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.4 }], proposal: null }),
  ]);
  await onTaskIngested(app, task);

  const confirmed = await confirmTaskType(app, task.id, type.id);

  expect(confirmed.typeId).toBe(type.id);
  expect(confirmed.state).toBe("needs_onboarding");
  expect(getTaskType(db, type.id)?.examples).toEqual(["Where is my order?"]);
});

test("skipping onboarding assigns the task to a human and leaves the type proposed", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
  ]);
  await onTaskIngested(app, task);

  const skipped = await skipOnboarding(app, task.id);

  expect(skipped.state).toBe("assigned_human");
  expect(getTaskType(db, type.id)?.status).toBe("proposed");
});

test("activating an onboarded pipeline processes the tasks that were waiting", async () => {
  const db = freshDb();
  const type = insertTaskType(db, { name: "Customer email", description: "d" });
  const task = insertTask(db, sample);
  const app = deps(db, [
    JSON.stringify({ scores: [{ typeId: type.id, confidence: 0.95 }], proposal: null }),
    JSON.stringify({
      steps: [
        { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
    "A summary",
  ]);
  await onTaskIngested(app, task);

  const draft = await onboardType(app, type.id, "Summarize it and give it to a human");
  expect(draft.status).toBe("draft");
  expect(getTask(db, task.id)?.state).toBe("needs_onboarding");

  await activateTypePipeline(app, draft.id);

  expect(getActivePipeline(db, type.id)?.id).toBe(draft.id);
  expect(getTaskType(db, type.id)?.status).toBe("active");
  const processed = getTask(db, task.id);
  expect(processed?.state).toBe("assigned_human");
  expect(processed?.context.summary).toBe("A summary");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator`.

- [ ] **Step 3: Write the orchestrator**

`src/orchestrator.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { AiProvider, ToolSpec } from "./ai/provider";
import type { Task } from "./domain/task";
import type { Pipeline } from "./domain/pipeline";
import { getTask, listTasks, updateTask } from "./repo/tasks";
import {
  getTaskType,
  insertTaskType,
  listTaskTypes,
  updateTaskType,
} from "./repo/taskTypes";
import {
  activatePipeline,
  getActivePipeline,
  getPipeline,
  insertPipeline,
  listPipelines,
} from "./repo/pipelines";
import { triageTask } from "./triage/triage";
import { runPipeline, type ToolCaller } from "./pipeline/executor";
import { buildPipeline } from "./pipeline/builder";

export interface AppDeps {
  db: Database;
  provider: AiProvider;
  mcp: { listTools(): ToolSpec[]; callTool: ToolCaller };
}

export async function onTaskIngested(deps: AppDeps, task: Task): Promise<Task> {
  const outcome = await triageTask(deps.provider, task, listTaskTypes(deps.db));

  if (outcome.kind === "ambiguous") {
    return updateTask(deps.db, task.id, {
      state: "needs_type_confirmation",
      typeCandidates: outcome.candidateTypeIds,
    });
  }

  if (outcome.kind === "new_type") {
    const type = insertTaskType(deps.db, {
      name: outcome.proposal.name,
      description: outcome.proposal.description,
    });
    return updateTask(deps.db, task.id, {
      typeId: type.id,
      typeCandidates: null,
      state: "needs_onboarding",
    });
  }

  const matched = updateTask(deps.db, task.id, {
    typeId: outcome.typeId,
    typeCandidates: null,
  });
  return processTask(deps, matched);
}

async function processTask(deps: AppDeps, task: Task): Promise<Task> {
  if (!task.typeId) throw new Error(`processTask: task ${task.id} has no type`);
  const pipeline = getActivePipeline(deps.db, task.typeId);
  if (!pipeline) return updateTask(deps.db, task.id, { state: "needs_onboarding" });
  return runPipelineForTask(deps, task, pipeline);
}

export async function runPipelineForTask(
  deps: AppDeps,
  task: Task,
  pipeline?: Pipeline,
): Promise<Task> {
  if (!task.typeId) throw new Error(`runPipelineForTask: task ${task.id} has no type`);
  const active = pipeline ?? getActivePipeline(deps.db, task.typeId);
  if (!active) return updateTask(deps.db, task.id, { state: "needs_onboarding" });

  const running = updateTask(deps.db, task.id, { state: "processing" });

  try {
    const result = await runPipeline(
      {
        provider: deps.provider,
        callTool: deps.mcp.callTool,
        listTools: () => deps.mcp.listTools(),
        loadPipeline: (typeId, version) =>
          listPipelines(deps.db, typeId).find((p) => p.version === version)?.definition ?? null,
        self: { typeId: active.typeId, version: active.version },
      },
      active.definition,
      running,
    );

    return updateTask(deps.db, task.id, {
      context: { ...result.context, pipelineLog: result.log },
      assignee: result.assignee,
      state: result.assignee === "ai" ? "assigned_ai" : "assigned_human",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return updateTask(deps.db, task.id, {
      state: "failed",
      context: { ...running.context, error: message },
    });
  }
}

export async function confirmTaskType(
  deps: AppDeps,
  taskId: string,
  typeId: string,
): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`confirmTaskType: unknown task ${taskId}`);
  const type = getTaskType(deps.db, typeId);
  if (!type) throw new Error(`confirmTaskType: unknown type ${typeId}`);

  updateTaskType(deps.db, typeId, { examples: [...type.examples, task.title] });
  const updated = updateTask(deps.db, taskId, { typeId, typeCandidates: null });
  return processTask(deps, updated);
}

export async function onboardType(
  deps: AppDeps,
  typeId: string,
  description: string,
): Promise<Pipeline> {
  const type = getTaskType(deps.db, typeId);
  if (!type) throw new Error(`onboardType: unknown type ${typeId}`);

  const definition = await buildPipeline(deps.provider, {
    type,
    description,
    tools: deps.mcp.listTools(),
  });
  return insertPipeline(deps.db, { typeId, definition });
}

export async function activateTypePipeline(
  deps: AppDeps,
  pipelineId: string,
): Promise<Pipeline> {
  const pipeline = getPipeline(deps.db, pipelineId);
  if (!pipeline) throw new Error(`activateTypePipeline: unknown pipeline ${pipelineId}`);

  const active = activatePipeline(deps.db, pipelineId);
  updateTaskType(deps.db, pipeline.typeId, { status: "active" });

  for (const task of listTasks(deps.db)) {
    if (task.typeId === pipeline.typeId && task.state === "needs_onboarding") {
      await runPipelineForTask(deps, task, active);
    }
  }
  return active;
}

export async function skipOnboarding(deps: AppDeps, taskId: string): Promise<Task> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new Error(`skipOnboarding: unknown task ${taskId}`);
  return updateTask(deps.db, taskId, { state: "assigned_human", assignee: "human" });
}
```

- [ ] **Step 4: Run the orchestrator test to verify it passes**

Run: `bun test tests/orchestrator.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing API test**

`tests/api/server.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTask } from "../../src/repo/tasks";
import { insertTaskType } from "../../src/repo/taskTypes";
import { createServer } from "../../src/api/server";
import type { AppDeps } from "../../src/orchestrator";
import type { AiProvider } from "../../src/ai/provider";

function app(replies: string[] = []): { deps: AppDeps; fetch: (req: Request) => Promise<Response> } {
  const db = openDb(":memory:");
  migrate(db);
  let i = 0;
  const provider: AiProvider = {
    id: "stub",
    async complete() {
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
  const deps: AppDeps = { db, provider, mcp: { listTools: () => [], callTool: async () => "" } };
  const server = createServer(deps);
  return { deps, fetch: (req) => server.fetch(req) };
}

test("GET /api/tasks returns tasks", async () => {
  const { deps, fetch } = app();
  insertTask(deps.db, { sourceId: "outlook", externalId: "m1", title: "One", body: "b" });

  const response = await fetch(new Request("http://localhost/api/tasks"));

  expect(response.status).toBe(200);
  const body = (await response.json()) as { tasks: { title: string }[] };
  expect(body.tasks.map((t) => t.title)).toEqual(["One"]);
});

test("GET /api/types returns types with their active pipeline", async () => {
  const { deps, fetch } = app();
  insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const body = (await (await fetch(new Request("http://localhost/api/types"))).json()) as {
    types: { name: string; activePipelineId: string | null }[];
  };

  expect(body.types).toEqual([
    expect.objectContaining({ name: "Customer email", activePipelineId: null }),
  ]);
});

test("POST /api/tasks/:id/type confirms an ambiguous task", async () => {
  const { deps, fetch } = app();
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });
  const task = insertTask(deps.db, { sourceId: "outlook", externalId: "m1", title: "One", body: "b" });

  const response = await fetch(
    new Request(`http://localhost/api/tasks/${task.id}/type`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeId: type.id }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { task: { typeId: string; state: string } };
  expect(body.task.typeId).toBe(type.id);
  expect(body.task.state).toBe("needs_onboarding");
});

test("POST /api/types/:id/onboard builds a draft pipeline and activate publishes it", async () => {
  const { deps, fetch } = app([
    JSON.stringify({
      steps: [
        { id: "s1", type: "ai", prompt: "Summarize {{task.body}}", output: "summary" },
        { id: "s2", type: "assign", to: "human" },
      ],
    }),
  ]);
  const type = insertTaskType(deps.db, { name: "Customer email", description: "d" });

  const draft = (await (
    await fetch(
      new Request(`http://localhost/api/types/${type.id}/onboard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "Summarize then hand to a human" }),
      }),
    )
  ).json()) as { pipeline: { id: string; status: string } };

  expect(draft.pipeline.status).toBe("draft");

  const activated = (await (
    await fetch(
      new Request(`http://localhost/api/pipelines/${draft.pipeline.id}/activate`, {
        method: "POST",
      }),
    )
  ).json()) as { pipeline: { status: string } };

  expect(activated.pipeline.status).toBe("active");
});

test("a request for an unknown task returns 404", async () => {
  const { fetch } = app();

  const response = await fetch(
    new Request("http://localhost/api/tasks/nope/skip-onboarding", { method: "POST" }),
  );

  expect(response.status).toBe(404);
});
```

- [ ] **Step 6: Run the API test to verify it fails**

Run: `bun test tests/api/server.test.ts`
Expected: FAIL — cannot resolve `../../src/api/server`.

- [ ] **Step 7: Write the API**

`src/api/server.ts`:

```typescript
import { Hono } from "hono";
import { getTask, listTasks } from "../repo/tasks";
import { getTaskType, listTaskTypes, mergeTaskType, updateTaskType } from "../repo/taskTypes";
import { getActivePipeline, getPipeline, listPipelines } from "../repo/pipelines";
import {
  activateTypePipeline,
  confirmTaskType,
  onboardType,
  skipOnboarding,
  type AppDeps,
} from "../orchestrator";

export function createServer(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/tasks", (c) => c.json({ tasks: listTasks(deps.db) }));

  app.get("/api/types", (c) =>
    c.json({
      types: listTaskTypes(deps.db).map((type) => ({
        ...type,
        activePipelineId: getActivePipeline(deps.db, type.id)?.id ?? null,
        pipelines: listPipelines(deps.db, type.id).map((p) => ({
          id: p.id,
          version: p.version,
          status: p.status,
        })),
      })),
    }),
  );

  app.get("/api/pipelines/:id", (c) => {
    const pipeline = getPipeline(deps.db, c.req.param("id"));
    return pipeline ? c.json({ pipeline }) : c.json({ error: "unknown pipeline" }, 404);
  });

  app.post("/api/tasks/:id/type", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    const { typeId } = (await c.req.json()) as { typeId: string };
    if (!getTaskType(deps.db, typeId)) return c.json({ error: "unknown type" }, 404);
    return c.json({ task: await confirmTaskType(deps, id, typeId) });
  });

  app.post("/api/tasks/:id/skip-onboarding", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    return c.json({ task: await skipOnboarding(deps, id) });
  });

  app.patch("/api/types/:id", async (c) => {
    const id = c.req.param("id");
    if (!getTaskType(deps.db, id)) return c.json({ error: "unknown type" }, 404);
    const patch = (await c.req.json()) as {
      name?: string;
      description?: string;
      mergeInto?: string;
    };
    if (patch.mergeInto) {
      if (!getTaskType(deps.db, patch.mergeInto)) return c.json({ error: "unknown target" }, 404);
      mergeTaskType(deps.db, id, patch.mergeInto);
      return c.json({ merged: true });
    }
    return c.json({ type: updateTaskType(deps.db, id, patch) });
  });

  app.post("/api/types/:id/onboard", async (c) => {
    const id = c.req.param("id");
    if (!getTaskType(deps.db, id)) return c.json({ error: "unknown type" }, 404);
    const { description } = (await c.req.json()) as { description: string };
    try {
      return c.json({ pipeline: await onboardType(deps, id, description) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/pipelines/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (!getPipeline(deps.db, id)) return c.json({ error: "unknown pipeline" }, 404);
    return c.json({ pipeline: await activateTypePipeline(deps, id) });
  });

  return app;
}
```

- [ ] **Step 8: Run the API test to verify it passes**

Run: `bun test tests/api/server.test.ts`
Expected: PASS (5 tests). Then `bun test` — all suites green.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "feat: add orchestrator state machine and HTTP API"
```

---

### Task 11: React UI (board, type confirmation, onboarding)

**Files:**
- Create: `src/client/index.html`, `src/client/main.tsx`, `src/client/api.ts`, `src/client/App.tsx`, `src/client/Board.tsx`, `src/client/TypeConfirm.tsx`, `src/client/Onboarding.tsx`
- Test: `tests/client/columns.test.ts`
- Create: `src/client/columns.ts` (pure grouping logic, the part worth testing)

**Interfaces:**
- Consumes: the API routes from Task 10.
- Produces: `COLUMNS: { state: TaskState; label: string }[]`, `groupByColumn(tasks: Task[]): Record<TaskState, Task[]>`, and the React components. `App` renders `Board`; clicking a task in `needs_type_confirmation` opens `TypeConfirm`, in `needs_onboarding` opens `Onboarding`.

- [ ] **Step 1: Write the failing test**

`tests/client/columns.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { COLUMNS, groupByColumn } from "../../src/client/columns";
import type { Task } from "../../src/domain/task";

function task(id: string, state: Task["state"]): Task {
  return {
    id,
    sourceId: "outlook",
    externalId: id,
    url: null,
    title: id,
    body: "",
    metadata: {},
    typeId: null,
    typeCandidates: null,
    state,
    assignee: null,
    context: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("the board has one column per task state in flow order", () => {
  expect(COLUMNS.map((c) => c.state)).toEqual([
    "ingested",
    "needs_type_confirmation",
    "needs_onboarding",
    "processing",
    "assigned_ai",
    "assigned_human",
    "done",
    "failed",
  ]);
});

test("groupByColumn buckets tasks and leaves empty columns present", () => {
  const grouped = groupByColumn([task("a", "ingested"), task("b", "assigned_human"), task("c", "ingested")]);

  expect(grouped.ingested.map((t) => t.id)).toEqual(["a", "c"]);
  expect(grouped.assigned_human.map((t) => t.id)).toEqual(["b"]);
  expect(grouped.done).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/client/columns.test.ts`
Expected: FAIL — cannot resolve `../../src/client/columns`.

- [ ] **Step 3: Write the client**

`src/client/columns.ts`:

```typescript
import type { Task, TaskState } from "../domain/task";

export const COLUMNS: { state: TaskState; label: string }[] = [
  { state: "ingested", label: "Ingested" },
  { state: "needs_type_confirmation", label: "Needs type confirmation" },
  { state: "needs_onboarding", label: "Needs onboarding" },
  { state: "processing", label: "Processing" },
  { state: "assigned_ai", label: "Assigned to AI" },
  { state: "assigned_human", label: "Assigned to human" },
  { state: "done", label: "Done" },
  { state: "failed", label: "Failed" },
];

export function groupByColumn(tasks: Task[]): Record<TaskState, Task[]> {
  const grouped = Object.fromEntries(COLUMNS.map((c) => [c.state, [] as Task[]])) as Record<
    TaskState,
    Task[]
  >;
  for (const task of tasks) grouped[task.state]?.push(task);
  return grouped;
}
```

`src/client/api.ts`:

```typescript
import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";
import type { Pipeline } from "../domain/pipeline";

export interface TypeWithPipelines extends TaskType {
  activePipelineId: string | null;
  pipelines: { id: string; version: number; status: string }[];
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request failed: ${response.status}`);
  return body;
}

export const api = {
  tasks: () => json<{ tasks: Task[] }>("/api/tasks").then((r) => r.tasks),
  types: () => json<{ types: TypeWithPipelines[] }>("/api/types").then((r) => r.types),
  pipeline: (id: string) => json<{ pipeline: Pipeline }>(`/api/pipelines/${id}`).then((r) => r.pipeline),
  confirmType: (taskId: string, typeId: string) =>
    json<{ task: Task }>(`/api/tasks/${taskId}/type`, {
      method: "POST",
      body: JSON.stringify({ typeId }),
    }).then((r) => r.task),
  skipOnboarding: (taskId: string) =>
    json<{ task: Task }>(`/api/tasks/${taskId}/skip-onboarding`, { method: "POST" }).then(
      (r) => r.task,
    ),
  patchType: (typeId: string, patch: { name?: string; description?: string; mergeInto?: string }) =>
    json<{ type?: TaskType; merged?: boolean }>(`/api/types/${typeId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  onboard: (typeId: string, description: string) =>
    json<{ pipeline: Pipeline }>(`/api/types/${typeId}/onboard`, {
      method: "POST",
      body: JSON.stringify({ description }),
    }).then((r) => r.pipeline),
  activate: (pipelineId: string) =>
    json<{ pipeline: Pipeline }>(`/api/pipelines/${pipelineId}/activate`, { method: "POST" }).then(
      (r) => r.pipeline,
    ),
};
```

`src/client/Board.tsx`:

```tsx
import type { Task } from "../domain/task";
import { COLUMNS, groupByColumn } from "./columns";

export function Board({
  tasks,
  onSelect,
}: {
  tasks: Task[];
  onSelect: (task: Task) => void;
}) {
  const grouped = groupByColumn(tasks);

  return (
    <div className="board">
      {COLUMNS.map((column) => (
        <section key={column.state} className="column">
          <h2>
            {column.label} <span className="count">{grouped[column.state].length}</span>
          </h2>
          {grouped[column.state].map((task) => (
            <article key={task.id} className="card" onClick={() => onSelect(task)}>
              <h3>{task.title}</h3>
              <p>{task.body.slice(0, 120)}</p>
              <footer>{task.sourceId}</footer>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
```

`src/client/TypeConfirm.tsx`:

```tsx
import { useState } from "react";
import type { Task } from "../domain/task";
import type { TypeWithPipelines } from "./api";

export function TypeConfirm({
  task,
  types,
  onConfirm,
  onClose,
}: {
  task: Task;
  types: TypeWithPipelines[];
  onConfirm: (typeId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const candidates = task.typeCandidates ?? [];
  const shown = types.filter((t) => candidates.includes(t.id));

  return (
    <div className="dialog">
      <h2>Which type is this?</h2>
      <p className="subject">{task.title}</p>
      {(shown.length ? shown : types).map((type) => (
        <button
          key={type.id}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm(type.id);
            setBusy(false);
            onClose();
          }}
        >
          <strong>{type.name}</strong>
          <span>{type.description}</span>
        </button>
      ))}
      <button className="secondary" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
```

`src/client/Onboarding.tsx`:

```tsx
import { useState } from "react";
import type { Task } from "../domain/task";
import type { Pipeline } from "../domain/pipeline";
import { api, type TypeWithPipelines } from "./api";

export function Onboarding({
  task,
  type,
  onDone,
  onClose,
}: {
  task: Task;
  type: TypeWithPipelines;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description);
  const [handling, setHandling] = useState("");
  const [draft, setDraft] = useState<Pipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function build() {
    setBusy(true);
    setError(null);
    try {
      if (name !== type.name || description !== type.description) {
        await api.patchType(type.id, { name, description });
      }
      setDraft(await api.onboard(type.id, handling));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!draft) return;
    setBusy(true);
    try {
      await api.activate(draft.id);
      await onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog">
      <h2>New task type: {type.name}</h2>
      <p className="subject">First task: {task.title}</p>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        How should tasks of this type be handled?
        <textarea
          rows={5}
          value={handling}
          placeholder="e.g. Summarize the email, pull the order status, then assign it to a human"
          onChange={(e) => setHandling(e.target.value)}
        />
      </label>

      {error && <p className="error">{error}</p>}

      {!draft ? (
        <>
          <button disabled={busy || !handling.trim()} onClick={build}>
            {busy ? "Building pipeline…" : "Build pipeline"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={async () => {
              await api.skipOnboarding(task.id);
              await onDone();
              onClose();
            }}
          >
            Skip — assign to a human for now
          </button>
        </>
      ) : (
        <>
          <h3>Proposed pipeline (version {draft.version})</h3>
          <pre>{JSON.stringify(draft.definition, null, 2)}</pre>
          <button disabled={busy} onClick={activate}>
            Activate
          </button>
          <button className="secondary" disabled={busy} onClick={() => setDraft(null)}>
            Rewrite the description
          </button>
        </>
      )}
    </div>
  );
}
```

`src/client/App.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import type { Task } from "../domain/task";
import { api, type TypeWithPipelines } from "./api";
import { Board } from "./Board";
import { TypeConfirm } from "./TypeConfirm";
import { Onboarding } from "./Onboarding";

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [types, setTypes] = useState<TypeWithPipelines[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);

  const refresh = useCallback(async () => {
    const [nextTasks, nextTypes] = await Promise.all([api.tasks(), api.types()]);
    setTasks(nextTasks);
    setTypes(nextTypes);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const selectedType = selected?.typeId ? types.find((t) => t.id === selected.typeId) : undefined;

  return (
    <main>
      <header>
        <h1>Jidoka</h1>
        <button onClick={() => void refresh()}>Refresh</button>
      </header>

      <Board tasks={tasks} onSelect={setSelected} />

      {selected?.state === "needs_type_confirmation" && (
        <TypeConfirm
          task={selected}
          types={types}
          onConfirm={async (typeId) => {
            await api.confirmType(selected.id, typeId);
            await refresh();
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {selected?.state === "needs_onboarding" && selectedType && (
        <Onboarding
          task={selected}
          type={selectedType}
          onDone={refresh}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}
```

`src/client/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(<App />);
```

`src/client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Jidoka</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; padding: 16px; }
      header { display: flex; justify-content: space-between; align-items: center; }
      .board { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 12px; }
      .column { min-width: 240px; flex: 0 0 240px; }
      .column h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
      .count { opacity: 0.5; }
      .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; cursor: pointer; }
      .card h3 { font-size: 14px; margin: 0 0 4px; }
      .card p { font-size: 12px; margin: 0; opacity: 0.7; }
      .card footer { font-size: 11px; opacity: 0.5; margin-top: 6px; }
      .dialog { position: fixed; inset: 10% 20%; overflow: auto; padding: 20px; border-radius: 12px; background: Canvas; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
      .dialog label { display: block; margin: 10px 0; }
      .dialog input, .dialog textarea { width: 100%; }
      .dialog button { display: block; width: 100%; text-align: left; padding: 10px; margin: 6px 0; }
      .dialog pre { max-height: 240px; overflow: auto; font-size: 12px; }
      .error { color: crimson; }
      @media (max-width: 720px) { .dialog { inset: 4%; } }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/client/columns.test.ts`
Expected: PASS (2 tests). Also `bun run typecheck` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add kanban board UI with type confirmation and onboarding"
```

---

### Task 12: Wire up main, Outlook login command, single-executable build

**Files:**
- Create: `src/main.ts`, `README.md`
- Test: `tests/main.smoke.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: the runnable server. `bun src/main.ts` serves the UI and API; `bun src/main.ts login-outlook` runs the device-code flow and stores tokens; `bun run build` produces `./jidoka`.

- [ ] **Step 1: Write the failing smoke test**

`tests/main.smoke.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { createApp } from "../src/main";

test("createApp wires the API and serves the board HTML", async () => {
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

  const page = await app.fetch(new Request("http://localhost/"));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");

  await app.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/main.smoke.test.ts`
Expected: FAIL — cannot resolve `../src/main`.

- [ ] **Step 3: Write main**

`src/main.ts`:

```typescript
import index from "./client/index.html";
import { loadConfig, type Config } from "./config";
import { openDb, migrate } from "./db";
import { createProvider } from "./ai";
import { McpManager } from "./mcp/manager";
import { createServer } from "./api/server";
import { onTaskIngested, type AppDeps } from "./orchestrator";
import { startPoller } from "./sources/poller";
import { createOutlookSource } from "./sources/outlook/source";
import {
  AuthPendingError,
  completeDeviceLogin,
  startDeviceLogin,
} from "./sources/outlook/auth";

export interface App {
  deps: AppDeps;
  mcp: McpManager;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const db = openDb(config.dbPath);
  migrate(db);

  const mcp = new McpManager();
  const deps: AppDeps = {
    db,
    provider: createProvider(config),
    mcp: {
      listTools: () => mcp.listTools(),
      callTool: (server, tool, input) => mcp.callTool(server, tool, input),
    },
  };

  const api = createServer(deps);

  return {
    deps,
    mcp,
    fetch: (request) => api.fetch(request),
    async close() {
      await mcp.close();
      db.close();
    },
  };
}

async function loginOutlook(config: Config): Promise<void> {
  const db = openDb(config.dbPath);
  migrate(db);
  if (!config.outlook.clientId) throw new Error("JIDOKA_OUTLOOK_CLIENT_ID is not set");

  const deps = { db, clientId: config.outlook.clientId, tenant: config.outlook.tenant };
  const login = await startDeviceLogin(deps);
  console.log(`\nOpen ${login.verificationUri} and enter code: ${login.userCode}\n`);

  const deadline = Date.now() + login.expiresIn * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(login.interval * 1000);
    try {
      await completeDeviceLogin(deps, login.deviceCode);
      console.log("Outlook connected.");
      db.close();
      return;
    } catch (error) {
      if (!(error instanceof AuthPendingError)) throw error;
    }
  }
  throw new Error("device login timed out");
}

if (import.meta.main) {
  const config = loadConfig();

  if (Bun.argv[2] === "login-outlook") {
    await loginOutlook(config);
  } else {
    const app = createApp(config);
    await app.mcp.connectAll(config.mcpServers);

    if (config.outlook.clientId) {
      const source = createOutlookSource({
        db: app.deps.db,
        clientId: config.outlook.clientId,
        tenant: config.outlook.tenant,
      });
      startPoller(
        app.deps.db,
        [source],
        async (task) => {
          try {
            await onTaskIngested(app.deps, task);
          } catch (error) {
            console.error(`[orchestrator] task ${task.id} failed:`, error);
          }
        },
        config.pollIntervalMs,
      );
    } else {
      console.warn("JIDOKA_OUTLOOK_CLIENT_ID is not set — no sources are polling");
    }

    Bun.serve({
      port: config.port,
      routes: { "/*": index },
      fetch: (request) => app.fetch(request),
    });
    console.log(`Jidoka on http://localhost:${config.port}`);
  }
}
```

`README.md`:

````markdown
# Jidoka

Task management that polls your sources, triages each task with AI, and runs a
per-type pipeline you describe in plain language.

## Run it

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...        # or JIDOKA_AI_PROVIDER=openai + OPENAI_API_KEY
export JIDOKA_OUTLOOK_CLIENT_ID=<azure app registration client id>
bun src/main.ts login-outlook              # one-time device-code login
bun run dev                                # http://localhost:3000
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JIDOKA_DB` | `./jidoka.db` | SQLite file |
| `JIDOKA_PORT` | `3000` | HTTP port |
| `JIDOKA_POLL_INTERVAL_MS` | `60000` | How often sources are polled |
| `JIDOKA_AI_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `JIDOKA_AI_MODEL` | `claude-opus-5` | Model id for the chosen provider |
| `JIDOKA_OUTLOOK_CLIENT_ID` | — | Azure app registration (public client, `Mail.Read`) |
| `JIDOKA_OUTLOOK_TENANT` | `common` | Azure tenant |
| `JIDOKA_MCP_SERVERS` | `[]` | JSON array of `{ name, command, args }` |

## Build a single executable

```bash
bun run build      # -> ./jidoka (or jidoka.exe on Windows)
```

## Tests

```bash
bun test                                   # everything
bun test tests/triage/triage.test.ts       # one file
bun test tests/triage/triage.test.ts -t "ambiguous"   # one case
```
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/main.smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run everything and build the executable**

Run: `bun test` — expected: all suites pass.
Run: `bun run typecheck` — expected: no errors.
Run: `bun run build` — expected: `./jidoka` (or `jidoka.exe`) is produced.
Run: `./jidoka` with `JIDOKA_DB=./smoke.db` and no Outlook client id — expected: logs the "no sources are polling" warning and serves `http://localhost:3000` with an empty board. Stop it and delete `smoke.db`.

- [ ] **Step 6: Commit**

```bash
git add src tests README.md
git commit -m "feat: wire up server entry point, Outlook login command and executable build"
```

---

## What this plan does not cover

Carried forward to a second plan, all of them spec items deliberately deferred:

- **Re-triage on type changes.** The spec says open tasks are re-triaged when a type is merged, renamed, or re-described; `mergeTaskType` repoints tasks but nothing re-runs triage.
- **AI execution of tasks.** `assigned_ai` is a board column, not a worker — nothing yet acts on a task assigned to AI, and nothing moves tasks to `done`.
- **Tool approval.** An `agent` step's `tools` list is the only access control; there is no approval gate before a write action runs, so keep write tools out of agent steps until that exists.
- **Editing an existing pipeline.** Pipelines are versioned and re-buildable through onboarding, but there is no edit UI.
- **Merging types from the UI.** `PATCH /api/types/:id` with `mergeInto` works, but the onboarding screen only renames and re-describes — merging a duplicate type needs an API call by hand.
- **A second task source**, and packaging as a Tauri app.
