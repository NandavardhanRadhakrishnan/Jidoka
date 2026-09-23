import { useState } from "react";
import { api, type HandoffTarget } from "./api";

/**
 * The pick-up view: everything the human needs open, in one click. URLs open in
 * tabs, drafts are shown to copy, and commands can be launched in a terminal when
 * the server has one configured — otherwise they are copyable text.
 */
export function Handoff({
  taskId,
  targets,
  canLaunchTerminal,
}: {
  taskId: string;
  targets: HandoffTarget[];
  canLaunchTerminal: boolean;
}) {
  const [status, setStatus] = useState<string | null>(null);

  if (!targets.length) return null;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`${what} copied`);
    } catch {
      setStatus("could not copy — select the text instead");
    }
  }

  async function launch(label: string) {
    setStatus("opening a terminal…");
    try {
      await api.runCommand(taskId, label);
      setStatus("terminal opened");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {targets.map((target, index) => (
        <div key={`${target.label}-${index}`} className="handoff-target">
          <span className="kind">{target.kind}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{target.label}</span>

          {target.kind === "url" && (
            <a href={target.url} target="_blank" rel="noreferrer">
              open
            </a>
          )}

          {target.kind === "draft" && (
            <button className="btn btn-ghost" style={{ padding: 0, fontSize: 11 }} onClick={() => void copy(target.content, target.label)}>
              copy
            </button>
          )}

          {target.kind === "command" && (
            <span style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" style={{ padding: 0, fontSize: 11 }} onClick={() => void copy(target.command, "command")}>
                copy
              </button>
              {canLaunchTerminal && (
                <button className="btn btn-ghost" style={{ padding: 0, fontSize: 11 }} onClick={() => void launch(target.label)}>
                  open in terminal
                </button>
              )}
            </span>
          )}
        </div>
      ))}
      {status && (
        <p className="mono" style={{ fontSize: 11, color: "var(--color-neutral-700)", margin: 0 }}>
          {status}
        </p>
      )}
    </div>
  );
}

/** Opens every url target in its own tab; the browser may ask to allow popups. */
export function openUrlTargets(targets: HandoffTarget[]): void {
  for (const target of targets) {
    if (target.kind === "url") window.open(target.url, "_blank", "noreferrer");
  }
}
