import type { Database } from "bun:sqlite";

/**
 * The slice of `fetch` this source needs. Narrower than `typeof fetch` so tests
 * can pass a plain async function without implementing runtime-specific extras.
 */
export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const OUTLOOK_SCOPES = ["offline_access", "Mail.Read"];
const PROVIDER = "outlook";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface OutlookDeps {
  db: Database;
  clientId: string;
  tenant: string;
  fetch?: HttpFetch;
  now?: () => number;
}

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

export class AuthPendingError extends Error {
  constructor() {
    super("device login is still pending");
  }
}

function http(deps: OutlookDeps): HttpFetch {
  return deps.fetch ?? fetch;
}

function clock(deps: OutlookDeps): () => number {
  return deps.now ?? Date.now;
}

function tokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function saveTokens(db: Database, tokens: TokenSet): void {
  db.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at`,
  ).run(PROVIDER, tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
}

export function loadTokens(db: Database): TokenSet | null {
  const row = db
    .query("SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?")
    .get(PROVIDER) as
    | { access_token: string; refresh_token: string; expires_at: number }
    | null;
  return row
    ? {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function startDeviceLogin(deps: OutlookDeps): Promise<DeviceLogin> {
  const response = await http(deps)(
    `https://login.microsoftonline.com/${deps.tenant}/oauth2/v2.0/devicecode`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: deps.clientId,
        scope: OUTLOOK_SCOPES.join(" "),
      }).toString(),
    },
  );
  if (!response.ok) throw new Error(`device code request failed: ${response.status}`);
  const body = (await response.json()) as {
    user_code: string;
    device_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  return {
    userCode: body.user_code,
    deviceCode: body.device_code,
    verificationUri: body.verification_uri,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

export async function completeDeviceLogin(
  deps: OutlookDeps,
  deviceCode: string,
): Promise<TokenSet> {
  const response = await http(deps)(tokenUrl(deps.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: deps.clientId,
      device_code: deviceCode,
    }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    if (body.error === "authorization_pending") throw new AuthPendingError();
    throw new Error(`device login failed: ${String(body.error_description ?? body.error)}`);
  }
  const tokens: TokenSet = {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token),
    expiresAt: clock(deps)() + Number(body.expires_in) * 1000,
  };
  saveTokens(deps.db, tokens);
  return tokens;
}

export async function getAccessToken(deps: OutlookDeps): Promise<string> {
  const tokens = loadTokens(deps.db);
  if (!tokens) throw new Error("Outlook is not connected — run the device login first");

  const now = clock(deps)();
  if (tokens.expiresAt - 60_000 > now) return tokens.accessToken;

  const response = await http(deps)(tokenUrl(deps.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: deps.clientId,
      refresh_token: tokens.refreshToken,
      scope: OUTLOOK_SCOPES.join(" "),
    }).toString(),
  });
  if (!response.ok) throw new Error(`token refresh failed: ${response.status}`);
  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const refreshed: TokenSet = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? tokens.refreshToken,
    expiresAt: now + body.expires_in * 1000,
  };
  saveTokens(deps.db, refreshed);
  return refreshed.accessToken;
}
