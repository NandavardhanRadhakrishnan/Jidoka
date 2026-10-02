import { z } from "zod";
import { completeJson, type AiProvider } from "../ai/provider";
import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";
import type { RawItem } from "../sources/types";

const REOPEN_SYSTEM = `A work item that was already handled has changed at its source (a new comment,
reply or edit). Decide whether this specific change needs the connected user's attention again,
which would re-run the item's handling from the top.

It does NOT need attention when the change is only the user's own activity (when their identity
on the source is given, anything authored by that identity — including automated replies sent
on their behalf), a bot or notification echo, or side conversation between other people that
asks nothing of the user. It DOES need attention when someone asks the user something new,
supplies what the user was waiting for, reports the problem is still there, or otherwise moves
the item forward in a way the user must act on.

When unsure, answer relevant: true — a missed follow-up is worse than an extra pass.

Reply with JSON: { "relevant": true | false, "reason": "<one short phrase>" }`;

const responseSchema = z.object({ relevant: z.boolean(), reason: z.string().optional() });

/**
 * The lighter, type-aware check run before a task-threads reopen: the task
 * already has a type, so the only question is whether this delta warrants
 * another pass. Fails open — any unusable reply counts as relevant.
 */
export async function assessReopenRelevance(
  provider: AiProvider,
  task: Task,
  type: TaskType,
  item: RawItem,
  identity: string | null,
): Promise<{ relevant: boolean; reason?: string }> {
  const who = identity ? `The connected user's identity on this source: ${identity}\n\n` : "";
  const content =
    `${who}Task type: ${type.name} — ${type.description}\n\n` +
    `Item as it was when last handled:\ntitle: ${task.title}\nbody:\n${task.body}\n\n` +
    `Item as it is now:\ntitle: ${item.title}\nbody:\n${item.body}`;

  try {
    const response = await completeJson(
      provider,
      { system: REOPEN_SYSTEM, messages: [{ role: "user", content }], maxTokens: 300 },
      responseSchema,
    );
    return response.reason ? { relevant: response.relevant, reason: response.reason } : { relevant: response.relevant };
  } catch (error) {
    console.warn(`[reopen-relevance] task ${task.id}: falling back to relevant:`, error);
    return { relevant: true };
  }
}
