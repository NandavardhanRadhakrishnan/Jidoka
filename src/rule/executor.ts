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

export type RuleLoader = (
  typeId: string,
  version: number,
) => { id: string; definition: RuleDefinition } | null;

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
  self?: { typeId: string; version: number; ruleId: string };
  getHints?: (ruleId: string, stepId: string) => string[];
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

function renderStepPrompt(
  deps: ExecutorDeps,
  step: Extract<RuleStep, { type: "ai" | "agent" }>,
  scope: TemplateScope,
  owningRuleId: string,
): string {
  const rendered = renderTemplate(step.prompt, scope);
  const hints = deps.getHints?.(owningRuleId, step.id) ?? [];
  if (hints.length === 0) return rendered;
  return `${rendered}\n\nNotes from past corrections on this step:\n${hints.map((h) => `- ${h}`).join("\n")}`;
}

export async function runOneStep(
  deps: ExecutorDeps,
  step: Extract<RuleStep, { type: "ai" | "agent" }>,
  task: Task,
  state: RunState,
  owningRuleId: string,
): Promise<void> {
  const scope = scopeFor(task, state);

  if (step.type === "ai") {
    const result = await deps.provider.complete({
      messages: [{ role: "user", content: renderStepPrompt(deps, step, scope, owningRuleId) }],
      maxTokens: 4000,
      ...(step.model ? { model: step.model } : {}),
    });
    state.context[step.output] = result.text;
    state.log.push({ stepId: step.id, type: step.type, output: step.output });
    return;
  }

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
      prompt: renderStepPrompt(deps, step, scope, owningRuleId),
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
  if (result.sessionId) state.context[`${step.output}_session`] = result.sessionId;
  state.log.push({ stepId: step.id, type: step.type, output: step.output });
}

type AiAgentStep = Extract<RuleStep, { type: "ai" | "agent" }>;

function findAiAgentStep(
  deps: ExecutorDeps,
  steps: RuleStep[],
  stepId: string,
  owningRuleId: string,
): { step: AiAgentStep; owningRuleId: string } | null {
  for (const step of steps) {
    if ((step.type === "ai" || step.type === "agent") && step.id === stepId) {
      return { step, owningRuleId };
    }
    if (step.type === "branch") {
      for (const caseSteps of Object.values(step.cases)) {
        const found = findAiAgentStep(deps, caseSteps, stepId, owningRuleId);
        if (found) return found;
      }
      if (step.default) {
        const found = findAiAgentStep(deps, step.default, stepId, owningRuleId);
        if (found) return found;
      }
    }
    if (step.type === "call_rule") {
      const loaded = deps.loadRule(step.typeId, step.version);
      if (loaded) {
        const found = findAiAgentStep(deps, loaded.definition.steps, stepId, loaded.id);
        if (found) return found;
      }
    }
  }
  return null;
}

export async function rerunStep(
  deps: ExecutorDeps,
  definition: RuleDefinition,
  task: Task,
  stepId: string,
): Promise<{ context: Record<string, unknown>; log: StepLogEntry }> {
  const owningRuleId = deps.self?.ruleId ?? "";
  const found = findAiAgentStep(deps, definition.steps, stepId, owningRuleId);
  if (!found) {
    throw new Error(`rerunStep: no ai/agent step with id ${stepId}`);
  }

  const state: RunState = {
    context: { ...task.context },
    assignee: null,
    log: [],
    stack: [],
  };

  await runOneStep(deps, found.step, task, state, found.owningRuleId);

  const patch: Record<string, unknown> = {
    [found.step.output]: state.context[found.step.output],
  };
  const sessionKey = `${found.step.output}_session`;
  if (sessionKey in state.context) {
    patch[sessionKey] = state.context[sessionKey];
  }

  const log =
    state.log.find(
      (entry) => entry.stepId === found.step.id && entry.output === found.step.output,
    ) ?? state.log.at(-1)!;

  return { context: patch, log };
}

async function runSteps(
  deps: ExecutorDeps,
  steps: RuleStep[],
  task: Task,
  state: RunState,
  owningRuleId: string,
): Promise<void> {
  for (const step of steps) {
    const scope = scopeFor(task, state);

    switch (step.type) {
      case "ai":
      case "agent":
        await runOneStep(deps, step, task, state, owningRuleId);
        break;
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
        await runSteps(deps, chosen, task, state, owningRuleId);
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
        const loaded = deps.loadRule(step.typeId, step.version);
        if (!loaded) throw new Error(`called rule not found: ${key}`);
        state.log.push({ stepId: step.id, type: step.type, output: key });
        state.stack.push(key);
        await runSteps(deps, loaded.definition.steps, task, state, loaded.id);
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

  const owningRuleId = deps.self?.ruleId ?? "";
  await runSteps(deps, definition.steps, task, state, owningRuleId);

  return {
    context: state.context,
    assignee: state.assignee,
    log: state.log,
    ...(state.handoff ? { handoff: state.handoff } : {}),
  };
}
