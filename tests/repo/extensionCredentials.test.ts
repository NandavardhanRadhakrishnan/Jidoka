import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import * as credentials from "../../src/repo/extensionCredentials";
import * as extensions from "../../src/repo/extensions";
import type { ExtensionManifest } from "../../src/domain/extension";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function setupExtension(db: ReturnType<typeof openDb>, id: string = "notion") {
  const manifest: ExtensionManifest = {
    id,
    name: "Notion",
    version: "1.0.0",
    summary: "Test extension",
    readOnly: true,
    auth: { mode: "api-key", label: "API Key" },
  };
  extensions.upsertValid(db, manifest);
}

test("save then load round-trips the payload", () => {
  const db = freshDb();
  setupExtension(db);
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);

  expect(credentials.load(db, "notion")).toEqual({
    authMode: "api-key",
    payload: { apiKey: "secret-1" },
    status: "connected",
    updatedAt: 1_000,
  });
});

test("saving again replaces the previous payload for the same extension", () => {
  const db = freshDb();
  setupExtension(db);
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);
  credentials.save(db, "notion", "api-key", { apiKey: "secret-2" }, "connected", 2_000);

  expect(credentials.load(db, "notion")?.payload).toEqual({ apiKey: "secret-2" });
});

test("setStatus changes only the status", () => {
  const db = freshDb();
  setupExtension(db);
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);

  credentials.setStatus(db, "notion", "needs_reauth");

  const stored = credentials.load(db, "notion");
  expect(stored?.status).toBe("needs_reauth");
  expect(stored?.payload).toEqual({ apiKey: "secret-1" });
});

test("remove deletes the stored credential", () => {
  const db = freshDb();
  setupExtension(db);
  credentials.save(db, "notion", "api-key", { apiKey: "secret-1" }, "connected", 1_000);

  credentials.remove(db, "notion");

  expect(credentials.load(db, "notion")).toBeNull();
});

test("load returns null for an extension with no stored credential", () => {
  const db = freshDb();
  expect(credentials.load(db, "nope")).toBeNull();
});
