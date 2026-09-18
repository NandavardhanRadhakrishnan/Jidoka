import { test, expect } from "bun:test";
import { withConcurrencyLimit } from "../../src/agent/limit";
import type { AgentRunner } from "../../src/agent/runner";

function trackingRunner(): { runner: AgentRunner; peak: () => number; release: () => void } {
  let active = 0;
  let peak = 0;
  const gates: (() => void)[] = [];

  return {
    peak: () => peak,
    release: () => gates.shift()?.(),
    runner: {
      id: "fake",
      async run() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return { text: "done", toolCalls: [] };
      },
    },
  };
}

test("no more than the limit run at once", async () => {
  const tracking = trackingRunner();
  const limited = withConcurrencyLimit(tracking.runner, 2);
  const input = { prompt: "p", allowedTools: [], maxTurns: 1 };

  const runs = [limited.run(input), limited.run(input), limited.run(input)];
  await Bun.sleep(5);
  expect(tracking.peak()).toBe(2);

  tracking.release();
  tracking.release();
  await Bun.sleep(5);
  tracking.release();

  expect(await Promise.all(runs)).toHaveLength(3);
  expect(tracking.peak()).toBe(2);
});

test("a failing run still frees its slot", async () => {
  const failing: AgentRunner = {
    id: "boom",
    async run() {
      throw new Error("nope");
    },
  };
  const limited = withConcurrencyLimit(failing, 1);
  const input = { prompt: "p", allowedTools: [], maxTurns: 1 };

  await expect(limited.run(input)).rejects.toThrow("nope");
  await expect(limited.run(input)).rejects.toThrow("nope");
});

test("a limit below one is rejected", () => {
  const runner: AgentRunner = { id: "x", async run() { return { text: "", toolCalls: [] }; } };

  expect(() => withConcurrencyLimit(runner, 0)).toThrow(/at least 1/);
});
