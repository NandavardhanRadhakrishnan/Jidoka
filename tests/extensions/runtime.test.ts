import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import * as extensions from "../../src/repo/extensions";
import { createVault } from "../../src/vault/vault";
import { loadEnabledExtensionSources, loadOneExtensionSource, resolveIdentity } from "../../src/extensions/runtime";
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

test("a valid, enabled extension's source loads and its list() runs with the window and an injected token", async () => {
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
        async list({ since }) {
          const token = await deps.getToken();
          return {
            items: [{ key: "1", occurredAt: "2026-10-20T10:00:00.000Z", title: "via " + token + " since " + since, body: "" }],
            failures: [],
          };
        },
      };
    }`,
  );
  const vault = createVault({ db });
  vault.saveApiKey("good", "secret-token");

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toHaveLength(1);
  expect(sources[0]?.id).toBe("good");
  const result = await sources[0]!.list({ since: "2026-10-18T00:00:00.000Z" });
  expect(result.items).toEqual([
    {
      key: "1",
      occurredAt: "2026-10-20T10:00:00.000Z",
      title: "via secret-token since 2026-10-18T00:00:00.000Z",
      body: "",
    },
  ]);
  expect(result.failures).toEqual([]);
});

test("an extension whose createSource returns only poll() is rejected with a list({ since }) message", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("old-style"));
  await writeSource(
    dir,
    "old-style",
    `export function createSource() {
      return { async poll(cursor) { return { items: [], cursor }; } };
    }`,
  );
  const vault = createVault({ db });

  await expect(loadOneExtensionSource(db, dir, vault, "old-style")).rejects.toThrow(
    "old-style: createSource() must return an object with a list({ since }) function",
  );
});

test("a disabled extension is excluded even if its source.ts is valid", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("off"));
  await writeSource(
    dir,
    "off",
    `export function createSource() {
      return { id: "off", async list() { return { items: [] }; } };
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
      return { id: "good2", async list() { return { items: [] }; } };
    }`,
  );

  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources.map((s) => s.id)).toEqual(["good2"]);
});

test("a source's list method is bound correctly to the original source object so this-based implementations work", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("bound"));
  extensions.setEnabled(db, "bound", true);
  await writeSource(
    dir,
    "bound",
    `export function createSource() {
      return {
        id: "unused",
        label: "bound-correctly",
        async list() {
          return { items: [{ key: "1", occurredAt: "2026-10-20T10:00:00.000Z", title: this.label, body: "" }] };
        },
      };
    }`,
  );
  const vault = createVault({ db });

  const sources = await loadEnabledExtensionSources(db, dir, vault);

  expect(sources).toHaveLength(1);
  expect(sources[0]?.id).toBe("bound");
  const result = await sources[0]!.list({ since: null });
  expect(result.items).toEqual([{ key: "1", occurredAt: "2026-10-20T10:00:00.000Z", title: "bound-correctly", body: "" }]);
});

test("loadOneExtensionSource loads a single extension regardless of its enabled flag", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("solo"));
  // deliberately not enabled
  await writeSource(
    dir,
    "solo",
    `export function createSource() {
      return { async list() { return { items: [], failures: [{ error: "solo-marker" }] }; } };
    }`,
  );
  const vault = createVault({ db });

  const source = await loadOneExtensionSource(db, dir, vault, "solo");

  expect(source.id).toBe("solo");
  expect((await source.list({ since: null })).failures).toEqual([{ error: "solo-marker" }]);
});

test("loadOneExtensionSource cache-busts by mtime: approving a Fix overwrites source.ts in place, and the very next load reflects the new code without a process restart", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("fixable"));
  await writeSource(
    dir,
    "fixable",
    `export function createSource() {
      return { async list() { return { items: [], failures: [{ error: "v1-marker" }] }; } };
    }`,
  );
  const vault = createVault({ db });

  const first = await loadOneExtensionSource(db, dir, vault, "fixable");
  expect((await first.list({ since: null })).failures).toEqual([{ error: "v1-marker" }]);

  // Mimic approve()'s exact sequence for a "fix": the same source.ts path is
  // overwritten in place with corrected content. A naive "import the stable
  // path" implementation would have Bun's module cache return the v1 module
  // forever from here on — this is exactly the bug the reviewer verified.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeSource(
    dir,
    "fixable",
    `export function createSource() {
      return { async list() { return { items: [], failures: [{ error: "v2-marker" }] }; } };
    }`,
  );

  const second = await loadOneExtensionSource(db, dir, vault, "fixable");
  expect((await second.list({ since: null })).failures).toEqual([{ error: "v2-marker" }]);
});

test("loadOneExtensionSource throws for an unknown id", async () => {
  const db = freshDb();
  const dir = await freshDir();
  const vault = createVault({ db });

  await expect(loadOneExtensionSource(db, dir, vault, "ghost")).rejects.toThrow(/unknown extension/);
});

test("resolveIdentity calls an exported getIdentity with the vault's token", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("gh"));
  await writeSource(
    dir,
    "gh",
    `export function createSource() { return { id: "gh", async list() { return { items: [] }; } }; }
     export async function getIdentity(deps) { return "user-for-" + (await deps.getToken()); }`,
  );
  const vault = createVault({ db });
  vault.saveApiKey("gh", "tok");

  expect(await resolveIdentity(db, dir, vault, "gh")).toBe("user-for-tok");
});

test("resolveIdentity returns null when the source has no getIdentity export", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("plain"));
  await writeSource(dir, "plain", `export function createSource() { return { id: "plain", async list() { return { items: [] }; } }; }`);

  expect(await resolveIdentity(db, dir, createVault({ db }), "plain")).toBeNull();
});

test("resolveIdentity returns null instead of throwing when getIdentity fails", async () => {
  const db = freshDb();
  const dir = await freshDir();
  extensions.upsertValid(db, manifest("flaky"));
  await writeSource(
    dir,
    "flaky",
    `export function createSource() { return { id: "flaky", async list() { return { items: [] }; } }; }
     export async function getIdentity() { throw new Error("network down"); }`,
  );

  expect(await resolveIdentity(db, dir, createVault({ db }), "flaky")).toBeNull();
});
