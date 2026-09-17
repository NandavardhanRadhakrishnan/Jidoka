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
