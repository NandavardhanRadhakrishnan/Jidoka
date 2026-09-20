import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getSettings, saveSettings } from "../repo/settings";
import { SettingsSchema, type Settings } from "../domain/settings";
import { applySettings, type Config } from "../config";

export interface SettingsRoutesDeps {
  db: Database;
  baseConfig: Config;
}

interface MaskedAi {
  provider?: string;
  apiKeyConfigured: boolean;
  model?: string;
  baseUrl?: string;
}

interface EffectiveSettings {
  ai: MaskedAi;
  agent: {
    runner: Config["agent"]["runner"];
    model?: string;
    concurrency: number;
    maxBudgetUsd?: number;
  };
  mcpServers: Config["mcpServers"];
  sampleDir?: string;
  extensionsDir: string;
  pollIntervalMs: number;
  terminalCommand?: string;
}

function maskAi(ai: Settings["ai"]): MaskedAi | undefined {
  if (!ai) return undefined;
  return { provider: ai.provider, apiKeyConfigured: Boolean(ai.apiKey), model: ai.model, baseUrl: ai.baseUrl };
}

function effectiveOf(config: Config): EffectiveSettings {
  return {
    ai: {
      provider: config.ai.provider,
      apiKeyConfigured: Boolean(config.ai.apiKey),
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
    },
    agent: {
      runner: config.agent.runner,
      model: config.agent.model,
      concurrency: config.agent.concurrency,
      maxBudgetUsd: config.agent.maxBudgetUsd,
    },
    mcpServers: config.mcpServers,
    sampleDir: config.sampleDir,
    extensionsDir: config.extensionsDir,
    pollIntervalMs: config.pollIntervalMs,
    terminalCommand: config.terminalCommand,
  };
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
  const app = new Hono();

  app.get("/api/settings", (c) => {
    const settings = getSettings(deps.db);
    const effective = applySettings(deps.baseConfig, settings);
    return c.json({
      settings: { ...settings, ai: maskAi(settings.ai) },
      effective: effectiveOf(effective),
    });
  });

  app.patch("/api/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        400,
      );
    }
    const patch: Settings = parsed.data;

    const settings = saveSettings(deps.db, patch);
    const effective = applySettings(deps.baseConfig, settings);
    return c.json({
      settings: { ...settings, ai: maskAi(settings.ai) },
      effective: effectiveOf(effective),
    });
  });

  return app;
}
