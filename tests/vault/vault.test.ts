// tests/vault/vault.test.ts
import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import * as extensions from "../../src/repo/extensions";
import * as credentials from "../../src/repo/extensionCredentials";
import { createVault, AuthPendingError, type VaultDeps } from "../../src/vault/vault";
import type { ExtensionManifest } from "../../src/domain/extension";
import type { HttpFetch } from "../../src/vault/deviceCode";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const apiKeyManifest: ExtensionManifest = {
  id: "notion",
  name: "Notion",
  version: "1.0.0",
  summary: "Reads pages.",
  readOnly: true,
  auth: { mode: "api-key", label: "Personal Access Token" },
};

const deviceCodeManifest: ExtensionManifest = {
  id: "outlook2",
  name: "Outlook",
  version: "1.0.0",
  summary: "Reads mail.",
  readOnly: true,
  auth: {
    mode: "oauth2-device-code",
    deviceCodeUrl: "https://example.com/devicecode",
    tokenUrl: "https://example.com/token",
    clientId: "client-1",
    scopes: ["Mail.Read"],
  },
};

const pkceManifest: ExtensionManifest = {
  id: "slack",
  name: "Slack",
  version: "1.0.0",
  summary: "Reads channel messages.",
  readOnly: true,
  auth: {
    mode: "oauth2-auth-code-pkce",
    authorizeUrl: "https://example.com/authorize",
    tokenUrl: "https://example.com/token",
    clientId: "client-1",
    scopes: ["channels:read"],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("saveApiKey then getToken returns the stored key with no HTTP calls", async () => {
  const db = freshDb();
  extensions.upsertValid(db, apiKeyManifest);
  const vault = createVault({ db, fetch: async () => { throw new Error("should not fetch"); } });

  vault.saveApiKey("notion", "secret-key");

  expect(await vault.getToken("notion")).toBe("secret-key");
  expect(vault.status("notion")).toBe("connected");
});

test("getToken returns a stored oauth token that has not expired", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 2_000_000 },
    "connected",
    0,
  );
  const vault = createVault({
    db,
    now: () => 1_000_000,
    fetch: async () => { throw new Error("should not refresh"); },
  });

  expect(await vault.getToken("slack")).toBe("at-1");
});

test("getToken refreshes an expired oauth token and persists the new one", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000 },
    "connected",
    0,
  );
  const fakeFetch: HttpFetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  };
  const vault = createVault({ db, now: () => 1_000_000, fetch: fakeFetch });

  const token = await vault.getToken("slack");

  expect(token).toBe("at-2");
  expect(credentials.load(db, "slack")?.payload).toEqual({
    accessToken: "at-2",
    refreshToken: "rt-2",
    expiresAt: 1_000_000 + 3600 * 1000,
  });
});

test("getToken refreshes an expired oauth token stored under device-code mode and persists the new one", async () => {
  const db = freshDb();
  extensions.upsertValid(db, deviceCodeManifest);
  credentials.save(
    db,
    "outlook2",
    "oauth2-device-code",
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000 },
    "connected",
    0,
  );
  const fakeFetch: HttpFetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  };
  const vault = createVault({ db, now: () => 1_000_000, fetch: fakeFetch });

  const token = await vault.getToken("outlook2");

  expect(token).toBe("at-2");
  expect(credentials.load(db, "outlook2")?.payload).toEqual({
    accessToken: "at-2",
    refreshToken: "rt-2",
    expiresAt: 1_000_000 + 3600 * 1000,
  });
});

test("getToken flips status to needs_reauth and rethrows when refresh fails", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000 },
    "connected",
    0,
  );
  const vault = createVault({
    db,
    now: () => 1_000_000,
    fetch: async () => jsonResponse({ error: "invalid_grant" }, 400),
  });

  await expect(vault.getToken("slack")).rejects.toThrow();
  expect(credentials.load(db, "slack")?.status).toBe("needs_reauth");
});

test("getToken throws and flips status when there is no refresh token to use", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  credentials.save(
    db,
    "slack",
    "oauth2-auth-code-pkce",
    { accessToken: "at-1", refreshToken: null, expiresAt: 1_000 },
    "connected",
    0,
  );
  const vault = createVault({ db, now: () => 1_000_000 });

  await expect(vault.getToken("slack")).rejects.toThrow(/reauthorization/);
  expect(credentials.load(db, "slack")?.status).toBe("needs_reauth");
});

test("device-code connect flow stores a connected credential", async () => {
  const db = freshDb();
  extensions.upsertValid(db, deviceCodeManifest);
  const fakeFetch: HttpFetch = async (input) => {
    if (String(input).includes("devicecode")) {
      return jsonResponse({
        user_code: "ABCD",
        device_code: "dc-1",
        verification_uri: "https://example.com/activate",
        expires_in: 900,
        interval: 5,
      });
    }
    return jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  };
  const vault = createVault({ db, now: () => 0, fetch: fakeFetch });

  const login = await vault.startDeviceConnect("outlook2");
  expect(login.deviceCode).toBe("dc-1");

  await vault.completeDeviceConnect("outlook2", "dc-1");

  expect(vault.status("outlook2")).toBe("connected");
  expect(await vault.getToken("outlook2")).toBe("at-1");
});

test("completeDeviceConnect propagates AuthPendingError without saving anything", async () => {
  const db = freshDb();
  extensions.upsertValid(db, deviceCodeManifest);
  const vault = createVault({
    db,
    fetch: async () => jsonResponse({ error: "authorization_pending" }, 400),
  });

  await expect(vault.completeDeviceConnect("outlook2", "dc-1")).rejects.toBeInstanceOf(AuthPendingError);
  expect(vault.status("outlook2")).toBe("not_connected");
});

test("auth-code+PKCE connect flow: the authorize URL carries state, and a matching code completes it", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  const fakeFetch: HttpFetch = async () =>
    jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  const vault = createVault({ db, now: () => 0, fetch: fakeFetch });

  const { url } = await vault.startAuthCodeConnect("slack", "http://localhost:3000/callback");
  const parsed = new URL(url);
  const state = parsed.searchParams.get("state")!;
  expect(parsed.origin + parsed.pathname).toBe("https://example.com/authorize");
  expect(state.length).toBeGreaterThan(0);

  await vault.completeAuthCodeConnect("slack", "auth-code-1", state);

  expect(vault.status("slack")).toBe("connected");
  expect(await vault.getToken("slack")).toBe("at-1");
});

test("completeAuthCodeConnect rejects a mismatched state", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  const vault = createVault({ db, fetch: async () => jsonResponse({}) });

  await vault.startAuthCodeConnect("slack", "http://localhost:3000/callback");

  await expect(vault.completeAuthCodeConnect("slack", "code", "wrong-state")).rejects.toThrow(/state/);
});

test("calling a device-code method against a PKCE extension is rejected", async () => {
  const db = freshDb();
  extensions.upsertValid(db, pkceManifest);
  const vault = createVault({ db });

  await expect(vault.startDeviceConnect("slack")).rejects.toThrow(/does not use device-code/);
});

test("getToken rejects a stored credential whose auth mode no longer matches the manifest", async () => {
  const db = freshDb();
  extensions.upsertValid(db, apiKeyManifest);
  credentials.save(db, "notion", "api-key", { apiKey: "secret-key" }, "connected", 0);

  // Manifest is re-discovered with a different auth mode than the stored credential.
  extensions.upsertValid(db, { ...apiKeyManifest, auth: pkceManifest.auth });
  const vault = createVault({ db });

  await expect(vault.getToken("notion")).rejects.toThrow(/not connected/);
});

test("disconnect removes the credential and status reverts to not_connected", async () => {
  const db = freshDb();
  extensions.upsertValid(db, apiKeyManifest);
  const vault = createVault({ db });
  vault.saveApiKey("notion", "secret-key");

  vault.disconnect("notion");

  expect(vault.status("notion")).toBe("not_connected");
  await expect(vault.getToken("notion")).rejects.toThrow(/not connected/);
});
