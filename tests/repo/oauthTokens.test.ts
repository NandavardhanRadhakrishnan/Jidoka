import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import {
  saveTokens,
  loadTokens,
  deleteTokens,
  listProviders,
} from "../../src/repo/oauthTokens";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("saveTokens upserts and replaces an existing row for the same provider", () => {
  const db = freshDb();

  saveTokens(db, "outlook", {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 1_000,
  });
  saveTokens(db, "outlook", {
    accessToken: "at-2",
    refreshToken: "rt-2",
    expiresAt: 2_000,
  });

  expect(loadTokens(db, "outlook")).toEqual({
    accessToken: "at-2",
    refreshToken: "rt-2",
    expiresAt: 2_000,
  });
  expect(listProviders(db)).toEqual(["outlook"]);
});

test("two providers coexist independently", () => {
  const db = freshDb();

  saveTokens(db, "outlook", { accessToken: "at-o", refreshToken: "rt-o", expiresAt: 1_000 });
  saveTokens(db, "github", { accessToken: "at-g", refreshToken: "rt-g", expiresAt: 2_000 });

  expect(loadTokens(db, "outlook")).toEqual({
    accessToken: "at-o",
    refreshToken: "rt-o",
    expiresAt: 1_000,
  });
  expect(loadTokens(db, "github")).toEqual({
    accessToken: "at-g",
    refreshToken: "rt-g",
    expiresAt: 2_000,
  });
});

test("a null refreshToken round-trips as null", () => {
  const db = freshDb();

  saveTokens(db, "github", { accessToken: "at-1", refreshToken: null, expiresAt: 1_000 });

  expect(loadTokens(db, "github")).toEqual({
    accessToken: "at-1",
    refreshToken: null,
    expiresAt: 1_000,
  });
});

test("deleteTokens removes only that provider", () => {
  const db = freshDb();

  saveTokens(db, "outlook", { accessToken: "at-o", refreshToken: "rt-o", expiresAt: 1_000 });
  saveTokens(db, "github", { accessToken: "at-g", refreshToken: "rt-g", expiresAt: 2_000 });

  deleteTokens(db, "outlook");

  expect(loadTokens(db, "outlook")).toBeNull();
  expect(loadTokens(db, "github")).not.toBeNull();
});

test("loadTokens returns null for an unknown provider", () => {
  const db = freshDb();
  expect(loadTokens(db, "nope")).toBeNull();
});

test("listProviders returns the stored provider names", () => {
  const db = freshDb();

  saveTokens(db, "outlook", { accessToken: "at-o", refreshToken: "rt-o", expiresAt: 1_000 });
  saveTokens(db, "github", { accessToken: "at-g", refreshToken: "rt-g", expiresAt: 2_000 });

  expect(listProviders(db).sort()).toEqual(["github", "outlook"]);
});
