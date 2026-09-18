import { test, expect } from "bun:test";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  refreshTokens,
  type HttpFetch,
  type OAuthProviderConfig,
} from "../../src/auth/oauth";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

const config: OAuthProviderConfig = {
  id: "outlook",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  clientId: "client-123",
  clientSecret: "super-secret-value",
  scopes: ["offline_access", "Mail.Read"],
};

const publicClientConfig: OAuthProviderConfig = {
  id: "anthropic",
  authorizeUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  clientId: "public-client",
  scopes: ["profile"],
};

test("createPkcePair produces a spec-shaped verifier and a real S256 challenge", async () => {
  const pair = await createPkcePair();

  expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
  expect(pair.verifier.length).toBeLessThanOrEqual(128);
  expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);

  expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(pair.challenge).not.toContain("=");

  const recomputed = await sha256Base64Url(pair.verifier);
  expect(pair.challenge).toBe(recomputed);
});

test("createPkcePair does not repeat itself", async () => {
  const first = await createPkcePair();
  const second = await createPkcePair();
  expect(first.verifier).not.toBe(second.verifier);
});

test("buildAuthorizeUrl includes every required param and encodes spaces as %20", () => {
  const url = buildAuthorizeUrl(config, {
    redirectUri: "http://localhost:3000/callback",
    state: "state-abc",
    challenge: "challenge-xyz",
  });

  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe(config.authorizeUrl);
  expect(parsed.searchParams.get("response_type")).toBe("code");
  expect(parsed.searchParams.get("client_id")).toBe("client-123");
  expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback");
  expect(parsed.searchParams.get("scope")).toBe("offline_access Mail.Read");
  expect(parsed.searchParams.get("state")).toBe("state-abc");
  expect(parsed.searchParams.get("code_challenge")).toBe("challenge-xyz");
  expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");

  // The raw query string must use %20, never "+", for the space in the scope list.
  expect(url).toContain("offline_access%20Mail.Read");
  expect(url).not.toContain("offline_access+Mail.Read");
});

test("buildAuthorizeUrl appends extraAuthParams", () => {
  const url = buildAuthorizeUrl(
    { ...config, extraAuthParams: { prompt: "consent", access_type: "offline" } },
    { redirectUri: "http://localhost:3000/callback", state: "s", challenge: "c" },
  );

  const parsed = new URL(url);
  expect(parsed.searchParams.get("prompt")).toBe("consent");
  expect(parsed.searchParams.get("access_type")).toBe("offline");
});

test("exchangeCode posts the right form body and maps the token response", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  const fakeFetch: HttpFetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        access_token: "access-token-value",
        refresh_token: "refresh-token-value",
        expires_in: 1800,
        scope: "offline_access Mail.Read",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const tokens = await exchangeCode(config, {
    code: "auth-code-value",
    verifier: "verifier-value",
    redirectUri: "http://localhost:3000/callback",
    fetch: fakeFetch,
    now: () => 1_000_000,
  });

  expect(capturedUrl).toBe(config.tokenUrl);
  expect(capturedInit?.method).toBe("POST");
  expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBe(
    "application/x-www-form-urlencoded",
  );

  const body = new URLSearchParams(capturedInit?.body as string);
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("auth-code-value");
  expect(body.get("redirect_uri")).toBe("http://localhost:3000/callback");
  expect(body.get("client_id")).toBe("client-123");
  expect(body.get("code_verifier")).toBe("verifier-value");
  expect(body.get("client_secret")).toBe("super-secret-value");

  expect(tokens).toEqual({
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresAt: 1_000_000 + 1800 * 1000,
    scope: "offline_access Mail.Read",
  });
});

test("exchangeCode defaults expires_in to 3600s and null refresh_token when absent", async () => {
  const fakeFetch: HttpFetch = async () =>
    new Response(JSON.stringify({ access_token: "only-access-token" }), { status: 200 });

  const tokens = await exchangeCode(publicClientConfig, {
    code: "code",
    verifier: "verifier",
    redirectUri: "http://localhost/callback",
    fetch: fakeFetch,
    now: () => 0,
  });

  expect(tokens.refreshToken).toBeNull();
  expect(tokens.expiresAt).toBe(3600 * 1000);
  expect(tokens.scope).toBeUndefined();
});

test("exchangeCode omits client_secret for a public (PKCE-only) client", async () => {
  let capturedBody: string | undefined;

  const fakeFetch: HttpFetch = async (_input, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
  };

  await exchangeCode(publicClientConfig, {
    code: "code",
    verifier: "verifier",
    redirectUri: "http://localhost/callback",
    fetch: fakeFetch,
    now: () => 0,
  });

  const body = new URLSearchParams(capturedBody);
  expect(body.has("client_secret")).toBe(false);
});

test("refreshTokens maps a response that omits refresh_token to null", async () => {
  let capturedBody: string | undefined;

  const fakeFetch: HttpFetch = async (_input, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({ access_token: "new-access-token", expires_in: 900 }),
      { status: 200 },
    );
  };

  const tokens = await refreshTokens(config, {
    refreshToken: "old-refresh-token",
    fetch: fakeFetch,
    now: () => 5000,
  });

  const body = new URLSearchParams(capturedBody);
  expect(body.get("grant_type")).toBe("refresh_token");
  expect(body.get("refresh_token")).toBe("old-refresh-token");

  // The caller is expected to keep its previously stored refresh token when this is null.
  expect(tokens.refreshToken).toBeNull();
  expect(tokens.accessToken).toBe("new-access-token");
  expect(tokens.expiresAt).toBe(5000 + 900 * 1000);
});

test("a 400 response throws with the status and error_description, without leaking the secret", async () => {
  const fakeFetch: HttpFetch = async () =>
    new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "The refresh token expired" }),
      { status: 400, statusText: "Bad Request" },
    );

  await expect(
    refreshTokens(config, { refreshToken: "old-refresh-token", fetch: fakeFetch, now: () => 0 }),
  ).rejects.toThrow(/400/);

  try {
    await refreshTokens(config, { refreshToken: "old-refresh-token", fetch: fakeFetch, now: () => 0 });
    throw new Error("expected refreshTokens to throw");
  } catch (err) {
    const message = (err as Error).message;
    expect(message).toContain("400");
    expect(message).toContain("The refresh token expired");
    expect(message).not.toContain(config.clientSecret as string);
    expect(message).not.toContain("old-refresh-token");
  }
});
