# Extension vault HTTP routes + wizard Path A

**Status:** design approved, not yet planned/implemented.

## Problem

The extension vault and discovery backend (`docs/superpowers/specs/2026-09-19-extension-vault-design.md`, implemented) has no entry point in Jidoka at all — no route calls `discoverExtensions` or the `Vault`, and `src/client/` has zero references to "extension." An extension folder can exist on disk and be entirely unreachable. This plan gives Path A (installing an already-present extension folder) a real HTTP surface and UI, so a user can actually connect and activate one.

## Scope

In scope: HTTP routes over discovery + the vault, `main.ts` wiring, and the wizard UI for Path A (an extension folder that already exists on disk).

Explicitly out of scope, each its own follow-on plan:
1. **Poller wiring** — nothing here dynamically `import()`s an enabled extension's `source.ts` into `src/sources/poller.ts`. Activating an extension in this plan only flips its `enabled` flag; making that flag mean something is the next plan.
2. **Wizard Path B** — agent-authored extension generation. Builds on this plan's Path A (a generated extension joins the same install flow) but is a separate, larger feature.
3. **The manifest's `config` field / a Config step.** Still just a validated-but-unused JSON blob (per the vault plan's own deferred note) — nothing in this plan builds a form for it. The wizard here is Review → Connect → Activate, not Review → Connect → Config → Activate.
4. **Pruning deleted extensions** — unchanged from the vault plan's deferred note; still the poller-wiring plan's problem.

## Config

New `JIDOKA_EXTENSIONS_DIR` env var (`src/config.ts`), defaulting to `./extensions`. Unlike `sampleDir` (unset = disabled), this is always on — scanning a missing or empty directory is already a documented no-op in `discoverExtensions` (Task 6 of the vault plan), so there's no reason to gate it behind explicit opt-in.

## Routes

New `src/api/extensions.ts`, following the existing shape of `src/api/auth.ts` (a `createExtensionRoutes(deps)` factory returning a `Hono` app, mounted onto `extraRoutes` in `main.ts` next to auth and handoff routes). Deps: `{ db, vault, extensionsDir }`.

- `GET /api/extensions` — every discovered extension: `id`, `name`, `summary`, `readOnly`, `auth` (the extension's full `ExtensionAuth`, i.e. `{mode, ...}` including `label` for `api-key` or `scopes` for the OAuth modes — the UI needs `auth.label` to render the api-key field's prompt), `enabled`, `valid`, `error`, and `status` (`Vault.status()`'s `"connected" | "not_connected" | "needs_reauth" | "unknown" | "invalid"` — in practice `"unknown"` never appears here since the list itself comes from the `extensions` table, but the type is reused as-is rather than narrowed).
- `POST /api/extensions/rescan` — runs `discoverExtensions(db, extensionsDir)`, responds with the refreshed list (same shape as the GET above).
- `POST /api/extensions/:id/connect/api-key` — body `{ apiKey: string }` → `vault.saveApiKey(id, apiKey)`. 400 if the extension's mode isn't `api-key` (the vault itself throws this; the route just relays it) or the body is missing `apiKey`.
- `POST /api/extensions/:id/connect/device/start` — `vault.startDeviceConnect(id)`, returns `{ userCode, verificationUri, deviceCode, expiresIn, interval }` verbatim.
- `POST /api/extensions/:id/connect/device/complete` — body `{ deviceCode: string }` → `vault.completeDeviceConnect(id, deviceCode)`. On `AuthPendingError`, responds `202 { pending: true }` (not an error the client should surface) rather than propagating the throw as a 4xx/5xx. Any other failure is `400 { error }`.
- `GET /api/extensions/:id/connect/pkce/start` — a link, not a fetch (matches `/api/auth/:id/start`): builds the redirect URI from the request URL (`/api/extensions/:id/connect/pkce/callback`), calls `vault.startAuthCodeConnect(id, redirectUri)`, 302s to the returned authorize URL.
- `GET /api/extensions/:id/connect/pkce/callback` — mirrors `/api/auth/:id/callback`: reads `code`/`state` query params, calls `vault.completeAuthCodeConnect(id, code, state)`. On success, 302 to `/`. On failure (missing params, vault throws), a small HTML error page with a link back to `/`, matching the existing callback's `escapeHtml`-guarded error rendering — copy that helper rather than re-deriving it.
- `POST /api/extensions/:id/disconnect` → `vault.disconnect(id)`.
- `POST /api/extensions/:id/enable` — `extensions.setEnabled(db, id, true)`. 400 if the extension isn't currently connected (checked via `vault.status(id)` before flipping the flag) — activating something that isn't connected is a wizard-flow error, not a valid state.
- `POST /api/extensions/:id/disable` — `extensions.setEnabled(db, id, false)`, no precondition.

Every route 404s with `{ error: "unknown extension" }` for an `id` `extensionsRepo.get` doesn't find, before touching the vault — consistent with how `src/api/server.ts`'s existing routes 404 on an unknown task/type/pipeline id first.

## `main.ts` wiring

- `Config.extensionsDir: string`, loaded as described above.
- In `createApp`, construct `const vault = createVault({ db })` and pass it (plus `extensionsDir`) into `createExtensionRoutes`, mounted on `extraRoutes` alongside auth/handoff.
- In the `import.meta.main` block, call `await discoverExtensions(db, config.extensionsDir)` once at startup, logging a one-line summary (`N extensions discovered (M invalid)`) the same way the sample source logs which directory it's watching.

## UI

New `src/client/Extensions.tsx`, added to `App.tsx`'s header actions next to `SignIn`/`NewTask`/`Refresh`. Styled after `SignIn.tsx` (status dots, `.link`-styled action buttons) but always rendered — unlike `SignIn`, which hides itself when there are no providers, this stays visible even with zero extensions discovered, since "click Rescan after adding a folder" has to be discoverable.

**Panel layout:** a `.dialog` (same class `Onboarding`/`TypeConfirm` use) opened by the header button, containing a "Rescan" button at the top and one row per discovered extension: name, summary, a status dot, and one action based on state:

| State | Row shows | Action |
|---|---|---|
| `invalid` | name + `error` text | none |
| `not_connected` | name + summary | "Connect" → opens the mode-specific sub-flow below |
| connected (`status` truthy-connected), `enabled = false` | name + summary | "Activate" → `POST .../enable` |
| `enabled = true` | name + summary | "Disable" and "Disconnect" links |
| `needs_reauth` | name + summary, dot in a third (warning) color | "Reconnect" → same sub-flow as `not_connected` |

**Connect sub-flow, per `authMode`:**
- `api-key`: an inline text input (label taken from the extension's `auth.label`, present in the list response) + "Save", calling `connect/api-key`.
- `oauth2-auth-code-pkce`: a plain `<a href="/api/extensions/:id/connect/pkce/start">Connect</a>` — the browser navigates away and back, identical to `SignIn`'s existing OAuth link. No client-side state needed; the panel re-fetches on next open.
- `oauth2-device-code`: "Connect" calls `device/start`, then shows the user code and verification link, and polls `device/complete` on a `setInterval` using the response's `interval` (seconds) until it gets a non-`pending` result or `expiresIn` elapses (then shows a "timed out, try again" state).

The panel fetches the list on mount and after every action (connect, activate, disable, disconnect, rescan) — no background polling loop, matching `SignIn`'s pattern rather than the board's 5-second interval.

## Data model

None — no new tables or columns. This plan is pure routing + UI over the vault plan's existing schema.

## Testing

- Route tests in `tests/api/extensions.test.ts`, following `tests/api/auth.test.ts`'s style: a real `Vault`/`discoverExtensions` against an in-memory db and a temp extensions directory, with `fetch`/`now` injected through `VaultDeps` so no test hits a network. Cover: list shape, rescan picking up a newly-written folder, each connect mode's happy path, the device-code `AuthPendingError` → `202` mapping, the PKCE start/callback redirect pair (asserting the `Location` header and query params, not following the redirect), enable's precondition check, disable, disconnect, and the 404-before-vault-call behavior for an unknown id.
- No React component tests — this codebase has none for `.tsx` files today (`SignIn`/`Onboarding` weren't tested that way either); verify the UI manually in the browser with a hand-written sample extension folder covering all three auth modes, per the `run` skill.
