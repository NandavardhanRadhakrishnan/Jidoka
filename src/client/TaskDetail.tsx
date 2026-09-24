import { useState } from "react";
import type { Task } from "../domain/task";
import { api, type HandoffTarget } from "./api";
import { Handoff, openUrlTargets } from "./Handoff";
import { daysUntil, deadlineUrgency } from "./columns";
import { Icon } from "./icons";

interface StepLogEntry {
  stepId: string;
  type: string;
  output?: string;
  error?: string;
}

interface MergedFromRecord {
  taskId: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  mergedAt: string;
}

/** Context keys the rule writes for its own bookkeeping, not for reading. */
const INTERNAL_KEYS = new Set([
  "ruleLog",
  "completedAt",
  "completionNote",
  "error",
  "handoff",
  "pickedUpAt",
  "mergedFrom",
  "dedupRationale",
]);

export function TaskDetail({
  task,
  allTasks,
  onChanged,
  onClose,
  onMarkDuplicate,
}: {
  task: Task;
  allTasks: Task[];
  onChanged: () => Promise<void>;
  onClose: () => void;
  onMarkDuplicate: (ofTaskId: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<HandoffTarget[] | null>(
    (task.context.handoff as HandoffTarget[] | undefined) ?? null,
  );
  const [canLaunchTerminal, setCanLaunchTerminal] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);

  async function pickUp() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.pickUp(task.id);
      setHandoff(result.handoff);
      setCanLaunchTerminal(result.canLaunchTerminal);
      openUrlTargets(result.handoff);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const log = (task.context.ruleLog as StepLogEntry[] | undefined) ?? [];
  const outputs = Object.entries(task.context).filter(([key]) => !INTERNAL_KEYS.has(key));

  // A key only carries real model/tool output when an ai, agent, or mcp_tool
  // step's log entry named it — an assign step's `note:<id>` is pure
  // renderTemplate() substitution, never a model call, so it gets its own label.
  const producedBy = new Map(
    log.filter((entry) => entry.output && entry.type !== "assign").map((entry) => [entry.output as string, entry.type]),
  );
  function provenanceLabel(key: string): { text: string; kind: "note" | "produced" | "unknown" } {
    if (key.startsWith("note:")) return { text: "note", kind: "note" };
    const producer = producedBy.get(key);
    if (producer === "ai") return { text: "AI output", kind: "produced" };
    if (producer === "agent") return { text: "agent output", kind: "produced" };
    if (producer === "mcp_tool") return { text: "tool output", kind: "produced" };
    return { text: "context", kind: "unknown" };
  }

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

  const mergedFrom = Array.isArray(task.context.mergedFrom)
    ? (task.context.mergedFrom as MergedFromRecord[])
    : [];

  const [dedupOpen, setDedupOpen] = useState(false);
  const [dedupQuery, setDedupQuery] = useState("");
  const dedupMatches = dedupOpen
    ? allTasks
        .filter((t) => t.id !== task.id && t.title.toLowerCase().includes(dedupQuery.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  async function markAsDuplicate(ofTaskId: string) {
    await act(() => onMarkDuplicate(ofTaskId));
  }

  const tone =
    task.state === "done"
      ? "var(--color-neutral-500)"
      : task.state === "failed"
        ? "var(--color-accent-800)"
        : task.state === "assigned_human" ||
            task.state === "needs_type_confirmation" ||
            task.state === "needs_onboarding" ||
            task.state === "needs_dedup_confirmation"
          ? "var(--color-accent)"
          : "var(--color-neutral-800)";

  return (
    <div className="drawer-backdrop">
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div className="top">
            <span className="mono state" style={{ color: tone }}>
              {task.state.replace(/_/g, " ")}
            </span>
            <span className="mono id">{task.id}</span>
            <button className="btn btn-ghost" style={{ marginLeft: "auto", fontSize: 12, padding: 0, color: "var(--color-neutral-700)" }} onClick={onClose}>
              Close
            </button>
          </div>
          <h4 style={{ margin: 0, fontSize: 21, lineHeight: 1.2 }}>{task.title}</h4>
          <div className="meta">
            <span className="mono">{task.sourceId}</span>
            <span>·</span>
            <span>{task.assignee ? `assigned to ${task.assignee}` : "unassigned"}</span>
            {task.deadline && (
              <>
                <span>·</span>
                <span className={`deadline-badge ${deadlineUrgency(daysUntil(task.deadline)).cls}`}>
                  <Icon name="calendar" size={10} />
                  {deadlineUrgency(daysUntil(task.deadline)).label}
                </span>
              </>
            )}
            {task.url && (
              <>
                <span>·</span>
                <a href={task.url} target="_blank" rel="noreferrer">
                  open source item
                </a>
              </>
            )}
          </div>
        </div>

        <div className="drawer-body">
          {mergedFrom.length > 0 && (
            <section className="drawer-section">
              <h6 style={{ margin: 0 }}>Merged from</h6>
              {mergedFrom.map((m) => (
                <div key={m.taskId} className="artifact">
                  <div className="head">
                    <span className="mono key">{m.sourceId}</span>
                    <span className="provenance-badge provenance-unknown" style={{ marginLeft: "auto" }}>
                      duplicate
                    </span>
                  </div>
                  <div className="content">
                    {m.url ? (
                      <a href={m.url} target="_blank" rel="noreferrer">
                        {m.title}
                      </a>
                    ) : (
                      m.title
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}

          {outputs.length > 0 && (
            <section className="drawer-section">
              <h6 style={{ margin: 0 }}>What the rule produced</h6>
              {outputs.map(([key, value]) => {
                const provenance = provenanceLabel(key);
                return (
                  <div key={key} className="artifact">
                    <div className="head">
                      <span className="mono key">{key}</span>
                      <span className={`provenance-badge provenance-${provenance.kind}`}>{provenance.text}</span>
                    </div>
                    <div className="content">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</div>
                  </div>
                );
              })}
            </section>
          )}

          {typeof task.context.error === "string" && <p className="error-text">Rule failed: {task.context.error}</p>}

          {task.state === "assigned_human" && (
            <section className="human-panel">
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="label">Yours to do</span>
                <span style={{ fontSize: 12, color: "var(--color-neutral-800)" }}>prepared and waiting on you</span>
              </div>
              {handoff && <Handoff taskId={task.id} targets={handoff} canLaunchTerminal={canLaunchTerminal} />}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => void pickUp()}>
                  {task.context.pickedUpAt ? "Open everything again" : "Pick up"}
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => void act(() => api.completeTask(task.id, note))}>
                  Mark done
                </button>
              </div>
            </section>
          )}

          {task.body && (
            <section className="drawer-section">
              <h6 style={{ margin: 0 }}>Task content</h6>
              <div className="task-body">{task.body}</div>
            </section>
          )}

          {log.length > 0 && (
            <section className="drawer-section">
              <button className="trace-toggle" onClick={() => setTraceOpen((v) => !v)}>
                <span>Run trace</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--color-neutral-700)" }}>
                  {log.length} step(s)
                </span>
                <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-accent)" }}>
                  {traceOpen ? "hide" : "show"}
                </span>
              </button>
              {traceOpen && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {log.map((entry, index) => (
                    <div key={`${entry.stepId}-${index}`} className="trace-entry">
                      <span className="tone" style={{ background: entry.error ? "var(--color-accent)" : "var(--color-neutral-400)" }} />
                      <span className="mono id">{entry.stepId} · {entry.type}</span>
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                        {entry.output && (
                          <span className="mono" style={{ fontSize: 11, color: "var(--color-neutral-700)", lineHeight: 1.5 }}>
                            {entry.output}
                          </span>
                        )}
                        {entry.error && <span className="error-text">{entry.error}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="drawer-section">
            {!dedupOpen ? (
              <button
                className="btn btn-secondary"
                style={{ alignSelf: "flex-start" }}
                disabled={task.state === "processing"}
                title={task.state === "processing" ? "Can't merge away a task while its rule is running" : undefined}
                onClick={() => setDedupOpen(true)}
              >
                Mark as duplicate of…
              </button>
            ) : (
              <>
                <div className="field">
                  <label>Find the task this duplicates</label>
                  <input
                    className="input"
                    autoFocus
                    value={dedupQuery}
                    placeholder="Search by title…"
                    onChange={(e) => setDedupQuery(e.target.value)}
                  />
                </div>
                {dedupQuery.trim() && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {dedupMatches.length === 0 && <span className="text-muted">No matching tasks</span>}
                    {dedupMatches.map((match) => (
                      <button
                        key={match.id}
                        className="candidate-btn"
                        disabled={busy}
                        onClick={() => void markAsDuplicate(match.id)}
                      >
                        <span className="row">
                          <span className="name">{match.title}</span>
                        </span>
                        <span className="desc">
                          {match.sourceId} · {match.state.replace(/_/g, " ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11, padding: 0, alignSelf: "flex-start" }}
                  onClick={() => {
                    setDedupOpen(false);
                    setDedupQuery("");
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </section>

          {task.state === "done" ? (
            <section className="drawer-section">
              {typeof task.context.completionNote === "string" && (
                <p className="text-muted">Note: {task.context.completionNote}</p>
              )}
              <button className="btn btn-secondary" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void act(() => api.reopenTask(task.id))}>
                Reopen
              </button>
            </section>
          ) : task.state !== "assigned_human" ? (
            <section className="drawer-section">
              <div className="field">
                <label>Closing note (optional)</label>
                <input className="input" value={note} placeholder="What you did, or why this is finished" onChange={(e) => setNote(e.target.value)} />
              </div>
              <button className="btn btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void act(() => api.completeTask(task.id, note))}>
                {busy ? "Saving…" : "Mark done"}
              </button>
            </section>
          ) : null}

          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}
