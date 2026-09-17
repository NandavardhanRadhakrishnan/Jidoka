import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";

export const TRIAGE_SYSTEM = `You triage incoming work items for a task management system.

You are given a task and the list of known task types. Score how well each existing
type fits the task, from 0 to 1. Prefer an existing type: only propose a new type when
no existing type plausibly fits, and never propose a type that restates an existing one
in different words.

Reply with JSON of this shape:
{
  "scores": [{ "typeId": "<id>", "confidence": <0..1> }],
  "proposal": { "name": "<short name>", "description": "<one sentence>", "rationale": "<why no existing type fits>" } | null
}`;

export function triageUserMessage(task: Task, types: TaskType[]): string {
  const known = types.length
    ? types
        .map(
          (t) =>
            `- id: ${t.id}\n  name: ${t.name}\n  description: ${t.description}` +
            (t.examples.length ? `\n  examples: ${t.examples.join(" | ")}` : ""),
        )
        .join("\n")
    : "(none yet)";

  return `Known task types:\n${known}\n\nTask:\nsource: ${task.sourceId}\ntitle: ${task.title}\nbody:\n${task.body}`;
}
