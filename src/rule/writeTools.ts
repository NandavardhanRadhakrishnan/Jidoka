import type { RuleDefinition, RuleStep } from "../domain/rule";
import type { ToolSpec } from "../ai/provider";
import { TOOL_SEPARATOR } from "../mcp/names";

/**
 * Pure computation, no runtime dependencies beyond domain/rule and ai/provider
 * types — safe to import from both the server (the real enforcement point,
 * see src/api/server.ts) and the client bundle (the activation-preview UI in
 * RuleEditor.tsx), so the two never drift apart.
 */

function collectToolNames(steps: RuleStep[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    if (step.type === "agent") {
      names.push(...step.tools);
    } else if (step.type === "mcp_tool") {
      names.push(`${step.server}${TOOL_SEPARATOR}${step.tool}`);
    } else if (step.type === "assign" && step.agentTask) {
      names.push(...step.agentTask.tools);
    } else if (step.type === "branch") {
      for (const caseSteps of Object.values(step.cases)) names.push(...collectToolNames(caseSteps));
      if (step.default) names.push(...collectToolNames(step.default));
    }
    // call_rule is deliberately not expanded — see the design doc: a called
    // rule's write tools are that rule's own concern, checked at its own
    // activation, not re-derived here.
  }
  return names;
}

/**
 * Every tool this rule's `agent`/`mcp_tool` steps and `assign`-to-ai
 * `agentTask`s reference that isn't known to be read-only — an explicit write
 * annotation, or no annotation at all (unknown is treated as write, not as
 * safe by default). Deduplicated and sorted.
 */
export function computeWriteTools(definition: RuleDefinition, tools: ToolSpec[]): string[] {
  const specByName = new Map(tools.map((t) => [t.name, t]));
  const referenced = new Set(collectToolNames(definition.steps));
  return [...referenced]
    .filter((name) => specByName.get(name)?.annotations?.readOnlyHint !== true)
    .sort();
}
