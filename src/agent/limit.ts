import type { AgentRunner, AgentRunInput, AgentRunResult } from "./runner";

/**
 * Caps how many agent runs happen at once.
 *
 * Subscription-backed runs each spawn a CLI process against one personal
 * account's limits, so they need a small cap; API-key runs can be given a larger
 * one. Waiters are served in arrival order.
 */
export function withConcurrencyLimit(runner: AgentRunner, limit: number): AgentRunner {
  if (limit <= 0) throw new Error("concurrency limit must be at least 1");

  let active = 0;
  const waiting: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  }

  function release(): void {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return {
    id: `${runner.id}(max ${limit})`,
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      await acquire();
      try {
        return await runner.run(input);
      } finally {
        release();
      }
    },
  };
}
