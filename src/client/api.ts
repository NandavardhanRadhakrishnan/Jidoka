import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";
import type { Pipeline } from "../domain/pipeline";

export interface TypeWithPipelines extends TaskType {
  activePipelineId: string | null;
  pipelines: { id: string; version: number; status: string }[];
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
  types: () => json<{ types: TypeWithPipelines[] }>("/api/types").then((r) => r.types),
  pipeline: (id: string) => json<{ pipeline: Pipeline }>(`/api/pipelines/${id}`).then((r) => r.pipeline),
  confirmType: (taskId: string, typeId: string) =>
    json<{ task: Task }>(`/api/tasks/${taskId}/type`, {
      method: "POST",
      body: JSON.stringify({ typeId }),
    }).then((r) => r.task),
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
    json<{ pipeline: Pipeline }>(`/api/types/${typeId}/onboard`, {
      method: "POST",
      body: JSON.stringify({ description }),
    }).then((r) => r.pipeline),
  activate: (pipelineId: string) =>
    json<{ pipeline: Pipeline }>(`/api/pipelines/${pipelineId}/activate`, { method: "POST" }).then(
      (r) => r.pipeline,
    ),
};
