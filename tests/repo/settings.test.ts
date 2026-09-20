import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { getSettings, saveSettings } from "../../src/repo/settings";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("getSettings on an empty db returns {}", () => {
  const db = freshDb();
  expect(getSettings(db)).toEqual({});
});

test("saveSettings persists and round-trips", () => {
  const db = freshDb();
  const saved = saveSettings(db, { sampleDir: "./samples", ai: { model: "claude-sonnet-5" } });

  expect(saved).toEqual({ sampleDir: "./samples", ai: { model: "claude-sonnet-5" } });
  expect(getSettings(db)).toEqual(saved);
});

test("saveSettings merges into an existing section instead of replacing it", () => {
  const db = freshDb();
  saveSettings(db, { ai: { apiKey: "sk-test", model: "claude-sonnet-5" } });

  const updated = saveSettings(db, { ai: { model: "claude-opus-5" } });

  expect(updated.ai).toEqual({ apiKey: "sk-test", model: "claude-opus-5" });
});

test("saveSettings replaces whole-value fields like mcpServers rather than merging them", () => {
  const db = freshDb();
  saveSettings(db, { mcpServers: [{ name: "a", command: "a", args: [] }] });

  const updated = saveSettings(db, { mcpServers: [{ name: "b", command: "b", args: [] }] });

  expect(updated.mcpServers).toEqual([{ name: "b", command: "b", args: [] }]);
});

test("saveSettings leaves a section untouched when the patch omits it", () => {
  const db = freshDb();
  saveSettings(db, { ai: { model: "claude-sonnet-5" }, sampleDir: "./samples" });

  const updated = saveSettings(db, { extensionsDir: "./extensions" });

  expect(updated.ai).toEqual({ model: "claude-sonnet-5" });
  expect(updated.sampleDir).toBe("./samples");
  expect(updated.extensionsDir).toBe("./extensions");
});
