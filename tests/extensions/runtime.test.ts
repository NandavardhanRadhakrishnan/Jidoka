import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import * as extensions from "../../src/repo/extensions";
import { createVault } from "../../src/vault/vault";
import { loadEnabledExtensionSources } from "../../src/extensions/runtime";
import type { ExtensionManifest } from "../../src/domain/extension";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-ext-runtime-"));
}

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function manifest(id: string): ExtensionManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    summary: "test fixture",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  };
}

async function writeSource(dir: string, id: string, code: string): Promise<void> {
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source.ts"), code);
}

test("a valid, enabled extension's source loads and its poll() runs with an injected token", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("good"));
  extensions.setEnabled(db, "good", true);
  await writeSource(
    dir,
    "good",
    `export function createSource(deps) {
      return {
        id: "wrong-id",
        async poll(cursor) {
          const token = await deps.getToken();
          return { items: [{ externalId: "1", title: "via " + token, body: "" }], cursor: "next-cursor" };
        },
      };
    }`,
  );
  const vault = createVault({ db });
  vault.saveApiKey("good", "secret-token");

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toHaveLength(1);
  expect(sources[0]?.id).toBe("good");
  const result = await sources[0]!.poll(null);
  expect(result.items).toEqual([{ externalId: "1", title: "via secret-token", body: "" }]);
  expect(result.cursor).toBe("next-cursor");
});

test("a disabled extension is excluded even if its source.ts is valid", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("off"));
  await writeSource(
    dir,
    "off",
    `export function createSource() {
      return { id: "off", async poll() { return { items: [], cursor: null }; } };
    }`,
  );
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("an invalid extension is excluded even if somehow marked enabled", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertInvalid(db, "broken-manifest", "bad manifest");
  extensions.setEnabled(db, "broken-manifest", true);
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("a missing source.ts is skipped without throwing", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("ghost"));
  extensions.setEnabled(db, "ghost", true);
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("a source.ts with no createSource export is skipped without throwing", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("no-export"));
  extensions.setEnabled(db, "no-export", true);
  await writeSource(dir, "no-export", `export const notCreateSource = 1;`);
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toEqual([]);
});

test("a createSource that throws is skipped, and a good extension alongside it still loads", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("throws"));
  extensions.setEnabled(db, "throws", true);
  await writeSource(dir, "throws", `export function createSource() { throw new Error("boom"); }`);

  extensions.upsertValid(db, manifest("good2"));
  extensions.setEnabled(db, "good2", true);
  await writeSource(
    dir,
    "good2",
    `export function createSource() {
      return { id: "good2", async poll() { return { items: [], cursor: null }; } };
    }`,
  );

  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources.map((s) => s.id)).toEqual(["good2"]);
});
