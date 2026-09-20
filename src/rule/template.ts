import type { RuleDefinition, RuleStep } from "../domain/rule";

export interface TemplateScope {
  task: Record<string, unknown>;
  context: Record<string, unknown>;
}

function lookup(scope: TemplateScope, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = scope as unknown;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function renderTemplate(input: string, scope: TemplateScope): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookup(scope, path);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export function renderInput(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === "string") return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((item) => renderInput(item, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderInput(v, scope)]),
    );
  }
  return value;
}

const TASK_URL_PLACEHOLDER = /\{\{\s*task\.url\s*\}\}/;

function stepUsesTaskUrl(step: RuleStep): boolean {
  switch (step.type) {
    case "ai":
    case "agent":
      return TASK_URL_PLACEHOLDER.test(step.prompt);
    case "mcp_tool":
      return TASK_URL_PLACEHOLDER.test(JSON.stringify(step.input));
    case "assign":
      return (
        (step.note !== undefined && TASK_URL_PLACEHOLDER.test(step.note)) ||
        (step.open ?? []).some((target) => {
          if (target.kind === "url") return TASK_URL_PLACEHOLDER.test(target.url);
          if (target.kind === "draft") return TASK_URL_PLACEHOLDER.test(target.content);
          if (target.kind === "command") return TASK_URL_PLACEHOLDER.test(target.command);
          return false;
        })
      );
    case "branch":
    case "call_rule":
      return false;
  }
}

/**
 * Whether any step in the definition templates in the task's URL. Used to refuse
 * running a rule against a task with no URL, rather than silently rendering the
 * placeholder as an empty string.
 */
export function ruleUsesTaskUrl(definition: RuleDefinition): boolean {
  function walk(steps: RuleStep[]): boolean {
    return steps.some((step) => {
      if (step.type === "branch") {
        return walk(step.default ?? []) || Object.values(step.cases).some(walk);
      }
      return stepUsesTaskUrl(step);
    });
  }
  return walk(definition.steps);
}
