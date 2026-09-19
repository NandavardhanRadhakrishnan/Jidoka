# Wizard Path B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user describe an integration in plain language and have an agent write the extension, plus two generically useful additions the design required to make this trustworthy — testing a connected extension's `poll()` for real, and deleting an extension outright.

**Architecture:** A new generator module (`src/extensions/generator.ts`) mirrors `src/pipeline/builder.ts`'s retry-with-feedback shape but drives the tool-using `AgentRunner` interface instead of a plain completion. Generated drafts are staged in a temp directory plus an in-memory registry inside `src/api/extensions.ts`, never touching `extensionsDir` until approved. Six new routes cover generate/approve/discard/test-poll/delete/fix; the client gets a generate form, a draft review card, and Test/Fix/Delete row actions.

**Tech Stack:** Bun (`bun:sqlite`, `bun:test`), Hono, the existing `AgentRunner` interface (`src/agent/runner.ts`), React.

**Spec:** `docs/superpowers/specs/2026-09-20-extension-wizard-path-b-design.md`

## Global Constraints

- Bun only. No test hits a network — every `AgentRunner` in tests is a stub.
- `bun run typecheck` (`tsc --noEmit`) must stay clean after every task.
- Every `:id` route 404s with `{ error: "unknown extension" }` for an id `extensionsRepo.get` doesn't find, before doing anything else — the established pattern in `src/api/extensions.ts`.
- Staging copies files, never renames/moves them — the OS temp dir and `extensionsDir` can be on different drives, and a cross-drive rename fails outright.
- `test-poll` calls `source.poll(null)` directly, never through `pollOnce` — it must never insert a task row or store/advance a cursor.
- A fix's resulting `manifest.id` is always forced to equal the id being fixed, regardless of what the model returns.
- No generation provenance is tracked or persisted; no `config` field work; no server-enforced Test-before-Activate gate — all explicitly out of scope.

---

## Task 1: Generator module

**Files:**
- Create: `src/extensions/generator.ts`
- Test: `tests/extensions/generator.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `AgentRunInput`, `AgentRunResult` (`src/agent/runner.ts`, existing); `ExtensionManifestSchema`, `ExtensionManifest` (`src/domain/extension.ts`, existing); `ExtensionSourceDeps`, `TaskSource` (`src/sources/types.ts`, existing).
- Produces: `GenerateInput` (`{ kind: "create", description: string }`), `FixInput` (`{ kind: "fix", targetId: string, currentManifest: string, currentSource: string, error: string }`), `GeneratedExtension` (`{ manifest: ExtensionManifest, source: string }`), `generateExtension(runAgent: AgentRunner, input: GenerateInput | FixInput, allowedTools: string[]): Promise<GeneratedExtension>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/extensions/generator.test.ts
import { test, expect } from "bun:test";
import { generateExtension } from "../../src/extensions/generator";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "../../src/agent/runner";

function scripted(replies: string[]): AgentRunner & { calls: AgentRunInput[] } {
  let i = 0;
  return {
    id: "stub",
    calls: [],
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      this.calls.push(input);
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
}

const validManifest = JSON.stringify({
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  summary: "Reads demo items.",
  readOnly: true,
  auth: { mode: "api-key", label: "Token" },
});

const validSource = `export function createSource(deps) {
  return {
    async poll(cursor) {
      return { items: [], cursor };
    },
  };
}`;

function fenced(json: string, source: string): string {
  return `\`\`\`json\n${json}\n\`\`\`\n\`\`\`typescript\n${source}\n\`\`\``;
}

test("generateExtension returns a validated manifest and source on the first try", async () => {
  const runner = scripted([fenced(validManifest, validSource)]);

  const result = await generateExtension(
    runner,
    { kind: "create", description: "A demo integration" },
    ["notion__search"],
  );

  expect(result.manifest.id).toBe("demo");
  expect(result.source).toContain("createSource");
  expect(runner.calls[0]?.allowedTools).toEqual(["notion__search"]);
  expect(runner.calls[0]?.prompt).toContain("A demo integration");
});

test("generateExtension retries with feedback when the manifest fails schema validation", async () => {
  const runner = scripted([
    fenced(JSON.stringify({ id: "demo" }), validSource),
    fenced(validManifest, validSource),
  ]);

  const result = await generateExtension(runner, { kind: "create", description: "d" }, []);

  expect(result.manifest.id).toBe("demo");
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls[1]?.prompt).toContain("rejected");
});

test("generateExtension retries when source.ts does not export createSource", async () => {
  const runner = scripted([
    fenced(validManifest, `export const notCreateSource = 1;`),
    fenced(validManifest, validSource),
  ]);

  const result = await generateExtension(runner, { kind: "create", description: "d" }, []);

  expect(result.source).toContain("createSource");
  expect(runner.calls).toHaveLength(2);
});

test("generateExtension retries when createSource throws", async () => {
  const runner = scripted([
    fenced(validManifest, `export function createSource() { throw new Error("boom"); }`),
    fenced(validManifest, validSource),
  ]);

  const result = await generateExtension(runner, { kind: "create", description: "d" }, []);

  expect(result.source).toContain("createSource");
});

test("generateExtension throws after both attempts fail", async () => {
  const runner = scripted(["no fenced blocks here", "still nothing"]);

  await expect(
    generateExtension(runner, { kind: "create", description: "d" }, []),
  ).rejects.toThrow(/failed after a retry/);
});

test("a fix pins manifest.id to targetId even if the model changes it", async () => {
  const renamedManifest = JSON.stringify({
    id: "renamed-by-model",
    name: "Demo",
    version: "1.0.0",
    summary: "Reads demo items.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });
  const runner = scripted([fenced(renamedManifest, validSource)]);

  const result = await generateExtension(
    runner,
    {
      kind: "fix",
      targetId: "demo",
      currentManifest: validManifest,
      currentSource: validSource,
      error: "401 unauthorized",
    },
    [],
  );

  expect(result.manifest.id).toBe("demo");
  expect(runner.calls[0]?.prompt).toContain("401 unauthorized");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/extensions/generator.test.ts`
Expected: FAIL — `src/extensions/generator.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/extensions/generator.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRunner } from "../agent/runner";
import { ExtensionManifestSchema, type ExtensionManifest } from "../domain/extension";
import type { ExtensionSourceDeps, TaskSource } from "../sources/types";

export interface GenerateInput {
  kind: "create";
  description: string;
}

export interface FixInput {
  kind: "fix";
  targetId: string;
  currentManifest: string;
  currentSource: string;
  error: string;
}

export interface GeneratedExtension {
  manifest: ExtensionManifest;
  source: string;
}

const SYSTEM_PROMPT = `You write Jidoka extensions: a manifest.json describing an integration and a source.ts that polls it.

Reply with exactly two fenced code blocks, in this order:

\`\`\`json
{ "id": "...", "name": "...", "version": "1.0.0", "summary": "...", "readOnly": true, "auth": { ... } }
\`\`\`

\`\`\`typescript
export function createSource(deps) {
  return {
    async poll(cursor) {
      // return { items: [...], cursor: "..." }
    },
  };
}
\`\`\`

Manifest rules:
- "id" is a short kebab-case identifier for the integration (e.g. "notion", "linear-issues").
- "summary" is one plain-language sentence describing what it reads, shown to a non-technical user reviewing whether to install it. Do not describe the code.
- "readOnly" is true unless the description explicitly asks for writing back to the target system.
- "auth" must be exactly one of these three shapes:
  { "mode": "api-key", "label": "<what to prompt the user for, e.g. 'Personal Access Token'>" }
  { "mode": "oauth2-device-code", "deviceCodeUrl": "...", "tokenUrl": "...", "clientId": "...", "scopes": [...] }
  { "mode": "oauth2-auth-code-pkce", "authorizeUrl": "...", "tokenUrl": "...", "clientId": "...", "scopes": [...] }
  Pick whichever the target API actually supports, using real values from its real documentation. If the target has no public OAuth client id, prefer "api-key" instead of inventing one.

source.ts rules:
- Export exactly one function: createSource(deps) -> { poll(cursor) }. Do not add TypeScript type annotations or import anything from Jidoka's own source tree — nothing resolves that path at runtime; write plain, untyped JavaScript-shaped code.
- "deps.getToken()" returns a Promise<string> — the current valid token or API key. Call it inside poll(), never store it.
- "poll(cursor)" takes the last cursor (a string, or null on the first call) and must return { items: RawItem[], cursor: string | null }.
- Each RawItem is { externalId: string, title: string, body: string, url?: string, metadata?: Record<string, unknown> }. "externalId" must be stable and unique per item — it is used to avoid re-ingesting the same item twice.
- Use "cursor" to avoid re-fetching items already seen; do not keep in-memory state across calls — poll() may run in a fresh process.`;

function userMessage(input: GenerateInput | FixInput, feedback?: string): string {
  const base =
    input.kind === "create"
      ? `Build an extension for this: ${input.description}`
      : `This extension (id "${input.targetId}") failed a real test run. Fix it.

Current manifest.json:
${input.currentManifest}

Current source.ts:
${input.currentSource}

The error from testing it against the real API:
${input.error}`;

  return feedback
    ? `${base}\n\nYour previous attempt was rejected: ${feedback}\nFix it and reply with corrected output.`
    : base;
}

function extractBlocks(text: string): { json: string; source: string } | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  const sourceMatch = text.match(/```(?:typescript|ts|javascript|js)\s*([\s\S]*?)```/);
  if (!jsonMatch || !sourceMatch) return null;
  return { json: jsonMatch[1]!.trim(), source: sourceMatch[1]!.trim() };
}

async function checkSourceShape(source: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "jidoka-gen-"));
  const path = join(dir, "source.ts");
  await writeFile(path, source);
  try {
    const mod = (await import(pathToFileURL(path).href)) as {
      createSource?: (deps: ExtensionSourceDeps) => TaskSource;
    };
    if (typeof mod.createSource !== "function") {
      return "source.ts must export a function named createSource";
    }
    const created = mod.createSource({ getToken: async () => "stub-token" });
    if (!created || typeof created.poll !== "function") {
      return "createSource(deps) must return an object with a poll(cursor) function";
    }
    return null;
  } catch (error) {
    return `source.ts threw while loading: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function generateExtension(
  runAgent: AgentRunner,
  input: GenerateInput | FixInput,
  allowedTools: string[],
): Promise<GeneratedExtension> {
  let feedback: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runAgent.run({
      systemPrompt: SYSTEM_PROMPT,
      prompt: userMessage(input, feedback),
      allowedTools,
      maxTurns: 10,
    });

    const blocks = extractBlocks(result.text);
    if (!blocks) {
      feedback = "reply must contain exactly one ```json``` block and one ```typescript``` block";
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(blocks.json);
    } catch (error) {
      feedback = `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }

    const manifestResult = ExtensionManifestSchema.safeParse(parsedJson);
    if (!manifestResult.success) {
      feedback = manifestResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      continue;
    }

    const shapeError = await checkSourceShape(blocks.source);
    if (shapeError) {
      feedback = shapeError;
      continue;
    }

    const manifest =
      input.kind === "fix" ? { ...manifestResult.data, id: input.targetId } : manifestResult.data;

    return { manifest, source: blocks.source };
  }

  throw new Error(`extension generator failed after a retry: ${feedback}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/generator.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 6: Commit**

```bash
git add src/extensions/generator.ts tests/extensions/generator.test.ts
git commit -m "feat: add the extension generator"
```

---

## Task 2: Generate/Approve/Discard routes + registry + main.ts wiring

**Files:**
- Modify: `src/api/extensions.ts`
- Modify: `src/main.ts`
- Modify: `tests/api/extensions.test.ts`

**Interfaces:**
- Consumes: `generateExtension`, `GenerateInput` (Task 1, `src/extensions/generator.ts`); `AgentRunner` (`src/agent/runner.ts`, existing); `ToolSpec` (`src/ai/provider.ts`, existing).
- Produces: `ExtensionRoutesDeps` gains `runAgent: AgentRunner` and `listTools: () => ToolSpec[]`. New routes: `POST /api/extensions/generate` → `{ generationId, manifest }` or `{ error }` (502); `POST /api/extensions/generate/:id/approve` → `{ extensionId }`, 404 if unknown, 409 on a fresh collision; `POST /api/extensions/generate/:id/discard` → `{ discarded: true }`.

- [ ] **Step 1: Extend the test file's `setup()` helper and imports**

In `tests/api/extensions.test.ts`, add to the existing imports:

```typescript
import { mkdir, readFile, rm } from "node:fs/promises";
import type { AgentRunner } from "../../src/agent/runner";
```

(`mkdtemp`, `writeFile`, `tmpdir`, `join` are already imported — `mkdir`/`readFile`/`rm` are new, add them alongside `mkdtemp, writeFile` in the existing `node:fs/promises` import line rather than a second import line.)

Replace the existing `setup` function with:

```typescript
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
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/api/extensions.test.ts`:

```typescript
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
  const { fetch } = await setup({ runAgent });

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/api/extensions.test.ts`
Expected: FAIL — the routes don't exist yet, and `setup()`/`createExtensionRoutes` don't accept `runAgent`/`listTools` yet.

- [ ] **Step 4: Write the implementation**

In `src/api/extensions.ts`, update imports:

```typescript
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { mkdtemp, mkdir, copyFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extensionsRepo from "../repo/extensions";
import { discoverExtensions } from "../extensions/discovery";
import { generateExtension, type GeneratedExtension } from "../extensions/generator";
import { AuthPendingError, type Vault } from "../vault/vault";
import type { AgentRunner } from "../agent/runner";
import type { ToolSpec } from "../ai/provider";
import type { ExtensionManifest } from "../domain/extension";
```

Add to `ExtensionRoutesDeps`:

```typescript
export interface ExtensionRoutesDeps {
  db: Database;
  vault: Vault;
  extensionsDir: string;
  runAgent: AgentRunner;
  listTools: () => ToolSpec[];
}
```

Add, right after the `errorMessage` helper function:

```typescript
interface PendingGeneration {
  tempDir: string;
  manifest: ExtensionManifest;
  mode: "create" | "fix";
  targetId: string;
}
```

Inside `createExtensionRoutes`, right after `const app = new Hono();`, add the registry and a helper for id collisions:

```typescript
  const pending = new Map<string, PendingGeneration>();

  function uniqueId(baseId: string): string {
    const taken = new Set([
      ...extensionsRepo.list(deps.db).map((r) => r.id),
      ...[...pending.values()].map((p) => p.targetId),
    ]);
    if (!taken.has(baseId)) return baseId;
    let n = 2;
    while (taken.has(`${baseId}-${n}`)) n++;
    return `${baseId}-${n}`;
  }

  async function stageDraft(
    generated: GeneratedExtension,
    mode: "create" | "fix",
    targetId: string,
  ): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), "jidoka-ext-draft-"));
    await writeFile(join(tempDir, "manifest.json"), JSON.stringify(generated.manifest, null, 2));
    await writeFile(join(tempDir, "source.ts"), generated.source);
    const generationId = crypto.randomUUID();
    pending.set(generationId, { tempDir, manifest: generated.manifest, mode, targetId });
    return generationId;
  }
```

Add these three routes (placement: anywhere among the other routes before `return app;` — grouping them together after the existing `/rescan` route reads naturally):

```typescript
  app.post("/api/extensions/generate", async (c) => {
    let body: { description?: string } | null;
    try {
      body = (await c.req.json()) as { description?: string };
    } catch {
      body = null;
    }
    if (!body?.description?.trim()) return c.json({ error: "description is required" }, 400);

    try {
      const allowedTools = deps.listTools().map((t) => t.name);
      const generated = await generateExtension(
        deps.runAgent,
        { kind: "create", description: body.description },
        allowedTools,
      );
      const targetId = uniqueId(generated.manifest.id);
      const manifest = { ...generated.manifest, id: targetId };
      const generationId = await stageDraft({ manifest, source: generated.source }, "create", targetId);

      return c.json({ generationId, manifest });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  app.post("/api/extensions/generate/:id/approve", async (c) => {
    const generationId = c.req.param("id");
    const entry = pending.get(generationId);
    if (!entry) return c.json({ error: "unknown or expired generation" }, 404);

    const targetDir = join(deps.extensionsDir, entry.targetId);

    if (entry.mode === "create") {
      const exists = await stat(targetDir)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        return c.json({ error: `an extension named "${entry.targetId}" already exists` }, 409);
      }
    }

    try {
      await mkdir(targetDir, { recursive: true });
      await copyFile(join(entry.tempDir, "manifest.json"), join(targetDir, "manifest.json"));
      await copyFile(join(entry.tempDir, "source.ts"), join(targetDir, "source.ts"));
    } catch (error) {
      await rm(targetDir, { recursive: true, force: true });
      return c.json({ error: errorMessage(error) }, 500);
    }

    await rm(entry.tempDir, { recursive: true, force: true });
    pending.delete(generationId);
    await discoverExtensions(deps.db, deps.extensionsDir);

    return c.json({ extensionId: entry.targetId });
  });

  app.post("/api/extensions/generate/:id/discard", async (c) => {
    const generationId = c.req.param("id");
    const entry = pending.get(generationId);
    if (!entry) return c.json({ error: "unknown or expired generation" }, 404);

    await rm(entry.tempDir, { recursive: true, force: true });
    pending.delete(generationId);

    return c.json({ discarded: true });
  });
```

- [ ] **Step 5: Wire `runAgent`/`listTools` into `main.ts`**

In `src/main.ts`, change the `createExtensionRoutes({...})` call inside `createApp` to:

```typescript
  extraRoutes.route(
    "/",
    createExtensionRoutes({
      db,
      vault,
      extensionsDir: config.extensionsDir,
      runAgent,
      listTools: () => mcp.listTools(),
    }),
  );
```

(`runAgent` and `mcp` are both already in scope at this point in `createApp` — no new imports needed.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/api/extensions.test.ts`
Expected: PASS (all existing tests plus the 7 new ones)

- [ ] **Step 7: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 8: Commit**

```bash
git add src/api/extensions.ts src/main.ts tests/api/extensions.test.ts
git commit -m "feat: add generate/approve/discard extension routes"
```

---

## Task 3: Test-poll + Delete routes

**Files:**
- Modify: `src/extensions/runtime.ts`
- Modify: `src/repo/extensions.ts`
- Modify: `src/api/extensions.ts`
- Modify: `tests/extensions/runtime.test.ts`
- Modify: `tests/api/extensions.test.ts`

**Interfaces:**
- Produces: `loadOneExtensionSource(db, extensionsDir, vault, id): Promise<TaskSource>` (`src/extensions/runtime.ts`); `extensionsRepo.remove(db, id): void` (`src/repo/extensions.ts`); routes `POST /api/extensions/:id/test-poll` → `{ itemCount, sample }` or `{ error }` (400); `POST /api/extensions/:id/delete` → `{ deleted: true }`.

- [ ] **Step 1: Write the failing test for `loadOneExtensionSource`**

Add to `tests/extensions/runtime.test.ts` (this file already has `freshDb`, `freshDir`, `manifest`, `writeSource` helpers from Task 1 of the poller-wiring plan — reuse them):

```typescript
test("loadOneExtensionSource loads a single extension regardless of its enabled flag", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("solo"));
  // deliberately not enabled
  await writeSource(
    dir,
    "solo",
    `export function createSource() {
      return { async poll() { return { items: [], cursor: "solo-cursor" }; } };
    }`,
  );
  const vault = createVault({ db });

  const source = await loadOneExtensionSource(db, dir, vault, "solo");

  expect(source.id).toBe("solo");
  expect((await source.poll(null)).cursor).toBe("solo-cursor");
});

test("loadOneExtensionSource throws for an unknown id", async () => {
  const db = freshDb();
  const dir = await freshDir();
  const vault = createVault({ db });

  await expect(loadOneExtensionSource(db, dir, vault, "ghost")).rejects.toThrow(/unknown extension/);
});
```

Add `loadOneExtensionSource` to the existing import line from `../../src/extensions/runtime`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/extensions/runtime.test.ts`
Expected: FAIL — `loadOneExtensionSource` is not exported yet.

- [ ] **Step 3: Extract `loadOneExtensionSource` and have the bulk loader reuse it**

Replace the full contents of `src/extensions/runtime.ts` with:

```typescript
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import type { Vault } from "../vault/vault";
import type { ExtensionSourceDeps, TaskSource } from "../sources/types";

export async function loadOneExtensionSource(
  db: Database,
  extensionsDir: string,
  vault: Vault,
  id: string,
): Promise<TaskSource> {
  const record = extensionsRepo.get(db, id);
  if (!record) throw new Error(`unknown extension: ${id}`);
  const modulePath = pathToFileURL(join(extensionsDir, id, "source.ts")).href;
  const mod = (await import(modulePath)) as {
    createSource?: (deps: ExtensionSourceDeps) => TaskSource;
  };
  if (typeof mod.createSource !== "function") {
    throw new Error(`${id}: source.ts does not export createSource()`);
  }
  const source = mod.createSource({ getToken: () => vault.getToken(id) });
  return { id: record.id, poll: source.poll.bind(source) };
}

export async function loadEnabledExtensionSources(
  db: Database,
  extensionsDir: string,
  vault: Vault,
): Promise<TaskSource[]> {
  const records = extensionsRepo.list(db).filter((record) => record.enabled && record.valid);

  const sources: TaskSource[] = [];
  for (const record of records) {
    try {
      sources.push(await loadOneExtensionSource(db, extensionsDir, vault, record.id));
    } catch (error) {
      console.error(`[extensions] failed to load source for ${record.id}:`, error);
    }
  }
  return sources;
}
```

This is a pure extraction — `loadEnabledExtensionSources`'s behavior (filtering, per-extension error isolation, `this`-binding) is unchanged, just implemented by calling the newly-extracted single-extension function.

- [ ] **Step 4: Run the full `runtime.test.ts` file to confirm no regression, plus the new tests**

Run: `bun test tests/extensions/runtime.test.ts`
Expected: PASS (all pre-existing tests plus the 2 new ones — the extraction must not change any existing test's outcome)

- [ ] **Step 5: Add `remove` to the extensions repo**

Add to `src/repo/extensions.ts`, after `setEnabled`:

```typescript
export function remove(db: Database, id: string): void {
  db.query("DELETE FROM extensions WHERE id = ?").run(id);
}
```

(`extension_credentials.extension_id` has `ON DELETE CASCADE` and `PRAGMA foreign_keys = ON` is always set — deleting the extensions row automatically removes its stored credential too.)

- [ ] **Step 6: Write the failing route tests**

Add to `tests/api/extensions.test.ts`:

```typescript
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
```

Add these imports to `tests/api/extensions.test.ts`: `getCursor` from `../../src/repo/sourceState`, `listTasks` from `../../src/repo/tasks`.

- [ ] **Step 7: Run tests to verify they fail**

Run: `bun test tests/api/extensions.test.ts`
Expected: FAIL — the two routes don't exist yet.

- [ ] **Step 8: Write the route implementations**

Add to the imports at the top of `src/api/extensions.ts`: `loadOneExtensionSource` from `../extensions/runtime`.

Add these two routes to `src/api/extensions.ts`:

```typescript
  app.post("/api/extensions/:id/test-poll", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    try {
      const source = await loadOneExtensionSource(deps.db, deps.extensionsDir, deps.vault, id);
      const result = await source.poll(null);
      return c.json({ itemCount: result.items.length, sample: result.items.slice(0, 3) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/extensions/:id/delete", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    deps.vault.disconnect(id);
    extensionsRepo.remove(deps.db, id);
    await rm(join(deps.extensionsDir, id), { recursive: true, force: true });
    return c.json({ deleted: true });
  });
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `bun test tests/api/extensions.test.ts`
Expected: PASS

- [ ] **Step 10: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 11: Commit**

```bash
git add src/extensions/runtime.ts src/repo/extensions.ts src/api/extensions.ts tests/extensions/runtime.test.ts tests/api/extensions.test.ts
git commit -m "feat: add test-poll and delete extension routes"
```

---

## Task 4: Fix route

**Files:**
- Modify: `src/api/extensions.ts`
- Modify: `tests/api/extensions.test.ts`

**Interfaces:**
- Consumes: `generateExtension` in `"fix"` mode (Task 1); `stageDraft`, `pending`, `uniqueId` (Task 2, already inside `createExtensionRoutes`'s closure — `fix` reuses `stageDraft` directly, it does not need `uniqueId` since the target id is already fixed).
- Produces: `POST /api/extensions/:id/fix` → `{ generationId, manifest }` or `{ error }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/extensions.test.ts`:

```typescript
test("fix reads the current files and stages a corrected draft under the same id", async () => {
  const fixedManifest = { ...apiKeyManifest, id: "renamed-by-model" };
  const fixedSource = `export function createSource(deps) {
    return { async poll(cursor) { return { items: [], cursor }; } };
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
    `export function createSource() { return { async poll() { throw new Error("bad url"); } }; }`,
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
  expect(sourceAfterFix).toContain("cursor");
  expect(sourceAfterFix).not.toContain("bad url");
});

test("fix requires a non-empty error", async () => {
  const { fetch, dir, db } = await setup();
  await writeManifest(dir, "notion", apiKeyManifest);
  await mkdir(join(dir, "notion"), { recursive: true });
  await writeFile(
    join(dir, "notion", "source.ts"),
    `export function createSource() { return { async poll() { return { items: [], cursor: null }; } }; }`,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/api/extensions.test.ts`
Expected: FAIL — the fix route doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Add `readFile` to the `node:fs/promises` import line in `src/api/extensions.ts` (already imports `mkdtemp, mkdir, copyFile, rm, stat, writeFile` from Task 2 — add `readFile` to that same line).

Add this route to `src/api/extensions.ts`:

```typescript
  app.post("/api/extensions/:id/fix", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    let body: { error?: string } | null;
    try {
      body = (await c.req.json()) as { error?: string };
    } catch {
      body = null;
    }
    if (!body?.error?.trim()) return c.json({ error: "error is required" }, 400);

    let currentManifest: string;
    let currentSource: string;
    try {
      currentManifest = await readFile(join(deps.extensionsDir, id, "manifest.json"), "utf8");
      currentSource = await readFile(join(deps.extensionsDir, id, "source.ts"), "utf8");
    } catch (error) {
      return c.json({ error: `could not read current extension files: ${errorMessage(error)}` }, 500);
    }

    try {
      const allowedTools = deps.listTools().map((t) => t.name);
      const generated = await generateExtension(
        deps.runAgent,
        { kind: "fix", targetId: id, currentManifest, currentSource, error: body.error },
        allowedTools,
      );
      const generationId = await stageDraft(generated, "fix", id);

      return c.json({ generationId, manifest: generated.manifest });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/api/extensions.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 6: Commit**

```bash
git add src/api/extensions.ts tests/api/extensions.test.ts
git commit -m "feat: add the fix extension route"
```

---

## Task 5: Client UI

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/Extensions.tsx`

**Interfaces:**
- Consumes: all six routes from Tasks 2-4.
- Produces: `GeneratedManifest`, `GenerationDraft` types and `api.generateExtension/approveGeneration/discardGeneration/testPoll/deleteExtension/fixExtension` (`src/client/api.ts`).

No automated tests for this task — matches this codebase's existing convention for `.tsx` files. Verified manually per the last step.

- [ ] **Step 1: Add types and API calls to `src/client/api.ts`**

Add near `ExtensionListItem`:

```typescript
export interface GeneratedManifest {
  id: string;
  name: string;
  summary: string;
  readOnly: boolean;
  auth: ExtensionAuth;
}

export interface GenerationDraft {
  generationId: string;
  manifest: GeneratedManifest;
}
```

Add to the `api` object:

```typescript
  generateExtension: (description: string) =>
    json<GenerationDraft>("/api/extensions/generate", {
      method: "POST",
      body: JSON.stringify({ description }),
    }),
  approveGeneration: (generationId: string) =>
    json<{ extensionId: string }>(`/api/extensions/generate/${generationId}/approve`, {
      method: "POST",
    }),
  discardGeneration: (generationId: string) =>
    json<{ discarded: true }>(`/api/extensions/generate/${generationId}/discard`, { method: "POST" }),
  testPoll: (id: string) =>
    json<{ itemCount: number; sample: { externalId: string; title: string; body: string }[] }>(
      `/api/extensions/${id}/test-poll`,
      { method: "POST" },
    ),
  deleteExtension: (id: string) =>
    json<{ deleted: true }>(`/api/extensions/${id}/delete`, { method: "POST" }),
  fixExtension: (id: string, error: string) =>
    json<GenerationDraft>(`/api/extensions/${id}/fix`, {
      method: "POST",
      body: JSON.stringify({ error }),
    }),
```

- [ ] **Step 2: Add state, handlers, and JSX to `src/client/Extensions.tsx`**

Update the import line at the top:

```typescript
import { api, type ExtensionListItem, type GenerationDraft } from "./api";
```

Add these state declarations inside the `Extensions` component, alongside the existing ones:

```typescript
  const [draft, setDraft] = useState<GenerationDraft | null>(null);
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [testResults, setTestResults] = useState<
    Record<string, { itemCount: number } | { error: string } | undefined>
  >({});
```

Add these handlers, alongside the existing ones (e.g. after `disconnect`):

```typescript
  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      const result = await api.generateExtension(description);
      setDraft(result);
      setDescription("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function approveDraft() {
    if (!draft) return;
    setError(null);
    try {
      await api.approveGeneration(draft.generationId);
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function discardDraft() {
    if (!draft) return;
    try {
      await api.discardGeneration(draft.generationId);
    } finally {
      setDraft(null);
    }
  }

  async function testPoll(id: string) {
    try {
      const result = await api.testPoll(id);
      setTestResults((prev) => ({ ...prev, [id]: { itemCount: result.itemCount } }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  async function fix(id: string) {
    const result = testResults[id];
    if (!result || !("error" in result)) return;
    setError(null);
    try {
      const draftResult = await api.fixExtension(id, result.error);
      setDraft(draftResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteExtension(id: string) {
    if (!window.confirm(`Delete "${id}"? This removes it and its credentials permanently.`)) return;
    setError(null);
    try {
      await api.deleteExtension(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function testResultView(id: string) {
    const result = testResults[id];
    if (!result) return null;
    if ("error" in result) {
      return (
        <>
          <p className="error">✗ {result.error}</p>
          <button className="link" onClick={() => fix(id)}>
            Fix
          </button>
        </>
      );
    }
    return <p className="meta">✓ {result.itemCount} item(s) found</p>;
  }
```

In the JSX, add the generate form and draft card right after the `<button onClick={rescan}>Rescan</button>` line:

```typescript
          <div className="connect-form">
            <label>
              Describe the integration
              <textarea
                rows={3}
                placeholder="e.g. Reads pages from my Notion databases"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <button disabled={generating || !description.trim()} onClick={generate}>
              {generating ? "Generating…" : "Generate"}
            </button>
          </div>

          {draft && (
            <div className="extension-row">
              <strong>{draft.manifest.name}</strong>
              <p>{draft.manifest.summary}</p>
              <p className="meta">
                {draft.manifest.readOnly ? "Read-only" : "Can write"} · {draft.manifest.auth.mode}
              </p>
              <button onClick={approveDraft}>Approve</button>
              <button className="secondary" onClick={discardDraft}>
                Discard
              </button>
            </div>
          )}
```

Inside the `extensions.map((ext) => ...)` block, add the Test/Delete buttons right after the existing `{ext.status === "connected" && !ext.enabled && (...Activate...)}` block and before the closing `</div>` of each row:

```typescript
              {ext.status === "connected" && (
                <button className="link" onClick={() => testPoll(ext.id)}>
                  Test
                </button>
              )}

              {testResultView(ext.id)}

              <button className="link" onClick={() => deleteExtension(ext.id)}>
                Delete
              </button>
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 4: Manual verification**

This step requires a working `AiProvider`/`AgentRunner` configured (an `ANTHROPIC_API_KEY`, or `JIDOKA_AI_PROVIDER=agent-sdk` with a Claude Code CLI login) — generation calls a real model. Run `bun run dev` and open `http://localhost:3000`, open the Extensions panel:

- Type a description (e.g. "Reads issues from a fake test API") and click Generate. Verify a busy state shows, then either a draft review card appears (name/summary/readOnly/auth mode) or a clear error is shown if generation failed — either outcome is fine to observe here, since model output isn't deterministic; what matters is the UI reaches one of those two states correctly, not a specific generated result.
- If a draft appears, click Discard and confirm it disappears and never shows up in the installed list.
- Generate again, click Approve, and confirm the new row appears in the installed list exactly like a hand-written extension (open its folder on disk to confirm `manifest.json`/`source.ts` were actually written).
- Using the demo `api-key` fixture from the wizard plan's own manual verification (or the newly-generated one, if its auth mode is `api-key`), Connect it, then click Test — verify it shows either a result count or an error inline, and that Fix/Delete appear only after a failing Test.
- Click Delete on any extension and confirm it disappears and does not reappear after clicking Rescan.

- [ ] **Step 5: Commit**

```bash
git add src/client/api.ts src/client/Extensions.tsx
git commit -m "feat: add the generate/test/fix/delete extension UI"
```
