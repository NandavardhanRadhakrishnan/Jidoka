export function taskUrl(id: string): string {
  return `?${new URLSearchParams({ task: id }).toString()}`;
}

export function readTaskId(search: string): string | null {
  return new URLSearchParams(search).get("task");
}
