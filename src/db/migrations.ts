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
  `CREATE TABLE IF NOT EXISTS rules (
     id TEXT PRIMARY KEY,
     type_id TEXT NOT NULL REFERENCES task_types(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     status TEXT NOT NULL,
     definition TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (type_id, version)
   )`,
  `DROP TABLE IF EXISTS pipelines`,
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
  `CREATE TABLE IF NOT EXISTS settings (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
  `ALTER TABLE tasks ADD COLUMN deadline TEXT`,
  `ALTER TABLE tasks ADD COLUMN dedup_candidate_id TEXT`,
  `CREATE TABLE IF NOT EXISTS hints (
     id TEXT PRIMARY KEY,
     rule_id TEXT NOT NULL,
     step_id TEXT NOT NULL,
     text TEXT NOT NULL,
     excerpt TEXT,
     created_at TEXT NOT NULL
   )`,
  `ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`,
  `ALTER TABLE task_types ADD COLUMN default_priority TEXT NOT NULL DEFAULT 'normal'`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     actor TEXT NOT NULL,
     task_id TEXT,
     type_id TEXT,
     rule_id TEXT,
     data TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS audit_log_task ON audit_log (task_id, at)`,
  `CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at)`,
  `ALTER TABLE extensions ADD COLUMN resolved_identity TEXT`,
  `CREATE TABLE IF NOT EXISTS orgs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     is_home INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS orgs_one_home ON orgs (is_home) WHERE is_home = 1`,
  `CREATE TABLE IF NOT EXISTS org_domains (
     domain TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS people (
     id TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
     is_self INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS people_one_self ON people (is_self) WHERE is_self = 1`,
  `CREATE TABLE IF NOT EXISTS person_identities (
     identity TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS task_participants (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     identity TEXT,
     person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
     name TEXT,
     role TEXT NOT NULL,
     added_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     CHECK (identity IS NOT NULL OR person_id IS NOT NULL)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS task_participants_source
     ON task_participants (task_id, identity, role) WHERE added_by = 'source'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS task_participants_human
     ON task_participants (task_id, person_id) WHERE added_by = 'human'`,
  `CREATE INDEX IF NOT EXISTS task_participants_identity ON task_participants (identity)`,
  `CREATE TABLE IF NOT EXISTS source_items (
     source_id TEXT NOT NULL,
     key TEXT NOT NULL,
     thread_key TEXT,
     version TEXT,
     occurred_at TEXT,
     title TEXT,
     body TEXT,
     url TEXT,
     metadata TEXT NOT NULL DEFAULT '{}',
     participants TEXT NOT NULL DEFAULT '[]',
     task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
     status TEXT NOT NULL,
     error TEXT,
     failed_window TEXT,
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     PRIMARY KEY (source_id, key)
   )`,
  `CREATE INDEX IF NOT EXISTS source_items_thread ON source_items (source_id, thread_key)`,
  `CREATE INDEX IF NOT EXISTS source_items_task ON source_items (task_id)`,
  `CREATE TABLE IF NOT EXISTS source_polls (
     id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     since TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     outcome TEXT,
     error TEXT,
     seen INTEGER NOT NULL DEFAULT 0,
     new INTEGER NOT NULL DEFAULT 0,
     changed INTEGER NOT NULL DEFAULT 0,
     failed INTEGER NOT NULL DEFAULT 0,
     unkeyed_failures TEXT NOT NULL DEFAULT '[]'
   )`,
  `CREATE INDEX IF NOT EXISTS source_polls_source ON source_polls (source_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS source_horizons (
     source_id TEXT PRIMARY KEY,
     horizon TEXT NOT NULL
   )`,
  // The cursor contract's tables, replaced by source_items / source_polls.
  `DROP TABLE IF EXISTS source_state`,
  `DROP TABLE IF EXISTS merged_source_items`,
];
