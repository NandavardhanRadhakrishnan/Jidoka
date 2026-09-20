import { z } from "zod";
import type { ModelProviderId } from "../ai/models";
import type { McpServerConfig } from "../config";

/**
 * A partial overlay onto Config: presence of a field means "override the env
 * var/default for this", absence means "fall through". Persisted as one JSON
 * blob (see src/repo/settings.ts) — never partially-typed at the DB layer,
 * only here.
 */
export interface Settings {
  ai?: {
    provider?: ModelProviderId;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  agent?: {
    runner?: "in-process" | "agent-sdk";
    model?: string;
    concurrency?: number;
    maxBudgetUsd?: number;
  };
  mcpServers?: McpServerConfig[];
  sampleDir?: string;
  extensionsDir?: string;
  pollIntervalMs?: number;
  terminalCommand?: string;
}

export const SettingsSchema = z.object({
  ai: z
    .object({
      provider: z.enum(["anthropic", "openai", "agent-sdk"]).optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
  agent: z
    .object({
      runner: z.enum(["in-process", "agent-sdk"]).optional(),
      model: z.string().optional(),
      concurrency: z.number().int().positive().optional(),
      maxBudgetUsd: z.number().positive().optional(),
    })
    .optional(),
  mcpServers: z
    .array(z.object({ name: z.string(), command: z.string(), args: z.array(z.string()) }))
    .optional(),
  sampleDir: z.string().optional(),
  extensionsDir: z.string().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  terminalCommand: z.string().optional(),
});
