/** Pure helpers for the extension card's polling UI. No React. */
import type { ExtensionListItem, PollRecord, TestPollItem, TestPollResult } from "./api";

const DAY = 86_400_000;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "just now" | "N min ago" | "N h ago" | "1 day ago" | "N days ago". */
export function relTime(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

/** Absolute local date and time, for `title` attributes. */
export function absTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The card's status line, from the last regular poll only. */
export function pollSummary(poll: PollRecord | null, now: number): string {
  if (!poll) return "Never polled";
  if (!poll.finishedAt) return "Polling now…";
  const when = relTime(poll.finishedAt, now);
  if (poll.outcome === "error") return `Last poll failed ${when}: ${poll.error || "unknown error"}`;
  const parts = [`Polled ${when}`, `${poll.new} new`];
  if (poll.changed) parts.push(`${poll.changed} changed`);
  if (poll.failed) parts.push(`${poll.failed} failed`);
  return parts.join(" · ");
}

export function rescanMessage(recovered: number): string {
  if (recovered === 0) return "Nothing new found";
  return `Recovered ${plural(recovered, "item")} not seen before`;
}

/** History row counts: seen (omitted at 0), new (always), changed and failed (omitted at 0). */
export function pollCounts(poll: PollRecord): string {
  const parts: string[] = [];
  if (poll.seen) parts.push(`${poll.seen} seen`);
  parts.push(`${poll.new} new`);
  if (poll.changed) parts.push(`${poll.changed} changed`);
  if (poll.failed) parts.push(`${poll.failed} failed`);
  return parts.join(" · ");
}

/** "since 14:02" within a day of the start, "since 7 days ago" beyond, "no window" without one. */
export function sinceLabel(poll: PollRecord): string {
  if (!poll.since) return "no window";
  const gap = Date.parse(poll.startedAt) - Date.parse(poll.since);
  if (gap >= DAY) {
    const d = Math.round(gap / DAY);
    return `since ${d === 1 ? "1 day" : `${d} days`} ago`;
  }
  return `since ${hhmm(poll.since)}`;
}

/** Middle truncation: the tail is the last 14 characters; keys of 26 or fewer aren't split. */
export function splitKey(key: string): [head: string, tail: string] {
  return key.length <= 26 ? [key, ""] : [key.slice(0, -14), key.slice(-14)];
}

/** The poll whose unkeyed failures are current: the last poll if it was ok, otherwise the
 *  newest ok regular poll in the loaded history (a poll that errors as a whole lists nothing,
 *  so it can't say the unkeyed items have gone). */
export function lastOkPoll(lastPoll: PollRecord | null, polls: PollRecord[] | null): PollRecord | null {
  if (!lastPoll) return null;
  if (lastPoll.outcome === "ok") return lastPoll;
  return polls?.find((p) => p.kind === "poll" && p.outcome === "ok") ?? null;
}

export function unkeyedToShow(lastPoll: PollRecord | null, polls: PollRecord[] | null): { error: string }[] {
  const source = lastOkPoll(lastPoll, polls);
  if (!source) return [];
  return source.unkeyedFailures.filter((u) => !u.key).map((u) => ({ error: u.error }));
}

export type Tone = "tone-on" | "tone-off" | "tone-warn";

/** The head's status text tone. */
export function toneOf(ext: ExtensionListItem): Tone {
  if (ext.status === "needs_reauth") return "tone-warn";
  if (ext.status === "connected" && ext.enabled) return "tone-on";
  return "tone-off";
}

/** The tone bar: accent for anything a connected card can act on. */
export function barTone(ext: ExtensionListItem, unkeyedShown: boolean): Tone {
  if (ext.status === "needs_reauth") return "tone-warn";
  const connected = ext.status === "connected";
  if (connected && (ext.failedCount > 0 || unkeyedShown || ext.lastPoll?.outcome === "error")) return "tone-warn";
  if (connected && ext.enabled) return "tone-on";
  return "tone-off";
}

export function previewSummary(r: TestPollResult): string {
  return [
    plural(r.items.length, "item"),
    plural(r.failures.length, "failure"),
    plural(r.checkFailures.length, "check failure"),
  ].join(" · ");
}

export interface PreviewGroup {
  label: string;
  /** Items in the whole group, shown or not. */
  count: number;
  threadKey: string | null;
  /** The shown items; `first` marks the one that creates the task. */
  items: { item: TestPollItem; first: boolean }[];
}

/** Groups the preview's items into the tasks they'd become (threadKey ?? key, first-seen
 *  order), showing only the first `limit` items across all groups. */
export function groupPreview(
  items: TestPollItem[],
  limit: number,
): { tasks: number; groups: PreviewGroup[]; hidden: number } {
  const order: string[] = [];
  const byTask = new Map<string, { threadKey: string | null; all: TestPollItem[] }>();
  for (const item of items) {
    const g = item.threadKey ?? item.key;
    let entry = byTask.get(g);
    if (!entry) {
      entry = { threadKey: item.threadKey ?? null, all: [] };
      byTask.set(g, entry);
      order.push(g);
    }
    entry.all.push(item);
  }
  const visible = new Set(items.slice(0, limit));
  const groups: PreviewGroup[] = [];
  order.forEach((g, i) => {
    const entry = byTask.get(g)!;
    const shown = entry.all.filter((x) => visible.has(x));
    if (shown.length === 0) return;
    groups.push({
      label: `Task ${i + 1}`,
      count: entry.all.length,
      threadKey: entry.threadKey,
      items: shown.map((item) => ({ item, first: entry.all[0] === item })),
    });
  });
  return { tasks: order.length, groups, hidden: items.length - visible.size };
}
