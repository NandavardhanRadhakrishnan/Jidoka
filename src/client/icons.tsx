/** Inline icon paths, viewBox 0 0 24 24 — reproduced from the Modernist design import so no icon package is needed. */
export const ICONS: Record<string, string[]> = {
  mail: [
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
  ],
  github: [
    "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
    "M9 18c-4.51 2-5-2-7-2",
  ],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  board: ["M3 3h18v18H3z", "M9 3v18", "M15 3v18"],
  rules: ["M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M6 9v3a3 3 0 0 0 3 3h6"],
  plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"],
  settings: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M1 14h6", "M9 8h6", "M17 16h6"],
  panel: ["M3 3h18v18H3z", "M9 3v18"],
  plus: ["M5 12h14", "M12 5v14"],
  ai: [
    "M9.9 15.5A2 2 0 0 0 8.5 14.1l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6A2 2 0 0 0 9.9 8.5l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z",
  ],
  agent: [
    "M12 8V4H8",
    "M4 8h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
    "M2 14h2",
    "M20 14h2",
    "M15 13v2",
    "M9 13v2",
  ],
  tool: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  ],
  assign: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "m16 11 2 2 4-4"],
  branch: ["M16 3h5v5", "M8 3H3v5", "M12 22v-8.3a4 4 0 0 0-1.2-2.9L3 3", "m15 9 6-6"],
  server: ["M4 4h16v8H4z", "M4 16h16v4H4z", "M8 8h.01", "M8 18h.01"],
  calendar: ["M8 2v4", "M16 2v4", "M3 4h18v18H3z", "M3 10h18"],
};

const FALLBACK_ICON = ICONS.ai as string[];

export function Icon({ name, size = 17 }: { name: string; size?: number }) {
  const paths = ICONS[name] ?? FALLBACK_ICON;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export function sourceIcon(sourceId: string): string {
  const id = sourceId.toLowerCase();
  if (id.includes("github")) return "github";
  if (id.includes("sample")) return "folder";
  return "mail";
}

export function stepKindIcon(kind: string): string {
  switch (kind) {
    case "assign":
      return "assign";
    case "agent":
      return "agent";
    case "mcp_tool":
      return "tool";
    case "branch":
      return "branch";
    default:
      return "ai";
  }
}

export function toolPerm(annotations?: { readOnlyHint?: boolean }): { label: string; cls: string } {
  if (annotations?.readOnlyHint === true) return { label: "read", cls: "perm-read" };
  if (annotations?.readOnlyHint === false) return { label: "write", cls: "perm-write" };
  return { label: "—", cls: "perm-unknown" };
}

export function stepKindColors(kind: string): { bg: string; fg: string } {
  if (kind === "assign") return { bg: "var(--color-accent)", fg: "var(--color-bg)" };
  if (kind === "agent") return { bg: "var(--color-neutral-900)", fg: "var(--color-bg)" };
  if (kind === "mcp_tool") return { bg: "var(--color-neutral-300)", fg: "var(--color-neutral-900)" };
  return { bg: "var(--color-neutral-200)", fg: "var(--color-neutral-900)" };
}

