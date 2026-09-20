import type { Database } from "bun:sqlite";
import type { Settings } from "../domain/settings";

function mergeSection<T extends object>(current: T | undefined, patch: T | undefined): T | undefined {
  if (!current && !patch) return undefined;
  return { ...current, ...patch } as T;
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
