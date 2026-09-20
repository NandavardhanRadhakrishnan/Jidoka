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

export function remove(db: Database, id: string): void {
  db.query("DELETE FROM extensions WHERE id = ?").run(id);
}
