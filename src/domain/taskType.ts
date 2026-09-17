export type TaskTypeStatus = "proposed" | "active";

export interface TaskType {
  id: string;
  name: string;
  description: string;
  examples: string[];
  status: TaskTypeStatus;
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
}
