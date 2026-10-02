import { z } from "zod";
import { completeJson, type AiProvider } from "../ai/provider";
import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";
import { isPriority, type Priority } from "../domain/priority";
import { TRIAGE_SYSTEM, triageUserMessage } from "./prompt";

export const MIN_CONFIDENCE = 0.6;
export const AMBIGUITY_MARGIN = 0.15;

export interface TypeProposal {
  name: string;
  description: string;
  rationale: string;
}

export type TriageOutcome =
  | { kind: "matched"; typeId: string }
  | { kind: "ambiguous"; candidateTypeIds: string[] }
  | { kind: "new_type"; proposal: TypeProposal }
  | { kind: "not_relevant" };

const responseSchema = z.object({
  scores: z.array(z.object({ typeId: z.string(), confidence: z.number().min(0).max(1) })),
  proposal: z
    .object({ name: z.string(), description: z.string(), rationale: z.string() })
    .nullable()
    .optional(),
  deadline: z.string().nullable().optional(),
  // Level is a loose string here so one off-vocabulary answer ("P1") drops
  // just the signal instead of failing the whole triage call.
  urgency: z.object({ level: z.string(), reason: z.string() }).nullable().optional(),
  notRelevant: z.boolean().optional(),
});

export interface UrgencySignal {
  level: Priority;
  reason: string;
}

export interface TriageResult {
  outcome: TriageOutcome;
  /** yyyy-mm-dd if the task text states or clearly implies one, else null. */
  deadline: string | null;
  /** Set only when the content itself signals elevated urgency; raises, never lowers, the type default. */
  urgency: UrgencySignal | null;
}

export async function triageTask(
  provider: AiProvider,
  task: Task,
  types: TaskType[],
  /** The connected user's identity on the task's source (a GitHub login, an
   *  email address), when that source can resolve one; null otherwise. */
  identity: string | null = null,
): Promise<TriageResult> {
  const response = await completeJson(
    provider,
    {
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content: triageUserMessage(task, types, identity) }],
      maxTokens: 2000,
    },
    responseSchema,
  );

  const deadline = response.deadline ?? null;
  const urgency =
    response.urgency && isPriority(response.urgency.level)
      ? { level: response.urgency.level, reason: response.urgency.reason }
      : null;

  // Fail open: only an affirmative flag drops a task; silence or uncertainty
  // falls through to normal classification below, never to a silent dismissal.
  if (response.notRelevant === true) return { outcome: { kind: "not_relevant" }, deadline, urgency };
  const known = new Set(types.map((t) => t.id));
  const scores = response.scores
    .filter((s) => known.has(s.typeId))
    .sort((a, b) => b.confidence - a.confidence);

  const proposal = response.proposal ?? null;
  const top = scores[0];
  const runnerUp = scores[1];

  if (!top) {
    if (proposal) return { outcome: { kind: "new_type", proposal }, deadline, urgency };
    throw new Error("triage returned no usable type scores and no proposal");
  }

  if (top.confidence >= MIN_CONFIDENCE) {
    if (runnerUp && top.confidence - runnerUp.confidence <= AMBIGUITY_MARGIN) {
      return { outcome: { kind: "ambiguous", candidateTypeIds: [top.typeId, runnerUp.typeId] }, deadline, urgency };
    }
    return { outcome: { kind: "matched", typeId: top.typeId }, deadline, urgency };
  }

  if (proposal) return { outcome: { kind: "new_type", proposal }, deadline, urgency };
  return {
    outcome: { kind: "ambiguous", candidateTypeIds: runnerUp ? [top.typeId, runnerUp.typeId] : [top.typeId] },
    deadline,
    urgency,
  };
}
