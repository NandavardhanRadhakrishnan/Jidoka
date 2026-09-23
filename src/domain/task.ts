export type TaskState =
  | "ingested"
  | "needs_type_confirmation"
  | "needs_onboarding"
  | "processing"
  | "assigned_ai"
  | "assigned_human"
  | "done"
  | "failed";

export type Assignee = "ai" | "human";

export interface Task {
  id: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  typeId: string | null;
  typeCandidates: string[] | null;
  state: TaskState;
  assignee: Assignee | null;
  /** yyyy-mm-dd, extracted from the source content by triage; null when none was mentioned. */
  deadline: string | null;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  sourceId: string;
  externalId: string;
  url?: string | null;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface TaskPatch {
  state?: TaskState;
  typeId?: string | null;
  typeCandidates?: string[] | null;
  assignee?: Assignee | null;
  deadline?: string | null;
  context?: Record<string, unknown>;
}
