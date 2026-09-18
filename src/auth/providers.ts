import type { OAuthProviderConfig } from "./oauth";

export interface OAuthConfigInput {
  /** Raw JSON from JIDOKA_OAUTH_PROVIDERS, if set. */
  providersJson?: string;
  outlook?: { clientId?: string; tenant: string };
  anthropic?: {
    clientId?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    scopes?: string;
  };
}

/**
 * Providers the browser sign-in flow can talk to.
 *
 * Microsoft's endpoints are well-known, so an Outlook client id is enough. Every
 * other provider must supply its own authorize/token URLs — this project never
 * guesses an endpoint, and never ships another product's client id.
 */
export function buildOAuthProviders(input: OAuthConfigInput): Record<string, OAuthProviderConfig> {
  const providers: Record<string, OAuthProviderConfig> = {};

  if (input.outlook?.clientId) {
    const tenant = input.outlook.tenant;
    providers.outlook = {
      id: "outlook",
      clientId: input.outlook.clientId,
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scopes: ["offline_access", "Mail.Read"],
    };
  }

  const anthropic = input.anthropic;
  if (anthropic?.clientId && anthropic.authorizeUrl && anthropic.tokenUrl) {
    providers.anthropic = {
      id: "anthropic",
      clientId: anthropic.clientId,
      authorizeUrl: anthropic.authorizeUrl,
      tokenUrl: anthropic.tokenUrl,
      scopes: anthropic.scopes ? anthropic.scopes.split(/[\s,]+/).filter(Boolean) : [],
    };
  }

  if (input.providersJson) {
    for (const entry of JSON.parse(input.providersJson) as OAuthProviderConfig[]) {
      providers[entry.id] = entry;
    }
  }

  return providers;
}
