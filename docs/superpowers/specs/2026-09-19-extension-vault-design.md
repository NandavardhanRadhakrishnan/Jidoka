# Extension packaging + credential vault

**Status:** design approved, not yet planned/implemented.

## Problem

Today a task source is hand-wired into `src/main.ts`: config comes from env vars read once at startup, and Outlook's OAuth device-code flow (`src/sources/outlook/auth.ts`) is bespoke, hardcoded to Microsoft's endpoints, with tokens in a generic-but-unused-as-such `oauth_tokens` table. Adding a second source today means repeating that hand-wiring and, if it uses OAuth, re-deriving token refresh from scratch. There is no way for a user to add a source without editing core code, and no shared place credentials live that isn't specific to one provider.

This is CLAUDE.md's open decision: "Task source extension mechanism (packaging, loading, sandboxing, credential storage)."

## Scope

In scope: extension packaging + discovery, the credential vault, and the onboarding wizard (including agent-authored extensions).

Explicitly deferred (not designed further here):
1. **A registry to pull shared extensions into the `extensions/` folder.** Users can already share an extension folder by hand (zip it, copy it, whatever); an in-product discover/install/publish flow is a later project once the extension format below exists and is stable.
2. **Installing MCP servers from within Jidoka.** For now, MCP servers are still configured exactly as today (`mcpServers` config, `npx`-style manual install). Jidoka only *links* an already-configured MCP server to an extension that expects one — it doesn't install the MCP server itself.
3. **Migrating Outlook's existing bespoke auth to the vault.** A natural follow-up once the vault exists, not required for this design.

## Extension package format

An extension is a plain folder under `extensions/<id>/`:

- `manifest.json` — pure data, validated with Zod *before* any code from the extension ever runs:
  ```
  {
    id: string,
    name: string,
    version: string,
    summary: string,              // plain-language, shown in wizard review — see below
    readOnly: boolean,            // false if the extension can write back, not just poll
    auth: {
      mode: "oauth2-device-code" | "oauth2-auth-code-pkce" | "api-key",
      // + mode-specific fields, see Vault below
    },
    expectedMcpServer?: string,   // name Jidoka tries to match against configured mcpServers
    config?: { ... }              // schema for non-secret settings, e.g. poll interval
  }
  ```
- `source.ts` — the actual code. Exports something satisfying the existing `TaskSource` interface (`src/sources/types.ts`: `poll(cursor)`). Only dynamically `import()`-ed for extensions that are both valid and enabled.

Jidoka discovers extensions by scanning `extensions/` on startup (and on an explicit rescan trigger), validating each manifest, and upserting a row into a new `extensions` table (`id`, `name`, `version`, `enabled`, `auth_mode`, `summary`, `read_only`, `status`). A malformed manifest is recorded with an error and does not block discovery of other extensions or startup.

This satisfies "single executable, extensions addable/removable later": `bun build --compile` embeds the Bun runtime, which can still `import()` arbitrary files from disk at runtime — extensions never need to be known at compile time.

## The vault

The vault is the only thing in Jidoka that knows how to run an auth flow or where a secret is stored. Extensions never write auth code — they declare a mode and supply that mode's config; the vault does the rest. This is a closed set by design: an extension needing an auth style outside these three isn't supportable yet (a real, accepted limit, not an oversight), in exchange for every supported flow being implemented and audited exactly once.

Three modes for v1, chosen to cover the overwhelming majority of real APIs and because most of the protocol work already exists in this codebase:

- **`oauth2-auth-code-pkce`** — wraps `src/auth/oauth.ts` as-is (it's already provider-agnostic: `OAuthProviderConfig` takes `authorizeUrl`/`tokenUrl`/`clientId`/`scopes`). Manifest supplies those four fields. Redirect is caught by Jidoka's existing local callback server (`src/api/auth.ts` already does this for Jidoka's own sign-in).
- **`oauth2-device-code`** — generalizes `src/sources/outlook/auth.ts`, which today hardcodes Microsoft's device-code/token URLs. Same shape, manifest supplies `deviceCodeUrl`, `tokenUrl`, `clientId`, `scopes` instead of them being baked in.
- **`api-key`** — no protocol. Wizard shows one text field (label from the manifest), value stored as-is.

Storage: a new `extension_credentials` table — `extension_id` (PK), `auth_mode`, `payload` (JSON: token/refresh/expiry for OAuth modes, raw key for `api-key`), `status` (`connected` / `not_connected` / `needs_reauth`), `updated_at`. Kept separate from the existing `oauth_tokens` table rather than migrating Outlook's current flow onto it now (see Deferred).

Vault module surface — deliberately small:
- `getToken(extensionId): Promise<string>` — returns a currently-valid token/key, refreshing under the hood for OAuth modes. This is the only thing a `source.ts`'s `poll()` ever calls.
- `status(extensionId)`, `startConnect(extensionId)`, `completeConnect(extensionId, ...)`, `disconnect(extensionId)` — used only by the onboarding wizard.

If `getToken` fails at poll time (e.g. a revoked refresh token), the extension's status flips to `needs_reauth` and the poller skips it until the user re-runs Connect.

## Onboarding wizard

Two entry paths that converge on the same artifact — an extension folder:

**Path A — install existing.** The folder is already in `extensions/` (hand-written or previously agent-generated). Wizard steps: **Review** (name/summary from the manifest, whether `expectedMcpServer` is currently configured) → **Connect** (branches on `auth.mode`: device-code shows a code + verification URL and polls; auth-code-pkce opens the browser to the authorize URL; api-key is a form field) → **Config** (any non-secret settings the manifest declares) → **Activate** (flips `enabled = true`, `source.ts` is imported and added to the poller's rotation in `src/sources/poller.ts`).

**Path B — build one.** No matching extension exists. The user describes the source in natural language (optionally pointing at its API docs). An agent — reusing the `AgentRunner` pattern already used by the pipeline-building agent (`src/pipeline/builder.ts`) — generates `manifest.json` and `source.ts`: it picks one of the vault's three closed auth modes and fills in that mode's config, and writes `poll()` using `vault.getToken()` against the target API. Because auth is vault-only, the agent never has to get token-refresh logic right — it only has to pick a mode and describe the target API's shape.

**Review, not code review.** Neither technical nor non-technical users are expected to read `source.ts` in the wizard — if someone wants to inspect the actual code, it's a plain file in `extensions/<id>/`, not something the UI needs to surface. Instead, review shows the same `summary` and `readOnly` facts pulled straight from the manifest (so the summary can't drift from what the code can actually touch): what API it talks to, what it reads, whether it can write. This mirrors how pipelines are already reviewed as their declarative step list rather than as code — extensions get the equivalent readable surface via the manifest instead. Once approved, the generated folder is written to `extensions/<id>/` and **the flow continues straight into Path A** (Review → Connect → Config → Activate) — no separate activation logic to maintain.

If the agent fails to produce a valid extension (bad manifest, can't determine the target API's auth), nothing is written to disk and the wizard reports the failure so the user can retry with more detail.

## Data model summary

New tables:
- `extensions` — `id` (PK), `name`, `version`, `enabled`, `auth_mode`, `summary`, `read_only`, `status`
- `extension_credentials` — `extension_id` (PK), `auth_mode`, `payload` (JSON), `status`, `updated_at`

## Testing

Same seams used everywhere else in this codebase: injectable `fetch`/`now()` for the device-code generalization and the reused PKCE flow (no test hits a network); discovery/validation tested against a temp directory of fixture extension folders (valid manifest, malformed manifest, mode/field mismatch) rather than the real `extensions/` folder.
