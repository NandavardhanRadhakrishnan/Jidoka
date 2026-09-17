import type { AiMessage, AiProvider, AiToolResult, ToolSpec } from "../ai/provider";
import type { Assignee, Task } from "../domain/task";
import type { PipelineDefinition, PipelineStep } from "../domain/pipeline";
import { TOOL_SEPARATOR } from "../mcp/names";
import { renderInput, renderTemplate, type TemplateScope } from "./template";

export type ToolCaller = (
  server: string,
  tool: string,
  input: Record<string, unknown>,
) => Promise<string>;

export type PipelineLoader = (typeId: string, version: number) => PipelineDefinition | null;

export interface ExecutorDeps {
  provider: AiProvider;
  callTool: ToolCaller;
  loadPipeline: PipelineLoader;
  /** Tool catalogue for agent steps; names are `server__tool`. */
  listTools?: () => ToolSpec[];
  /** The pipeline being run, so that a self-call is detected as a loop. */
  self?: { typeId: string; version: number };
}

export interface StepLogEntry {
  stepId: string;
  type: PipelineStep["type"];
  output?: string;
  error?: string;
}

export interface RunResult {
  context: Record<string, unknown>;
  assignee: Assignee | null;
  log: StepLogEntry[];
}

const MAX_DEPTH = 5;

interface RunState {
  context: Record<string, unknown>;
  assignee: Assignee | null;
  log: StepLogEntry[];
  stack: string[];
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
  steps: PipelineStep[],
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
        });
        state.context[step.output] = result.text;
        state.log.push({ stepId: step.id, type: step.type, output: step.output });
        break;
      }
      case "agent": {
        const catalogue = deps.listTools?.() ?? [];
        const specs = catalogue.filter((t) => step.tools.includes(t.name));
        const missing = step.tools.filter((name) => !specs.some((t) => t.name === name));
        if (missing.length) {
          throw new Error(`agent step ${step.id}: unavailable tools ${missing.join(", ")}`);
        }

        const messages: AiMessage[] = [
          { role: "user", content: renderTemplate(step.prompt, scope) },
        ];
        const failures = new Map<string, number>();
        let text = "";

        for (let turn = 0; turn < step.maxIterations; turn++) {
          const result = await deps.provider.complete({
            messages,
            tools: specs,
            maxTokens: 8000,
          });
          if (result.text) text = result.text;
          if (!result.toolCalls.length) break;

          messages.push({ role: "assistant", content: result.text, raw: result.raw });

          const results: AiToolResult[] = [];
          for (const call of result.toolCalls) {
            const index = call.name.indexOf(TOOL_SEPARATOR);
            if (index === -1) throw new Error(`agent step ${step.id}: bad tool name ${call.name}`);
            const server = call.name.slice(0, index);
            const tool = call.name.slice(index + TOOL_SEPARATOR.length);

            try {
              const output = await deps.callTool(server, tool, call.input);
              results.push({ callId: call.id, content: output });
            } catch (error) {
              const count = (failures.get(call.name) ?? 0) + 1;
              failures.set(call.name, count);
              const message = error instanceof Error ? error.message : String(error);
              if (count > 1) {
                throw new Error(`agent step ${step.id}: ${call.name} failed twice: ${message}`);
              }
              results.push({ callId: call.id, content: message, isError: true });
            }
            state.log.push({ stepId: step.id, type: "agent", output: call.name });
          }
          messages.push({ role: "tool_results", results });
        }

        state.context[step.output] = text;
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
      case "call_pipeline": {
        const key = `${step.typeId}@${step.version}`;
        if (state.stack.includes(key)) {
          throw new Error(`pipeline loop detected: ${[...state.stack, key].join(" -> ")}`);
        }
        if (state.stack.length >= MAX_DEPTH) {
          throw new Error(`pipeline nesting deeper than ${MAX_DEPTH}: ${state.stack.join(" -> ")}`);
        }
        const child = deps.loadPipeline(step.typeId, step.version);
        if (!child) throw new Error(`called pipeline not found: ${key}`);
        state.log.push({ stepId: step.id, type: step.type, output: key });
        state.stack.push(key);
        await runSteps(deps, child.steps, task, state);
        state.stack.pop();
        break;
      }
    }
  }
}

export async function runPipeline(
  deps: ExecutorDeps,
  definition: PipelineDefinition,
  task: Task,
): Promise<RunResult> {
  const state: RunState = {
    context: { ...task.context },
    assignee: null,
    log: [],
    stack: deps.self ? [`${deps.self.typeId}@${deps.self.version}`] : [],
  };

  await runSteps(deps, definition.steps, task, state);

  return { context: state.context, assignee: state.assignee, log: state.log };
}
