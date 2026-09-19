import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ExtensionManifestSchema } from "../domain/extension";
import * as extensions from "../repo/extensions";

export interface DiscoveryResult {
  valid: string[];
  invalid: { id: string; error: string }[];
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function discoverExtensions(db: Database, dir: string): Promise<DiscoveryResult> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return { valid: [], invalid: [] };
    throw error;
  }

  const result: DiscoveryResult = { valid: [], invalid: [] };

  for (const name of names.sort()) {
    const manifestPath = join(dir, name, "manifest.json");

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = `manifest.json is not valid JSON: ${(error as Error).message}`;
      extensions.upsertInvalid(db, name, message);
      result.invalid.push({ id: name, error: message });
      continue;
    }

    const manifest = ExtensionManifestSchema.safeParse(parsed);
    if (!manifest.success) {
      const message = manifest.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      extensions.upsertInvalid(db, name, message);
      result.invalid.push({ id: name, error: message });
      continue;
    }

    if (manifest.data.id !== name) {
      const message = `manifest id "${manifest.data.id}" does not match folder name "${name}"`;
      extensions.upsertInvalid(db, name, message);
      result.invalid.push({ id: name, error: message });
      continue;
    }

    extensions.upsertValid(db, manifest.data);
    result.valid.push(manifest.data.id);
  }

  return result;
}
