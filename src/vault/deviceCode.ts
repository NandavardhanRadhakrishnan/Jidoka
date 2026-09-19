export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DeviceCodeConfig {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
}

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceCodeTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export class AuthPendingError extends Error {
  constructor() {
    super("device login is still pending");
  }
}

export async function startDeviceLogin(
  config: DeviceCodeConfig,
  deps: { fetch?: HttpFetch } = {},
): Promise<DeviceLogin> {
  const httpFetch = deps.fetch ?? fetch;
  const response = await httpFetch(config.deviceCodeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    }).toString(),
  });
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
  config: DeviceCodeConfig,
  deviceCode: string,
  deps: { fetch?: HttpFetch; now?: () => number } = {},
): Promise<DeviceCodeTokens> {
  const httpFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const response = await httpFetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: config.clientId,
      device_code: deviceCode,
    }).toString(),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    if (body.error === "authorization_pending") throw new AuthPendingError();
    throw new Error(`device login failed: ${String(body.error_description ?? body.error)}`);
  }

  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    expiresAt: now() + Number(body.expires_in) * 1000,
  };
}
