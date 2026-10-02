import { test, expect } from "bun:test";
import { triageTask } from "../../src/triage/triage";
import { triageUserMessage } from "../../src/triage/prompt";
import type { AiProvider } from "../../src/ai/provider";
import type { Task } from "../../src/domain/task";
import type { TaskType } from "../../src/domain/taskType";

function stub(reply: unknown): AiProvider {
  return {
    id: "stub",
    async complete() {
      return { text: JSON.stringify(reply), toolCalls: [] };
    },
  };
}

const task: Task = {
  id: "t1",
  sourceId: "outlook",
  externalId: "m1",
  url: null,
  title: "Where is my order?",
  body: "I ordered last week and it has not arrived.",
  metadata: {},
  typeId: null,
  typeCandidates: null,
  state: "ingested",
  assignee: null,
  deadline: null,
  priority: "normal",
  dedupCandidateId: null,
  context: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function type(id: string, name: string): TaskType {
  return {
    id,
    name,
    description: `${name} description`,
    examples: [],
    status: "active",
    defaultPriority: "normal",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("no existing types means a new type proposal", async () => {
  const provider = stub({
    scores: [],
    proposal: { name: "Customer email", description: "External question", rationale: "first task" },
  });

  const { outcome } = await triageTask(provider, task, []);

  expect(outcome).toEqual({
    kind: "new_type",
    proposal: { name: "Customer email", description: "External question", rationale: "first task" },
  });
});

test("a deadline mentioned in the task is extracted alongside the outcome", async () => {
  const provider = stub({
    scores: [{ typeId: "a", confidence: 0.92 }],
    proposal: null,
    deadline: "2026-02-01",
  });

  const { deadline } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(deadline).toBe("2026-02-01");
});

test("no deadline mentioned leaves it null", async () => {
  const provider = stub({
    scores: [{ typeId: "a", confidence: 0.92 }],
    proposal: null,
  });

  const { deadline } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(deadline).toBeNull();
});

test("a confident, clear winner matches that type", async () => {
  const provider = stub({
    scores: [
      { typeId: "a", confidence: 0.92 },
      { typeId: "b", confidence: 0.2 },
    ],
    proposal: null,
  });

  const { outcome } = await triageTask(provider, task, [type("a", "Customer email"), type("b", "Recon")]);

  expect(outcome).toEqual({ kind: "matched", typeId: "a" });
});

test("two close candidates are ambiguous and go to the user", async () => {
  const provider = stub({
    scores: [
      { typeId: "a", confidence: 0.7 },
      { typeId: "b", confidence: 0.62 },
    ],
    proposal: null,
  });

  const { outcome } = await triageTask(provider, task, [type("a", "Customer email"), type("b", "Recon")]);

  expect(outcome).toEqual({ kind: "ambiguous", candidateTypeIds: ["a", "b"] });
});

test("low confidence with a proposal yields a new type", async () => {
  const provider = stub({
    scores: [{ typeId: "a", confidence: 0.3 }],
    proposal: { name: "Reconciliation", description: "Ledger check", rationale: "no fit" },
  });

  const { outcome } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(outcome.kind).toBe("new_type");
});

test("unknown type ids from the model are ignored", async () => {
  const provider = stub({
    scores: [
      { typeId: "ghost", confidence: 0.99 },
      { typeId: "a", confidence: 0.81 },
    ],
    proposal: null,
  });

  const { outcome } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(outcome).toEqual({ kind: "matched", typeId: "a" });
});

test("an urgency signal in the task is extracted with its reason", async () => {
  const provider = stub({
    scores: [{ typeId: "a", confidence: 0.92 }],
    proposal: null,
    urgency: { level: "urgent", reason: "threatens legal action by Monday" },
  });

  const { urgency } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(urgency).toEqual({ level: "urgent", reason: "threatens legal action by Monday" });
});

test("no urgency signal leaves it null", async () => {
  const provider = stub({ scores: [{ typeId: "a", confidence: 0.92 }], proposal: null });

  const { urgency } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(urgency).toBeNull();
});

test("an urgency level outside the known priorities is ignored rather than failing triage", async () => {
  const provider = stub({
    scores: [{ typeId: "a", confidence: 0.92 }],
    proposal: null,
    urgency: { level: "P1", reason: "sounds bad" },
  });

  const { outcome, urgency } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(outcome).toEqual({ kind: "matched", typeId: "a" });
  expect(urgency).toBeNull();
});

test("notRelevant short-circuits to not_relevant even when a type scores high", async () => {
  const provider = stub({
    scores: [{ typeId: "a", confidence: 0.95 }],
    proposal: null,
    notRelevant: true,
  });

  const { outcome } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(outcome).toEqual({ kind: "not_relevant" });
});

test("notRelevant false falls through to normal classification", async () => {
  const provider = stub({ scores: [{ typeId: "a", confidence: 0.95 }], proposal: null, notRelevant: false });

  const { outcome } = await triageTask(provider, task, [type("a", "Customer email")]);

  expect(outcome).toEqual({ kind: "matched", typeId: "a" });
});

test("the connected user's identity on the source is given to triage when known", () => {
  expect(triageUserMessage(task, [], "octocat")).toContain("The connected user's identity on this source: octocat");
  expect(triageUserMessage(task, [], null)).not.toContain("identity on this source");
});

test("triageTask passes the identity through to the model", async () => {
  let seen = "";
  const provider: AiProvider = {
    id: "stub",
    async complete(req) {
      seen = JSON.stringify(req.messages);
      return { text: JSON.stringify({ scores: [], proposal: { name: "n", description: "d", rationale: "r" } }), toolCalls: [] };
    },
  };

  await triageTask(provider, task, [], "octocat");

  expect(seen).toContain("octocat");
});
