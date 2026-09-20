import type { AiProvider, ToolSpec } from "../ai/provider";
import type { Assignee, Task } from "../domain/task";
import type { HandoffTarget, RuleDefinition, RuleStep } from "../domain/rule";
import { createInProcessRunner, type AgentRunner } from "../agent/runner";
import { renderInput, renderTemplate, type TemplateScope } from "./template";

export type ToolCaller = (
  server: string,
  tool: string,
  input: Record<string, unknown>,
) => Promise<string>;

export type RuleLoader = (typeId: string, version: number) => RuleDefinition | null;

export interface ExecutorDeps {
  provider: AiProvider;
  callTool: ToolCaller;
  loadRule: RuleLoader;
  /** Tool catalogue for agent steps; names are `server__tool`. */
  listTools?: () => ToolSpec[];
  /**
   * Backend for `agent` steps. Defaults to the in-process loop over `provider`
   * and `callTool`; set it to the Agent SDK runner to use subscription auth.
   */
  runAgent?: AgentRunner;
  /** The rule being run, so that a self-call is detected as a loop. */
  self?: { typeId: string; version: number };
}

export interface StepLogEntry {
  stepId: string;
  type: RuleStep["type"];
  output?: string;
  error?: string;
}

export interface RunResult {
  context: Record<string, unknown>;
  assignee: Assignee | null;
  log: StepLogEntry[];
  /** What a human should have open when they pick this task up. */
  handoff?: ResolvedHandoffTarget[];
}

/** A handoff target with its templates filled in. */
export type ResolvedHandoffTarget =
  | { kind: "url"; label: string; url: string }
  | { kind: "draft"; label: string; content: string }
  | { kind: "command"; label: string; command: string };

/**
 * Renders handoff targets. A `session` target becomes the command that resumes
 * that conversation; a target whose value did not resolve is dropped rather than
 * handed to someone as an empty link.
 */
export function resolveHandoff(
  targets: HandoffTarget[],
  scope: TemplateScope,
  resumeCommand = (sessionId: string) => `claude --resume ${sessionId}`,
): ResolvedHandoffTarget[] {
  const resolved: ResolvedHandoffTarget[] = [];

  for (const target of targets) {
    const label = renderTemplate(target.label, scope);

    if (target.kind === "session") {
      const sessionId = renderTemplate(target.sessionId, scope).trim();
      if (sessionId) resolved.push({ kind: "command", label, command: resumeCommand(sessionId) });
      continue;
    }

    if (target.kind === "url") {
      const url = renderTemplate(target.url, scope).trim();
      if (url) resolved.push({ kind: "url", label, url });
      continue;
    }

    if (target.kind === "draft") {
      const content = renderTemplate(target.content, scope);
      if (content.trim()) resolved.push({ kind: "draft", label, content });
      continue;
    }

    const command = renderTemplate(target.command, scope).trim();
    if (command) resolved.push({ kind: "command", label, command });
  }

  return resolved;
}

const MAX_DEPTH = 5;

interface RunState {
  context: Record<string, unknown>;
  assignee: Assignee | null;
  log: StepLogEntry[];
  stack: string[];
  handoff?: ResolvedHandoffTarget[];
}

function scopeFor(task: Task, state: RunState): TemplateScope {
  return {
    task: {
      id: task.id,
      title: task.title,
      body: task.body,
      url: task.url,
      metadata: task.metadata,
      sourceId: task.sourceId,
    },
    context: state.context,
  };
}

async function runSteps(
  deps: ExecutorDeps,
  steps: RuleStep[],
  task: Task,
  state: RunState,
): Promise<void> {
  for (const step of steps) {
    const scope = scopeFor(task, state);

    switch (step.type) {
      case "ai": {
        const result = await deps.provider.complete({
          messages: [{ role: "user", content: renderTemplate(step.prompt, scope) }],
          maxTokens: 4000,
          ...(step.model ? { model: step.model } : {}),
        });
        state.context[step.output] = result.text;
        state.log.push({ stepId: step.id, type: step.type, output: step.output });
        break;
      }
      case "agent": {
        const runner =
          deps.runAgent ??
          createInProcessRunner({
            provider: deps.provider,
            listTools: () => deps.listTools?.() ?? [],
            callTool: deps.callTool,
          });

        let result;
        try {
          result = await runner.run({
            prompt: renderTemplate(step.prompt, scope),
            allowedTools: step.tools,
            maxTurns: step.maxIterations,
            ...(step.model ? { model: step.model } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`agent step ${step.id}: ${message}`);
        }

        for (const call of result.toolCalls) {
          state.log.push({
            stepId: step.id,
            type: "agent",
            output: call.name,
            ...(call.error ? { error: call.error } : {}),
          });
        }

        state.context[step.output] = result.text;
        // Keep the conversation id so a handoff can offer to resume it.
        if (result.sessionId) state.context[`${step.output}_session`] = result.sessionId;
        state.log.push({ stepId: step.id, type: step.type, output: step.output });
        break;
      }
      case "mcp_tool": {
        const input = renderInput(step.input, scope) as Record<string, unknown>;
        const output = await deps.callTool(step.server, step.tool, input);
        state.context[step.output] = output;
        state.log.push({ stepId: step.id, type: step.type, output: step.output });
        break;
      }
      case "assign": {
        state.assignee = step.to;
        if (step.note) state.context[`note:${step.id}`] = renderTemplate(step.note, scope);
        if (step.open?.length) state.handoff = resolveHandoff(step.open, scope);
        state.log.push({ stepId: step.id, type: step.type });
        break;
      }
      case "branch": {
        const value = state.context[step.on];
        const key = typeof value === "string" ? value : JSON.stringify(value);
        const chosen = step.cases[key] ?? step.default ?? [];
        state.log.push({ stepId: step.id, type: step.type, output: key });
        await runSteps(deps, chosen, task, state);
        break;
      }
      case "call_rule": {
        const key = `${step.typeId}@${step.version}`;
        if (state.stack.includes(key)) {
          throw new Error(`rule loop detected: ${[...state.stack, key].join(" -> ")}`);
        }
        if (state.stack.length >= MAX_DEPTH) {
          throw new Error(`rule nesting deeper than ${MAX_DEPTH}: ${state.stack.join(" -> ")}`);
        }
        const child = deps.loadRule(step.typeId, step.version);
        if (!child) throw new Error(`called rule not found: ${key}`);
        state.log.push({ stepId: step.id, type: step.type, output: key });
        state.stack.push(key);
        await runSteps(deps, child.steps, task, state);
        state.stack.pop();
        break;
      }
    }
  }
}

export async function runRule(
  deps: ExecutorDeps,
  definition: RuleDefinition,
  task: Task,
): Promise<RunResult> {
  const state: RunState = {
    context: { ...task.context },
    assignee: null,
    log: [],
    stack: deps.self ? [`${deps.self.typeId}@${deps.self.version}`] : [],
  };

  await runSteps(deps, definition.steps, task, state);

  return {
    context: state.context,
    assignee: state.assignee,
    log: state.log,
    ...(state.handoff ? { handoff: state.handoff } : {}),
  };
}
