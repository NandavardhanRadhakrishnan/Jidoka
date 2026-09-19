# Poller wiring for extensions

**Status:** design approved, not yet planned/implemented.

## Problem

Activating an extension today (`POST /api/extensions/:id/enable`) only flips a boolean in the `extensions` table. Nothing ever reads that flag except the wizard UI itself — `src/sources/poller.ts` still only polls the fixed `sources: TaskSource[]` array built once at startup from `JIDOKA_OUTLOOK_CLIENT_ID`/`JIDOKA_SAMPLE_DIR`. An enabled extension does not run.

## Scope

In scope: making an enabled, valid extension's `source.ts` actually get polled, live, without restarting Jidoka.

Explicitly out of scope:
1. **Surfacing source-load or runtime-poll failures in the UI.** A missing `source.ts`, a bad export, or a throwing `poll()` are logged to the server console, same as an existing source's poll failure already is — no new UI state, no `lastError` field. A future plan can add this.
2. **Hot-reloading an extension's code.** Editing `source.ts` while Jidoka is running has no effect until restart (Bun's module cache is for the process lifetime). Editing `manifest.json` and clicking Rescan *does* take effect live — only code changes require a restart. This is a stated, accepted limitation, not a defect to fix here.
3. **Pruning.** Still deferred from the vault plan. A load failure here is handled by skipping that extension for the current poll, not by touching its `extensions` row.
4. **Wizard Path B** (agent-authored extension generation) — unrelated, separate plan.

## Extension source module contract

Addition to `src/sources/types.ts`, next to the existing `TaskSource`:

```typescript
export interface ExtensionSourceDeps {
  getToken(): Promise<string>;
}
```

An extension's `source.ts` must export:

```typescript
export function createSource(deps: ExtensionSourceDeps): TaskSource
```

This matches the existing factory-function convention already used by `createOutlookSource(options)` and `createSampleFolderSource(options)` — nothing new is invented, an extension author writes their `source.ts` the same way Jidoka's own built-in sources are already written. The loader (below) injects a `getToken` closed over that specific extension's id; nothing else is injected. This preserves "the vault owns all auth, extensions never see it directly" — an extension calls `getToken()` and uses whatever string comes back however its target API needs it (a bearer header, a query param, whatever), exactly like `createOutlookSource` already does internally with its own token. **This is a convention, not a sandbox boundary**: extension code runs in-process with no isolation, so nothing stops a module from `import`-ing Jidoka's internals directly instead of using the injected `getToken`. That's an accepted, pre-existing property of "extensions are plain code Jidoka dynamically imports" (see the vault plan) — this plan is simply the point where such code first actually executes, so it's worth stating plainly here rather than implying a stronger guarantee than exists.

**`createSource` is called once per poll tick, not once per process lifetime.** Bun's module cache makes the repeat `import()` of an already-loaded path free, but the loader still *calls* `createSource(deps)` fresh every tick (see Dynamic loading below) — nothing memoizes the returned `TaskSource`. An extension author must treat `createSource` as cheap and side-effect-free, persisting all state through the `cursor` argument to `poll()` rather than in a captured variable, a held-open connection, or a `setInterval`/timer started inside `createSource` — any of those leaks or duplicates once per tick, forever, for as long as the extension stays enabled. Jidoka's own `createSampleFolderSource`/`createOutlookSource` already follow this shape (pure closures, no held resources), so this is a constraint on new code, not a change to existing code.

## Dynamic loading

New `src/extensions/runtime.ts`:

```typescript
export async function loadEnabledExtensionSources(
  db: Database,
  extensionsDir: string,
  vault: Vault,
): Promise<TaskSource[]>
```

Queries `extensionsRepo.list(db)` for records where `enabled && valid`. For each, dynamically `import()`s `<extensionsDir>/<id>/source.ts` (resolved to a `file://` URL — Bun supports importing `.ts` files directly, no build step), calls the module's `createSource({ getToken: () => vault.getToken(id) })`, and wraps the result as `{ id: record.id, poll: source.poll }` — the loader always uses the id from the database row, never whatever the module itself might claim its `id` to be, so a task's `sourceId` can never point at the wrong extension even if a module is misconfigured.

A per-extension failure — the file doesn't exist, the module doesn't export `createSource`, importing it throws, `createSource()` itself throws — is caught, logged with `console.error` (naming the extension id), and that extension is simply omitted from the returned array. One broken extension never prevents any other extension from loading. As stated in Scope, this deliberately does not touch the `extensions` table's `valid`/`error` columns: those describe manifest validity, a `discoverExtensions` concern, not runtime code health — conflating them would make a code bug look like a broken manifest.

## Wiring into the poller

`src/sources/poller.ts`'s `startPoller` gains an optional 5th parameter:

```typescript
export function startPoller(
  db: Database,
  sources: TaskSource[],
  onTask: OnTask,
  intervalMs: number,
  loadDynamicSources?: () => Promise<TaskSource[]>,
): { stop(): void }
```

Each `tick()` now polls `[...sources, ...(await loadDynamicSources?.() ?? [])]` instead of just `sources`. Calling `loadEnabledExtensionSources` fresh every tick is what makes enabling, disabling, or rescanning an extension take effect without a restart — it's cheap (one SQLite query, plus Bun's own module cache making a repeat `import()` of an already-loaded path effectively free), so there's no need for a separate change-detection or invalidation mechanism. If `loadDynamicSources` itself rejects (shouldn't happen given the per-extension catch inside it, but as a last line of defense), the existing per-tick behavior already wraps each `pollOnce` call in its own try/catch — a top-level catch around the `await loadDynamicSources?.()` call itself is added so a defect in the loader can't take down polling for the static sources either.

## `main.ts` changes

- `createApp`'s returned `App` interface gains a `vault: Vault` field (alongside the existing `mcp`), so the `import.meta.main` block can reach it.
- The `import.meta.main` block passes `() => loadEnabledExtensionSources(app.deps.db, config.extensionsDir, app.vault)` as `startPoller`'s 5th argument.
- The poller now always starts, regardless of whether the static `sources` array is empty — an extension can be the *only* source Jidoka has configured. The existing "No sources configured" warning's condition and wording is adjusted to also account for this (it should no longer fire, or should mention extensions, if at least one is enabled — the simplest correct version just updates the message text to mention installing an extension, without adding a startup DB query purely to make the warning's exact firing condition airtight; the warning is informational, not a functional gate).

## Testing

- `tests/extensions/runtime.test.ts`: writes real `.ts` fixture files to a temp directory (a valid one exporting `createSource`, one missing entirely, one whose module doesn't export `createSource`, one whose `createSource` throws) and dynamically imports them for real — no mocking of `import()` itself, matching this codebase's existing preference for real behavior over mocks. Covers: a valid enabled+valid extension loads and its returned `TaskSource.poll()` works end-to-end against a stub `getToken`; a disabled extension is excluded; an invalid (manifest-failed) extension is excluded even if somehow marked enabled; each of the three failure shapes above is skipped without throwing, and a good extension alongside a broken one still loads.
- `tests/sources/poller.test.ts` gets one new case: `startPoller` with an empty static `sources` array and a `loadDynamicSources` stub returning one source confirms that source's items get ingested on a tick — proving the wiring, not re-testing `loadEnabledExtensionSources` itself.
