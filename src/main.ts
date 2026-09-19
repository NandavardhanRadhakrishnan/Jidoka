import index from "./client/index.html";
import { loadConfig, type Config } from "./config";
import { openDb, migrate } from "./db";
import { createProvider, describeCredentials } from "./ai";
import { McpManager } from "./mcp/manager";
import { createServer } from "./api/server";
import { createAuthRoutes, getValidAccessToken } from "./api/auth";
import { createHandoffRoutes } from "./api/handoff";
import { createVault, type Vault } from "./vault/vault";
import { createExtensionRoutes } from "./api/extensions";
import { discoverExtensions } from "./extensions/discovery";
import { createInProcessRunner, type AgentRunner } from "./agent/runner";
import { createAgentSdkRunner } from "./agent/claudeAgentSdk";
import { withConcurrencyLimit } from "./agent/limit";
import { onTaskIngested, type AppDeps } from "./orchestrator";
import { startPoller } from "./sources/poller";
import { createOutlookSource } from "./sources/outlook/source";
import { createSampleFolderSource } from "./sources/sample/folder";
import type { TaskSource } from "./sources/types";
import { loadEnabledExtensionSources } from "./extensions/runtime";
import {
  AuthPendingError,
  completeDeviceLogin,
  startDeviceLogin,
} from "./sources/outlook/auth";

export interface App {
  deps: AppDeps;
  mcp: McpManager;
  vault: Vault;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const db = openDb(config.dbPath);
  migrate(db);

  const authDeps = { db, providers: config.oauth };

  const mcp = new McpManager();
  // With no key or token in the environment, fall back to whatever the browser
  // sign-in flow stored for this provider.
  const provider = createProvider(config, {
    getAuthToken: config.oauth[config.ai.provider]
      ? () => getValidAccessToken(authDeps, config.ai.provider)
      : undefined,
  });

  const runAgent: AgentRunner = withConcurrencyLimit(
    config.agent.runner === "agent-sdk"
      ? createAgentSdkRunner({
          mcpServers: Object.fromEntries(
            config.mcpServers.map((s) => [s.name, { command: s.command, args: s.args }]),
          ),
          ...(config.agent.model ? { model: config.agent.model } : {}),
          ...(config.agent.maxBudgetUsd ? { maxBudgetUsd: config.agent.maxBudgetUsd } : {}),
        })
      : createInProcessRunner({
          provider,
          listTools: () => mcp.listTools(),
          callTool: (server, tool, input) => mcp.callTool(server, tool, input),
        }),
    config.agent.concurrency,
  );

  const deps: AppDeps = {
    db,
    runAgent,
    provider,
    mcp: {
      listTools: () => mcp.listTools(),
      callTool: (server, tool, input) => mcp.callTool(server, tool, input),
    },
  };

  const vault = createVault({ db });

  const extraRoutes = createAuthRoutes(authDeps);
  extraRoutes.route(
    "/",
    createHandoffRoutes({
      db,
      ...(config.terminalCommand ? { terminalCommand: config.terminalCommand } : {}),
    }),
  );
  extraRoutes.route(
    "/",
    createExtensionRoutes({ db, vault, extensionsDir: config.extensionsDir }),
  );

  const api = createServer(deps, extraRoutes);

  return {
    deps,
    mcp,
    vault,
    fetch: async (request) => api.fetch(request),
    async close() {
      await mcp.close();
      db.close();
    },
  };
}

/**
 * Route map for Bun.serve. "/api/*" must stay more specific than "/*", or the
 * HTML page swallows every API call.
 */
export function createRoutes(app: App) {
  return {
    "/api/*": (request: Request) => app.fetch(request),
    "/*": index,
  };
}

async function loginOutlook(config: Config): Promise<void> {
  const db = openDb(config.dbPath);
  migrate(db);
  if (!config.outlook.clientId) throw new Error("JIDOKA_OUTLOOK_CLIENT_ID is not set");

  const deps = { db, clientId: config.outlook.clientId, tenant: config.outlook.tenant };
  const login = await startDeviceLogin(deps);
  console.log(`\nOpen ${login.verificationUri} and enter code: ${login.userCode}\n`);

  const deadline = Date.now() + login.expiresIn * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(login.interval * 1000);
    try {
      await completeDeviceLogin(deps, login.deviceCode);
      console.log("Outlook connected.");
      db.close();
      return;
    } catch (error) {
      if (!(error instanceof AuthPendingError)) throw error;
    }
  }
  throw new Error("device login timed out");
}

if (import.meta.main) {
  const config = loadConfig();

  if (Bun.argv[2] === "login-outlook") {
    await loginOutlook(config);
  } else {
    const app = createApp(config);
    console.log(
      `AI provider: ${config.ai.provider} (${config.ai.model ?? "default model"}), ` +
        `credentials: ${describeCredentials(config)}`,
    );
    console.log(
      `Agent steps: ${config.agent.runner}` +
        (config.agent.runner === "agent-sdk" ? " (Claude Code CLI login)" : " (AiProvider)") +
        `, max ${config.agent.concurrency} at a time`,
    );
    await app.mcp.connectAll(config.mcpServers);

    try {
      const discovered = await discoverExtensions(app.deps.db, config.extensionsDir);
      console.log(
        `${discovered.valid.length} extension(s) discovered` +
          (discovered.invalid.length ? ` (${discovered.invalid.length} invalid)` : ""),
      );
    } catch (error) {
      console.warn(
        `Extension discovery failed for "${config.extensionsDir}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const sources: TaskSource[] = [];
    if (config.outlook.clientId) {
      sources.push(
        createOutlookSource({
          db: app.deps.db,
          clientId: config.outlook.clientId,
          tenant: config.outlook.tenant,
        }),
      );
    }
    if (config.sampleDir) {
      sources.push(createSampleFolderSource({ dir: config.sampleDir }));
      console.log(`Sample source watching ${config.sampleDir}`);
    }

    startPoller(
      app.deps.db,
      sources,
      async (task) => {
        try {
          await onTaskIngested(app.deps, task);
        } catch (error) {
          console.error(`[orchestrator] task ${task.id} failed:`, error);
        }
      },
      config.pollIntervalMs,
      () => loadEnabledExtensionSources(app.deps.db, config.extensionsDir, app.vault),
    );
    if (!sources.length) {
      console.warn(
        "No static sources configured — set JIDOKA_OUTLOOK_CLIENT_ID or JIDOKA_SAMPLE_DIR, " +
          "install an extension, or add tasks from the board",
      );
    }

    Bun.serve({
      port: config.port,
      // Model calls keep a request open for a long time with no bytes flowing;
      // the default idle timeout closes such a connection mid-call.
      idleTimeout: 255,
      routes: createRoutes(app),
    });
    console.log(`Jidoka on http://localhost:${config.port}`);
  }
}
