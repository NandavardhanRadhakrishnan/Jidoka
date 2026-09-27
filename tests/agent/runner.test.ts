import { test, expect } from "bun:test";
import { createInProcessRunner } from "../../src/agent/runner";

test("createInProcessRunner accepts and ignores resumeSessionId", async () => {
  const runner = createInProcessRunner({
    provider: {
      id: "stub",
      async complete() {
        return { text: "done", toolCalls: [] };
      },
    },
    listTools: () => [],
    callTool: async () => "",
  });

  const result = await runner.run({
    prompt: "go",
    allowedTools: [],
    maxTurns: 1,
    resumeSessionId: "sess-1",
  });

  expect(result).toEqual({ text: "done", toolCalls: [] });
});
