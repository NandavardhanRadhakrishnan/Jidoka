import type { AiProvider, ToolSpec } from "../ai/provider";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
  type PipelineStep,
} from "../domain/pipeline";
import type { TaskType } from "../domain/taskType";
import { TOOL_SEPARATOR } from "../mcp/names";

export const BUILDER_SYSTEM = `You turn a plain-language description of how to handle a kind of task into a pipeline definition.

The pipeline runs automatically for every task of its type. Reply with JSON only:
{ "steps": [ ... ] }

Step shapes:
- { "id": "s1", "type": "ai", "prompt": "<prompt, may use {{task.title}}, {{task.body}}, {{task.metadata.<key>}}, {{context.<key>}}>", "output": "<context key>" }
- { "id": "s1b", "type": "agent", "prompt": "<what to find out and what to produce>", "tools": ["<server>__<tool>", ...], "maxIterations": 6, "output": "<context key>" }
- { "id": "s2", "type": "mcp_tool", "server": "<server>", "tool": "<tool>", "input": { ... }, "output": "<context key>" }
- { "id": "s3", "type": "branch", "on": "<context key>", "cases": { "<value>": [ ...steps ] }, "default": [ ...steps ] }
- { "id": "s4", "type": "assign", "to": "ai" | "human", "note": "<optional note>", "open": [ ...handoff targets ] }

Handoff targets (only on an assign to "human") are what the person should have in
front of them when they pick the task up:
- { "kind": "url", "label": "The email", "url": "{{task.url}}" }
- { "kind": "draft", "label": "Suggested reply", "content": "{{context.reply}}" }
- { "kind": "session", "label": "Review conversation", "sessionId": "{{context.<agent step output>_session}}" }
- { "kind": "command", "label": "Check out the PR", "command": "gh pr checkout 123" }

Rules:
- Use an "ai" step for a single self-contained judgement (summarize, classify, draft) over what the task already contains.
- Use an "agent" step when gathering context needs an unknown number of lookups — "read the related mails", "find the matching order" — and list exactly the tools it may use.
- Use an "mcp_tool" step when the exact call is known in advance.
- When assigning to a human, add handoff targets so they do not have to go hunting: the source item's URL when the task has one, any draft the pipeline produced, and a session target for an agent step whose conversation is worth resuming (its id is at "<that step's output>_session").
- Step ids are unique within the pipeline.
- Every pipeline ends on an assign step in every branch — a task must never finish unassigned.
- Only use mcp_tool steps for tools listed as available; use the exact server and tool names given.
- When a step branches on an AI classification, make the ai step's prompt state the exact allowed output values, and use those values as the branch case keys.`;

export interface BuildInput {
  type: TaskType;
  description: string;
  tools: ToolSpec[];
}

function toolCatalog(tools: ToolSpec[]): string {
  if (!tools.length) return "(no MCP tools are configured — do not use mcp_tool steps)";
  return tools
    .map((t) => {
      const index = t.name.indexOf(TOOL_SEPARATOR);
      const server = t.name.slice(0, index);
      const tool = t.name.slice(index + TOOL_SEPARATOR.length);
      return `- ${t.name} (server: ${server}, tool: ${tool}) — ${t.description}\n  input schema: ${JSON.stringify(t.inputSchema)}`;
    })
    .join("\n");
}

function userMessage(input: BuildInput): string {
  return `Task type: ${input.type.name}
Type description: ${input.type.description}

How the user wants these tasks handled:
${input.description}

Available MCP tools:
${toolCatalog(input.tools)}`;
}

function collectSteps(steps: PipelineStep[]): PipelineStep[] {
  return steps.flatMap((step) =>
    step.type === "branch"
      ? [step, ...collectSteps([...Object.values(step.cases).flat(), ...(step.default ?? [])])]
      : [step],
  );
}

function validateReferences(definition: PipelineDefinition, tools: ToolSpec[]): string[] {
  const available = new Set(tools.map((t) => t.name));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const step of collectSteps(definition.steps)) {
    if (seen.has(step.id)) problems.push(`duplicate step id: ${step.id}`);
    seen.add(step.id);

    if (step.type === "mcp_tool") {
      const name = `${step.server}${TOOL_SEPARATOR}${step.tool}`;
      if (!available.has(name)) {
        problems.push(`unknown tool "${step.server}/${step.tool}" — it is not in the available tool list`);
      }
    }

    if (step.type === "agent") {
      for (const name of step.tools) {
        if (!available.has(name)) {
          problems.push(`unknown tool "${name}" — it is not in the available tool list`);
        }
      }
    }
  }

  const endsAssigned = (steps: PipelineStep[]): boolean => {
    const last = steps.at(-1);
    if (!last) return false;
    if (last.type === "assign") return true;
    if (last.type === "branch") {
      const branches = [...Object.values(last.cases), last.default ?? []];
      return branches.every((branch) => endsAssigned(branch));
    }
    return false;
  };
  if (!endsAssigned(definition.steps)) {
    problems.push("the pipeline must end on an assign step in every branch");
  }

  return problems;
}

export async function buildPipeline(
  provider: AiProvider,
  input: BuildInput,
): Promise<PipelineDefinition> {
  let feedback = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const content = attempt === 0 ? userMessage(input) : `${userMessage(input)}

Your previous attempt was rejected: ${feedback}
Fix it and reply with corrected JSON only.`;

    const result = await provider.complete({
      system: BUILDER_SYSTEM,
      messages: [{ role: "user", content }],
      maxTokens: 8000,
    });

    const parsed = PipelineDefinitionSchema.safeParse(extractJson(result.text));
    if (!parsed.success) {
      feedback = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      continue;
    }

    const problems = validateReferences(parsed.data, input.tools);
    if (problems.length) {
      feedback = problems.join("; ");
      continue;
    }

    return parsed.data;
  }

  throw new Error(`pipeline builder failed after a retry: ${feedback}`);
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error("builder returned no JSON");
  return JSON.parse(candidate.slice(start));
}
