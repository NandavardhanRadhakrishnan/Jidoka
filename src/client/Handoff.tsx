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
    <>
      <h3>Handoff</h3>
      <div className="handoff">
        {targets.map((target, index) => (
          <div key={`${target.label}-${index}`} className="target">
            <strong>{target.label}</strong>

            {target.kind === "url" && (
              <a href={target.url} target="_blank" rel="noreferrer">
                {target.url}
              </a>
            )}

            {target.kind === "draft" && (
              <>
                <pre>{target.content}</pre>
                <button className="link" onClick={() => void copy(target.content, target.label)}>
                  copy
                </button>
              </>
            )}

            {target.kind === "command" && (
              <>
                <code>{target.command}</code>
                <span className="row">
                  <button className="link" onClick={() => void copy(target.command, "command")}>
                    copy
                  </button>
                  {canLaunchTerminal && (
                    <button className="link" onClick={() => void launch(target.label)}>
                      open in terminal
                    </button>
                  )}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      {status && <p className="meta">{status}</p>}
    </>
  );
}

/** Opens every url target in its own tab; the browser may ask to allow popups. */
export function openUrlTargets(targets: HandoffTarget[]): void {
  for (const target of targets) {
    if (target.kind === "url") window.open(target.url, "_blank", "noreferrer");
  }
}
