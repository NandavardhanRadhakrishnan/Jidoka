import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import * as extensions from "../../src/repo/extensions";
import type { ExtensionManifest } from "../../src/domain/extension";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const manifest: ExtensionManifest = {
  id: "notion",
  name: "Notion",
  version: "1.0.0",
  summary: "Reads pages from the databases you select.",
  readOnly: true,
  auth: { mode: "api-key", label: "Personal Access Token" },
};

test("upsertValid stores a manifest, disabled by default", () => {
  const db = freshDb();
  extensions.upsertValid(db, manifest);

  expect(extensions.get(db, "notion")).toEqual({
    id: "notion",
    name: "Notion",
    version: "1.0.0",
    summary: "Reads pages from the databases you select.",
    readOnly: true,
    auth: { mode: "api-key", label: "Personal Access Token" },
    expectedMcpServer: null,
    enabled: false,
    valid: true,
    error: null,
  });
});

test("re-running upsertValid preserves the enabled flag", () => {
  const db = freshDb();
  extensions.upsertValid(db, manifest);
  extensions.setEnabled(db, "notion", true);

  extensions.upsertValid(db, { ...manifest, name: "Notion (updated)" });

  const record = extensions.get(db, "notion");
  expect(record?.enabled).toBe(true);
  expect(record?.name).toBe("Notion (updated)");
});

test("upsertInvalid records an error and no auth", () => {
  const db = freshDb();
  extensions.upsertInvalid(db, "broken", "manifest.json is not valid JSON: Unexpected token");

  const record = extensions.get(db, "broken");
  expect(record?.valid).toBe(false);
  expect(record?.auth).toBeNull();
  expect(record?.error).toBe("manifest.json is not valid JSON: Unexpected token");
  expect(record?.enabled).toBe(false);
});

test("setEnabled toggles only the named extension", () => {
  const db = freshDb();
  extensions.upsertValid(db, manifest);
  extensions.upsertValid(db, { ...manifest, id: "other" });

  extensions.setEnabled(db, "notion", true);

  expect(extensions.get(db, "notion")?.enabled).toBe(true);
  expect(extensions.get(db, "other")?.enabled).toBe(false);
});

test("list returns every extension ordered by id", () => {
  const db = freshDb();
  extensions.upsertValid(db, { ...manifest, id: "zeta" });
  extensions.upsertValid(db, { ...manifest, id: "alpha" });

  expect(extensions.list(db).map((record) => record.id)).toEqual(["alpha", "zeta"]);
});

test("get returns null for an unknown id", () => {
  const db = freshDb();
  expect(extensions.get(db, "nope")).toBeNull();
});
