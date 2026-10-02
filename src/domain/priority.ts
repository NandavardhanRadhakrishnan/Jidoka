/** Lowest to highest — index order is the ranking. */
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type Priority = (typeof PRIORITIES)[number];

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

/**
 * A task's automatic priority: its type's default, raised (never lowered) by
 * an urgency signal triage read from the content. The type default is the
 * deterministic floor so free AI judgment can't quietly demote work, and a
 * signal only ever escalates — the usual failure mode is everything being P1.
 */
export function resolvePriority(typeDefault: Priority, signal: Priority | null): Priority {
  if (!signal) return typeDefault;
  return PRIORITIES.indexOf(signal) > PRIORITIES.indexOf(typeDefault) ? signal : typeDefault;
}
