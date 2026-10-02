import type { Priority } from "./priority";

export type TaskState =
  | "ingested"
  | "needs_type_confirmation"
  | "needs_onboarding"
  | "needs_dedup_confirmation"
  | "processing"
  | "assigned_ai"
  | "assigned_human"
  | "done"
  | "failed"
  /** Triage judged the item doesn't need the connected user at all. */
  | "dismissed";

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
  /** Type default raised by triage's urgency signal, or set by hand (see context.priorityOverride). */
  priority: Priority;
  /** Set while state is needs_dedup_confirmation: the task this might duplicate. */
  dedupCandidateId: string | null;
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
  /** Stamped into context.revision at creation, so a later reopen has
   *  something to compare the source's next revision against. */
  revision?: string;
}

export interface TaskPatch {
  state?: TaskState;
  typeId?: string | null;
  typeCandidates?: string[] | null;
  assignee?: Assignee | null;
  deadline?: string | null;
  priority?: Priority;
  dedupCandidateId?: string | null;
  context?: Record<string, unknown>;
  /** A reopened task's source content, refreshed from the latest poll. */
  title?: string;
  body?: string;
  metadata?: Record<string, unknown>;
}
