import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import type { Vault } from "../vault/vault";
import type { ExtensionSourceDeps, TaskSource } from "../sources/types";

export async function loadEnabledExtensionSources(
  db: Database,
  extensionsDir: string,
  vault: Vault,
): Promise<TaskSource[]> {
  const records = extensionsRepo.list(db).filter((record) => record.enabled && record.valid);

  const sources: TaskSource[] = [];
  for (const record of records) {
    try {
      const modulePath = pathToFileURL(join(extensionsDir, record.id, "source.ts")).href;
      const mod = (await import(modulePath)) as {
        createSource?: (deps: ExtensionSourceDeps) => TaskSource;
      };
      if (typeof mod.createSource !== "function") {
        console.error(`[extensions] ${record.id}: source.ts does not export createSource()`);
        continue;
      }
      const source = mod.createSource({ getToken: () => vault.getToken(record.id) });
      sources.push({ id: record.id, poll: source.poll.bind(source) });
    } catch (error) {
      console.error(`[extensions] failed to load source for ${record.id}:`, error);
    }
  }
  return sources;
}
