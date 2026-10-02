import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Task } from "../domain/task";
import type { Hint } from "../domain/hint";
import { PRIORITIES, type Priority } from "../domain/priority";
import { api, type HandoffTarget } from "./api";
import { Handoff, openUrlTargets } from "./Handoff";
import { daysUntil, deadlineUrgency, priorityBadge, taskAge } from "./columns";
import { Icon } from "./icons";
import { SelectTrigger } from "./SelectTrigger";

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

interface ThreadPass {
  outputs: Record<string, unknown>;
  ruleLog: StepLogEntry[];
  assignee: Task["assignee"];
  completedAt?: string;
  completionNote?: string;
  closedAt: string;
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
  "thread",
  "revision",
  "isFollowUp",
  "urgency",
  "priorityOverride",
]);

function kindBadgeLabel(type: string): string {
  return type === "mcp_tool" ? "mcp tool" : type;
}

/** Which step (and its kind, for the badge) produced a given output key within one pass's own ruleLog. */
function producerFor(ruleLog: StepLogEntry[], key: string): string | null {
  const entry = ruleLog.find((e) => e.output === key && e.type !== "assign");
  return entry ? entry.type : null;
}

function OutputRow({ outputKey, value, kind }: { outputKey: string; value: unknown; kind: string | null }) {
  const [open, setOpen] = useState(false);
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);

  return (
    <div className={`out-row${open ? " open" : ""}`}>
      <button type="button" className="out-row-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="key mono">{outputKey}</span>
        <span className="gist">{body}</span>
        {kind && <span className="kind-badge">{kindBadgeLabel(kind)}</span>}
        <span className="chevron">▶</span>
      </button>
      {open && <div className="out-row-body">{body}</div>}
    </div>
  );
}

function PastPassRow({ passNumber, pass }: { passNumber: number; pass: ThreadPass }) {
  const [open, setOpen] = useState(false);
  const outputEntries = Object.entries(pass.outputs);
  const summary = pass.completionNote ?? (pass.assignee ? `assigned to ${pass.assignee}` : "closed");

  return (
    <div className={`thread-pass${open ? " open" : ""}`}>
      <button type="button" className="thread-pass-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="n">pass {passNumber}</span>
        <span className="summary">{summary}</span>
        <span className="count">
          {outputEntries.length} output{outputEntries.length === 1 ? "" : "s"}
        </span>
        <span className="closed-at">{taskAge(pass.closedAt)} ago</span>
        <span className="chevron">▶</span>
      </button>
      {open && (
        <div className="thread-pass-body">
          <div className="out-list">
            {outputEntries.map(([key, value]) => (
              <OutputRow key={key} outputKey={key} value={value} kind={producerFor(pass.ruleLog, key)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const smallGhostBtn = { fontSize: 11, padding: 0 } as const;

const hintBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: 0,
  background: "transparent",
  color: "var(--color-neutral-700)",
  cursor: "pointer",
  padding: "2px 4px",
  fontFamily: "var(--font-heading)",
  fontWeight: 800,
  fontSize: 11,
} as const;

function stepFromLabel(producer: { type: string; stepId: string } | undefined): string | null {
  if (!producer) return null;
  const typeLabel = producer.type === "mcp_tool" ? "tool" : producer.type;
  return `${typeLabel} step · ${producer.stepId}`;
}

function ArtifactHeadActions({
  copyable,
  copyText,
  hintButton,
  provenance,
}: {
  copyable: boolean;
  copyText: string;
  hintButton?: ReactNode;
  provenance: { text: string; kind: "note" | "produced" | "unknown" };
}) {
  async function copyOutput() {
    try {
      await navigator.clipboard.writeText(copyText);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <span className="artifact-head-actions">
      {copyable && (
        <button type="button" className="btn btn-ghost" style={smallGhostBtn} onClick={() => void copyOutput()}>
          Copy
        </button>
      )}
      {hintButton}
      <span className={`provenance-badge provenance-${provenance.kind}`}>{provenance.text}</span>
    </span>
  );
}

function StepOutput({
  taskId,
  taskState,
  stepId,
  outputKey,
  from,
  copyable,
  body,
  provenance,
  onChanged,
}: {
  taskId: string;
  taskState: Task["state"];
  stepId: string;
  outputKey: string;
  from: string | null;
  copyable: boolean;
  body: string;
  provenance: { text: string; kind: "note" | "produced" | "unknown" };
  onChanged: () => Promise<void>;
}) {
  const closed = taskState === "done";
  const [hints, setHints] = useState<Hint[]>([]);
  const [dependents, setDependents] = useState<{ safe: string[]; unsafe: string[] }>({
    safe: [],
    unsafe: [],
  });
  const [hintOpen, setHintOpen] = useState(false);
  const [hintText, setHintText] = useState("");
  const [hintExcerpt, setHintExcerpt] = useState<string | undefined>(undefined);
  const [popover, setPopover] = useState<{ x: number; y: number; text: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastRerun, setLastRerun] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hintAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.taskStepHints(taskId, stepId), api.dependents(taskId, stepId)]).then(
      ([loadedHints, deps]) => {
        if (!cancelled) {
          setHints(loadedHints);
          setDependents(deps);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, stepId]);

  useEffect(() => {
    const drawer = document.querySelector(".drawer");
    if (!drawer) return;
    const hide = () => setPopover(null);
    drawer.addEventListener("scroll", hide);
    return () => drawer.removeEventListener("scroll", hide);
  }, []);

  useEffect(() => {
    if (hintOpen) hintAreaRef.current?.focus();
  }, [hintOpen]);

  function openHintForm(excerpt?: string) {
    setHintText("");
    setHintExcerpt(excerpt);
    setHintOpen(true);
    setPopover(null);
    setActionError(null);
    if (excerpt) {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    }
  }

  function onContentMouseUp() {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!text || !sel?.rangeCount) {
        setPopover(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setPopover({ x: rect.left + rect.width / 2, y: rect.top, text });
    }, 0);
  }

  async function reloadHints() {
    setHints(await api.taskStepHints(taskId, stepId));
  }

  async function saveHint() {
    const text = hintText.trim();
    if (!text) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.addTaskHint(taskId, { stepId, text, excerpt: hintExcerpt });
      setHintOpen(false);
      setHintText("");
      setHintExcerpt(undefined);
      setLastRerun(null);
      await reloadHints();
      setExpanded(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteStepHint(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteHint(id);
      await reloadHints();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rerunPrimary() {
    setBusy(true);
    setActionError(null);
    try {
      await api.rerunStep(taskId, stepId);
      setLastRerun("re-ran just now");
      await onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rerunWithDependents() {
    setBusy(true);
    setActionError(null);
    try {
      await api.rerunStep(taskId, stepId);
      for (const dependentId of dependents.safe) {
        await api.rerunStep(taskId, dependentId);
      }
      setLastRerun(
        dependents.safe.length > 0 ? `re-ran with ${dependents.safe.length} downstream` : "re-ran just now",
      );
      await onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const hintCountLabel = `${hints.length} hint${hints.length === 1 ? "" : "s"} on this step`;

  return (
    <div className="artifact">
      <div className="head">
        <span className="mono key">{outputKey}</span>
        {from && <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>{from}</span>}
        <ArtifactHeadActions
          copyable={copyable}
          copyText={body}
          provenance={provenance}
          hintButton={
            <button
              type="button"
              title="Add a hint for this step, or select text in the output"
              style={hintBtnStyle}
              onClick={() => openHintForm()}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--color-accent)";
                e.currentTarget.style.background = "color-mix(in srgb, var(--color-accent) 10%, transparent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--color-neutral-700)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon name="message-square-plus" size={13} />
              Hint
            </button>
          }
        />
      </div>
      <div className="content" onMouseUp={onContentMouseUp}>
        {body}
      </div>
      {popover && !hintOpen && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openHintForm(popover.text)}
          style={{
            position: "fixed",
            left: popover.x,
            top: popover.y - 38,
            transform: "translateX(-50%)",
            zIndex: 60,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "6px 10px",
            border: 0,
            background: "var(--color-neutral-900)",
            color: "var(--color-bg)",
            fontFamily: "var(--font-heading)",
            fontWeight: 800,
            fontSize: 12,
            cursor: "pointer",
            boxShadow: "var(--shadow-md)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--color-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--color-neutral-900)";
          }}
        >
          <Icon name="message-square-plus" size={13} />
          Add hint
        </button>
      )}
      {hintOpen && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid var(--color-divider)",
            background: "var(--color-bg)",
          }}
        >
          {hintExcerpt && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--color-neutral-800)",
                padding: "6px 9px",
                background: "var(--color-surface)",
                border: "1px solid var(--color-divider)",
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "var(--color-neutral-600)",
                }}
              >
                About this passage
              </span>
              <span>“{hintExcerpt}”</span>
            </div>
          )}
          <textarea
            ref={hintAreaRef}
            className="input"
            rows={3}
            value={hintText}
            onChange={(e) => setHintText(e.target.value)}
            placeholder="What should this step do differently next time?"
            style={{ minHeight: 72, fontSize: 13 }}
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: "5px 10px", fontSize: 12 }}
              disabled={busy || !hintText.trim()}
              onClick={() => void saveHint()}
            >
              Save hint
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={smallGhostBtn}
              disabled={busy}
              onClick={() => {
                setHintOpen(false);
                setHintExcerpt(undefined);
              }}
            >
              Cancel
            </button>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-neutral-600)" }}>
              Added to every future run of <span className="mono">{outputKey}</span>
            </span>
          </div>
          {actionError && <p className="error-text" style={{ margin: 0 }}>{actionError}</p>}
        </div>
      )}
      {hints.length > 0 && (
        <div style={{ borderTop: "1px solid var(--color-divider)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "7px 12px",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="mono"
              onClick={() => setExpanded((v) => !v)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                border: 0,
                background: "transparent",
                padding: 0,
                cursor: "pointer",
                fontSize: 11,
                color: "var(--color-neutral-800)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--color-accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--color-neutral-800)";
              }}
            >
              <Icon name="message-square-plus" size={12} />
              {hintCountLabel}
              <Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} />
            </button>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              {!busy && lastRerun && (
                <span className="mono" style={{ fontSize: 10.5, color: "var(--color-accent-700)" }}>
                  {lastRerun}
                </span>
              )}
              {!closed ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ ...smallGhostBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
                    disabled={busy}
                    onClick={() => void rerunPrimary()}
                  >
                    <Icon name="rotate-ccw" size={12} />
                    {busy ? "Re-running…" : "Re-run with hints"}
                  </button>
                  {dependents.safe.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={smallGhostBtn}
                      disabled={busy}
                      title="Also rerun the steps that read this output"
                      onClick={() => void rerunWithDependents()}
                    >
                      + {dependents.safe.length} downstream
                    </button>
                  )}
                </>
              ) : (
                <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>Applies to future runs</span>
              )}
            </span>
          </div>
          {expanded && (
            <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column" }}>
              {hints.map((hint) => (
                <div
                  key={hint.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                    padding: "7px 0",
                    borderTop: "1px solid var(--color-divider)",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    {hint.excerpt && (
                      <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>on “{hint.excerpt}”</span>
                    )}
                    <span style={{ textWrap: "pretty" } as CSSProperties}>{hint.text}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={smallGhostBtn}
                    disabled={busy}
                    onClick={() => void deleteStepHint(hint.id)}
                  >
                    Delete
                  </button>
                </div>
              ))}
              {!closed && dependents.unsafe.length > 0 && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--color-neutral-700)",
                    paddingTop: 7,
                    borderTop: "1px solid var(--color-divider)",
                  }}
                >
                  Also feeds {dependents.unsafe.length} tool or branch step
                  {dependents.unsafe.length === 1 ? "" : "s"}, which won&apos;t rerun automatically.
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {!hintOpen && actionError && (
        <p className="error-text" style={{ margin: 0, padding: hints.length > 0 ? "0 12px 8px" : "0 12px 8px" }}>
          {actionError}
        </p>
      )}
    </div>
  );
}

/**
 * The drawer's priority control: "auto" follows the type default (raised by
 * triage's urgency signal), any explicit level pins it by hand until set back
 * to auto. The urgency reason, when triage raised it, rides along as a title.
 */
function PriorityControl({ task, onChanged }: { task: Task; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const pinned = task.context.priorityOverride === true;
  const urgency = task.context.urgency as { level: Priority; reason: string } | undefined;
  const badge = priorityBadge(task.priority);

  async function change(value: string) {
    setBusy(true);
    try {
      await api.setPriority(task.id, value as Priority | "auto");
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SelectTrigger
      label="priority"
      display={
        <>
          {badge ? (
            <span className={`priority-badge ${badge.cls}`}>{badge.label}</span>
          ) : (
            <span className="mono">NORMAL</span>
          )}
          {!pinned && <span className="mono select-trigger-hint">AUTO</span>}
        </>
      }
      value={pinned ? task.priority : "auto"}
      onChange={(value) => void change(value)}
      ariaLabel="Priority"
      title={urgency && !pinned ? `Raised by triage: ${urgency.reason}` : undefined}
      disabled={busy}
    >
      <option value="auto">Auto: type default, raised by triage ({task.priority})</option>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {p[0]!.toUpperCase() + p.slice(1)}
        </option>
      ))}
    </SelectTrigger>
  );
}

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
  const thread = Array.isArray(task.context.thread) ? (task.context.thread as ThreadPass[]) : [];
  const currentPassNumber = thread.length + 1;

  // A key only carries real model/tool output when an ai, agent, or mcp_tool
  // step's log entry named it — an assign step's `note:<id>` is pure
  // renderTemplate() substitution, never a model call, so it gets its own label.
  const producedBy = new Map(
    log
      .filter((entry) => entry.output && entry.type !== "assign")
      .map((entry) => [entry.output as string, { type: entry.type, stepId: entry.stepId }]),
  );
  function provenanceLabel(key: string): { text: string; kind: "note" | "produced" | "unknown" } {
    if (key.startsWith("note:")) return { text: "note", kind: "note" };
    const producer = producedBy.get(key);
    if (producer) return { text: kindBadgeLabel(producer.type), kind: "produced" };
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
            <span>·</span>
            <PriorityControl task={task} onChanged={onChanged} />
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

          {task.body && (
            <section className="drawer-section">
              <h6 style={{ margin: 0 }}>Task content</h6>
              <div className="task-body">{task.body}</div>
            </section>
          )}

          {(outputs.length > 0 || thread.length > 0) && (
            <section className="drawer-section">
              <h6 style={{ margin: 0 }}>Thread</h6>
              <div className="thread-list">
                <div className="thread-pass current open">
                  <div className="thread-pass-toggle">
                    <span className="n">pass {currentPassNumber}</span>
                    <span className="summary">current</span>
                    <span className="count">
                      {outputs.length} output{outputs.length === 1 ? "" : "s"}
                    </span>
                    <span className="closed-at">today</span>
                  </div>
                  <div className="thread-pass-body">
                    {outputs.map(([key, value]) => {
                      const provenance = provenanceLabel(key);
                      const producer = producedBy.get(key);
                      const from = stepFromLabel(producer);
                      const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
                      const copyable = typeof value === "string" && value.length > 0;
                      if (producer && (producer.type === "ai" || producer.type === "agent")) {
                        return (
                          <StepOutput
                            key={key}
                            taskId={task.id}
                            taskState={task.state}
                            stepId={producer.stepId}
                            outputKey={key}
                            from={from}
                            copyable={copyable}
                            body={body}
                            provenance={provenance}
                            onChanged={onChanged}
                          />
                        );
                      }
                      return (
                        <div key={key} className="artifact">
                          <div className="head">
                            <span className="mono key">{key}</span>
                            {from && <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>{from}</span>}
                            <ArtifactHeadActions copyable={copyable} copyText={body} provenance={provenance} />
                          </div>
                          <div className="content">{body}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {thread
                  .map((pass, i) => ({ pass, passNumber: i + 1 }))
                  .reverse()
                  .map(({ pass, passNumber }) => (
                    <PastPassRow key={passNumber} passNumber={passNumber} pass={pass} />
                  ))}
              </div>
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

          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}
