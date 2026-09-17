/** Tools are exposed to models as `<server>__<tool>`. */
export const TOOL_SEPARATOR = "__";

export function splitToolName(name: string): { server: string; tool: string } {
  const index = name.indexOf(TOOL_SEPARATOR);
  if (index === -1) throw new Error(`tool name is missing a server prefix: ${name}`);
  return {
    server: name.slice(0, index),
    tool: name.slice(index + TOOL_SEPARATOR.length),
  };
}
