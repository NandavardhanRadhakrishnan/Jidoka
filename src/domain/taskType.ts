import type { Priority } from "./priority";

export type TaskTypeStatus = "proposed" | "active";

export interface TaskType {
  id: string;
  name: string;
  description: string;
  examples: string[];
  status: TaskTypeStatus;
  /** Floor for every task of this type; triage may raise a task above it, never below. */
  defaultPriority: Priority;
  createdAt: string;
  updatedAt: string;
}

export interface NewTaskType {
  name: string;
  description: string;
  examples?: string[];
}

export interface TaskTypePatch {
  name?: string;
  description?: string;
  examples?: string[];
  status?: TaskTypeStatus;
  defaultPriority?: Priority;
}
