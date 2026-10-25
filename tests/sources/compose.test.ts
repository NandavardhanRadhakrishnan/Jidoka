import { describe, expect, test } from "bun:test";
import { composeTask } from "../../src/sources/compose";
import type { SourceItemRow } from "../../src/repo/sourceItems";
import type { SourceParticipant } from "../../src/domain/roster";

function row(over: Partial<SourceItemRow>): SourceItemRow {
  return {
    sourceId: "s", key: "k", threadKey: "t", version: null,
    occurredAt: "2026-10-01T10:00:00.000Z", title: "T", body: "B", url: null,
    metadata: {}, participants: [], taskId: null, status: "ingested",
    error: null, failedWindow: null, firstSeenAt: "x", lastSeenAt: "x", ...over,
  };
}
const from = (identity: string, name?: string): SourceParticipant => ({ identity, name, role: "from" });
const date = (iso: string) => new Date(iso).toLocaleString();

describe("composeTask", () => {
  test("one row", () => {
    const r = row({ title: "Hello", body: " text \n", participants: [from("email:bob@acme.test", "Bob Smith")] });
    const t = composeTask([r]);
    expect(t.title).toBe("Hello");
    expect(t.body).toBe(`— Bob Smith · ${date(r.occurredAt!)} —\ntext`);
  });

  test("two rows newest-first", () => {
    const old = row({ key: "a", title: "Old", body: "first", occurredAt: "2026-10-01T10:00:00.000Z", url: "u1", metadata: { n: 1 } });
    const neu = row({ key: "b", title: "New", body: "second", occurredAt: "2026-10-02T10:00:00.000Z", url: "u2", metadata: { n: 2 } });
    const t = composeTask([neu, old]);
    expect(t.title).toBe("Old");
    expect(t.body).toBe(
      `— ${date(old.occurredAt!)} —\nfirst\n\n— ${date(neu.occurredAt!)} —\nsecond`,
    );
    expect(t.url).toBe("u2");
    expect(t.metadata).toEqual({ n: 2 });
  });

  test("heading falls back to address, then date only", () => {
    const d = date("2026-10-01T10:00:00.000Z");
    expect(composeTask([row({ participants: [from("email:bob@acme.test")] })]).body).toBe(`— bob@acme.test · ${d} —\nB`);
    expect(composeTask([row({ participants: [from("github:octo", "")] })]).body).toBe(`— octo · ${d} —\nB`);
    expect(composeTask([row({})]).body).toBe(`— ${d} —\nB`);
  });

  test("null url", () => {
    expect(composeTask([row({ url: null })]).url).toBeNull();
  });
});
