import { test, expect } from "bun:test";
import { checkItem, checkList } from "../../src/sources/checks";

const ok = { key: "m1", occurredAt: "2026-10-01T10:00:00Z", title: "Hi", body: "b" };
test("a valid item passes", () => expect(checkItem(ok, null)).toBeNull());
test("empty or overlong keys fail", () => {
  expect(checkItem({ ...ok, key: "" }, null)).toBe("item has no key");
  expect(checkItem({ ...ok, key: "x".repeat(513) }, null)).toBe("key is longer than 512 characters");
});
test("a bad date fails", () => expect(checkItem({ ...ok, occurredAt: "soon" }, null)).toBe("occurredAt is not a valid date"));
test("an empty title fails", () => expect(checkItem({ ...ok, title: "  " }, null)).toBe("item has no title"));
test("a known key with a different thread key fails", () => {
  expect(checkItem({ ...ok, threadKey: "t2" }, { threadKey: "t1" })).toBe("thread key changed from t1 to t2");
  expect(checkItem({ ...ok, threadKey: "t1" }, { threadKey: "t1" })).toBeNull();
});
test("identical duplicates collapse; differing duplicates fail", () => {
  expect(checkList([ok, { ...ok }]).valid).toHaveLength(1);
  const r = checkList([ok, { ...ok, body: "other" }]);
  expect(r.valid).toHaveLength(0);
  expect(r.failures).toEqual([{ key: "m1", error: "key m1 appears twice with different content" }]);
});
test("a non-object fails without a key", () =>
  expect(checkList([42]).failures).toEqual([{ error: "item is not an object" }]));
