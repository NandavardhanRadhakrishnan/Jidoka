import { test, expect } from "bun:test";
import { generateExtension } from "../../src/extensions/generator";
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
    async poll(cursor) {
      return { items: [], cursor };
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
