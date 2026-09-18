import { buildOAuthProviders } from "./auth/providers";
import type { OAuthProviderConfig } from "./auth/oauth";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
}

export interface Config {
  dbPath: string;
  port: number;
  pollIntervalMs: number;
  ai: {
    provider: "anthropic" | "openai";
    apiKey?: string;
    /** OAuth bearer token, used when no API key is set. */
    authToken?: string;
    /** Gateway or proxy base URL. */
    baseUrl?: string;
    model?: string;
  };
  outlook: {
    clientId?: string;
    tenant: string;
  };
  /** Folder polled by the sample source; unset disables it. */
  sampleDir?: string;
  /** Providers the browser sign-in flow can talk to, keyed by id. */
  oauth: Record<string, OAuthProviderConfig>;
  mcpServers: McpServerConfig[];
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const provider = env.JIDOKA_AI_PROVIDER === "openai" ? "openai" : "anthropic";
  return {
    dbPath: env.JIDOKA_DB ?? "./jidoka.db",
    port: Number(env.JIDOKA_PORT ?? 3000),
    pollIntervalMs: Number(env.JIDOKA_POLL_INTERVAL_MS ?? 60_000),
    ai: {
      provider,
      apiKey: provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY,
      authToken: provider === "openai" ? undefined : env.ANTHROPIC_AUTH_TOKEN,
      baseUrl: env.JIDOKA_AI_BASE_URL ?? (provider === "openai" ? undefined : env.ANTHROPIC_BASE_URL),
      model: env.JIDOKA_AI_MODEL,
    },
    outlook: {
      clientId: env.JIDOKA_OUTLOOK_CLIENT_ID,
      tenant: env.JIDOKA_OUTLOOK_TENANT ?? "common",
    },
    sampleDir: env.JIDOKA_SAMPLE_DIR,
    oauth: buildOAuthProviders({
      providersJson: env.JIDOKA_OAUTH_PROVIDERS,
      outlook: {
        clientId: env.JIDOKA_OUTLOOK_CLIENT_ID,
        tenant: env.JIDOKA_OUTLOOK_TENANT ?? "common",
      },
      anthropic: {
        clientId: env.JIDOKA_ANTHROPIC_OAUTH_CLIENT_ID,
        authorizeUrl: env.JIDOKA_ANTHROPIC_OAUTH_AUTHORIZE_URL,
        tokenUrl: env.JIDOKA_ANTHROPIC_OAUTH_TOKEN_URL,
        scopes: env.JIDOKA_ANTHROPIC_OAUTH_SCOPES,
      },
    }),
    mcpServers: env.JIDOKA_MCP_SERVERS
      ? (JSON.parse(env.JIDOKA_MCP_SERVERS) as McpServerConfig[])
      : [],
  };
}
