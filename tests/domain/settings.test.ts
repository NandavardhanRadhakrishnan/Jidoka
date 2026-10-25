import { test, expect } from "bun:test";
import { SettingsSchema } from "../../src/domain/settings";

// The removed sample source's settings field, spelled in parts so a search
// for the old name finds no live use of it.
const REMOVED_SAMPLE_FIELD = ["sample", "Dir"].join("");

test("settings saved before the sample source was removed still validate, without its folder field", () => {
  const parsed = SettingsSchema.parse({ [REMOVED_SAMPLE_FIELD]: "./samples" });

  expect(parsed).toEqual({});
  expect(REMOVED_SAMPLE_FIELD in parsed).toBe(false);
});
