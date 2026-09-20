# Wizard Path B: agent-authored extension generation

**Status:** design approved, not yet planned/implemented.

## Problem

Path A (installing an already-present extension folder) is built and working end to end: routes, wizard UI, and the poller actually run an enabled extension. But nothing yet *creates* an extension folder — a user who wants to connect Jidoka to a system with no existing extension has to hand-write `manifest.json` + `source.ts` themselves. Path B is the other half the vault plan's own spec described: describe a source in natural language, an agent writes it, the user reviews and approves.

## Scope

In scope: generating a new extension from a description (or fixing an existing one from a real test failure), a lightweight pre-write review gate, and two generically useful additions to the wizard that turn out to be required for Path B to be trustworthy at all — testing a connected extension's `poll()` for real, and deleting an extension outright.

Explicitly out of scope:
1. **Persisting or tracking generation provenance.** Nothing records "this extension was agent-generated" vs. hand-written, and nothing stores the original description after generation. Fix works by reading the *current* `manifest.json`/`source.ts` off disk plus a fresh error, not by remembering history — this is deliberate (see Approaches below), not a corner cut.
2. **A general "edit this extension via natural language" feature.** Fix is scoped specifically to "the last test-poll failed with this error, repair it" — not an open-ended regenerate/improve command.
3. **Enforcing Test before Activate.** Test is available and the UI's flow strongly suggests Connect → Test → Activate, but `enable`'s existing precondition (`status === "connected"`) is unchanged — nothing new is stored to hard-block activating an untested extension.
4. **The manifest's `config` field, pruning** — still deferred from earlier plans, unaffected by this one. Hot-reload is **not** independent of this plan the way it first appeared: Bun caches an imported module by resolved file path, so overwriting `source.ts` on disk (which is exactly what an approved Fix does) has no effect on a process that already imported it, until restart — the same limitation the poller-wiring plan accepted for a manual edit applies just as much to Fix's own overwrite. `loadOneExtensionSource` cache-busts by importing a copy keyed to the file's mtime instead of the stable path, specifically so Fix's own write-then-reload loop works within a single running process — this is the minimum needed to make Fix functional at all, not a general hot-reload feature.

## Generation

New `src/extensions/generator.ts`. Structurally parallel to `src/pipeline/builder.ts`'s `buildPipeline`, but driven by the tool-using `AgentRunner` interface (`src/agent/runner.ts`) instead of a plain `AiProvider.complete()` call — same interface, same `config.agent.runner`/model/concurrency pipelines already use.

```typescript
export interface GenerateInput {
  kind: "create";
  description: string;
}

export interface FixInput {
  kind: "fix";
  targetId: string;
  currentManifest: string; // raw manifest.json text
  currentSource: string;   // raw source.ts text
  error: string;           // the test-poll failure being repaired
}

export interface GeneratedExtension {
  manifest: ExtensionManifest;
  source: string; // source.ts text
}

export async function generateExtension(
  runAgent: AgentRunner,
  input: GenerateInput | FixInput,
): Promise<GeneratedExtension>
```

**Tool access:** `allowedTools` is the full currently-configured MCP tool catalog — the same trust model a pipeline's `agent` step already uses (the user's decision to configure an MCP server *is* the trust decision; Jidoka doesn't classify tools as read/write anywhere else, and this feature doesn't invent a new tier). With no MCP servers configured, or none relevant, this degrades gracefully to a toolless agent run — the same quality as pure-training-knowledge generation, which is often sufficient for well-known APIs (GitHub, Slack, Notion, Stripe). **Accepted risk, stated plainly:** the agent could in principle call an irrelevant write-capable tool from a configured MCP server while "researching," constrained only by the system prompt's framing, not a hard permission wall.

**System prompt** asks for two fenced blocks in one reply — ```json``` (the manifest) and ```typescript``` (`source.ts`) — and gives the exact three closed auth-mode shapes from `ExtensionManifestSchema` so the manifest comes out schema-valid on the first try in the common case, plus the `createSource(deps)` / `RawItem` / `poll()` contract (mirroring `src/sources/types.ts`). It explicitly says to write plain, untyped code with no `import type` of Jidoka's internals — nothing resolves that path at runtime (per the poller-wiring plan's own noted gap), and the validation below checks runtime shape, not `tsc` correctness.

For a **fix**, the prompt instead includes the current manifest and source verbatim plus the real error, and asks for a corrected version of both files — same two-fenced-block format. The result's `manifest.id` is forced to equal `targetId` by the caller regardless of what the model returns, so a fix can never accidentally rename the extension it's repairing.

**Validation, retried with feedback exactly like `buildPipeline` (up to 2 attempts):**
1. Both fenced blocks present — missing either is a retry-triggering failure.
2. Manifest parsed with `ExtensionManifestSchema.safeParse` — issues fed back verbatim.
3. `source.ts` written to a temp file and dynamically `import()`ed — reusing the same failure-detection `src/extensions/runtime.ts` already does: confirms `createSource` is exported and calling it with a stubbed `{getToken: async () => "stub-token"}` returns an object whose `poll` is a function. `poll()` itself is never invoked during this check. This bounds but does not eliminate what runs before a human reviews anything: the module's top-level statements and the `createSource()` factory body do execute in-process, with the same privileges as the rest of Jidoka (env vars, the sqlite file, network) — only `poll()`'s own network call is deferred past the review gate. Extension code has never been sandboxed (see the vault plan); this check narrows the pre-review execution surface, it doesn't close it.

If both attempts fail, the caller (the route) reports the last feedback message as the error; nothing is staged.

## Staging: pending drafts

A draft is not written into `extensionsDir` until approved. Held in an OS temp directory (`mkdtemp`) plus a small in-memory registry in `src/api/extensions.ts` (or a new small module it owns) — the exact same "ephemeral, a restart mid-flow just means starting over" shape the vault's own PKCE-pending map already uses:

```typescript
interface PendingGeneration {
  tempDir: string;
  manifest: ExtensionManifest;
  mode: "create" | "fix";
  targetId: string; // manifest.id for create (post auto-suffix); the fixed id for a fix
}
```

**Id collisions on create:** if the generated `manifest.id` collides with an already-installed extension or another pending draft, it's auto-suffixed (`notion` → `notion-2`) before staging — silently, since this is Jidoka-internal bookkeeping, not something worth interrupting the user over.

## Routes (added to `src/api/extensions.ts`)

- `POST /api/extensions/generate` — body `{ description: string }` → `{ generationId, manifest }` on success, `{ error }` if both generation attempts fail.
- `POST /api/extensions/generate/:id/approve` — looks up the pending entry (404 if gone — expired, already resolved, or a restart since generation). For `mode: "create"`, re-checks the collision at this moment (not just at generation time) and errors without deleting anything if one now exists. For `mode: "fix"`, expects `extensionsDir/<targetId>/` to already exist and overwrites its two files. Either way: creates the target folder if needed, **copies** (not renames — the temp dir and `extensionsDir` can be on different drives, e.g. `C:` vs `D:`, and a cross-drive rename fails outright) `manifest.json` and `source.ts` into it, deletes the temp dir, clears the registry entry, runs `discoverExtensions` so the extension (or its fix) is immediately visible. A copy failing partway removes the partially-created target folder and returns an error without touching the still-intact temp staging files, so the user can just retry.
- `POST /api/extensions/generate/:id/discard` — deletes the temp dir and registry entry.
- `POST /api/extensions/:id/test-poll` — loads that one extension's `source.ts` (same dynamic-import mechanism as `loadEnabledExtensionSources`, but for a single id and regardless of its `enabled` flag — this is explicitly a pre-activation check), calls `source.poll(null)` directly rather than through `pollOnce`, so **no task is inserted and no cursor is stored or advanced** — a test run must be fully side-effect-free with respect to Jidoka's own data, or a subsequent real Activate would silently skip whatever the test already "consumed." Returns `{ itemCount, sample: RawItem[] }` (a small prefix of the returned items) on success, `{ error }` on failure (including a `getToken()` failure — not connected yet, needs reauth, etc., which surfaces exactly the same way a real poll failure would).
- `POST /api/extensions/:id/delete` — `vault.disconnect(id)`, a new `extensionsRepo.remove(db, id)` (doesn't exist yet — `upsertValid`/`upsertInvalid`/`get`/`list`/`setEnabled` do, `remove` doesn't), and deletes `extensionsDir/<id>/` from disk. A genuinely destructive action; the UI confirms before calling it.
- `POST /api/extensions/:id/fix` — body `{ error: string }`. Reads `manifest.json`/`source.ts` off disk for `id`, calls `generateExtension` in fix mode, stages the result exactly like a fresh generation (same registry, same approve/discard routes apply).

## UI

A "Generate" control in the Extensions panel next to Rescan, opening a description textarea. While the agent runs (tool calls can take a while), a busy state. On success: a draft review card — name/summary/`readOnly`/auth mode, Approve/Discard — kept visually separate from the installed list until approved (this reuses the manifest's existing `summary` field, added specifically for this kind of review in the vault plan). On failure, the error is shown with a chance to edit the description and retry.

Two generic additions to every row's actions (Path A extensions benefit too, not just generated ones): once `status === "connected"`, a **Test** button appears next to Activate. Result shows inline — `✓ N items found` or `✗ <error>`. On failure, **Fix** appears (submits that error, lands back at the same draft-review card). **Delete** is unconditional on every row regardless of test status — there's no reason removing an extension should require first running a failed test, and it needs to be available for an extension that was never connected or tested at all.

## Testing

- `tests/extensions/generator.test.ts` — a stub `AgentRunner` (an object implementing `.run()` returning canned text, matching the shape `tests/pipeline/builder.test.ts` already stubs the provider with). Covers: two-fenced-block extraction; the schema-validation retry path; the dynamic-import shape-check retry path (an export that isn't `createSource`, one that throws, one whose returned object has no `poll`); fix-mode's `manifest.id` being pinned to `targetId` even when the stubbed response tries to change it.
- `tests/api/extensions.test.ts` extended for the six new routes: generate→approve happy path (stub `AgentRunner` returning valid content in one shot) and the id-collision-triggers-error path; discard; `test-poll` with a real fixture `source.ts` and a real assertion that zero task rows exist and no cursor was stored afterward (not just that the response shape looks right); delete asserting the DB row, credential, and on-disk folder are all gone and a subsequent rescan doesn't resurrect it; fix overwriting an existing extension's files in place and preserving `targetId` regardless of the stub's returned manifest id.
