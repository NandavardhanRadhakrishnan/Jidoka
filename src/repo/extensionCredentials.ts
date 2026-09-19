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
