import { useState } from "react";
import type { Task } from "../domain/task";
import { api } from "./api";

interface StepLogEntry {
  stepId: string;
  type: string;
  output?: string;
  error?: string;
}

/** Context keys the pipeline writes for its own bookkeeping, not for reading. */
const INTERNAL_KEYS = new Set(["pipelineLog", "completedAt", "completionNote", "error"]);

export function TaskDetail({
  task,
  onChanged,
  onClose,
}: {
  task: Task;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const log = (task.context.pipelineLog as StepLogEntry[] | undefined) ?? [];
  const outputs = Object.entries(task.context).filter(([key]) => !INTERNAL_KEYS.has(key));

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog">
      <h2>{task.title}</h2>
      <p className="meta">
        {task.state.replace(/_/g, " ")}
        {task.assignee ? ` · ${task.assignee}` : ""} · {task.sourceId}
        {task.url ? (
          <>
            {" · "}
            <a href={task.url} target="_blank" rel="noreferrer">
              open source item
            </a>
          </>
        ) : null}
      </p>

      {task.body && <pre className="body">{task.body}</pre>}

      {typeof task.context.error === "string" && (
        <p className="error">Pipeline failed: {task.context.error}</p>
      )}

      {outputs.length > 0 && (
        <>
          <h3>What the pipeline produced</h3>
          {outputs.map(([key, value]) => (
            <div key={key} className="output">
              <strong>{key}</strong>
              <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
            </div>
          ))}
        </>
      )}

      {log.length > 0 && (
        <>
          <h3>Steps</h3>
          <ol className="steps">
            {log.map((entry, index) => (
              <li key={`${entry.stepId}-${index}`}>
                {entry.stepId} ({entry.type})
                {entry.output ? ` → ${entry.output}` : ""}
                {entry.error ? ` — ${entry.error}` : ""}
              </li>
            ))}
          </ol>
        </>
      )}

      {task.state === "done" ? (
        <>
          {typeof task.context.completionNote === "string" && (
            <p className="meta">Note: {task.context.completionNote}</p>
          )}
          <button disabled={busy} onClick={() => void act(() => api.reopenTask(task.id))}>
            Reopen
          </button>
        </>
      ) : (
        <>
          <label>
            Closing note (optional)
            <input
              value={note}
              placeholder="What you did, or why this is finished"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button disabled={busy} onClick={() => void act(() => api.completeTask(task.id, note))}>
            {busy ? "Saving…" : "Mark done"}
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}

      <button className="secondary" disabled={busy} onClick={onClose}>
        Close
      </button>
    </div>
  );
}
