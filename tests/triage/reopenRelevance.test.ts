import { test, expect } from "bun:test";
import { assessReopenRelevance } from "../../src/triage/reopenRelevance";
import type { AiProvider } from "../../src/ai/provider";
import type { Task } from "../../src/domain/task";
import type { TaskType } from "../../src/domain/taskType";

const task: Task = {
  id: "t1",
  sourceId: "gh",
  externalId: "42",
  url: null,
  title: "Login button broken",
  body: "Clicking login does nothing.",
  metadata: {},
  typeId: "bug",
  typeCandidates: null,
  state: "assigned_human",
  assignee: "human",
  deadline: null,
  priority: "normal",
  dedupCandidateId: null,
  context: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const type: TaskType = {
  id: "bug",
  name: "Bug report",
  description: "A user reporting broken behaviour",
  examples: [],
  status: "active",
  defaultPriority: "normal",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const item = { externalId: "42", title: "Login button broken", body: "octocat: Thanks, we're looking into it.", revision: "r2" };

function capturing(reply: string): AiProvider & { seen: string } {
  return {
    id: "stub",
    seen: "",
    async complete(req) {
      this.seen = JSON.stringify(req);
      return { text: reply, toolCalls: [] };
    },
  };
}

test("a change the model judges not relevant is reported as such, with its reason", async () => {
  const provider = capturing(JSON.stringify({ relevant: false, reason: "the user's own comment" }));

  expect(await assessReopenRelevance(provider, task, type, item, "octocat")).toEqual({
    relevant: false,
    reason: "the user's own comment",
  });
});

test("the type, the prior and new content, and the identity all reach the model", async () => {
  const provider = capturing(JSON.stringify({ relevant: true }));

  await assessReopenRelevance(provider, task, type, item, "octocat");

  expect(provider.seen).toContain("Bug report");
  expect(provider.seen).toContain("Clicking login does nothing.");
  expect(provider.seen).toContain("we're looking into it");
  expect(provider.seen).toContain("octocat");
});

test("an unusable reply fails open to relevant, so a real follow-up is never silently dropped", async () => {
  const provider = capturing("not json at all");

  expect((await assessReopenRelevance(provider, task, type, item, null)).relevant).toBe(true);
});
