import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { createAuthRoutes, getValidAccessToken } from "../../src/api/auth";
import { loadTokens, saveTokens } from "../../src/repo/oauthTokens";
import type { OAuthProviderConfig } from "../../src/auth/oauth";

const provider: OAuthProviderConfig = {
  id: "demo",
  clientId: "client-123",
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["offline_access", "read"],
};

function routes() {
  const db = openDb(":memory:");
  migrate(db);
  const deps = { db, providers: { demo: provider } };
  const app = createAuthRoutes(deps);
  return { db, deps, fetch: async (req: Request) => app.fetch(req) };
}

test("start redirects to the provider with PKCE and state", async () => {
  const { fetch } = routes();

  const response = await fetch(new Request("http://localhost/api/auth/demo/start", { redirect: "manual" }));

  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://auth.example.com/authorize");
  expect(location.searchParams.get("client_id")).toBe("client-123");
  expect(location.searchParams.get("response_type")).toBe("code");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  expect(location.searchParams.get("state")).toMatch(/[0-9a-f-]{36}/);
  expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/demo/callback");
  expect(location.searchParams.get("scope")).toBe("offline_access read");
});

test("an unknown provider is a 404 on start and callback", async () => {
  const { fetch } = routes();

  expect((await fetch(new Request("http://localhost/api/auth/ghost/start"))).status).toBe(404);
  expect((await fetch(new Request("http://localhost/api/auth/ghost/callback?code=c&state=s"))).status).toBe(404);
});

test("a callback with unknown state is rejected", async () => {
  const { fetch } = routes();

  const response = await fetch(
    new Request("http://localhost/api/auth/demo/callback?code=abc&state=never-issued"),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "unknown or expired sign-in state" });
});

test("a provider error is shown instead of being exchanged", async () => {
  const { fetch } = routes();

  const response = await fetch(
    new Request("http://localhost/api/auth/demo/callback?error=access_denied&error_description=user+said+no"),
  );

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("access_denied");
});

test("status reports connected providers and signout clears them", async () => {
  const { db, fetch } = routes();

  const before = (await (await fetch(new Request("http://localhost/api/auth"))).json()) as {
    providers: { id: string; connected: boolean }[];
  };
  expect(before.providers).toEqual([
    expect.objectContaining({ id: "demo", connected: false }),
  ]);

  saveTokens(db, "demo", {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: Date.now() + 3_600_000,
  });

  const after = (await (await fetch(new Request("http://localhost/api/auth"))).json()) as {
    providers: { id: string; connected: boolean; expired: boolean }[];
  };
  expect(after.providers[0]).toMatchObject({ connected: true, expired: false });

  const out = await fetch(new Request("http://localhost/api/auth/demo/signout", { method: "POST" }));
  expect(out.status).toBe(200);
  expect(loadTokens(db, "demo")).toBeNull();
});

test("getValidAccessToken returns a live token and null when not signed in", async () => {
  const { db, deps } = routes();

  expect(await getValidAccessToken(deps, "demo")).toBeNull();

  saveTokens(db, "demo", {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: Date.now() + 3_600_000,
  });

  expect(await getValidAccessToken(deps, "demo")).toBe("at-1");
  expect(await getValidAccessToken(deps, "ghost")).toBeNull();
});

test("an expired token with no refresh token yields null rather than a failed call", async () => {
  const { db, deps } = routes();
  saveTokens(db, "demo", { accessToken: "at-1", refreshToken: null, expiresAt: 1_000 });

  expect(await getValidAccessToken(deps, "demo")).toBeNull();
});
