import type { Database } from "bun:sqlite";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
}

export function saveTokens(db: Database, provider: string, tokens: StoredTokens): void {
  db.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at`,
  ).run(provider, tokens.accessToken, tokens.refreshToken ?? "", tokens.expiresAt);
}

export function loadTokens(db: Database, provider: string): StoredTokens | null {
  const row = db
    .query("SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?")
    .get(provider) as
    | { access_token: string; refresh_token: string; expires_at: number }
    | null;
  return row
    ? {
        accessToken: row.access_token,
        refreshToken: row.refresh_token === "" ? null : row.refresh_token,
        expiresAt: row.expires_at,
      }
    : null;
}

export function deleteTokens(db: Database, provider: string): void {
  db.query("DELETE FROM oauth_tokens WHERE provider = ?").run(provider);
}

export function listProviders(db: Database): string[] {
  const rows = db.query("SELECT provider FROM oauth_tokens ORDER BY provider").all() as {
    provider: string;
  }[];
  return rows.map((row) => row.provider);
}
