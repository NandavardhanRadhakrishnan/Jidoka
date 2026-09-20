import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";
import type { Rule, RuleDefinition } from "../domain/rule";
import type { ExtensionAuth } from "../domain/extension";
import type { ToolSpec } from "../ai/provider";

export type { Rule };

export interface ModelOption {
  id: string;
  label: string;
  blurb: string;
}

export type HandoffTarget =
  | { kind: "url"; label: string; url: string }
  | { kind: "draft"; label: string; content: string }
  | { kind: "command"; label: string; command: string };

export interface AuthProviderStatus {
  id: string;
  connected: boolean;
  expiresAt: string | null;
  expired: boolean;
  canRefresh: boolean;
}

export interface TypeWithRules extends TaskType {
  activeRuleId: string | null;
  rules: { id: string; version: number; status: string }[];
}

export interface ExtensionListItem {
  id: string;
  name: string;
  summary: string;
  readOnly: boolean;
  auth: ExtensionAuth | null;
  enabled: boolean;
  valid: boolean;
  error: string | null;
  status: "connected" | "not_connected" | "needs_reauth" | "unknown" | "invalid";
}

export interface GeneratedManifest {
  id: string;
  name: string;
  summary: string;
  readOnly: boolean;
  auth: ExtensionAuth;
}

export interface GenerationDraft {
  generationId: string;
  manifest: GeneratedManifest;
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request failed: ${response.status}`);
  return body;
}

export const api = {
  tasks: () => json<{ tasks: Task[] }>("/api/tasks").then((r) => r.tasks),
  types: () => json<{ types: TypeWithRules[] }>("/api/types").then((r) => r.types),
  rule: (id: string) => json<{ rule: Rule }>(`/api/rules/${id}`).then((r) => r.rule),
  auth: () =>
    json<{ providers: AuthProviderStatus[] }>("/api/auth").then((r) => r.providers),
  signOut: (providerId: string) =>
    json<{ signedOut: boolean }>(`/api/auth/${providerId}/signout`, { method: "POST" }),
  createTask: (input: { title: string; body: string }) =>
    json<{ task: Task }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.task),
  confirmType: (taskId: string, typeId: string) =>
    json<{ task: Task }>(`/api/tasks/${taskId}/type`, {
      method: "POST",
      body: JSON.stringify({ typeId }),
    }).then((r) => r.task),
  pickUp: (taskId: string) =>
    json<{ task: Task; handoff: HandoffTarget[]; canLaunchTerminal: boolean }>(
      `/api/tasks/${taskId}/pick-up`,
      { method: "POST" },
    ),
  runCommand: (taskId: string, label: string) =>
    json<{ launched: string }>(`/api/tasks/${taskId}/run-command`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  completeTask: (taskId: string, note?: string) =>
    json<{ task: Task }>(`/api/tasks/${taskId}/complete`, {
      method: "POST",
      body: JSON.stringify({ note: note ?? "" }),
    }).then((r) => r.task),
  reopenTask: (taskId: string) =>
    json<{ task: Task }>(`/api/tasks/${taskId}/reopen`, { method: "POST" }).then((r) => r.task),
  skipOnboarding: (taskId: string) =>
    json<{ task: Task }>(`/api/tasks/${taskId}/skip-onboarding`, { method: "POST" }).then(
      (r) => r.task,
    ),
  patchType: (typeId: string, patch: { name?: string; description?: string; mergeInto?: string }) =>
    json<{ type?: TaskType; merged?: boolean }>(`/api/types/${typeId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  onboard: (typeId: string, description: string) =>
    json<{ rule: Rule }>(`/api/types/${typeId}/onboard`, {
      method: "POST",
      body: JSON.stringify({ description }),
    }).then((r) => r.rule),
  activate: (ruleId: string) =>
    json<{ rule: Rule }>(`/api/rules/${ruleId}/activate`, { method: "POST" }).then(
      (r) => r.rule,
    ),
  extensions: () => json<{ extensions: ExtensionListItem[] }>("/api/extensions").then((r) => r.extensions),
  rescanExtensions: () =>
    json<{ discovered: { valid: string[]; invalid: { id: string; error: string }[] } }>(
      "/api/extensions/rescan",
      { method: "POST" },
    ),
  connectApiKey: (id: string, apiKey: string) =>
    json<{ connected: true }>(`/api/extensions/${id}/connect/api-key`, {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    }),
  startDeviceConnect: (id: string) =>
    json<{
      userCode: string;
      verificationUri: string;
      deviceCode: string;
      expiresIn: number;
      interval: number;
    }>(`/api/extensions/${id}/connect/device/start`, { method: "POST" }),
  completeDeviceConnect: (id: string, deviceCode: string) =>
    json<{ connected?: true; pending?: true }>(`/api/extensions/${id}/connect/device/complete`, {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    }),
  disconnectExtension: (id: string) =>
    json<{ disconnected: true }>(`/api/extensions/${id}/disconnect`, { method: "POST" }),
  enableExtension: (id: string) =>
    json<{ enabled: true }>(`/api/extensions/${id}/enable`, { method: "POST" }),
  disableExtension: (id: string) =>
    json<{ enabled: false }>(`/api/extensions/${id}/disable`, { method: "POST" }),
  generateExtension: (description: string) =>
    json<GenerationDraft>("/api/extensions/generate", {
      method: "POST",
      body: JSON.stringify({ description }),
    }),
  approveGeneration: (generationId: string) =>
    json<{ extensionId: string }>(`/api/extensions/generate/${generationId}/approve`, {
      method: "POST",
    }),
  discardGeneration: (generationId: string) =>
    json<{ discarded: true }>(`/api/extensions/generate/${generationId}/discard`, { method: "POST" }),
  testPoll: (id: string) =>
    json<{ itemCount: number; sample: { externalId: string; title: string; body: string }[] }>(
      `/api/extensions/${id}/test-poll`,
      { method: "POST" },
    ),
  deleteExtension: (id: string) =>
    json<{ deleted: true }>(`/api/extensions/${id}/delete`, { method: "POST" }),
  fixExtension: (id: string, error: string) =>
    json<GenerationDraft>(`/api/extensions/${id}/fix`, {
      method: "POST",
      body: JSON.stringify({ error }),
    }),
  models: () => json<{ provider: string; models: ModelOption[] }>("/api/models"),
  mcpTools: () => json<{ tools: ToolSpec[] }>("/api/mcp/tools").then((r) => r.tools),
  saveRule: (typeId: string, definition: RuleDefinition) =>
    json<{ rule: Rule }>(`/api/types/${typeId}/rules`, {
      method: "POST",
      body: JSON.stringify({ definition }),
    }).then((r) => r.rule),
};
