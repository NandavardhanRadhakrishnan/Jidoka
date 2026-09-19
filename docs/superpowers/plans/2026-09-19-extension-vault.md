# Extension Vault & Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend half of the extension system — a closed-set credential vault (device-code, auth-code+PKCE, api-key) that owns all auth-flow protocol logic, and extension discovery that validates a folder of manifests into the database. No UI, no wizard, no poller wiring — those are a follow-on plan once this exists.

**Architecture:** Extensions are plain folders (`extensions/<id>/manifest.json` + `source.ts`); a manifest is validated with Zod and upserted into a new `extensions` table, never trusting extension code until it's both valid and enabled. The vault reuses the codebase's existing provider-agnostic OAuth pieces (`src/auth/oauth.ts`'s PKCE flow, and a newly-generalized device-code flow) rather than letting any extension implement auth itself; credentials live in a new `extension_credentials` table, separate from the existing Outlook-specific `oauth_tokens` table.

**Tech Stack:** Bun (`bun:sqlite`, `bun:test`), Zod, `node:fs/promises` for folder scanning.

**Spec:** `docs/superpowers/specs/2026-09-19-extension-vault-design.md`

## Global Constraints

- Bun only — no Node-specific APIs beyond what's already used elsewhere in this codebase (`node:fs/promises`, `node:path`, `node:os` are already used in `tests/sources/sampleFolder.test.ts` and are fine).
- No test hits a network: every HTTP call takes an injectable `fetch`, every clock reference takes an injectable `now()`, matching `src/auth/oauth.ts` and `src/sources/outlook/auth.ts`.
- `bun run typecheck` (`tsc --noEmit`) must stay clean after every task.
- IDs are `crypto.randomUUID()` where a fresh ID is needed; extension IDs come from the folder name / manifest instead (see Task 6).
- Credential expiry/update timestamps are epoch-ms integers, matching the existing `oauth_tokens.expires_at` column — not the ISO-8601 strings used for task/pipeline `created_at`/`updated_at`.
- `src/repo/` is the only place SQL lives; one module per table.

---

## Task 1: Extension manifest schema

**Files:**
- Create: `src/domain/extension.ts`
- Test: `tests/domain/extension.test.ts`

**Interfaces:**
- Produces: `ExtensionManifestSchema` (Zod schema), `ExtensionManifest` type, `ExtensionAuth` type, `AuthMode` type (`"oauth2-device-code" | "oauth2-auth-code-pkce" | "api-key"`), and the three per-mode auth shapes: `{ mode: "oauth2-device-code", deviceCodeUrl, tokenUrl, clientId, scopes }`, `{ mode: "oauth2-auth-code-pkce", authorizeUrl, tokenUrl, clientId, scopes }`, `{ mode: "api-key", label }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/domain/extension.test.ts
import { test, expect } from "bun:test";
import { ExtensionManifestSchema } from "../../src/domain/extension";

const base = {
  id: "notion",
  name: "Notion",
  version: "1.0.0",
  summary: "Reads pages from the databases you select.",
  readOnly: true,
};

test("a valid api-key manifest parses", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: { mode: "api-key", label: "Personal Access Token" },
  });
  expect(result.success).toBe(true);
});

test("a valid device-code manifest parses", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: {
      mode: "oauth2-device-code",
      deviceCodeUrl: "https://example.com/devicecode",
      tokenUrl: "https://example.com/token",
      clientId: "client-1",
      scopes: ["read"],
    },
  });
  expect(result.success).toBe(true);
});

test("a valid auth-code+PKCE manifest parses, and expectedMcpServer is optional", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: {
      mode: "oauth2-auth-code-pkce",
      authorizeUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      clientId: "client-1",
      scopes: ["read"],
    },
    expectedMcpServer: "notion",
  });
  expect(result.success).toBe(true);
  expect(result.data?.expectedMcpServer).toBe("notion");
});

test("a device-code auth block missing tokenUrl is rejected", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: {
      mode: "oauth2-device-code",
      deviceCodeUrl: "https://example.com/devicecode",
      clientId: "client-1",
      scopes: ["read"],
    },
  });
  expect(result.success).toBe(false);
});

test("an unknown auth mode is rejected", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: { mode: "basic-auth", username: "a", password: "b" },
  });
  expect(result.success).toBe(false);
});

test("readOnly and summary are required", () => {
  const { readOnly, ...withoutReadOnly } = base;
  const result = ExtensionManifestSchema.safeParse({
    ...withoutReadOnly,
    auth: { mode: "api-key", label: "Token" },
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/extension.test.ts`
Expected: FAIL — `src/domain/extension.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/domain/extension.ts
import { z } from "zod";

const DeviceCodeAuthSchema = z.object({
  mode: z.literal("oauth2-device-code"),
  deviceCodeUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.string()),
});

const AuthCodePkceAuthSchema = z.object({
  mode: z.literal("oauth2-auth-code-pkce"),
  authorizeUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.string()),
});

const ApiKeyAuthSchema = z.object({
  mode: z.literal("api-key"),
  label: z.string().min(1),
});

export const ExtensionAuthSchema = z.discriminatedUnion("mode", [
  DeviceCodeAuthSchema,
  AuthCodePkceAuthSchema,
  ApiKeyAuthSchema,
]);

export type ExtensionAuth = z.infer<typeof ExtensionAuthSchema>;
export type AuthMode = ExtensionAuth["mode"];

export const ExtensionManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  /** Plain-language capability summary, shown in the onboarding wizard's review step. */
  summary: z.string().min(1),
  readOnly: z.boolean(),
  auth: ExtensionAuthSchema,
  /** Name Jidoka tries to match against a configured MCP server. */
  expectedMcpServer: z.string().optional(),
  /** Schema for non-secret settings; values are collected by the wizard's Config step (not built yet). */
  config: z.record(z.string(), z.unknown()).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/domain/extension.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/extension.ts tests/domain/extension.test.ts
git commit -m "feat: add extension manifest schema"
```

---

## Task 2: Migrations + extensions repo

**Files:**
- Modify: `src/db/migrations.ts`
- Create: `src/repo/extensions.ts`
- Test: `tests/repo/extensions.test.ts`

**Interfaces:**
- Consumes: `ExtensionManifest`, `ExtensionAuth` from Task 1 (`src/domain/extension.ts`).
- Produces: `ExtensionRecord` type (`{ id, name, version, summary, readOnly, auth: ExtensionAuth | null, expectedMcpServer: string | null, enabled, valid, error: string | null }`), `upsertValid(db, manifest)`, `upsertInvalid(db, id, error)`, `get(db, id)`, `list(db)`, `setEnabled(db, id, enabled)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/repo/extensions.test.ts
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import * as extensions from "../../src/repo/extensions";
import type { ExtensionManifest } from "../../src/domain/extension";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const manifest: ExtensionManifest = {
  id: "notion",
  name: "Notion",
  version: "1.0.0",
  summary: "Reads pages from the databases you select.",
  readOnly: true,
  auth: { mode: "api-key", label: "Personal Access Token" },
};

test("upsertValid stores a manifest, disabled by default", () => {
  const db = freshDb();
  extensions.upsertValid(db, manifest);

  expect(extensions.get(db, "notion")).toEqual({
    id: "notion",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages from the databases you select.",
    readOnly: true,
    auth: { mode: "api-key", label: "Personal Access Token" },
    expectedMcpServer: null,
    enabled: false,
    valid: true,
    error: null,
  });
});

test("re-running upsertValid preserves the enabled flag", () => {
  const db = freshDb();
  extensions.upsertValid(db, manifest);
  extensions.setEnabled(db, "notion", true);

  extensions.upsertValid(db, { ...manifest, name: "Notion (updated)" });

  const record = extensions.get(db, "notion");
  expect(record?.enabled).toBe(true);
  expect(record?.name).toBe("Notion (updated)");
});

test("upsertInvalid records an error and no auth", () => {
  const db = freshDb();
  extensions.upsertInvalid(db, "broken", "manifest.json is not valid JSON: Unexpected token");

  const record = extensions.get(db, "broken");
  expect(record?.valid).toBe(false);
  expect(record?.auth).toBeNull();
  expect(record?.error).toBe("manifest.json is not valid JSON: Unexpected token");
  expect(record?.enabled).toBe(false);
});

test("setEnabled toggles only the named extension", () => {
  const db = freshDb();
  extensions.upsertValid(db, manifest);
  extensions.upsertValid(db, { ...manifest, id: "other" });

  extensions.setEnabled(db, "notion", true);

  expect(extensions.get(db, "notion")?.enabled).toBe(true);
  expect(extensions.get(db, "other")?.enabled).toBe(false);
});

test("list returns every extension ordered by id", () => {
  const db = freshDb();
  extensions.upsertValid(db, { ...manifest, id: "zeta" });
  extensions.upsertValid(db, { ...manifest, id: "alpha" });

  expect(extensions.list(db).map((record) => record.id)).toEqual(["alpha", "zeta"]);
});

test("get returns null for an unknown id", () => {
  const db = freshDb();
  expect(extensions.get(db, "nope")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/repo/extensions.test.ts`
Expected: FAIL — `src/repo/extensions.ts` does not exist and the table isn't migrated yet.

- [ ] **Step 3: Add the migrations**

Add two entries to the `MIGRATIONS` array in `src/db/migrations.ts`, after the existing `oauth_tokens` entry:

```typescript
  `CREATE TABLE IF NOT EXISTS extensions (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     version TEXT NOT NULL,
     summary TEXT NOT NULL,
     read_only INTEGER NOT NULL,
     auth_mode TEXT NOT NULL,
     auth_config TEXT NOT NULL,
     expected_mcp_server TEXT,
     enabled INTEGER NOT NULL DEFAULT 0,
     valid INTEGER NOT NULL DEFAULT 1,
     error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS extension_credentials (
     extension_id TEXT PRIMARY KEY REFERENCES extensions(id) ON DELETE CASCADE,
     auth_mode TEXT NOT NULL,
     payload TEXT NOT NULL,
     status TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
```

(`extension_credentials` is created now, in the same migration batch, even though Task 3 is what writes to it — `MIGRATIONS` is one append-only list and both tables belong together.)

- [ ] **Step 4: Write the implementation**

```typescript
// src/repo/extensions.ts
import type { Database } from "bun:sqlite";
import type { ExtensionAuth, ExtensionManifest } from "../domain/extension";

export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  summary: string;
  readOnly: boolean;
  auth: ExtensionAuth | null;
  expectedMcpServer: string | null;
  enabled: boolean;
  valid: boolean;
  error: string | null;
}

interface Row {
  id: string;
  name: string;
  version: string;
  summary: string;
  read_only: number;
  auth_mode: string;
  auth_config: string;
  expected_mcp_server: string | null;
  enabled: number;
  valid: number;
  error: string | null;
}

const COLUMNS =
  "id, name, version, summary, read_only, auth_mode, auth_config, expected_mcp_server, enabled, valid, error";

function toRecord(row: Row): ExtensionRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    summary: row.summary,
    readOnly: row.read_only === 1,
    auth: row.valid === 1 ? (JSON.parse(row.auth_config) as ExtensionAuth) : null,
    expectedMcpServer: row.expected_mcp_server,
    enabled: row.enabled === 1,
    valid: row.valid === 1,
    error: row.error,
  };
}

export function upsertValid(db: Database, manifest: ExtensionManifest): void {
  db.query(
    `INSERT INTO extensions (id, name, version, summary, read_only, auth_mode, auth_config, expected_mcp_server, enabled, valid, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       version = excluded.version,
       summary = excluded.summary,
       read_only = excluded.read_only,
       auth_mode = excluded.auth_mode,
       auth_config = excluded.auth_config,
       expected_mcp_server = excluded.expected_mcp_server,
       valid = 1,
       error = NULL`,
  ).run(
    manifest.id,
    manifest.name,
    manifest.version,
    manifest.summary,
    manifest.readOnly ? 1 : 0,
    manifest.auth.mode,
    JSON.stringify(manifest.auth),
    manifest.expectedMcpServer ?? null,
  );
}

export function upsertInvalid(db: Database, id: string, error: string): void {
  db.query(
    `INSERT INTO extensions (id, name, version, summary, read_only, auth_mode, auth_config, expected_mcp_server, enabled, valid, error)
     VALUES (?, '', '', '', 0, '', '{}', NULL, 0, 0, ?)
     ON CONFLICT (id) DO UPDATE SET valid = 0, error = excluded.error`,
  ).run(id, error);
}

export function get(db: Database, id: string): ExtensionRecord | null {
  const row = db.query(`SELECT ${COLUMNS} FROM extensions WHERE id = ?`).get(id) as Row | null;
  return row ? toRecord(row) : null;
}

export function list(db: Database): ExtensionRecord[] {
  const rows = db.query(`SELECT ${COLUMNS} FROM extensions ORDER BY id`).all() as Row[];
  return rows.map(toRecord);
}

export function setEnabled(db: Database, id: string, enabled: boolean): void {
  db.query("UPDATE extensions SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}
```

Note on `upsertValid`'s `ON CONFLICT`: it deliberately does not touch `enabled` — re-running discovery (Task 6) after editing a manifest must not silently disable/re-enable an extension the user already configured.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/repo/extensions.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations.ts src/repo/extensions.ts tests/repo/extensions.test.ts
git commit -m "feat: add extensions table and repo"
```

---

## Task 3: Extension credentials repo

**Files:**
- Create: `src/repo/extensionCredentials.ts`
- Test: `tests/repo/extensionCredentials.test.ts`

**Interfaces:**
- Consumes: the `extension_credentials` table migrated in Task 2.
- Produces: `CredentialStatus` type (`"connected" | "not_connected" | "needs_reauth"`), `StoredCredential` type (`{ authMode: string, payload: Record<string, unknown>, status: CredentialStatus, updatedAt: number }`), `save(db, extensionId, authMode, payload, status, updatedAt)`, `load(db, extensionId)`, `setStatus(db, extensionId, status)`, `remove(db, extensionId)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/repo/extensionCredentials.test.ts
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import * as credentials from "../../src/repo/extensionCredentials";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("save then load round-trips the payload", () => {
  const db = freshDb();
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);

  expect(credentials.load(db, "notion")).toEqual({
    authMode: "api-key",
    payload: { apiKey: "secret-1" },
    status: "connected",
    updatedAt: 1_000,
  });
});

test("saving again replaces the previous payload for the same extension", () => {
  const db = freshDb();
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);
  credentials.save(db, "notion", "api-key", { apiKey: "secret-2" }, "connected", 2_000);

  expect(credentials.load(db, "notion")?.payload).toEqual({ apiKey: "secret-2" });
});

test("setStatus changes only the status", () => {
  const db = freshDb();
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);

  credentials.setStatus(db, "notion", "needs_reauth");

  const stored = credentials.load(db, "notion");
  expect(stored?.status).toBe("needs_reauth");
  expect(stored?.payload).toEqual({ apiKey: "secret-1" });
});

test("remove deletes the stored credential", () => {
  const db = freshDb();
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);

  credentials.remove(db, "notion");

  expect(credentials.load(db, "notion")).toBeNull();
});

test("load returns null for an extension with no stored credential", () => {
  const db = freshDb();
  expect(credentials.load(db, "nope")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/repo/extensionCredentials.test.ts`
Expected: FAIL — `src/repo/extensionCredentials.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/repo/extensionCredentials.ts
import type { Database } from "bun:sqlite";

export type CredentialStatus = "connected" | "not_connected" | "needs_reauth";

export interface StoredCredential {
  authMode: string;
  payload: Record<string, unknown>;
  status: CredentialStatus;
  updatedAt: number;
}

export function save(
  db: Database,
  extensionId: string,
  authMode: string,
  payload: Record<string, unknown>,
  status: CredentialStatus,
  updatedAt: number,
): void {
  db.query(
    `INSERT INTO extension_credentials (extension_id, auth_mode, payload, status, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (extension_id) DO UPDATE SET
       auth_mode = excluded.auth_mode,
       payload = excluded.payload,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(extensionId, authMode, JSON.stringify(payload), status, updatedAt);
}

export function load(db: Database, extensionId: string): StoredCredential | null {
  const row = db
    .query(
      "SELECT auth_mode, payload, status, updated_at FROM extension_credentials WHERE extension_id = ?",
    )
    .get(extensionId) as
    | { auth_mode: string; payload: string; status: string; updated_at: number }
    | null;
  return row
    ? {
        authMode: row.auth_mode,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        status: row.status as CredentialStatus,
        updatedAt: row.updated_at,
      }
    : null;
}

export function setStatus(db: Database, extensionId: string, status: CredentialStatus): void {
  db.query("UPDATE extension_credentials SET status = ? WHERE extension_id = ?").run(
    status,
    extensionId,
  );
}

export function remove(db: Database, extensionId: string): void {
  db.query("DELETE FROM extension_credentials WHERE extension_id = ?").run(extensionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/repo/extensionCredentials.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/repo/extensionCredentials.ts tests/repo/extensionCredentials.test.ts
git commit -m "feat: add extension credentials repo"
```

---

## Task 4: Generalized device-code flow

**Files:**
- Create: `src/vault/deviceCode.ts`
- Test: `tests/vault/deviceCode.test.ts`

**Interfaces:**
- Produces: `HttpFetch` type, `DeviceCodeConfig` type (`{ deviceCodeUrl, tokenUrl, clientId, scopes }`), `DeviceLogin` type (`{ userCode, verificationUri, deviceCode, expiresIn, interval }`), `DeviceCodeTokens` type (`{ accessToken, refreshToken: string | null, expiresAt }`), `AuthPendingError` class, `startDeviceLogin(config, deps?)`, `completeDeviceLogin(config, deviceCode, deps?)`.

This lifts the device-code *initial exchange* out of `src/sources/outlook/auth.ts` and makes it provider-agnostic (explicit URLs instead of a `tenant`-built Microsoft URL). It deliberately does **not** include token refresh — refresh via `grant_type=refresh_token` is identical regardless of how the token was first obtained, so Task 5's vault reuses `src/auth/oauth.ts`'s existing `refreshTokens` for both OAuth modes instead of duplicating it here.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vault/deviceCode.test.ts
import { test, expect } from "bun:test";
import {
  startDeviceLogin,
  completeDeviceLogin,
  AuthPendingError,
  type DeviceCodeConfig,
  type HttpFetch,
} from "../../src/vault/deviceCode";

const config: DeviceCodeConfig = {
  deviceCodeUrl: "https://example.com/devicecode",
  tokenUrl: "https://example.com/token",
  clientId: "client-1",
  scopes: ["read", "write"],
};

test("startDeviceLogin posts client_id and scopes and maps the response", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const fakeFetch: HttpFetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body);
    return new Response(
      JSON.stringify({
        user_code: "ABCD-EFGH",
        device_code: "device-code-value",
        verification_uri: "https://example.com/activate",
        expires_in: 900,
        interval: 5,
      }),
      { status: 200 },
    );
  };

  const login = await startDeviceLogin(config, { fetch: fakeFetch });

  expect(capturedUrl).toBe(config.deviceCodeUrl);
  const body = new URLSearchParams(capturedBody);
  expect(body.get("client_id")).toBe("client-1");
  expect(body.get("scope")).toBe("read write");
  expect(login).toEqual({
    userCode: "ABCD-EFGH",
    deviceCode: "device-code-value",
    verificationUri: "https://example.com/activate",
    expiresIn: 900,
    interval: 5,
  });
});

test("startDeviceLogin throws when the request is not ok", async () => {
  const fakeFetch: HttpFetch = async () => new Response("", { status: 500 });
  await expect(startDeviceLogin(config, { fetch: fakeFetch })).rejects.toThrow(/500/);
});

test("completeDeviceLogin returns tokens on success", async () => {
  const fakeFetch: HttpFetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.get("device_code")).toBe("device-code-value");
    return new Response(
      JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      { status: 200 },
    );
  };

  const tokens = await completeDeviceLogin(config, "device-code-value", {
    fetch: fakeFetch,
    now: () => 1_000_000,
  });

  expect(tokens).toEqual({
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 1_000_000 + 3600 * 1000,
  });
});

test("completeDeviceLogin throws AuthPendingError while the user hasn't finished", async () => {
  const fakeFetch: HttpFetch = async () =>
    new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });

  await expect(completeDeviceLogin(config, "device-code-value", { fetch: fakeFetch })).rejects.toBeInstanceOf(
    AuthPendingError,
  );
});

test("completeDeviceLogin throws a descriptive error for any other failure", async () => {
  const fakeFetch: HttpFetch = async () =>
    new Response(JSON.stringify({ error: "expired_token", error_description: "device code expired" }), {
      status: 400,
    });

  await expect(completeDeviceLogin(config, "device-code-value", { fetch: fakeFetch })).rejects.toThrow(
    /device code expired/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/vault/deviceCode.test.ts`
Expected: FAIL — `src/vault/deviceCode.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/vault/deviceCode.ts
export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DeviceCodeConfig {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
}

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceCodeTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export class AuthPendingError extends Error {
  constructor() {
    super("device login is still pending");
  }
}

export async function startDeviceLogin(
  config: DeviceCodeConfig,
  deps: { fetch?: HttpFetch } = {},
): Promise<DeviceLogin> {
  const httpFetch = deps.fetch ?? fetch;
  const response = await httpFetch(config.deviceCodeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    }).toString(),
  });
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
  config: DeviceCodeConfig,
  deviceCode: string,
  deps: { fetch?: HttpFetch; now?: () => number } = {},
): Promise<DeviceCodeTokens> {
  const httpFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const response = await httpFetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: config.clientId,
      device_code: deviceCode,
    }).toString(),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    if (body.error === "authorization_pending") throw new AuthPendingError();
    throw new Error(`device login failed: ${String(body.error_description ?? body.error)}`);
  }

  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    expiresAt: now() + Number(body.expires_in) * 1000,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/vault/deviceCode.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/vault/deviceCode.ts tests/vault/deviceCode.test.ts
git commit -m "feat: add provider-agnostic device-code flow"
```

---

## Task 5: The vault

**Files:**
- Create: `src/vault/vault.ts`
- Test: `tests/vault/vault.test.ts`

**Interfaces:**
- Consumes: `ExtensionRecord`, `get` from `src/repo/extensions.ts` (Task 2); `CredentialStatus`, `save`, `load`, `setStatus`, `remove` from `src/repo/extensionCredentials.ts` (Task 3); `startDeviceLogin`, `completeDeviceLogin`, `AuthPendingError`, `DeviceCodeConfig`, `DeviceLogin` from `src/vault/deviceCode.ts` (Task 4); `buildAuthorizeUrl`, `createPkcePair`, `exchangeCode`, `refreshTokens`, `OAuthProviderConfig`, `HttpFetch` from `src/auth/oauth.ts` (existing).
- Produces: `VaultDeps` type (`{ db: Database, fetch?: HttpFetch, now?: () => number }`), `Vault` class with `status(extensionId)`, `startDeviceConnect(extensionId)`, `completeDeviceConnect(extensionId, deviceCode)`, `startAuthCodeConnect(extensionId, redirectUri)`, `completeAuthCodeConnect(extensionId, code, state)`, `saveApiKey(extensionId, apiKey)`, `getToken(extensionId)`, `disconnect(extensionId)`; `createVault(deps)` factory; re-exports `AuthPendingError`.

This is the whole point of the design: extensions never see or implement an auth flow. Everything here is either a passthrough to the already-generic `src/auth/oauth.ts` (for `oauth2-auth-code-pkce`, and for *refreshing* either OAuth mode) or to Task 4's device-code module (for the *initial* device-code exchange only).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vault/vault.test.ts
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import * as extensions from "../../src/repo/extensions";
import * as credentials from "../../src/repo/extensionCredentials";
import { createVault, AuthPendingError, type VaultDeps } from "../../src/vault/vault";
import type { ExtensionManifest } from "../../src/domain/extension";
import type { HttpFetch } from "../../src/vault/deviceCode";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const apiKeyManifest: ExtensionManifest = {
  id: "notion",
  name: "Notion",
  version: "1.0.0",
  summary: "Reads pages.",
  readOnly: true,
  auth: { mode: "api-key", label: "Personal Access Token" },
};

const deviceCodeManifest: ExtensionManifest = {
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

const pkceManifest: ExtensionManifest = {
  id: "slack",
  name: "Slack",
  version: "1.0.0",
  summary: "Reads channel messages.",
  readOnly: true,
  auth: {
    mode: "oauth2-auth-code-pkce",
    authorizeUrl: "https://example.com/authorize",
    tokenUrl: "https://example.com/token",
    clientId: "client-1",
    scopes: ["channels:read"],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("saveApiKey then getToken returns the stored key with no HTTP calls", async () => {
  const db = freshDb();
  extensions.upsertValid(db, apiKeyManifest);
  const vault = createVault({ db, fetch: async () => { throw new Error("should not fetch"); } });

  vault.saveApiKey("notion", "secret-key");

  expect(await vault.getToken("notion")).toBe("secret-key");
  expect(vault.status("notion")).toBe("connected");
});

test("getToken returns a stored oauth token that has not expired", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 2_000_000 },
    "connected",
    0,
  );
  const vault = createVault({
    db,
    now: () => 1_000_000,
    fetch: async () => { throw new Error("should not refresh"); },
  });

  expect(await vault.getToken("slack")).toBe("at-1");
});

test("getToken refreshes an expired oauth token and persists the new one", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000 },
    "connected",
    0,
  );
  const fakeFetch: HttpFetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  };
  const vault = createVault({ db, now: () => 1_000_000, fetch: fakeFetch });

  const token = await vault.getToken("slack");

  expect(token).toBe("at-2");
  expect(credentials.load(db, "slack")?.payload).toEqual({
    accessToken: "at-2",
    refreshToken: "rt-2",
    expiresAt: 1_000_000 + 3600 * 1000,
  });
});

test("getToken flips status to needs_reauth and rethrows when refresh fails", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000 },
    "connected",
    0,
  );
  const vault = createVault({
    db,
    now: () => 1_000_000,
    fetch: async () => jsonResponse({ error: "invalid_grant" }, 400),
  });

  await expect(vault.getToken("slack")).rejects.toThrow();
  expect(credentials.load(db, "slack")?.status).toBe("needs_reauth");
});

test("getToken throws and flips status when there is no refresh token to use", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: null, expiresAt: 1_000 },
    "connected",
    0,
  );
  const vault = createVault({ db, now: () => 1_000_000 });

  await expect(vault.getToken("slack")).rejects.toThrow(/reauthorization/);
  expect(credentials.load(db, "slack")?.status).toBe("needs_reauth");
});

test("device-code connect flow stores a connected credential", async () => {
  const db = freshDb();
  extensions.upsertValid(db, deviceCodeManifest);
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
  const vault = createVault({ db, now: () => 0, fetch: fakeFetch });

  const login = await vault.startDeviceConnect("outlook2");
  expect(login.deviceCode).toBe("dc-1");

  await vault.completeDeviceConnect("outlook2", "dc-1");

  expect(vault.status("outlook2")).toBe("connected");
  expect(await vault.getToken("outlook2")).toBe("at-1");
});

test("completeDeviceConnect propagates AuthPendingError without saving anything", async () => {
  const db = freshDb();
  extensions.upsertValid(db, deviceCodeManifest);
  const vault = createVault({
    db,
    fetch: async () => jsonResponse({ error: "authorization_pending" }, 400),
  });

  await expect(vault.completeDeviceConnect("outlook2", "dc-1")).rejects.toBeInstanceOf(AuthPendingError);
  expect(vault.status("outlook2")).toBe("not_connected");
});

test("auth-code+PKCE connect flow: the authorize URL carries state, and a matching code completes it", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  const fakeFetch: HttpFetch = async () =>
    jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  const vault = createVault({ db, now: () => 0, fetch: fakeFetch });

  const { url } = await vault.startAuthCodeConnect("slack", "http://localhost:3000/callback");
  const parsed = new URL(url);
  const state = parsed.searchParams.get("state")!;
  expect(parsed.origin + parsed.pathname).toBe("https://example.com/authorize");
  expect(state.length).toBeGreaterThan(0);

  await vault.completeAuthCodeConnect("slack", "auth-code-1", state);

  expect(vault.status("slack")).toBe("connected");
  expect(await vault.getToken("slack")).toBe("at-1");
});

test("completeAuthCodeConnect rejects a mismatched state", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  const vault = createVault({ db, fetch: async () => jsonResponse({}) });

  await vault.startAuthCodeConnect("slack", "http://localhost:3000/callback");

  await expect(vault.completeAuthCodeConnect("slack", "code", "wrong-state")).rejects.toThrow(/state/);
});

test("calling a device-code method against a PKCE extension is rejected", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  const vault = createVault({ db });

  await expect(vault.startDeviceConnect("slack")).rejects.toThrow(/does not use device-code/);
});

test("disconnect removes the credential and status reverts to not_connected", async () => {
  const db = freshDb();
  extensions.upsertValid(db, apiKeyManifest);
  const vault = createVault({ db });
  vault.saveApiKey("notion", "secret-key");

  vault.disconnect("notion");

  expect(vault.status("notion")).toBe("not_connected");
  await expect(vault.getToken("notion")).rejects.toThrow(/not connected/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/vault/vault.test.ts`
Expected: FAIL — `src/vault/vault.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/vault/vault.ts
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import * as credentialsRepo from "../repo/extensionCredentials";
import type { CredentialStatus } from "../repo/extensionCredentials";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  refreshTokens,
  type HttpFetch,
  type OAuthProviderConfig,
} from "../auth/oauth";
import {
  startDeviceLogin,
  completeDeviceLogin,
  AuthPendingError,
  type DeviceLogin,
} from "./deviceCode";

export { AuthPendingError };

export interface VaultDeps {
  db: Database;
  fetch?: HttpFetch;
  now?: () => number;
}

interface OAuthPayload {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

interface PendingAuthCode {
  verifier: string;
  state: string;
  redirectUri: string;
}

function toOAuthProviderConfig(
  id: string,
  auth: { tokenUrl: string; clientId: string; scopes: string[]; authorizeUrl?: string },
): OAuthProviderConfig {
  return {
    id,
    authorizeUrl: auth.authorizeUrl ?? "",
    tokenUrl: auth.tokenUrl,
    clientId: auth.clientId,
    scopes: auth.scopes,
  };
}

export class Vault {
  private pending = new Map<string, PendingAuthCode>();

  constructor(private deps: VaultDeps) {}

  private clock(): () => number {
    return this.deps.now ?? Date.now;
  }

  private http(): HttpFetch {
    return this.deps.fetch ?? fetch;
  }

  private requireExtension(extensionId: string): extensionsRepo.ExtensionRecord & {
    auth: NonNullable<extensionsRepo.ExtensionRecord["auth"]>;
  } {
    const record = extensionsRepo.get(this.deps.db, extensionId);
    if (!record) throw new Error(`unknown extension: ${extensionId}`);
    if (!record.valid || !record.auth) {
      throw new Error(`extension "${extensionId}" has an invalid manifest`);
    }
    return record as extensionsRepo.ExtensionRecord & {
      auth: NonNullable<extensionsRepo.ExtensionRecord["auth"]>;
    };
  }

  status(extensionId: string): CredentialStatus {
    return credentialsRepo.load(this.deps.db, extensionId)?.status ?? "not_connected";
  }

  async startDeviceConnect(extensionId: string): Promise<DeviceLogin> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-device-code") {
      throw new Error(`extension "${extensionId}" does not use device-code auth`);
    }
    return startDeviceLogin(auth, { fetch: this.http() });
  }

  async completeDeviceConnect(extensionId: string, deviceCode: string): Promise<void> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-device-code") {
      throw new Error(`extension "${extensionId}" does not use device-code auth`);
    }
    const tokens = await completeDeviceLogin(auth, deviceCode, {
      fetch: this.http(),
      now: this.clock(),
    });
    // Spread into a fresh literal: a variable typed as a plain interface fails
    // tsc's index-signature check against the Record<string, unknown> param,
    // but an inline object literal is checked structurally and passes.
    credentialsRepo.save(
      this.deps.db,
      extensionId,
      auth.mode,
      { ...tokens },
      "connected",
      this.clock()(),
    );
  }

  async startAuthCodeConnect(
    extensionId: string,
    redirectUri: string,
  ): Promise<{ url: string }> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-auth-code-pkce") {
      throw new Error(`extension "${extensionId}" does not use auth-code+PKCE`);
    }
    const pair = await createPkcePair();
    const state = crypto.randomUUID();
    this.pending.set(extensionId, { verifier: pair.verifier, state, redirectUri });

    const config = toOAuthProviderConfig(extensionId, auth);
    const url = buildAuthorizeUrl(config, { redirectUri, state, challenge: pair.challenge });
    return { url };
  }

  async completeAuthCodeConnect(extensionId: string, code: string, state: string): Promise<void> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-auth-code-pkce") {
      throw new Error(`extension "${extensionId}" does not use auth-code+PKCE`);
    }
    const pending = this.pending.get(extensionId);
    if (!pending) throw new Error(`no pending auth-code connect for extension "${extensionId}"`);
    if (pending.state !== state) throw new Error("state mismatch");

    const config = toOAuthProviderConfig(extensionId, auth);
    const tokens = await exchangeCode(config, {
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      fetch: this.http(),
      now: this.clock(),
    });
    this.pending.delete(extensionId);

    credentialsRepo.save(
      this.deps.db,
      extensionId,
      auth.mode,
      { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt },
      "connected",
      this.clock()(),
    );
  }

  saveApiKey(extensionId: string, apiKey: string): void {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "api-key") {
      throw new Error(`extension "${extensionId}" does not use api-key auth`);
    }
    credentialsRepo.save(this.deps.db, extensionId, auth.mode, { apiKey }, "connected", this.clock()());
  }

  async getToken(extensionId: string): Promise<string> {
    const { auth } = this.requireExtension(extensionId);
    const stored = credentialsRepo.load(this.deps.db, extensionId);
    if (!stored) throw new Error(`extension "${extensionId}" is not connected`);

    if (auth.mode === "api-key") {
      return String(stored.payload.apiKey);
    }

    const payload = stored.payload as unknown as OAuthPayload;
    const now = this.clock()();
    if (payload.expiresAt - 60_000 > now) return payload.accessToken;

    if (!payload.refreshToken) {
      credentialsRepo.setStatus(this.deps.db, extensionId, "needs_reauth");
      throw new Error(`extension "${extensionId}" needs reauthorization`);
    }

    const config = toOAuthProviderConfig(extensionId, auth);
    try {
      const refreshed = await refreshTokens(config, {
        refreshToken: payload.refreshToken,
        fetch: this.http(),
        now: this.clock(),
      });
      const nextRefreshToken = refreshed.refreshToken ?? payload.refreshToken;
      credentialsRepo.save(
        this.deps.db,
        extensionId,
        auth.mode,
        { accessToken: refreshed.accessToken, refreshToken: nextRefreshToken, expiresAt: refreshed.expiresAt },
        "connected",
        now,
      );
      return refreshed.accessToken;
    } catch (error) {
      credentialsRepo.setStatus(this.deps.db, extensionId, "needs_reauth");
      throw error;
    }
  }

  disconnect(extensionId: string): void {
    credentialsRepo.remove(this.deps.db, extensionId);
    this.pending.delete(extensionId);
  }
}

export function createVault(deps: VaultDeps): Vault {
  return new Vault(deps);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/vault/vault.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 6: Commit**

```bash
git add src/vault/vault.ts tests/vault/vault.test.ts
git commit -m "feat: add the credential vault"
```

---

## Task 6: Extension discovery

**Files:**
- Create: `src/extensions/discovery.ts`
- Test: `tests/extensions/discovery.test.ts`

**Interfaces:**
- Consumes: `ExtensionManifestSchema` from `src/domain/extension.ts` (Task 1); `upsertValid`, `upsertInvalid` from `src/repo/extensions.ts` (Task 2).
- Produces: `DiscoveryResult` type (`{ valid: string[], invalid: { id: string, error: string }[] }`), `discoverExtensions(db, dir)`.

Scans `dir` for subfolders containing `manifest.json`. A subfolder without one is silently skipped (not every entry in the extensions directory need be an extension folder). The manifest's `id` field must match its folder name — this is what prevents two folders from silently colliding on the same database row.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extensions/discovery.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import { discoverExtensions } from "../../src/extensions/discovery";
import * as extensions from "../../src/repo/extensions";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-extensions-"));
}

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

async function writeManifest(dir: string, id: string, manifest: unknown): Promise<void> {
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
}

test("a valid manifest is discovered and stored", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "notion", {
    id: "notion",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual(["notion"]);
  expect(result.invalid).toEqual([]);
  expect(extensions.get(db, "notion")?.valid).toBe(true);

  await rm(dir, { recursive: true, force: true });
});

test("malformed JSON is recorded as invalid, not thrown", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await mkdir(join(dir, "broken"), { recursive: true });
  await writeFile(join(dir, "broken", "manifest.json"), "{ not json");

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid).toEqual([
    { id: "broken", error: expect.stringContaining("not valid JSON") },
  ]);
  expect(extensions.get(db, "broken")?.valid).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("a manifest failing schema validation is recorded as invalid", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "half-built", { id: "half-built", name: "Half Built" });

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid.map((entry) => entry.id)).toEqual(["half-built"]);
  expect(extensions.get(db, "half-built")?.valid).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("a manifest id that does not match its folder name is rejected", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "notion", {
    id: "wrong-id",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid[0]?.error).toContain("does not match folder name");

  await rm(dir, { recursive: true, force: true });
});

test("a subfolder with no manifest.json is silently skipped", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await mkdir(join(dir, "not-an-extension"), { recursive: true });
  await writeFile(join(dir, "not-an-extension", "README.md"), "# notes");

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid).toEqual([]);

  await rm(dir, { recursive: true, force: true });
});

test("a missing extensions directory discovers nothing and does not throw", async () => {
  const db = freshDb();
  const result = await discoverExtensions(db, join(await freshDir(), "does-not-exist"));
  expect(result).toEqual({ valid: [], invalid: [] });
});

test("re-running discovery after enabling an extension leaves it enabled", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "notion", {
    id: "notion",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });
  await discoverExtensions(db, dir);
  extensions.setEnabled(db, "notion", true);

  await writeManifest(dir, "notion", {
    id: "notion",
    name: "Notion (renamed)",
    version: "1.0.1",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });
  await discoverExtensions(db, dir);

  const record = extensions.get(db, "notion");
  expect(record?.enabled).toBe(true);
  expect(record?.name).toBe("Notion (renamed)");

  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/discovery.test.ts`
Expected: FAIL — `src/extensions/discovery.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/extensions/discovery.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ExtensionManifestSchema } from "../domain/extension";
import * as extensions from "../repo/extensions";

export interface DiscoveryResult {
  valid: string[];
  invalid: { id: string; error: string }[];
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function discoverExtensions(db: Database, dir: string): Promise<DiscoveryResult> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return { valid: [], invalid: [] };
    throw error;
  }

  const result: DiscoveryResult = { valid: [], invalid: [] };

  for (const name of names.sort()) {
    const manifestPath = join(dir, name, "manifest.json");

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = `manifest.json is not valid JSON: ${(error as Error).message}`;
      extensions.upsertInvalid(db, name, message);
      result.invalid.push({ id: name, error: message });
      continue;
    }

    const manifest = ExtensionManifestSchema.safeParse(parsed);
    if (!manifest.success) {
      const message = manifest.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      extensions.upsertInvalid(db, name, message);
      result.invalid.push({ id: name, error: message });
      continue;
    }

    if (manifest.data.id !== name) {
      const message = `manifest id "${manifest.data.id}" does not match folder name "${name}"`;
      extensions.upsertInvalid(db, name, message);
      result.invalid.push({ id: name, error: message });
      continue;
    }

    extensions.upsertValid(db, manifest.data);
    result.valid.push(manifest.data.id);
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/extensions/discovery.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, clean

- [ ] **Step 6: Commit**

```bash
git add src/extensions/discovery.ts tests/extensions/discovery.test.ts
git commit -m "feat: add extension discovery"
```

---

## Out of scope (follow-on plan)

Not built here — these depend on this plan's vault/discovery but are their own plan once this lands:
- The onboarding wizard UI (Path A install, Path B agent-authored generation, the plain-language review step).
- Wiring an enabled extension's `source.ts` into `src/sources/poller.ts` (dynamic `import()` at runtime).
- The HTTP routes an auth-code+PKCE redirect and a device-code polling UI need.
- Matching an extension's `expectedMcpServer` against configured `mcpServers`.
- **Persisting the manifest's `config` field.** `ExtensionManifestSchema` validates it, but nothing in this plan stores it — the `extensions` table has no column for it, because its only consumer (the wizard's Config step) isn't built yet. Add the column and the persistence path together with that step, not before there's something to put in it.
- **Pruning extensions whose folder was deleted.** `discoverExtensions` only ever upserts; nothing removes an `extensions` row (or its `extension_credentials`, despite the `ON DELETE CASCADE`) when its folder disappears. An `enabled` row can outlive its folder indefinitely. The poller-wiring plan must handle this — either prune on discovery or have the dynamic `import()` path treat a missing `source.ts` as the same "goes to needs-attention" state as an invalid manifest.
