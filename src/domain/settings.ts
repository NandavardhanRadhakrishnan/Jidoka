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
