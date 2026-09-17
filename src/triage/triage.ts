import { z } from "zod";
import { completeJson, type AiProvider } from "../ai/provider";
import type { Task } from "../domain/task";
import type { TaskType } from "../domain/taskType";
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
  | { kind: "new_type"; proposal: TypeProposal };

const responseSchema = z.object({
  scores: z.array(z.object({ typeId: z.string(), confidence: z.number().min(0).max(1) })),
  proposal: z
    .object({ name: z.string(), description: z.string(), rationale: z.string() })
    .nullable()
    .optional(),
});

export async function triageTask(
  provider: AiProvider,
  task: Task,
  types: TaskType[],
): Promise<TriageOutcome> {
  const response = await completeJson(
    provider,
    {
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content: triageUserMessage(task, types) }],
      maxTokens: 2000,
    },
    responseSchema,
  );

  const known = new Set(types.map((t) => t.id));
  const scores = response.scores
    .filter((s) => known.has(s.typeId))
    .sort((a, b) => b.confidence - a.confidence);

  const proposal = response.proposal ?? null;
  const top = scores[0];
  const runnerUp = scores[1];

  if (!top) {
    if (proposal) return { kind: "new_type", proposal };
    throw new Error("triage returned no usable type scores and no proposal");
  }

  if (top.confidence >= MIN_CONFIDENCE) {
    if (runnerUp && top.confidence - runnerUp.confidence <= AMBIGUITY_MARGIN) {
      return { kind: "ambiguous", candidateTypeIds: [top.typeId, runnerUp.typeId] };
    }
    return { kind: "matched", typeId: top.typeId };
  }

  if (proposal) return { kind: "new_type", proposal };
  return {
    kind: "ambiguous",
    candidateTypeIds: runnerUp ? [top.typeId, runnerUp.typeId] : [top.typeId],
  };
}
