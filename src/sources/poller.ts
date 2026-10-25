import type { Database } from "bun:sqlite";
import type { Task, TaskState } from "../domain/task";
import { findTaskBySource, getTask, insertTask, updateTask } from "../repo/tasks";
import { wasMerged } from "../repo/mergedSourceItems";
import { getCursor, setCursor } from "../repo/sourceState";
import { fileFailure, fileIngested, getItemRow, rowsForTask, taskForThread, touchSeen } from "../repo/sourceItems";
import {
  finishPoll,
  getHorizon,
  nextWindow,
  setHorizon,
  startPoll,
  type PollKind,
  type PollRecord,
} from "../repo/sourcePolls";
import { checkItem, checkList, MAX_KEY } from "./checks";
import { composeTask } from "./compose";
import type { LegacyRawItem, LegacyTaskSource, ListResult, SourceItem, TaskSource } from "./types";
import { isParticipantRole, normalizeIdentity, type SourceParticipant } from "../domain/roster";
import { upsertSourceParticipants } from "../repo/participants";

export type OnTask = (task: Task) => Promise<void>;
/** Called when a source reports a revision change on a task that already
 *  passed through a rule at least once (done, or currently assigned). */
export type OnTaskChanged = (task: Task, item: LegacyRawItem) => Promise<void>;

/** States a revision change is allowed to reopen. Excludes `processing` (a
 *  rule is actively running) and every pre-triage state (no rule has run yet,
 *  so there's nothing to follow up on). `dismissed` is included so a thread
 *  that was side-chatter can become relevant later (it gets re-triaged). */
const REOPENABLE_STATES = new Set<TaskState>(["done", "assigned_ai", "assigned_human", "dismissed"]);

/** The valid participants of a raw item. Sources are third-party code, so
 *  anything malformed (no namespace, unknown role) is dropped and counted —
 *  bad participant data must never fail a poll. */
export function sanitizeParticipants(raw: unknown): { valid: SourceParticipant[]; dropped: number } {
  if (!Array.isArray(raw)) return { valid: [], dropped: 0 };
  const valid: SourceParticipant[] = [];
  let dropped = 0;
  for (const entry of raw as Partial<SourceParticipant>[]) {
    const identity = typeof entry?.identity === "string" ? normalizeIdentity(entry.identity) : null;
    if (!identity || !isParticipantRole(entry.role)) {
      dropped++;
      continue;
    }
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
    valid.push({ identity, role: entry.role, ...(name ? { name } : {}) });
  }
  return { valid, dropped };
}

export async function pollOnce(
  db: Database,
  source: LegacyTaskSource,
  onTask: OnTask,
  onTaskChanged?: OnTaskChanged,
): Promise<Task[]> {
  const cursor = getCursor(db, source.id);
  const result = await source.poll(cursor);

  const created: Task[] = [];
  const reopened: { task: Task; item: LegacyRawItem }[] = [];
  let droppedParticipants = 0;
  for (const item of result.items) {
    const { valid: participants, dropped } = sanitizeParticipants(item.participants);
    droppedParticipants += dropped;

    const existing = findTaskBySource(db, source.id, item.externalId);
    if (existing) {
      // Every sighting, regardless of state or revision: the upsert is
      // idempotent, and a new commenter is worth recording even when the
      // relevance check later declines to reopen the task.
      if (participants.length) upsertSourceParticipants(db, existing.id, participants);
      if (
        item.revision &&
        item.revision !== (existing.context.revision as string | undefined) &&
        REOPENABLE_STATES.has(existing.state)
      ) {
        reopened.push({ task: existing, item });
      }
      continue;
    }
    if (wasMerged(db, source.id, item.externalId)) continue;
    created.push(
      db.transaction(() => {
        const task = insertTask(db, {
          sourceId: source.id,
          externalId: item.externalId,
          url: item.url ?? null,
          title: item.title,
          body: item.body,
          metadata: item.metadata ?? {},
          revision: item.revision,
        });
        upsertSourceParticipants(db, task.id, participants);
        return task;
      })(),
    );
  }
  if (droppedParticipants) {
    console.warn(`[poller] ${source.id}: dropped ${droppedParticipants} malformed participant(s)`);
  }

  setCursor(db, source.id, result.cursor);

  for (const task of created) await onTask(task);
  for (const { task, item } of reopened) await onTaskChanged?.(task, item);
  return created;
}

/** Polls every source once per interval through `pollSource`, one source at a
 *  time. A tick never overlaps the previous one. */
export function startPoller(
  db: Database,
  sources: TaskSource[],
  hooks: PollHooks,
  intervalMs: number,
  loadDynamicSources?: () => Promise<TaskSource[]>,
): { stop(): void } {
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn("[poller] previous tick still running — skipping");
      return;
    }
    running = true;

    try {
      let dynamicSources: TaskSource[] = [];
      if (loadDynamicSources) {
        try {
          dynamicSources = await loadDynamicSources();
        } catch (error) {
          console.error("[poller] loadDynamicSources failed:", error);
        }
      }

      const staticIds = new Set(sources.map((source) => source.id));
      const uniqueDynamicSources = dynamicSources.filter((source) => {
        if (staticIds.has(source.id)) {
          console.error(
            `[poller] ignoring dynamic source "${source.id}": id collides with a static source`,
          );
          return false;
        }
        return true;
      });

      for (const source of [...sources, ...uniqueDynamicSources]) {
        try {
          await pollSource(db, source, hooks);
        } catch (error) {
          console.error(`[poller] ${source.id} failed:`, error);
        }
      }
    } finally {
      running = false;
    }
  };

  // tick() can still reject (e.g. if a caller-supplied loadDynamicSources
  // resolves to something other than an array — TypeScript prevents this,
  // but loadDynamicSources is a public parameter so we don't rely on that).
  // `running` is always reset via the `finally` above regardless, but
  // firing tick() with a bare `void` would otherwise leave that rejection
  // unhandled and able to crash the process; log it instead.
  const safeTick = () => {
    void tick().catch((error) => {
      console.error("[poller] tick failed unexpectedly:", error);
    });
  };

  safeTick();
  const timer = setInterval(safeTick, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

// ── Jidoka-owned polling: the list({ since }) contract ───────────────────────
// Jidoka picks each window, files every item by key in its own transaction and
// routes items into tasks by thread key. Re-listing is always safe: a key that
// is already filed with the same version is only touched.

export interface PollHooks {
  /** A task created by this run. Called after every item of the run is filed. */
  onCreated(task: Task): Promise<void>;
  /** An existing task that gained or changed items in this run, with those items. */
  onChanged(task: Task, newItems: SourceItem[]): Promise<void>;
}

export interface PollOutcome {
  poll: PollRecord;
  /** Keys filed by this run that had no row before (Rescan's "recovered N"). */
  recovered: number;
}

export interface PollOptions {
  now?: Date;
  timeoutMs?: number;
}

const LIST_TIMEOUT_MS = 60_000;

type Failure = { key?: string; error: string };

type Filed =
  | { kind: "seen" }
  | { kind: "thread_mismatch"; error: string }
  | {
      kind: "new" | "changed";
      taskId: string;
      createdTask: boolean;
      /** The key had no row at all before this item. */
      unseen: boolean;
      item: SourceItem;
      dropped: number;
    };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function timeoutMessage(ms: number): string {
  return `list timed out after ${ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`}`;
}

async function listWithTimeout(source: TaskSource, since: string | null, ms: number): Promise<ListResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage(ms))), ms);
  });
  try {
    // Through a .then so a list() that throws synchronously still lands here.
    return await Promise.race([Promise.resolve().then(() => source.list({ since })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The extension's result is untrusted: anything without an items array is an
 *  error poll, and malformed failure entries are kept, just without their key. */
function readResult(raw: unknown): { items: unknown[]; failures: Failure[] } {
  const result = raw as Partial<ListResult> | null;
  if (typeof result !== "object" || result === null || !Array.isArray(result.items)) {
    throw new Error("list did not return { items: [...] }");
  }
  const failures = (Array.isArray(result.failures) ? result.failures : []).map((entry: unknown): Failure => {
    const f = (typeof entry === "object" && entry !== null ? entry : {}) as { key?: unknown; error?: unknown };
    const error = typeof f.error === "string" && f.error.trim() ? f.error : "failure reported without a message";
    const key = typeof f.key === "string" && f.key !== "" && f.key.length <= MAX_KEY ? f.key : undefined;
    return key ? { key, error } : { error };
  });
  return { items: result.items, failures };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The fields of a checked item Jidoka stores, in their stored shape (an empty
 *  thread key is no thread key). Participants are sanitized separately. */
function normalize(raw: SourceItem): SourceItem {
  const item: SourceItem = {
    key: raw.key,
    occurredAt: raw.occurredAt,
    title: raw.title,
    body: typeof raw.body === "string" ? raw.body : "",
  };
  if (typeof raw.threadKey === "string" && raw.threadKey !== "") item.threadKey = raw.threadKey;
  if (raw.version !== undefined && raw.version !== null) item.version = String(raw.version);
  if (typeof raw.url === "string" && raw.url !== "") item.url = raw.url;
  if (isPlainObject(raw.metadata)) item.metadata = raw.metadata;
  return item;
}

/** The task a new item's thread already lives on: through the item record
 *  first, then a task created before the item record existed. */
function taskForNewItem(db: Database, sourceId: string, threadKey: string): string | null {
  const viaRows = taskForThread(db, sourceId, threadKey);
  if (viaRows && getTask(db, viaRows)) return viaRows;
  return findTaskBySource(db, sourceId, threadKey)?.id ?? null;
}

/** Files one checked item. Runs inside the item's transaction. */
function fileItem(db: Database, sourceId: string, raw: SourceItem): Filed {
  const row = getItemRow(db, sourceId, raw.key);
  const known = row?.status === "ingested" ? row : null;
  const base = normalize(raw);
  if (known) {
    const mismatch = checkItem(base, { threadKey: known.threadKey });
    if (mismatch) return { kind: "thread_mismatch", error: mismatch };
    if ((known.version ?? null) === (base.version ?? null)) {
      touchSeen(db, sourceId, raw.key);
      return { kind: "seen" };
    }
  }

  // A changed item stays on its task. A new item, or a changed one whose task
  // was deleted, is routed by its thread.
  const threadKey = base.threadKey ?? base.key;
  let taskId = known?.taskId && getTask(db, known.taskId) ? known.taskId : taskForNewItem(db, sourceId, threadKey);
  let createdTask = false;
  if (!taskId) {
    taskId = insertTask(db, {
      sourceId,
      externalId: threadKey,
      url: base.url ?? null,
      title: base.title,
      body: base.body,
      metadata: base.metadata ?? {},
    }).id;
    createdTask = true;
  }

  const { valid: participants, dropped } = sanitizeParticipants(raw.participants);
  const item: SourceItem = { ...base, participants };
  fileIngested(db, sourceId, item, taskId);
  upsertSourceParticipants(db, taskId, participants);
  updateTask(db, taskId, composeTask(rowsForTask(db, taskId)));
  return { kind: known ? "changed" : "new", taskId, createdTask, unseen: !row, item, dropped };
}

async function runList(
  db: Database,
  source: TaskSource,
  kind: PollKind,
  since: string | null,
  hooks: PollHooks,
  opts: PollOptions,
): Promise<PollOutcome> {
  const started = startPoll(db, source.id, kind, since);
  const counts = { seen: 0, new: 0, changed: 0, failed: 0 };
  const unkeyedFailures: Failure[] = [];
  const finish = (error?: string): PollRecord => {
    if (error) console.error(`[poller] ${source.id}: ${error}`);
    return finishPoll(db, started.id, {
      outcome: error ? "error" : "ok",
      ...(error ? { error } : {}),
      ...counts,
      unkeyedFailures,
    });
  };

  let result: { items: unknown[]; failures: Failure[] };
  try {
    result = readResult(await listWithTimeout(source, since, opts.timeoutMs ?? LIST_TIMEOUT_MS));
  } catch (error) {
    return { poll: finish(message(error)), recovered: 0 };
  }

  const created = new Set<string>();
  const changes = new Map<string, SourceItem[]>();
  const filingErrors: string[] = [];
  let recovered = 0;
  let droppedParticipants = 0;

  // A failure never downgrades an ingested row (it goes to the poll's unkeyed
  // list, key in the message) and never un-dismisses a dismissed one.
  const recordFailure = (key: string | undefined, error: string) => {
    if (!key) {
      counts.failed++;
      unkeyedFailures.push({ error });
      return;
    }
    const filed = db.transaction(() => fileFailure(db, source.id, key, error, since))();
    if (filed === "dismissed") return;
    counts.failed++;
    if (filed === "already_ingested") unkeyedFailures.push({ error: `${key}: ${error}` });
  };

  try {
    counts.seen = result.items.length;
    const { valid, failures: checkFailures } = checkList(result.items);
    for (const f of checkFailures) recordFailure(f.key, f.error);

    for (const raw of valid) {
      let filed: Filed;
      try {
        filed = db.transaction(() => fileItem(db, source.id, raw))();
      } catch (error) {
        filingErrors.push(`filing ${raw.key} failed: ${message(error)}`);
        continue;
      }
      if (filed.kind === "seen") continue;
      if (filed.kind === "thread_mismatch") {
        recordFailure(raw.key, filed.error);
        continue;
      }
      counts[filed.kind]++;
      if (filed.unseen) recovered++;
      droppedParticipants += filed.dropped;
      if (filed.createdTask) created.add(filed.taskId);
      else if (!created.has(filed.taskId)) {
        changes.set(filed.taskId, [...(changes.get(filed.taskId) ?? []), filed.item]);
      }
    }

    for (const f of result.failures) recordFailure(f.key, f.error);
  } catch (error) {
    filingErrors.push(message(error));
  }

  if (droppedParticipants) {
    console.warn(`[poller] ${source.id}: dropped ${droppedParticipants} malformed participant(s)`);
  }
  const poll = finish(filingErrors.length ? filingErrors.join("; ") : undefined);

  const runHook = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[poller] ${source.id}: ${label} failed:`, error);
    }
  };
  for (const id of created) {
    const task = getTask(db, id);
    if (task) await runHook(`onCreated for task ${id}`, () => hooks.onCreated(task));
  }
  for (const [id, items] of changes) {
    const task = getTask(db, id);
    if (task) await runHook(`onChanged for task ${id}`, () => hooks.onChanged(task, items));
  }

  return { poll, recovered };
}

/** One regular poll: lists from the next window, recording the horizon on the
 *  source's first poll. */
export async function pollSource(
  db: Database,
  source: TaskSource,
  hooks: PollHooks,
  opts: PollOptions = {},
): Promise<PollOutcome> {
  const { since, isFirst } = nextWindow(db, source.id, opts.now ?? new Date());
  if (isFirst) setHorizon(db, source.id, since);
  return runList(db, source, "poll", since, hooks, opts);
}

/** Re-lists the window a failed key was seen in. Never moves the normal window. */
export async function retryFailure(
  db: Database,
  source: TaskSource,
  key: string,
  hooks: PollHooks,
  opts: PollOptions = {},
): Promise<PollOutcome> {
  const row = getItemRow(db, source.id, key);
  if (row?.status !== "failed") throw new Error(`${source.id}: no failed item with key ${key}`);
  return runList(db, source, "retry", row.failedWindow, hooks, opts);
}

/** Re-lists everything since the source's horizon, filing unseen keys. Never
 *  moves the normal window. Before any poll, it records the horizon the first
 *  poll would have. */
export async function rescanSource(
  db: Database,
  source: TaskSource,
  hooks: PollHooks,
  opts: PollOptions = {},
): Promise<PollOutcome> {
  let horizon = getHorizon(db, source.id);
  if (!horizon) {
    horizon = nextWindow(db, source.id, opts.now ?? new Date()).since;
    setHorizon(db, source.id, horizon);
  }
  return runList(db, source, "rescan", horizon, hooks, opts);
}
