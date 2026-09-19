// src/vault/vault.ts
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import * as credentialsRepo from "../repo/extensionCredentials";
import type { CredentialStatus } from "../repo/extensionCredentials";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  refreshTokens,
  type HttpFetch,
  type OAuthProviderConfig,
} from "../auth/oauth";
import {
  startDeviceLogin,
  completeDeviceLogin,
  AuthPendingError,
  type DeviceLogin,
} from "./deviceCode";

export { AuthPendingError };

export interface VaultDeps {
  db: Database;
  fetch?: HttpFetch;
  now?: () => number;
}

interface OAuthPayload {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

interface PendingAuthCode {
  verifier: string;
  state: string;
  redirectUri: string;
}

function toOAuthProviderConfig(
  id: string,
  auth: { tokenUrl: string; clientId: string; scopes: string[]; authorizeUrl?: string },
): OAuthProviderConfig {
  return {
    id,
    authorizeUrl: auth.authorizeUrl ?? "",
    tokenUrl: auth.tokenUrl,
    clientId: auth.clientId,
    scopes: auth.scopes,
  };
}

export class Vault {
  private pending = new Map<string, PendingAuthCode>();

  constructor(private deps: VaultDeps) {}

  private clock(): () => number {
    return this.deps.now ?? Date.now;
  }

  private http(): HttpFetch {
    return this.deps.fetch ?? fetch;
  }

  private requireExtension(extensionId: string): extensionsRepo.ExtensionRecord & {
    auth: NonNullable<extensionsRepo.ExtensionRecord["auth"]>;
  } {
    const record = extensionsRepo.get(this.deps.db, extensionId);
    if (!record) throw new Error(`unknown extension: ${extensionId}`);
    if (!record.valid || !record.auth) {
      throw new Error(`extension "${extensionId}" has an invalid manifest`);
    }
    return record as extensionsRepo.ExtensionRecord & {
      auth: NonNullable<extensionsRepo.ExtensionRecord["auth"]>;
    };
  }

  status(extensionId: string): CredentialStatus {
    return credentialsRepo.load(this.deps.db, extensionId)?.status ?? "not_connected";
  }

  async startDeviceConnect(extensionId: string): Promise<DeviceLogin> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-device-code") {
      throw new Error(`extension "${extensionId}" does not use device-code auth`);
    }
    return startDeviceLogin(auth, { fetch: this.http() });
  }

  async completeDeviceConnect(extensionId: string, deviceCode: string): Promise<void> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-device-code") {
      throw new Error(`extension "${extensionId}" does not use device-code auth`);
    }
    const tokens = await completeDeviceLogin(auth, deviceCode, {
      fetch: this.http(),
      now: this.clock(),
    });
    // Spread into a fresh literal: a variable typed as a plain interface fails
    // tsc's index-signature check against the Record<string, unknown> param,
    // but an inline object literal is checked structurally and passes.
    credentialsRepo.save(
      this.deps.db,
      extensionId,
      auth.mode,
      { ...tokens },
      "connected",
      this.clock()(),
    );
  }

  async startAuthCodeConnect(
    extensionId: string,
    redirectUri: string,
  ): Promise<{ url: string }> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-auth-code-pkce") {
      throw new Error(`extension "${extensionId}" does not use auth-code+PKCE`);
    }
    const pair = await createPkcePair();
    const state = crypto.randomUUID();
    this.pending.set(extensionId, { verifier: pair.verifier, state, redirectUri });

    const config = toOAuthProviderConfig(extensionId, auth);
    const url = buildAuthorizeUrl(config, { redirectUri, state, challenge: pair.challenge });
    return { url };
  }

  async completeAuthCodeConnect(extensionId: string, code: string, state: string): Promise<void> {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "oauth2-auth-code-pkce") {
      throw new Error(`extension "${extensionId}" does not use auth-code+PKCE`);
    }
    const pending = this.pending.get(extensionId);
    if (!pending) throw new Error(`no pending auth-code connect for extension "${extensionId}"`);
    if (pending.state !== state) throw new Error("state mismatch");

    const config = toOAuthProviderConfig(extensionId, auth);
    const tokens = await exchangeCode(config, {
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      fetch: this.http(),
      now: this.clock(),
    });
    this.pending.delete(extensionId);

    credentialsRepo.save(
      this.deps.db,
      extensionId,
      auth.mode,
      { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt },
      "connected",
      this.clock()(),
    );
  }

  saveApiKey(extensionId: string, apiKey: string): void {
    const { auth } = this.requireExtension(extensionId);
    if (auth.mode !== "api-key") {
      throw new Error(`extension "${extensionId}" does not use api-key auth`);
    }
    credentialsRepo.save(this.deps.db, extensionId, auth.mode, { apiKey }, "connected", this.clock()());
  }

  async getToken(extensionId: string): Promise<string> {
    const { auth } = this.requireExtension(extensionId);
    const stored = credentialsRepo.load(this.deps.db, extensionId);
    if (!stored) throw new Error(`extension "${extensionId}" is not connected`);

    if (auth.mode === "api-key") {
      return String(stored.payload.apiKey);
    }

    const payload = stored.payload as unknown as OAuthPayload;
    const now = this.clock()();
    if (payload.expiresAt - 60_000 > now) return payload.accessToken;

    if (!payload.refreshToken) {
      credentialsRepo.setStatus(this.deps.db, extensionId, "needs_reauth");
      throw new Error(`extension "${extensionId}" needs reauthorization`);
    }

    const config = toOAuthProviderConfig(extensionId, auth);
    try {
      const refreshed = await refreshTokens(config, {
        refreshToken: payload.refreshToken,
        fetch: this.http(),
        now: this.clock(),
      });
      const nextRefreshToken = refreshed.refreshToken ?? payload.refreshToken;
      credentialsRepo.save(
        this.deps.db,
        extensionId,
        auth.mode,
        { accessToken: refreshed.accessToken, refreshToken: nextRefreshToken, expiresAt: refreshed.expiresAt },
        "connected",
        now,
      );
      return refreshed.accessToken;
    } catch (error) {
      credentialsRepo.setStatus(this.deps.db, extensionId, "needs_reauth");
      throw error;
    }
  }

  disconnect(extensionId: string): void {
    credentialsRepo.remove(this.deps.db, extensionId);
    this.pending.delete(extensionId);
  }
}

export function createVault(deps: VaultDeps): Vault {
  return new Vault(deps);
}
