import { buildOAuthProviders } from "./auth/providers";
import type { OAuthProviderConfig } from "./auth/oauth";
import type { ModelProviderId } from "./ai/models";
import type { Settings } from "./domain/settings";

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
    /**
     * "agent-sdk" runs every model call through the Claude Code CLI, so the CLI's
     * own login (a subscription included) covers them and no API key is needed.
     */
    provider: ModelProviderId;
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
  /** Folder scanned for extension manifests. Always on — a missing/empty directory is a no-op. */
  extensionsDir: string;
  /**
   * Launcher for handoff commands, with {{command}} substituted. Unset means
   * commands can only be copied, never launched by the server.
   */
  terminalCommand?: string;
  agent: {
    /**
     * Who runs an `agent` step's tool loop. "in-process" uses the AiProvider and
     * Jidoka's MCP client (API key). "agent-sdk" hands the loop to the Claude Code
     * CLI through the Agent SDK, so the CLI's own login — including a
     * subscription — covers the run and every MCP call in it.
     */
    runner: "in-process" | "agent-sdk";
    model?: string;
    maxBudgetUsd?: number;
    /** Parallel agent runs. Subscription runs share one account's limits. */
    concurrency: number;
  };
  /** Providers the browser sign-in flow can talk to, keyed by id. */
  oauth: Record<string, OAuthProviderConfig>;
  mcpServers: McpServerConfig[];
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const provider =
    env.JIDOKA_AI_PROVIDER === "openai"
      ? "openai"
      : env.JIDOKA_AI_PROVIDER === "agent-sdk"
        ? "agent-sdk"
        : "anthropic";
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
    extensionsDir: env.JIDOKA_EXTENSIONS_DIR ?? "./extensions",
    terminalCommand: env.JIDOKA_TERMINAL,
    agent: {
      // Model calls on the CLI imply agent steps on the CLI too, unless overridden.
      runner:
        (env.JIDOKA_AGENT_RUNNER ?? (provider === "agent-sdk" ? "agent-sdk" : "in-process")) ===
        "agent-sdk"
          ? "agent-sdk"
          : "in-process",
      model: env.JIDOKA_AGENT_MODEL,
      maxBudgetUsd: env.JIDOKA_AGENT_MAX_BUDGET_USD
        ? Number(env.JIDOKA_AGENT_MAX_BUDGET_USD)
        : undefined,
      concurrency: Number(
        env.JIDOKA_AGENT_CONCURRENCY ??
          (env.JIDOKA_AGENT_RUNNER === "agent-sdk" || provider === "agent-sdk" ? 1 : 4),
      ),
    },
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

export function applySettings(base: Config, settings: Settings): Config {
  return {
    ...base,
    ai: { ...base.ai, ...settings.ai },
    agent: { ...base.agent, ...settings.agent },
    mcpServers: settings.mcpServers ?? base.mcpServers,
    sampleDir: settings.sampleDir ?? base.sampleDir,
    extensionsDir: settings.extensionsDir ?? base.extensionsDir,
    pollIntervalMs: settings.pollIntervalMs ?? base.pollIntervalMs,
    terminalCommand: settings.terminalCommand ?? base.terminalCommand,
  };
}
