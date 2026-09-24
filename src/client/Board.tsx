import { useState } from "react";
import type { Task } from "../domain/task";
import type { TypeWithRules } from "./api";
import { LANES, filterByDateRange, groupByLane, STATE_LABEL, taskAge, daysUntil, deadlineUrgency } from "./columns";
import { Icon, sourceIcon } from "./icons";

function laneTone(lane: "needs" | "running" | "settled", failed: boolean): string {
  if (lane === "needs") return failed ? "var(--color-accent-800)" : "var(--color-accent)";
  if (lane === "running") return "var(--color-neutral-800)";
  return "var(--color-neutral-500)";
}

function TaskCard({
  task,
  types,
  allTasks,
  onOpen,
  onOpenTask,
  onOnboard,
  onConfirmType,
  onResolveDuplicate,
}: {
  task: Task;
  types: TypeWithRules[];
  allTasks: Task[];
  onOpen: () => void;
  onOpenTask: (task: Task) => void;
  onOnboard: () => void;
  onConfirmType: (typeId: string) => Promise<void>;
  onResolveDuplicate: (isDuplicate: boolean) => Promise<void>;
}) {
  const [triaging, setTriaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const tone = laneTone(
    task.state === "needs_type_confirmation" ||
      task.state === "needs_onboarding" ||
      task.state === "needs_dedup_confirmation" ||
      task.state === "assigned_human"
      ? "needs"
      : task.state === "done" || task.state === "failed"
        ? "settled"
        : "running",
    task.state === "failed",
  );
  const type = task.typeId ? types.find((t) => t.id === task.typeId) : undefined;
  const typeName = type?.name ?? (task.state === "ingested" ? "triage running…" : "unclassified");
  const candidateIds = task.typeCandidates?.length ? task.typeCandidates : types.map((t) => t.id);
  const candidates = types.filter((t) => candidateIds.includes(t.id));
  const excerptLine = task.body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0];
  const dedupCandidate = task.dedupCandidateId ? allTasks.find((t) => t.id === task.dedupCandidateId) : undefined;
  const dedupRationale = typeof task.context.dedupRationale === "string" ? task.context.dedupRationale : null;

  return (
    <article className="task-card">
      <div className="gutter" style={{ background: tone }} />
      <div className="body">
        <div className="top-row">
          <span className="mono state-label" style={{ color: tone }}>
            {STATE_LABEL[task.state]}
          </span>
          <span className="mono age" style={{ color: "var(--color-neutral-600)" }}>
            {taskAge(task.createdAt)}
          </span>
        </div>
        <button className="title-btn" onClick={onOpen}>
          {task.title}
        </button>
        <div className="meta-row">
          <Icon name={sourceIcon(task.sourceId)} size={13} />
          <span className="mono" style={{ marginRight: 4 }}>
            {task.sourceId}
          </span>
          <span>{typeName}</span>
          {task.deadline && (
            <span className={`deadline-badge ${deadlineUrgency(daysUntil(task.deadline)).cls}`} style={{ marginLeft: "auto" }}>
              <Icon name="calendar" size={10} />
              {deadlineUrgency(daysUntil(task.deadline)).label}
            </span>
          )}
        </div>

        {task.state === "needs_type_confirmation" && !triaging && (
          <button className="btn btn-primary" style={{ alignSelf: "flex-start", padding: "5px 10px", fontSize: 12 }} onClick={() => setTriaging(true)}>
            Which type?
          </button>
        )}

        {triaging && (
          <div className="triage">
            <div className="triage-why">AI could not decide between two types — pick the one that fits.</div>
            {excerptLine && <div className="triage-excerpt">{excerptLine.slice(0, 190)}…</div>}
            {candidates.map((c) => (
              <button
                key={c.id}
                className="candidate-btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onConfirmType(c.id);
                  } finally {
                    setBusy(false);
                    setTriaging(false);
                  }
                }}
              >
                <span className="row">
                  <span className="name">{c.name}</span>
                </span>
                <span className="desc">{c.description}</span>
              </button>
            ))}
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: 0 }} onClick={onOpen}>
                Read the whole task
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: 0, color: "var(--color-neutral-700)" }}
                onClick={() => setTriaging(false)}
              >
                Later
              </button>
            </div>
          </div>
        )}

        {task.state === "needs_dedup_confirmation" && dedupCandidate && (
          <div className="triage">
            <div className="triage-why">
              This looks like it might be the same as "{dedupCandidate.title}"
              {dedupRationale ? ` — ${dedupRationale}` : ""}.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onResolveDuplicate(true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Yes, same task
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onResolveDuplicate(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                No, keep separate
              </button>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: 0 }}
                onClick={() => onOpenTask(dedupCandidate)}
              >
                View original task →
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: 0 }} onClick={onOpen}>
                Read the whole task
              </button>
            </div>
          </div>
        )}

        {task.state === "needs_dedup_confirmation" && !dedupCandidate && (
          <div className="triage">
            <div className="triage-why">The task this was matched against no longer exists.</div>
            <button
              className="btn btn-secondary"
              style={{ alignSelf: "flex-start" }}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onResolveDuplicate(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Keep it
            </button>
          </div>
        )}

        {task.state === "needs_onboarding" && (
          <button className="btn btn-primary" style={{ alignSelf: "flex-start", padding: "5px 10px", fontSize: 12 }} onClick={onOnboard}>
            Onboard this type
          </button>
        )}

        {task.state === "assigned_human" && (
          <button className="btn btn-secondary" style={{ alignSelf: "flex-start", padding: "5px 10px", fontSize: 12 }} onClick={onOpen}>
            Pick up
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * A native date input fronted by a themed display: the real `<input type="date">`
 * sits invisibly over the whole pill so browser date semantics (keyboard, OS
 * picker, validation) keep working, while what's actually seen is our own
 * calendar icon + formatted date in the app's mono/uppercase style.
 */
function DateInput({
  value,
  onChange,
  min,
  max,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  ariaLabel: string;
}) {
  const display = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()
    : "— —";
  return (
    <span className="date-trigger">
      <Icon name="calendar" size={12} />
      <span className="mono">{display}</span>
      <input
        type="date"
        className="date-input-overlay"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
      />
    </span>
  );
}

/** Date-range control for the Settled lane — rendered in the app header, above the board. */
export function SettledDateFilter({
  from,
  to,
  onFromChange,
  onToChange,
  onClear,
}: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <span className="date-range-filter">
      <span className="mono" style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
        settled
      </span>
      <DateInput value={from} onChange={onFromChange} max={to || undefined} ariaLabel="Settled from date" />
      <span>–</span>
      <DateInput value={to} onChange={onToChange} min={from || undefined} ariaLabel="Settled to date" />
      {(from || to) && (
        <button className="btn btn-ghost" style={{ fontSize: 11, padding: 0 }} onClick={onClear}>
          Clear
        </button>
      )}
    </span>
  );
}

export function Board({
  tasks,
  types,
  onSelect,
  onOnboard,
  onConfirmType,
  onResolveDuplicate,
  settledFrom,
  settledTo,
}: {
  tasks: Task[];
  types: TypeWithRules[];
  onSelect: (task: Task) => void;
  onOnboard: (task: Task) => void;
  onConfirmType: (taskId: string, typeId: string) => Promise<void>;
  onResolveDuplicate: (taskId: string, isDuplicate: boolean) => Promise<void>;
  settledFrom: string;
  settledTo: string;
}) {
  const grouped = groupByLane(tasks);

  return (
    <div className="board-lanes">
      {LANES.map((lane) => {
        const laneTasks =
          lane.key === "settled" ? filterByDateRange(grouped[lane.key], settledFrom, settledTo) : grouped[lane.key];
        const tone = laneTone(lane.key, false);
        return (
          <section key={lane.key} className="board-lane">
            <div className="board-lane-head" style={{ borderBottomColor: tone }}>
              <span className="name" style={{ color: tone }}>
                {lane.label}
              </span>
              <span className="mono" style={{ fontSize: 12, color: tone }}>
                {laneTasks.length}
              </span>
              <span className="sub">{lane.sub}</span>
            </div>
            <div className="board-cards">
              {laneTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  types={types}
                  allTasks={tasks}
                  onOpen={() => onSelect(task)}
                  onOpenTask={onSelect}
                  onOnboard={() => onOnboard(task)}
                  onConfirmType={(typeId) => onConfirmType(task.id, typeId)}
                  onResolveDuplicate={(isDuplicate) => onResolveDuplicate(task.id, isDuplicate)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
