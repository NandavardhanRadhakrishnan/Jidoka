import { test, expect } from "bun:test";
import { generateExtension, SYSTEM_PROMPT } from "../../src/extensions/generator";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "../../src/agent/runner";

function scripted(replies: string[]): AgentRunner & { calls: AgentRunInput[] } {
  let i = 0;
  return {
    id: "stub",
    calls: [],
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      this.calls.push(input);
      return { text: replies[i++] ?? "", toolCalls: [] };
    },
  };
}

const validManifest = JSON.stringify({
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  summary: "Reads demo items.",
  readOnly: true,
  auth: { mode: "api-key", label: "Token" },
});

const validSource = `export function createSource(deps) {
  return {
    async list({ since }) {
      return { items: [], failures: [] };
    },
  };
}`;

function fenced(json: string, source: string): string {
  return `\`\`\`json\n${json}\n\`\`\`\n\`\`\`typescript\n${source}\n\`\`\``;
}

test("generateExtension returns a validated manifest and source on the first try", async () => {
  const runner = scripted([fenced(validManifest, validSource)]);

  const result = await generateExtension(
    runner,
    { kind: "create", description: "A demo integration" },
    ["notion__search"],
  );

  expect(result.manifest.id).toBe("demo");
  expect(result.source).toContain("createSource");
  expect(runner.calls[0]?.allowedTools).toEqual(["notion__search"]);
  expect(runner.calls[0]?.prompt).toContain("A demo integration");
});

test("generateExtension retries with feedback when the manifest fails schema validation", async () => {
  const runner = scripted([
    fenced(JSON.stringify({ id: "demo" }), validSource),
    fenced(validManifest, validSource),
  ]);

  const result = await generateExtension(runner, { kind: "create", description: "d" }, []);

  expect(result.manifest.id).toBe("demo");
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls[1]?.prompt).toContain("rejected");
});

test("generateExtension retries when source.ts does not export createSource", async () => {
  const runner = scripted([
    fenced(validManifest, `export const notCreateSource = 1;`),
    fenced(validManifest, validSource),
  ]);

  const result = await generateExtension(runner, { kind: "create", description: "d" }, []);

  expect(result.source).toContain("createSource");
  expect(runner.calls).toHaveLength(2);
});

test("generateExtension retries when createSource throws", async () => {
  const runner = scripted([
    fenced(validManifest, `export function createSource() { throw new Error("boom"); }`),
    fenced(validManifest, validSource),
  ]);

  const result = await generateExtension(runner, { kind: "create", description: "d" }, []);

  expect(result.source).toContain("createSource");
});

test("generateExtension throws after both attempts fail", async () => {
  const runner = scripted(["no fenced blocks here", "still nothing"]);

  await expect(
    generateExtension(runner, { kind: "create", description: "d" }, []),
  ).rejects.toThrow(/failed after a retry/);
});

test("a fix pins manifest.id to targetId even if the model changes it", async () => {
  const renamedManifest = JSON.stringify({
    id: "renamed-by-model",
    name: "Demo",
    version: "1.0.0",
    summary: "Reads demo items.",
    readOnly: true,
    auth: { mode: "api-key", label: "Token" },
  });
  const runner = scripted([fenced(renamedManifest, validSource)]);

  const result = await generateExtension(
    runner,
    {
      kind: "fix",
      targetId: "demo",
      currentManifest: validManifest,
      currentSource: validSource,
      error: "401 unauthorized",
    },
    [],
  );

  expect(result.manifest.id).toBe("demo");
  expect(runner.calls[0]?.prompt).toContain("401 unauthorized");
});

test("the generator is told to export getIdentity when the target has a self-identity endpoint", async () => {
  const runner = scripted([fenced(validManifest, validSource)]);

  await generateExtension(runner, { kind: "create", description: "GitHub issues" }, []);

  expect(runner.calls[0]?.systemPrompt).toContain("getIdentity(deps)");
});

test("the generator prompt teaches participants and namespaced identities", () => {
  expect(SYSTEM_PROMPT).toContain('"participants"');
  expect(SYSTEM_PROMPT).toContain('"github:octocat"');
  expect(SYSTEM_PROMPT).toContain('"email:you@example.com"');
});

test("the generator prompt teaches the list({ since }) contract and its key rules", () => {
  expect(SYSTEM_PROMPT).toContain("list({ since })");
  expect(SYSTEM_PROMPT).toContain("threadKey");
  expect(SYSTEM_PROMPT).toContain("never use IMAP UIDs");
  expect(SYSTEM_PROMPT).toContain("never invent a fallback key");
  expect(SYSTEM_PROMPT).toContain("failures");
  expect(SYSTEM_PROMPT).not.toContain("poll(cursor)");
});

test("the generator prompt asks for unique keys, unkeyed failures and one key per call", () => {
  expect(SYSTEM_PROMPT).toContain("unique within the source");
  expect(SYSTEM_PROMPT).toContain("prefix with the repo or kind when ids can repeat (e.g. `owner/repo#12`)");
  expect(SYSTEM_PROMPT).toContain(
    "failures.push({ key, error })`, or `failures.push({ error })` when there is no readable id",
  );
  expect(SYSTEM_PROMPT).not.toContain("(no readable id, a missing field): failures.push({ key, error })");
  expect(SYSTEM_PROMPT).toContain("return each key once per call");
});

test("the generator prompt carries the key table from the spec", () => {
  for (const source of ["Gmail API", "X-GM-MSGID", "internetMessageId", "conversationId", "Message-ID", "thread_ts", "Ledgers"]) {
    expect(SYSTEM_PROMPT).toContain(source);
  }
});

test("the shape check rejects a draft whose createSource returns only poll()", async () => {
  const pollOnly = `export function createSource() {
  return { async poll(cursor) { return { items: [], cursor }; } };
}`;
  const runner = scripted([fenced(validManifest, pollOnly), fenced(validManifest, validSource)]);

  const result = await generateExtension(runner, { kind: "create", description: "d" }, []);

  expect(result.source).toContain("list(");
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls[1]?.prompt).toContain(
    "createSource(deps) must return an object with a list({ since }) function",
  );
});
