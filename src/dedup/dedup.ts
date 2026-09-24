import { z } from "zod";
import { completeJson, type AiProvider } from "../ai/provider";
import type { Task } from "../domain/task";
import { DEDUP_SYSTEM, dedupUserMessage } from "./prompt";

export const DEDUP_MIN_CONFIDENCE = 0.6;

export interface DedupMatch {
  taskId: string;
  confidence: number;
  rationale: string;
}

const responseSchema = z.object({
  duplicateOfTaskId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export async function checkForDuplicate(
  provider: AiProvider,
  task: Task,
  candidates: Task[],
): Promise<DedupMatch | null> {
  if (candidates.length === 0) return null;

  const response = await completeJson(
    provider,
    {
      system: DEDUP_SYSTEM,
      messages: [{ role: "user", content: dedupUserMessage(task, candidates) }],
      maxTokens: 500,
    },
    responseSchema,
  );

  if (!response.duplicateOfTaskId) return null;
  if (!candidates.some((c) => c.id === response.duplicateOfTaskId)) return null;
  if (response.confidence < DEDUP_MIN_CONFIDENCE) return null;

  return {
    taskId: response.duplicateOfTaskId,
    confidence: response.confidence,
    rationale: response.rationale,
  };
}
