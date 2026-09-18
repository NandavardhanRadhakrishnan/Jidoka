// Provider-agnostic OAuth 2.0 authorization-code + PKCE helper.
//
// This module knows nothing about any particular provider (Anthropic, Outlook, ...);
// callers supply an `OAuthProviderConfig` describing the provider's endpoints and
// client registration. All network access goes through the injectable `fetch` seam
// so this module (and everything that uses it) can be tested without a network.

export interface OAuthProviderConfig {
  id: string; // e.g. "anthropic", "outlook"
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string; // omitted for public clients (PKCE only)
  scopes: string[];
  /** Extra params appended to the authorize URL, e.g. { prompt: "consent" }. */
  extraAuthParams?: Record<string, string>;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope?: string;
}

export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/** Base64url-encode bytes with no padding, per RFC 7636. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generates a PKCE verifier/challenge pair.
 *
 * The verifier is 32 random bytes, base64url-encoded (43 characters, well within
 * RFC 7636's 43-128 char requirement) from unreserved base64url characters only.
 * The challenge is base64url(SHA-256(verifier)), no padding (the "S256" method).
 */
export async function createPkcePair(): Promise<PkcePair> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const verifier = base64UrlEncode(randomBytes);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));

  return { verifier, challenge };
}

/**
 * Builds the authorization URL the user is sent to. Spaces in the scope list are
 * percent-encoded as %20 (not "+") — Microsoft Graph, among others, rejects "+".
 */
export function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  args: { redirectUri: string; state: string; challenge: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: args.redirectUri,
    scope: config.scopes.join(" "),
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
  });

  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    params.set(key, value);
  }

  // URLSearchParams encodes spaces as "+"; any literal "+" in a value is itself
  // encoded as "%2B", so it's safe to turn every remaining "+" into "%20".
  const query = params.toString().replace(/\+/g, "%20");

  return `${config.authorizeUrl}?${query}`;
}

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postTokenRequest(
  config: OAuthProviderConfig,
  body: Record<string, string>,
  httpFetch: HttpFetch,
): Promise<TokenResponseBody> {
  const form = new URLSearchParams(body);
  if (config.clientSecret !== undefined) {
    form.set("client_secret", config.clientSecret);
  }

  const response = await httpFetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const text = await response.text();
  let parsed: TokenResponseBody = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as TokenResponseBody) : {};
  } catch {
    // Non-JSON body; fall through with an empty parsed object.
  }

  if (!response.ok) {
    const detail = parsed.error_description ?? parsed.error ?? (response.statusText || "request failed");
    throw new Error(`OAuth token request to "${config.id}" failed with ${response.status}: ${detail}`);
  }

  return parsed;
}

function toTokens(body: TokenResponseBody, now: () => number): OAuthTokens {
  if (!body.access_token) {
    throw new Error(`OAuth token response is missing "access_token"`);
  }

  const expiresInSeconds = body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: now() + expiresInSeconds * 1000,
    ...(body.scope !== undefined ? { scope: body.scope } : {}),
  };
}

/** Exchanges an authorization code (and its PKCE verifier) for tokens. */
export async function exchangeCode(
  config: OAuthProviderConfig,
  args: {
    code: string;
    verifier: string;
    redirectUri: string;
    fetch?: HttpFetch;
    now?: () => number;
  },
): Promise<OAuthTokens> {
  const httpFetch = args.fetch ?? fetch;
  const now = args.now ?? Date.now;

  const body = await postTokenRequest(
    config,
    {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: config.clientId,
      code_verifier: args.verifier,
    },
    httpFetch,
  );

  return toTokens(body, now);
}

/**
 * Refreshes an access token. Per RFC 6749 the server may omit `refresh_token` in
 * the response, meaning the original refresh token is still valid; this function
 * returns `refreshToken: null` in that case, and the caller is expected to keep
 * using its previously stored refresh token rather than overwrite it with null.
 */
export async function refreshTokens(
  config: OAuthProviderConfig,
  args: { refreshToken: string; fetch?: HttpFetch; now?: () => number },
): Promise<OAuthTokens> {
  const httpFetch = args.fetch ?? fetch;
  const now = args.now ?? Date.now;

  const body = await postTokenRequest(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: config.clientId,
    },
    httpFetch,
  );

  return toTokens(body, now);
}
