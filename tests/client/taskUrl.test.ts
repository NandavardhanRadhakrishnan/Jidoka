import { test, expect } from "bun:test";
import { taskUrl, readTaskId } from "../../src/client/taskUrl";

test("taskUrl builds a ?task= query string", () => {
  expect(taskUrl("abc-123")).toBe("?task=abc-123");
});

test("taskUrl encodes special characters in the id", () => {
  expect(taskUrl("a b&c")).toBe("?task=a+b%26c");
});

test("readTaskId reads the task id from a query string", () => {
  expect(readTaskId("?task=abc-123")).toBe("abc-123");
});

test("readTaskId reads task among other params", () => {
  expect(readTaskId("?foo=bar&task=abc-123&baz=1")).toBe("abc-123");
});

test("readTaskId returns null when there is no task param", () => {
  expect(readTaskId("")).toBeNull();
  expect(readTaskId("?foo=bar")).toBeNull();
});
