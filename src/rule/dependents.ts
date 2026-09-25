import type { RuleDefinition, RuleStep } from "../domain/rule";

function flattenThroughBranches(steps: RuleStep[]): RuleStep[] {
  const out: RuleStep[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.type === "branch") {
      for (const caseSteps of Object.values(step.cases)) {
        out.push(...flattenThroughBranches(caseSteps));
      }
      if (step.default) out.push(...flattenThroughBranches(step.default));
    }
  }
  return out;
}

function stepOutput(step: RuleStep): string | null {
  if (
    step.type === "ai" ||
    step.type === "agent" ||
    step.type === "mcp_tool"
  ) {
    return step.output;
  }
  return null;
}

function templatableText(step: RuleStep): string {
  switch (step.type) {
    case "ai":
    case "agent":
      return step.prompt;
    case "mcp_tool":
      return JSON.stringify(step.input);
    case "branch":
      return step.on;
    default:
      return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function referencesDirtyKey(text: string, dirtyKey: string): boolean {
  const pattern = new RegExp(`\\{\\{\\s*context\\.${escapeRegExp(dirtyKey)}\\s*\\}\\}`);
  return pattern.test(text);
}

function stepReferencesDirty(step: RuleStep, dirty: Set<string>): boolean {
  if (step.type === "branch") {
    return dirty.has(step.on);
  }
  const text = templatableText(step);
  for (const key of dirty) {
    if (referencesDirtyKey(text, key)) return true;
  }
  return false;
}

export function findDependentSteps(
  definition: RuleDefinition,
  ranStepIds: Set<string>,
  changedStepId: string,
): { safe: string[]; unsafe: string[] } {
  const flat = flattenThroughBranches(definition.steps);
  const changed = flat.find((s) => s.id === changedStepId);
  if (!changed) return { safe: [], unsafe: [] };

  const changedOutput = stepOutput(changed);
  if (!changedOutput) return { safe: [], unsafe: [] };

  const candidates = flat.filter(
    (s) => s.id !== changedStepId && ranStepIds.has(s.id),
  );

  const dirty = new Set<string>([changedOutput]);
  const dependentIds: string[] = [];
  const seen = new Set<string>();

  let grew = true;
  while (grew) {
    grew = false;
    for (const step of candidates) {
      if (seen.has(step.id)) continue;
      if (!stepReferencesDirty(step, dirty)) continue;

      seen.add(step.id);
      dependentIds.push(step.id);
      const output = stepOutput(step);
      if (output && !dirty.has(output)) {
        dirty.add(output);
        grew = true;
      }
    }
  }

  const safe: string[] = [];
  const unsafe: string[] = [];
  const byId = new Map(flat.map((s) => [s.id, s]));

  for (const id of dependentIds) {
    const step = byId.get(id);
    if (!step) continue;
    if (step.type === "ai" || step.type === "agent") {
      safe.push(id);
    } else if (step.type === "mcp_tool") {
      unsafe.push(id);
    } else if (step.type === "branch") {
      unsafe.push(id);
    }
  }

  return { safe, unsafe };
}
