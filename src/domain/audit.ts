/**
 * What happened. Mechanical entries (`ingested`, `state_changed`) are written
 * by the tasks repo itself so no state change can bypass the trail; the rest
 * are written by the orchestrator where the intent is known.
 */
export type AuditKind =
  | "ingested"
  | "state_changed"
  | "triaged"
  | "rule_ran"
  | "rule_activated"
  | "type_confirmed"
  | "onboarding_skipped"
  | "priority_set"
  | "completed"
  | "reopened"
  | "merged"
  | "duplicate_dismissed"
  | "step_rerun"
  | "reopen_skipped"
  | "type_updated";

/** Who acted: automatic pipeline work, an AI worker finishing a task, or a person. */
export type AuditActor = "system" | "ai" | "human";

export interface AuditEntry {
  id: string;
  at: string;
  kind: AuditKind;
  actor: AuditActor;
  taskId: string | null;
  typeId: string | null;
  ruleId: string | null;
  data: Record<string, unknown>;
}

export interface NewAuditEntry {
  kind: AuditKind;
  actor: AuditActor;
  taskId?: string | null;
  typeId?: string | null;
  ruleId?: string | null;
  data: Record<string, unknown>;
  /** Defaults to now; settable so retention can be tested. */
  at?: string;
}
