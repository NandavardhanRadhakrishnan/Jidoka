# A settings menu for generic config, replacing hand-edited `.env`

**Status:** design approved, not yet planned/implemented.

## Problem

Every piece of Jidoka's runtime configuration today lives in environment variables, read once at startup by `loadConfig()` and baked into the objects `main.ts` builds (`AiProvider`, `AgentRunner`, MCP connections, the poller's source list). Changing anything — which model to use, the MCP server list, the terminal launcher for handoffs — means hand-editing `.env` (or the shell environment) and restarting the process. This session's own debugging of `JIDOKA_TERMINAL` showed how easy that is to get wrong (quoting differences between `cmd.exe`, PowerShell, and dotenv parsing all silently produce different literal values).

## Scope

**In scope:** a settings menu covering the fields a user would plausibly want to tweak while using the app: AI provider/model/key/base URL, agent runner/model/concurrency/budget, the MCP server list, the sample and extensions folder paths, the poll interval, and the handoff terminal launcher. Settings are persisted in the existing SQLite db, take precedence over the matching env var on a per-field basis (only for fields actually saved — an unset field falls through to the env var, then the built-in default), and take effect on the next server restart.

**Explicitly out of scope**, decided during brainstorming:
1. **`dbPath` and `port`.** The user doesn't expect to need to change these, and they're the two fields that can't sensibly change without a process restart in the first place (an open SQLite file, a bound listening socket). Leaving them env-var-only sidesteps a real chicken-and-egg problem this project's precedence rule would otherwise create: if settings lived inside the very db file `dbPath` points at, a process wouldn't know where the *new* `dbPath` is without first opening the *old* one.
2. **Any self-restart mechanism.** Was under consideration specifically for `dbPath`/`port`; dropping those fields drops the need for it entirely. Saving a setting today just means "next restart, this applies" — no process respawn, no risk of the app failing to come back up.
3. **Live-reloading any individual field** (swapping the running `AiProvider`/`AgentRunner` instance, adding/removing an MCP connection without restart, re-reading `terminalCommand` per-request instead of once at construction). Real, separate follow-up work, one field at a time, after this ships.
4. **Outlook's `clientId`/`tenant`.** Not vestigial — it's still live, unmigrated code (`src/sources/outlook/auth.ts`'s own bespoke device-code flow), gating whether `main.ts` constructs the built-in Outlook source at all. But it's a *source-specific* setting, not a generic one, and migrating it onto the vault/extension system (so it stops being a special case in `Config` at all) is its own separate, already-previously-deferred project. Out of scope here.
5. **The OAuth app-registration config** (`JIDOKA_OAUTH_PROVIDERS` — client id/authorize/token URL per browser-sign-in provider). A one-time developer/ops setup, not a user-facing setting.

## Storage

A new `settings` table, one fixed row, matching the codebase's existing convention of a JSON blob in a `TEXT` column (`tasks.context`, `tasks.metadata`, `task_types.examples` all already do this):

```sql
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
)
```

Always read/written at `id = 'global'`. No new migration-runner machinery needed — `CREATE TABLE IF NOT EXISTS` is idempotent like every other migration in `src/db/migrations.ts`.

`src/repo/settings.ts`:

```typescript
export function getSettings(db: Database): Settings {
  const row = db.query("SELECT data FROM settings WHERE id = 'global'").get() as { data: string } | null;
  return row ? (JSON.parse(row.data) as Settings) : {};
}

export function saveSettings(db: Database, patch: Settings): Settings {
  const current = getSettings(db);
  const merged: Settings = {
    ai: { ...current.ai, ...patch.ai },
    agent: { ...current.agent, ...patch.agent },
    mcpServers: patch.mcpServers ?? current.mcpServers,
    sampleDir: patch.sampleDir ?? current.sampleDir,
    extensionsDir: patch.extensionsDir ?? current.extensionsDir,
    pollIntervalMs: patch.pollIntervalMs ?? current.pollIntervalMs,
    terminalCommand: patch.terminalCommand ?? current.terminalCommand,
  };
  db.query(
    `INSERT INTO settings (id, data) VALUES ('global', ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
  ).run(JSON.stringify(merged));
  return merged;
}
```

`ai`/`agent` merge one level deep (so patching just `ai.model` doesn't drop an already-saved `ai.apiKey`); the array/scalar fields (`mcpServers`, `sampleDir`, etc.) are whole-value replacements — patching them means sending the complete new value, which is what the UI's "Save" button already does per section.

## Domain shape

`src/domain/settings.ts`:

```typescript
import type { ModelProviderId } from "../ai/models";
import type { McpServerConfig } from "../config";

export interface Settings {
  ai?: {
    provider?: ModelProviderId;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  agent?: {
    runner?: "in-process" | "agent-sdk";
    model?: string;
    concurrency?: number;
    maxBudgetUsd?: number;
  };
  mcpServers?: McpServerConfig[];
  sampleDir?: string;
  extensionsDir?: string;
  pollIntervalMs?: number;
  terminalCommand?: string;
}
```

Every field optional at every level: presence means "override," absence means "fall through."

## Config integration

`main.ts`'s `createApp` currently takes a fully-resolved `Config` built once by `loadConfig()`. That stays the *base* — env vars are still read exactly as today. A new pure function, `applySettings(base: Config, settings: Settings): Config` (co-located in `src/config.ts`), overlays saved settings on top:

```typescript
export function applySettings(base: Config, settings: Settings): Config {
  return {
    ...base,
    ai: { ...base.ai, ...settings.ai },
    agent: { ...base.agent, ...settings.agent },
    mcpServers: settings.mcpServers ?? base.mcpServers,
    sampleDir: settings.sampleDir ?? base.sampleDir,
    extensionsDir: settings.extensionsDir ?? base.extensionsDir,
    pollIntervalMs: settings.pollIntervalMs ?? base.pollIntervalMs,
    terminalCommand: settings.terminalCommand ?? base.terminalCommand,
  };
}
```

`main.ts`'s startup sequence becomes:

```typescript
const envConfig = loadConfig();
const db = openDb(envConfig.dbPath);
migrate(db);
const config = applySettings(envConfig, getSettings(db));
// ...everything else in createApp already reads from `config`, unchanged
```

`dbPath` itself is read from `envConfig` before this merge ever happens (`openDb(envConfig.dbPath)`), so it's structurally impossible for a saved setting to affect it — consistent with it being out of scope, not just conventionally excluded.

## API

New `src/api/settings.ts`, mounted into `main.ts`'s `extraRoutes` chain the same way `auth`/`handoff`/`extensions` already are.

`EffectiveSettings` mirrors `Settings`'s shape with every field resolved to its actual current value (saved setting, else env-derived config, else built-in default) instead of left optional/absent, and with `ai.apiKey` replaced by a boolean:

```typescript
export interface EffectiveSettings {
  ai: { provider: ModelProviderId; apiKeyConfigured: boolean; model?: string; baseUrl?: string };
  agent: { runner: "in-process" | "agent-sdk"; model?: string; concurrency: number; maxBudgetUsd?: number };
  mcpServers: McpServerConfig[];
  sampleDir?: string;
  extensionsDir: string;
  pollIntervalMs: number;
  terminalCommand?: string;
}
```

- `GET /api/settings` → `{ settings: Settings, effective: EffectiveSettings }`. `settings` is exactly what's stored, unresolved (for the UI to know which fields are user-set vs falling through to env/default). `effective` is what the form fields display. Neither object ever carries `ai.apiKey` as plaintext — both use `apiKeyConfigured` instead, mirroring how extension credentials already avoid echoing secrets back over HTTP. (`settings.ai`, being the raw stored partial, only gains `apiKeyConfigured` when returned over this route — the DB row itself still stores the real key under `apiKey`, exactly as `saveSettings` wrote it.)
- `PATCH /api/settings` → body is a partial `Settings` object, merged via `saveSettings` and persisted. Returns the same `{ settings, effective }` shape (secret-masked the same way). No route triggers a restart — saving just persists; the response includes nothing more than confirmation, and the client shows its own static "restart to apply" notice.

## UI

`src/client/Settings.tsx`: a header button next to `Rules`/`Extensions`, opening a `.dialog.extensions`-styled panel (same conventions: `.extension-row`-equivalent rows, `.link`/`.secondary` buttons, `.meta`/`.error` text) with five sections — AI, Agent, MCP Servers, Sources, Handoff — each field bound to `effective`'s current value. MCP Servers gets a small add/remove list editor for `{name, command, args}` rows, following the same add-row/remove-row pattern already built for rule steps in `StepList.tsx`. A single "Save" button per section (or one for the whole panel — implementation's call, whichever keeps the component simplest) calls `PATCH /api/settings`, then shows: "Saved — restart the server for this to take effect."

## Testing

- `tests/repo/settings.test.ts` — `getSettings` on an empty db returns `{}`; `saveSettings` persists and round-trips; a second `saveSettings` call merges into the first rather than replacing it wholesale (specifically: patching `ai.model` alone preserves a previously-saved `ai.apiKey`).
- `tests/config.test.ts` (new, or added to wherever `src/config.ts` is already covered) — `applySettings` precedence: a saved setting overrides the env-derived base; an absent setting field falls through to the base's value unchanged.
- `tests/api/settings.test.ts` — `GET` returns the effective merged view; `PATCH` persists and the next `GET` reflects it; `ai.apiKey` is never present as plaintext in either response, only `apiKeyConfigured`.
- UI: manual verification with the dev server, matching this codebase's existing convention for React components (no automated component tests exist for `Rules.tsx`/`Extensions.tsx` either).
