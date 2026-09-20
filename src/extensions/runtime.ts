import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { stat, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import type { Vault } from "../vault/vault";
import type { ExtensionSourceDeps, TaskSource } from "../sources/types";

// Bun caches ES modules by their resolved import path for the lifetime of the
// process. If we always imported extensionsDir/<id>/source.ts, then once an
// extension's source had been imported once, a later "Fix" that overwrites
// that same file in place (via approve()'s copyFile) would silently keep
// serving the stale cached module forever — until a full process restart.
//
// To bust the cache, we import a copy of the source keyed by the real file's
// mtime instead of the real path. As long as the file hasn't changed since it
// was last loaded, the keyed cache path already exists and this is just a
// stat() + import() of an already-materialized file (cheap — the poller calls
// this every tick). The moment the file's mtime changes (a fresh
// generate/approve or fix/approve cycle), a brand-new cache path is computed,
// forcing Bun to actually import fresh code.
async function resolveCacheBustedModulePath(extensionsDir: string, id: string): Promise<string> {
  const sourcePath = join(extensionsDir, id, "source.ts");
  const { mtimeMs } = await stat(sourcePath);
  const cacheDir = join(tmpdir(), "jidoka-ext-cache");
  const cachePath = join(cacheDir, `${id}-${mtimeMs}.ts`);
  const alreadyCached = await stat(cachePath)
    .then(() => true)
    .catch(() => false);
  if (!alreadyCached) {
    await mkdir(cacheDir, { recursive: true });
    await copyFile(sourcePath, cachePath);
  }
  return pathToFileURL(cachePath).href;
}

export async function loadOneExtensionSource(
  db: Database,
  extensionsDir: string,
  vault: Vault,
  id: string,
): Promise<TaskSource> {
  const record = extensionsRepo.get(db, id);
  if (!record) throw new Error(`unknown extension: ${id}`);
  const modulePath = await resolveCacheBustedModulePath(extensionsDir, id);
  const mod = (await import(modulePath)) as {
    createSource?: (deps: ExtensionSourceDeps) => TaskSource;
  };
  if (typeof mod.createSource !== "function") {
    throw new Error(`${id}: source.ts does not export createSource()`);
  }
  const source = mod.createSource({ getToken: () => vault.getToken(id) });
  return { id: record.id, poll: source.poll.bind(source) };
}

export async function loadEnabledExtensionSources(
  db: Database,
  extensionsDir: string,
  vault: Vault,
): Promise<TaskSource[]> {
  const records = extensionsRepo.list(db).filter((record) => record.enabled && record.valid);

  const sources: TaskSource[] = [];
  for (const record of records) {
    try {
      sources.push(await loadOneExtensionSource(db, extensionsDir, vault, record.id));
    } catch (error) {
      console.error(`[extensions] failed to load source for ${record.id}:`, error);
    }
  }
  return sources;
}
