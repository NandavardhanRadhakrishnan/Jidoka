import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import type { Vault } from "../vault/vault";
import type { ExtensionSourceDeps, TaskSource } from "../sources/types";

export async function loadOneExtensionSource(
  db: Database,
  extensionsDir: string,
  vault: Vault,
  id: string,
): Promise<TaskSource> {
  const record = extensionsRepo.get(db, id);
  if (!record) throw new Error(`unknown extension: ${id}`);
  const modulePath = pathToFileURL(join(extensionsDir, id, "source.ts")).href;
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
