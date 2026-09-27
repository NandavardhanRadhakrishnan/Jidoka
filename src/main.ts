import { resolve } from "node:path";
import index from "./client/index.html";
import { loadConfig, applySettings, type Config } from "./config";
import { openDb, migrate } from "./db";
import { createProvider, describeCredentials } from "./ai";
import { McpManager } from "./mcp/manager";
import { createServer } from "./api/server";
import { createAuthRoutes, getValidAccessToken } from "./api/auth";
import { createHandoffRoutes } from "./api/handoff";
import { createSettingsRoutes } from "./api/settings";
import { createVault, type Vault } from "./vault/vault";
import { createExtensionRoutes } from "./api/extensions";
import { discoverExtensions } from "./extensions/discovery";
import { createInProcessRunner, type AgentRunner } from "./agent/runner";
import { createAgentSdkRunner } from "./agent/claudeAgentSdk";
import { withConcurrencyLimit } from "./agent/limit";
import { onTaskIngested, onTaskChanged, type AppDeps } from "./orchestrator";
import { startPoller } from "./sources/poller";
import { createSampleFolderSource } from "./sources/sample/folder";
import type { TaskSource } from "./sources/types";
import { loadEnabledExtensionSources } from "./extensions/runtime";
import { getSettings } from "./repo/settings";

export interface App {
  deps: AppDeps;
  mcp: McpManager;
  vault: Vault;
  config: Config;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createApp(baseConfig: Config): App {
  const db = openDb(baseConfig.dbPath);
  migrate(db);
  const config = applySettings(baseConfig, getSettings(db));

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
    modelProvider: config.ai.provider,
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
    createExtensionRoutes({
      db,
      vault,
      extensionsDir: config.extensionsDir,
      runAgent,
      listTools: () => mcp.listTools(),
    }),
  );
  extraRoutes.route("/", createSettingsRoutes({ db, baseConfig }));

  const api = createServer(deps, extraRoutes);

  return {
    deps,
    mcp,
    vault,
    config,
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

if (import.meta.main) {
  const config = loadConfig();
  const app = createApp(config);
  console.log(
    `AI provider: ${app.config.ai.provider} (${app.config.ai.model ?? "default model"}), ` +
      `credentials: ${describeCredentials(app.config)}`,
  );
  console.log(
    `Agent steps: ${app.config.agent.runner}` +
      (app.config.agent.runner === "agent-sdk" ? " (Claude Code CLI login)" : " (AiProvider)") +
      `, max ${app.config.agent.concurrency} at a time`,
  );
  // dbPath/extensionsDir resolve relative to the process's cwd at launch, not to
  // where the executable lives — log the resolved path so a wrong-cwd launch of
  // the built binary is loud instead of silently creating an empty DB.
  console.log(`Database: ${resolve(app.config.dbPath)}`);
  console.log(`Extensions: ${resolve(app.config.extensionsDir)}`);
  await app.mcp.connectAll(app.config.mcpServers);

  try {
    const discovered = await discoverExtensions(app.deps.db, app.config.extensionsDir);
    console.log(
      `${discovered.valid.length} extension(s) discovered` +
        (discovered.invalid.length ? ` (${discovered.invalid.length} invalid)` : ""),
    );
  } catch (error) {
    console.warn(
      `Extension discovery failed for "${app.config.extensionsDir}": ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const sources: TaskSource[] = [];
  if (app.config.sampleDir) {
    sources.push(createSampleFolderSource({ dir: app.config.sampleDir }));
    console.log(`Sample source watching ${app.config.sampleDir}`);
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
    app.config.pollIntervalMs,
    () => loadEnabledExtensionSources(app.deps.db, app.config.extensionsDir, app.vault),
    async (task, item) => {
      try {
        await onTaskChanged(app.deps, task, item);
      } catch (error) {
        console.error(`[orchestrator] reopen for task ${task.id} failed:`, error);
      }
    },
  );
  if (!sources.length) {
    console.warn(
      "No static sources configured — set JIDOKA_SAMPLE_DIR, install an extension, " +
        "or add tasks from the board",
    );
  }

  Bun.serve({
    port: app.config.port,
    // Model calls keep a request open for a long time with no bytes flowing;
    // the default idle timeout closes such a connection mid-call.
    idleTimeout: 255,
    routes: createRoutes(app),
  });
  console.log(`Jidoka on http://localhost:${app.config.port}`);
}
