import { test, expect } from "bun:test";
import { PRIORITIES, isPriority, resolvePriority } from "../../src/domain/priority";

test("priorities are ordered from lowest to highest", () => {
  expect(PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
});

test("isPriority accepts only the four known levels", () => {
  expect(isPriority("high")).toBe(true);
  expect(isPriority("P1")).toBe(false);
  expect(isPriority(undefined)).toBe(false);
});

test("resolvePriority keeps the type default when triage saw no urgency signal", () => {
  expect(resolvePriority("high", null)).toBe("high");
});

test("resolvePriority lets an urgency signal raise the type default", () => {
  expect(resolvePriority("normal", "urgent")).toBe("urgent");
});

test("resolvePriority never lets an urgency signal lower the type default", () => {
  expect(resolvePriority("high", "low")).toBe("high");
});
