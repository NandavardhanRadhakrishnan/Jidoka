import type { OAuthProviderConfig } from "./oauth";

export interface OAuthConfigInput {
  /** Raw JSON from JIDOKA_OAUTH_PROVIDERS, if set. */
  providersJson?: string;
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
 * Every provider must supply its own authorize/token URLs — this project never
 * guesses an endpoint, and never ships another product's client id.
 */
export function buildOAuthProviders(input: OAuthConfigInput): Record<string, OAuthProviderConfig> {
  const providers: Record<string, OAuthProviderConfig> = {};

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
