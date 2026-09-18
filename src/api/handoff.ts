import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getTask, updateTask } from "../repo/tasks";
import type { ResolvedHandoffTarget } from "../pipeline/executor";

export interface HandoffDeps {
  db: Database;
  /**
   * How to open a terminal, with {{command}} substituted. Unset means the UI can
   * only offer the command for copying — nothing is ever launched.
   */
  terminalCommand?: string;
  spawn?: (argv: string[]) => void;
}

function defaultSpawn(argv: string[]): void {
  const [command, ...args] = argv;
  if (!command) throw new Error("empty terminal command");
  Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

/** Splits a configured launcher on spaces, respecting "quoted segments". */
export function parseLauncher(template: string, command: string): string[] {
  const parts = template.match(/"[^"]*"|\S+/g) ?? [];
  return parts.map((part) => {
    const unquoted = part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part;
    return unquoted.replace("{{command}}", command);
  });
}

export function taskHandoff(db: Database, taskId: string): ResolvedHandoffTarget[] | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  const handoff = task.context.handoff;
  return Array.isArray(handoff) ? (handoff as ResolvedHandoffTarget[]) : [];
}

/**
 * Handoff: what a human should have open when they pick a task up.
 *
 * `run-command` deliberately takes a label, not a command string. Pipelines are
 * written by a model from task content, so the command text is untrusted input;
 * the server only ever launches something already stored on that task's own
 * handoff, and only in a visible terminal.
 */
export function createHandoffRoutes(deps: HandoffDeps): Hono {
  const app = new Hono();
  const spawn = deps.spawn ?? defaultSpawn;

  app.post("/api/tasks/:id/pick-up", (c) => {
    const id = c.req.param("id");
    const task = getTask(deps.db, id);
    if (!task) return c.json({ error: "unknown task" }, 404);

    const updated = updateTask(deps.db, id, {
      context: { ...task.context, pickedUpAt: new Date().toISOString() },
    });

    return c.json({
      task: updated,
      handoff: taskHandoff(deps.db, id) ?? [],
      canLaunchTerminal: Boolean(deps.terminalCommand),
    });
  });

  app.post("/api/tasks/:id/run-command", async (c) => {
    const id = c.req.param("id");
    if (!getTask(deps.db, id)) return c.json({ error: "unknown task" }, 404);
    if (!deps.terminalCommand) {
      return c.json({ error: "no terminal is configured; set JIDOKA_TERMINAL" }, 409);
    }

    let label: unknown;
    try {
      label = ((await c.req.json()) as { label?: unknown }).label;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    if (typeof label !== "string") return c.json({ error: "label is required" }, 400);

    const target = (taskHandoff(deps.db, id) ?? []).find(
      (entry) => entry.kind === "command" && entry.label === label,
    );
    if (!target || target.kind !== "command") {
      return c.json({ error: "no command with that label on this task" }, 404);
    }

    try {
      spawn(parseLauncher(deps.terminalCommand, target.command));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }

    return c.json({ launched: target.command });
  });

  return app;
}
