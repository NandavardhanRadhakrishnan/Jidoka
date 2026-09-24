import { test, expect } from "bun:test";
import { checkForDuplicate, DEDUP_MIN_CONFIDENCE } from "../../src/dedup/dedup";
import type { AiProvider } from "../../src/ai/provider";
import type { Task } from "../../src/domain/task";

function stub(reply: unknown): AiProvider {
  return {
    id: "stub",
    async complete() {
      return { text: JSON.stringify(reply), toolCalls: [] };
    },
  };
}

function task(id: string, title: string, body = "…"): Task {
  return {
    id,
    sourceId: "outlook",
    externalId: id,
    url: null,
    title,
    body,
    metadata: {},
    typeId: null,
    typeCandidates: null,
    state: "ingested",
    assignee: null,
    deadline: null,
    dedupCandidateId: null,
    context: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("an empty candidate list never calls the provider", async () => {
  let called = false;
  const provider: AiProvider = {
    id: "stub",
    async complete() {
      called = true;
      return { text: "{}", toolCalls: [] };
    },
  };

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), []);

  expect(match).toBeNull();
  expect(called).toBe(false);
});

test("a confident match against a known candidate is returned", async () => {
  const candidate = task("c1", "Order #4021 missing");
  const provider = stub({ duplicateOfTaskId: "c1", confidence: 0.9, rationale: "same order number" });

  const match = await checkForDuplicate(provider, task("new", "Where is my order #4021?"), [candidate]);

  expect(match).toEqual({ taskId: "c1", confidence: 0.9, rationale: "same order number" });
});

test("confidence below the threshold is treated as no match", async () => {
  const candidate = task("c1", "Order #4021 missing");
  const provider = stub({
    duplicateOfTaskId: "c1",
    confidence: DEDUP_MIN_CONFIDENCE - 0.01,
    rationale: "maybe",
  });

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), [candidate]);

  expect(match).toBeNull();
});

test("an id outside the candidate list is ignored", async () => {
  const candidate = task("c1", "Order #4021 missing");
  const provider = stub({ duplicateOfTaskId: "ghost", confidence: 0.95, rationale: "?" });

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), [candidate]);

  expect(match).toBeNull();
});

test("no match from the model is returned as null", async () => {
  const candidate = task("c1", "Unrelated topic");
  const provider = stub({ duplicateOfTaskId: null, confidence: 0.1, rationale: "no relation" });

  const match = await checkForDuplicate(provider, task("new", "Where is my order?"), [candidate]);

  expect(match).toBeNull();
});
