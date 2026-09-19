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
];
