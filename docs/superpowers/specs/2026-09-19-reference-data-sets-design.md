# Reference data sets — design

## Problem

Pipelines and prompts have no way to reach structured context about the
outside world that isn't tied to one task. The motivating case: a Teams
source/MCP server where triage or an `agent` step needs to know who's on the
team and who's senior, so it can route or address people correctly. Nothing
in the domain model carries data like this today — `TaskSource` is just
`{ id, poll() }`, `McpServerConfig` is just `{ name, command, args }`, and the
only per-task context is `task.metadata` (source-item-specific) and
`state.context` (built up during one pipeline run).

This spec covers reference data only. A related but separate gap — limiting
*what* an agent step can say/do when it uses a write-capable MCP tool (e.g.
sending a chat message) — is intentionally out of scope here and gets its own
spec later.

## Non-goals

- No per-pipeline declaration of which reference data sets it uses. Every
  pipeline/prompt can address any set by id; this trades dependency
  visibility for simplicity (YAGNI — there's currently one use case).
- No typed schema for a set's `data`. It's arbitrary JSON; the shape is
  whatever the prompt author put there.
- No versioning of reference data sets (unlike pipelines/task types). Editing
  a set overwrites it in place.
- No approval/audit trail for edits. Single-user, no auth, same as the rest
  of the app.

## A. Data model & storage

New domain type, `src/domain/referenceData.ts`:

```ts
export interface ReferenceDataSet {
  id: string;        // user-chosen slug, e.g. "team-roster" — this is the
                      // template key, not a uuid; validated against
                      // /^[a-z0-9][a-z0-9-]*$/ and immutable once created
  name: string;       // display name, e.g. "Team roster"
  data: unknown;      // arbitrary JSON
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
```

New table, added to `src/db/migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS reference_data (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

`data` is stored as `JSON.stringify(...)`, parsed back on read — same
convention as `pipelines.definition` and `task_types.examples`.

New repo module `src/repo/referenceData.ts`, shaped like
`src/repo/taskTypes.ts`:

- `insertReferenceData(db, input: NewReferenceDataSet): ReferenceDataSet` —
  throws if `id` fails the slug pattern or already exists (`INSERT` will hit
  the primary key conflict; surface it as a clear error rather than a raw
  SQLite exception).
- `getReferenceData(db, id): ReferenceDataSet | null`
- `listReferenceData(db): ReferenceDataSet[]` — ordered by `name`.
- `updateReferenceData(db, id, patch: ReferenceDataSetPatch): ReferenceDataSet`
  — throws if `id` is unknown.
- `deleteReferenceData(db, id): void`.

## B. Wiring into prompts and pipelines

`TemplateScope` (`src/pipeline/template.ts`) gains a `data` field:

```ts
export interface TemplateScope {
  task: Record<string, unknown>;
  context: Record<string, unknown>;
  data: Record<string, unknown>;   // set id -> its `data` value
}
```

No change to `renderTemplate`/`renderInput`/`lookup` — they already resolve
arbitrary dotted paths and already stringify non-string values, so
`{{data.team-roster}}` behaves exactly like `{{task.metadata}}` does today:
inlines the JSON. A path into a set that doesn't exist resolves to
`undefined` and renders as `""`, same as any other missing path — no new
error handling required.

`ExecutorDeps` (`src/pipeline/executor.ts`) gains an optional loader:

```ts
export interface ExecutorDeps {
  // ...existing fields...
  listReferenceData?: () => ReferenceDataSet[];
}
```

`scopeFor` calls it once per pipeline run (empty object if the dep is
omitted, e.g. in tests that don't need it) and populates
`scope.data[set.id] = set.data` for every set returned.

`src/orchestrator.ts` wires it the same way it wires `loadPipeline`:

```ts
listReferenceData: () => listReferenceData(deps.db),
```

No changes to the `ai`, `agent`, `mcp_tool`, `branch`, `assign`, or
`call_pipeline` step schemas in `src/domain/pipeline.ts` — this only adds to
what template substitution can see, not a new step type or step field.

## C. API + UI

New routes in `src/api/server.ts`, following the existing route style (thin
Hono handlers over the repo module):

- `GET /api/reference-data` → `{ sets: ReferenceDataSet[] }`
- `POST /api/reference-data` — body `{ id, name, data }` → 201 with the
  created set; 409 if `id` fails the slug pattern or already exists.
- `PATCH /api/reference-data/:id` — body `{ name?, data? }` → the updated
  set; 404 if unknown.
- `DELETE /api/reference-data/:id` → 204; 404 if unknown.

New client screen `src/client/ReferenceData.tsx`, styled as a modal panel
like `Onboarding.tsx`/`TaskDetail.tsx`:

- Lists existing sets (name + id).
- Selecting one shows a raw JSON textarea (`JSON.stringify(set.data, null, 2)`)
  and a name field, with Save (`PATCH`) and Delete (`DELETE`).
- A "new set" form: id, name, JSON textarea, Create (`POST`).
- JSON is parsed client-side before every `PATCH`/`POST`; a parse error is
  shown inline and the request isn't sent.

`src/client/App.tsx` gets a new header button ("Reference Data") and its own
`showReferenceData` boolean state — unlike `TypeConfirm`/`Onboarding`/
`TaskDetail`, this panel isn't scoped to a `selected` task, so it doesn't hang
off task selection.

No new client-side tests: there's no existing precedent in `tests/client/`
for rendering React components (`columns.test.ts` covers pure logic only),
and none of `TypeConfirm.tsx`/`Onboarding.tsx`/`TaskDetail.tsx` have render
tests either. This panel gets manual verification through `bun run dev`.

## Testing

- `tests/repo/referenceData.test.ts` — CRUD, mirroring
  `tests/repo/taskTypes.test.ts`: insert, get, list ordering, update, delete,
  duplicate-id rejection, invalid-slug rejection.
- Addition to `tests/pipeline/template.test.ts` — `{{data.foo}}` resolution
  and the missing-key-renders-empty case.
- Addition to `tests/pipeline/executor.test.ts` — a pipeline step whose
  prompt/input uses `{{data.*}}`, with `listReferenceData` supplied via
  `ExecutorDeps`, and a case where it's omitted (falls back to empty).
- Addition to `tests/api/server.test.ts` — the four routes, including the
  409/404 error paths.

## Manual verification

`bun run dev`, create a set via the UI (e.g. `team-roster`), reference it in
a pipeline step's prompt as `{{data.team-roster}}`, run a task through that
pipeline, and confirm the rendered prompt (visible in the step log / agent
transcript) contains the set's JSON.
