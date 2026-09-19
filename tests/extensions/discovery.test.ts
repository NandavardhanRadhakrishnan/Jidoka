import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import { discoverExtensions } from "../../src/extensions/discovery";
import * as extensions from "../../src/repo/extensions";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-extensions-"));
}

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

async function writeManifest(dir: string, id: string, manifest: unknown): Promise<void> {
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
}

test("a valid manifest is discovered and stored", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "notion", {
    id: "notion",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual(["notion"]);
  expect(result.invalid).toEqual([]);
  expect(extensions.get(db, "notion")?.valid).toBe(true);

  await rm(dir, { recursive: true, force: true });
});

test("malformed JSON is recorded as invalid, not thrown", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await mkdir(join(dir, "broken"), { recursive: true });
  await writeFile(join(dir, "broken", "manifest.json"), "{ not json");

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid).toEqual([
    { id: "broken", error: expect.stringContaining("not valid JSON") },
  ]);
  expect(extensions.get(db, "broken")?.valid).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("a manifest failing schema validation is recorded as invalid", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "half-built", { id: "half-built", name: "Half Built" });

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid.map((entry) => entry.id)).toEqual(["half-built"]);
  expect(extensions.get(db, "half-built")?.valid).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("a manifest id that does not match its folder name is rejected", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "notion", {
    id: "wrong-id",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid[0]?.error).toContain("does not match folder name");

  await rm(dir, { recursive: true, force: true });
});

test("a subfolder with no manifest.json is silently skipped", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await mkdir(join(dir, "not-an-extension"), { recursive: true });
  await writeFile(join(dir, "not-an-extension", "README.md"), "# notes");

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid).toEqual([]);

  await rm(dir, { recursive: true, force: true });
});

test("a missing extensions directory discovers nothing and does not throw", async () => {
  const db = freshDb();
  const result = await discoverExtensions(db, join(await freshDir(), "does-not-exist"));
  expect(result).toEqual({ valid: [], invalid: [] });
});

test("re-running discovery after enabling an extension leaves it enabled", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeManifest(dir, "notion", {
    id: "notion",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });
  await discoverExtensions(db, dir);
  extensions.setEnabled(db, "notion", true);

  await writeManifest(dir, "notion", {
    id: "notion",
    name: "Notion (renamed)",
    version: "1.0.1",
    summary: "Reads pages.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });
  await discoverExtensions(db, dir);

  const record = extensions.get(db, "notion");
  expect(record?.enabled).toBe(true);
  expect(record?.name).toBe("Notion (renamed)");

  await rm(dir, { recursive: true, force: true });
});

test("a loose file directly in the extensions root is silently skipped", async () => {
  const dir = await freshDir();
  const db = freshDb();
  await writeFile(join(dir, "not-a-folder.txt"), "just a file");

  const result = await discoverExtensions(db, dir);

  expect(result.valid).toEqual([]);
  expect(result.invalid).toEqual([]);

  await rm(dir, { recursive: true, force: true });
});
