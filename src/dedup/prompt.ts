import type { Task } from "../domain/task";

export const DEDUP_SYSTEM = `You check whether a newly submitted task describes the same underlying
work as one already tracked, so the system can avoid tracking the same work twice.

You are given the new task and a list of candidate tasks already on the board. Decide
whether the new task is clearly about the same underlying work as exactly one candidate.
Only match when you are confident — near-identical requests, the same issue reported
through a different channel, or explicit cross-references (the same ticket number, the
same order, the same person's same problem). Do not match tasks that are merely similar
in topic or type.

Reply with JSON of this shape:
{
  "duplicateOfTaskId": "<id>" | null,
  "confidence": <0..1>,
  "rationale": "<one sentence>"
}`;

export function dedupUserMessage(task: Task, candidates: Task[]): string {
  const list = candidates
    .map(
      (c) =>
        `- id: ${c.id}\n  source: ${c.sourceId}\n  title: ${c.title}\n  excerpt: ${c.body.slice(0, 300)}`,
    )
    .join("\n");

  return `Candidate tasks already tracked:\n${list}\n\nNew task:\nsource: ${task.sourceId}\ntitle: ${task.title}\nbody:\n${task.body}`;
}
