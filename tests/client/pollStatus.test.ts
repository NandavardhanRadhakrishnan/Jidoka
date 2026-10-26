import { test, expect, describe } from "bun:test";
import {
  barTone,
  groupPreview,
  lastOkPoll,
  pollCounts,
  pollSummary,
  previewSummary,
  relTime,
  rescanMessage,
  sinceLabel,
  splitKey,
  unkeyedToShow,
} from "../../src/client/pollStatus";
import type { ExtensionListItem, PollRecord, TestPollItem } from "../../src/client/api";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.parse("2026-10-25T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

let n = 0;
function poll(o: Partial<PollRecord> = {}): PollRecord {
  return {
    id: `pol_${++n}`,
    sourceId: "imap-work",
    kind: "poll",
    since: ago(7 * MIN),
    startedAt: ago(2 * MIN + 4000),
    finishedAt: ago(2 * MIN),
    outcome: "ok",
    error: null,
    seen: 0,
    new: 0,
    changed: 0,
    failed: 0,
    unkeyedFailures: [],
    ...o,
  };
}

describe("relTime", () => {
  test("under a minute is just now, and the future never goes negative", () => {
    expect(relTime(ago(59_000), now)).toBe("just now");
    expect(relTime(new Date(now + 5000).toISOString(), now)).toBe("just now");
  });
  test("minutes, hours and days", () => {
    expect(relTime(ago(2 * MIN), now)).toBe("2 min ago");
    expect(relTime(ago(59 * MIN), now)).toBe("59 min ago");
    expect(relTime(ago(3 * HOUR), now)).toBe("3 h ago");
    expect(relTime(ago(DAY), now)).toBe("1 day ago");
    expect(relTime(ago(3 * DAY), now)).toBe("3 days ago");
  });
});

describe("pollSummary", () => {
  test("never polled", () => {
    expect(pollSummary(null, now)).toBe("Never polled");
  });

  test("ok poll leaves out zero changed and failed (acceptance 2)", () => {
    expect(pollSummary(poll({ seen: 3, new: 3 }), now)).toBe("Polled 2 min ago · 3 new");
  });

  test("ok poll always shows new, even at zero", () => {
    expect(pollSummary(poll(), now)).toBe("Polled 2 min ago · 0 new");
  });

  test("ok poll with changed and failed, singular and plural", () => {
    expect(pollSummary(poll({ new: 3, changed: 1, failed: 1 }), now)).toBe(
      "Polled 2 min ago · 3 new · 1 changed · 1 failed",
    );
    expect(pollSummary(poll({ new: 1, changed: 2, failed: 4 }), now)).toBe(
      "Polled 2 min ago · 1 new · 2 changed · 4 failed",
    );
    expect(pollSummary(poll({ new: 0, failed: 2 }), now)).toBe("Polled 2 min ago · 0 new · 2 failed");
  });

  test("failed poll shows the error (acceptance 4)", () => {
    const p = poll({ outcome: "error", error: "IMAP: connection reset by peer" });
    expect(pollSummary(p, now)).toBe("Last poll failed 2 min ago: IMAP: connection reset by peer");
  });

  test("failed poll with no error text", () => {
    expect(pollSummary(poll({ outcome: "error", error: null }), now)).toBe(
      "Last poll failed 2 min ago: unknown error",
    );
  });

  test("relative time is measured from finishedAt, not startedAt", () => {
    const p = poll({ startedAt: ago(10 * MIN), finishedAt: ago(5 * MIN), new: 1 });
    expect(pollSummary(p, now)).toBe("Polled 5 min ago · 1 new");
  });

  test("a regular poll with no finishedAt is still running", () => {
    expect(pollSummary(poll({ finishedAt: null, outcome: null }), now)).toBe("Polling now…");
  });
});

describe("rescanMessage (acceptance 22)", () => {
  test("zero, singular and plural", () => {
    expect(rescanMessage(0)).toBe("Nothing new found");
    expect(rescanMessage(1)).toBe("Recovered 1 item not seen before");
    expect(rescanMessage(4)).toBe("Recovered 4 items not seen before");
  });
});

describe("pollCounts (acceptance 9, 12)", () => {
  test("first poll", () => {
    expect(pollCounts(poll({ seen: 41, new: 41 }))).toBe("41 seen · 41 new");
  });
  test("quiet poll shows 0 new with no 0 seen", () => {
    expect(pollCounts(poll())).toBe("0 new");
  });
  test("retry still failing", () => {
    expect(pollCounts(poll({ kind: "retry", seen: 1, failed: 1 }))).toBe("1 seen · 0 new · 1 failed");
  });
  test("every count", () => {
    expect(pollCounts(poll({ seen: 9, new: 5, changed: 2, failed: 2 }))).toBe(
      "9 seen · 5 new · 2 changed · 2 failed",
    );
  });
});

describe("sinceLabel (acceptance 12)", () => {
  test("rescan has no window", () => {
    expect(sinceLabel(poll({ kind: "rescan", since: null }))).toBe("no window");
  });
  test("a first poll a week back", () => {
    const startedAt = ago(22 * MIN);
    expect(sinceLabel(poll({ startedAt, since: new Date(Date.parse(startedAt) - 7 * DAY).toISOString() }))).toBe(
      "since 7 days ago",
    );
  });
  test("exactly a day reads singular", () => {
    const startedAt = ago(0);
    expect(sinceLabel(poll({ startedAt, since: ago(DAY) }))).toBe("since 1 day ago");
  });
  test("under a day shows the local clock time", () => {
    const since = new Date(2026, 9, 25, 14, 2).toISOString();
    const startedAt = new Date(2026, 9, 25, 14, 7).toISOString();
    expect(sinceLabel(poll({ since, startedAt }))).toBe("since 14:02");
  });
});

describe("splitKey", () => {
  test("keys of 26 characters or fewer are not split", () => {
    const k = "github:acme/web#1187";
    expect(splitKey(k)).toEqual([k, ""]);
    expect(splitKey("a".repeat(26))).toEqual(["a".repeat(26), ""]);
  });
  test("longer keys keep the last 14 characters as the tail", () => {
    const k = "<75c1a1ab-0c7b-49cd-bf1c-0bdc54f804b2@acme.test>";
    const [head, tail] = splitKey(k);
    expect(tail).toBe("4b2@acme.test>");
    expect(tail.length).toBe(14);
    expect(head + tail).toBe(k);
    expect(splitKey("a".repeat(27))).toEqual(["a".repeat(13), "a".repeat(14)]);
  });
});

describe("unkeyedToShow", () => {
  const noId = { error: "message has no Message-ID header" };
  const keyed = { key: "<k@x>", error: "body is not valid UTF-8" };

  test("nothing without a last poll", () => {
    expect(unkeyedToShow(null, null)).toEqual([]);
    expect(unkeyedToShow(null, [poll({ unkeyedFailures: [noId] })])).toEqual([]);
  });

  test("an ok last poll reports its own unkeyed failures, dropping keyed ones", () => {
    const last = poll({ unkeyedFailures: [noId, keyed] });
    expect(unkeyedToShow(last, null)).toEqual([noId]);
    expect(lastOkPoll(last, null)).toBe(last);
  });

  test("after a failed poll, the newest ok regular poll from history is used", () => {
    const last = poll({ outcome: "error", error: "reset" });
    const okPoll = poll({ unkeyedFailures: [noId] });
    const history = [
      last,
      poll({ outcome: "error", error: "reset" }),
      poll({ kind: "retry", unkeyedFailures: [{ error: "retry only" }] }),
      poll({ kind: "rescan", since: null, unkeyedFailures: [{ error: "rescan only" }] }),
      okPoll,
      poll({ unkeyedFailures: [{ error: "older" }] }),
    ];
    expect(unkeyedToShow(last, history)).toEqual([noId]);
    expect(lastOkPoll(last, history)).toBe(okPoll);
  });

  test("a failed last poll with history not loaded shows nothing", () => {
    expect(unkeyedToShow(poll({ outcome: "error" }), null)).toEqual([]);
  });

  test("a newer ok poll that stops reporting them clears them", () => {
    const last = poll({ unkeyedFailures: [] });
    expect(unkeyedToShow(last, [last, poll({ unkeyedFailures: [noId] })])).toEqual([]);
  });
});

describe("barTone (acceptance 5)", () => {
  const ext = (o: Partial<ExtensionListItem>): ExtensionListItem => ({
    id: "x",
    name: "X",
    summary: "",
    readOnly: true,
    auth: null,
    enabled: true,
    valid: true,
    error: null,
    status: "connected",
    lastPoll: null,
    failedCount: 0,
    ...o,
  });

  test("needs reauth is accent", () => {
    expect(barTone(ext({ status: "needs_reauth", enabled: false }), false)).toBe("tone-warn");
  });
  test("connected trouble is accent", () => {
    expect(barTone(ext({ failedCount: 1 }), false)).toBe("tone-warn");
    expect(barTone(ext({}), true)).toBe("tone-warn");
    expect(barTone(ext({ lastPoll: poll({ outcome: "error" }) }), false)).toBe("tone-warn");
    expect(barTone(ext({ enabled: false, failedCount: 2 }), false)).toBe("tone-warn");
  });
  test("healthy connected and enabled is on; connected not enabled is off", () => {
    expect(barTone(ext({ lastPoll: poll() }), false)).toBe("tone-on");
    expect(barTone(ext({ enabled: false }), false)).toBe("tone-off");
  });
  test("a not-connected card never goes accent for failures", () => {
    expect(
      barTone(ext({ status: "not_connected", enabled: false, failedCount: 3, lastPoll: poll({ outcome: "error" }) }), true),
    ).toBe("tone-off");
  });
});

describe("test poll preview (acceptance 15, 16)", () => {
  const THREAD = "<0b9d4e7a-2c61-4f3e-8a5d-7e1f90c4b2a6@acme.test>";
  const item = (key: string, title: string, threadKey?: string): TestPollItem => ({
    key,
    title,
    threadKey,
    occurredAt: "2026-10-25T10:00:00.000Z",
    body: "",
  });
  const items = [
    item(THREAD, "Q4 vendor onboarding checklist", THREAD),
    item("<a7c4@acme.test>", "Invoice INV-20931 is overdue"),
    item("<5e2a@acme.test>", "Re: Q4 vendor onboarding checklist", THREAD),
  ];

  test("summary pluralises each count", () => {
    expect(previewSummary({ items, failures: [{ key: "k", error: "e" }], checkFailures: [{ error: "e" }] })).toBe(
      "3 items · 1 failure · 1 check failure",
    );
    expect(previewSummary({ items: items.slice(0, 1), failures: [], checkFailures: [] })).toBe(
      "1 item · 0 failures · 0 check failures",
    );
  });

  test("items group into tasks by threadKey ?? key, first-seen order", () => {
    const { tasks, groups, hidden } = groupPreview(items, 5);
    expect(tasks).toBe(2);
    expect(hidden).toBe(0);
    expect(groups.map((g) => [g.label, g.count, g.threadKey])).toEqual([
      ["Task 1", 2, THREAD],
      ["Task 2", 1, null],
    ]);
    expect(groups[0]!.items.map((i) => [i.item.title, i.first])).toEqual([
      ["Q4 vendor onboarding checklist", true],
      ["Re: Q4 vendor onboarding checklist", false],
    ]);
    expect(groups[1]!.items[0]!.first).toBe(true);
  });

  test("only the first N items show; the rest are counted as hidden", () => {
    const many = Array.from({ length: 7 }, (_, i) => item(`github:acme/api#${i}`, `Issue ${i}`, `github:acme/api#${i}`));
    const capped = groupPreview(many, 5);
    expect(capped.groups.flatMap((g) => g.items).length).toBe(5);
    expect(capped.hidden).toBe(2);
    expect(capped.tasks).toBe(7);
    const all = groupPreview(many, Infinity);
    expect(all.groups.flatMap((g) => g.items).length).toBe(7);
    expect(all.hidden).toBe(0);
  });

  test("a group keeps its full count and task number when only part of it is shown", () => {
    const { groups } = groupPreview(items, 1);
    expect(groups.map((g) => [g.label, g.count, g.items.length])).toEqual([["Task 1", 2, 1]]);
  });
});
