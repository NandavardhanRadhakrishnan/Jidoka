import type { SourceItem } from "./types";

const MAX_KEY = 512;

/** Validates one item from an extension (untrusted output). Returns an error
 *  message, or null when the item is fine. `known` is what Jidoka stored the
 *  last time it saw this key, or null for a new key. */
export function checkItem(item: unknown, known: { threadKey: string | null } | null): string | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return "item is not an object";
  const o = item as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key === "") return "item has no key";
  if (o.key.length > MAX_KEY) return `key is longer than ${MAX_KEY} characters`;
  if (typeof o.occurredAt !== "string" || Number.isNaN(Date.parse(o.occurredAt))) {
    return "occurredAt is not a valid date";
  }
  if (typeof o.title !== "string" || o.title.trim() === "") return "item has no title";
  if (known) {
    const now = typeof o.threadKey === "string" ? o.threadKey : null;
    if (now !== known.threadKey) {
      return `thread key changed from ${known.threadKey ?? "none"} to ${now ?? "none"}`;
    }
  }
  return null;
}

/** Runs checkItem over a whole list and applies the duplicate rule: a key
 *  repeated with identical content collapses to one item; with different
 *  content it fails and neither copy is kept. */
export function checkList(items: unknown[]): {
  valid: SourceItem[];
  failures: { key?: string; error: string }[];
} {
  const failures: { key?: string; error: string }[] = [];
  const seen = new Map<string, { item: SourceItem; json: string }>();
  const conflicted = new Set<string>();
  for (const raw of items) {
    const error = checkItem(raw, null);
    if (error) {
      const key = (raw as { key?: unknown } | null)?.key;
      failures.push(typeof key === "string" && key !== "" && error !== "item is not an object" ? { key, error } : { error });
      continue;
    }
    const item = raw as SourceItem;
    const json = JSON.stringify(item);
    const prior = seen.get(item.key);
    if (!prior) {
      seen.set(item.key, { item, json });
    } else if (prior.json !== json && !conflicted.has(item.key)) {
      conflicted.add(item.key);
      failures.push({ key: item.key, error: `key ${item.key} appears twice with different content` });
    }
  }
  const valid = [...seen.values()].filter((e) => !conflicted.has(e.item.key)).map((e) => e.item);
  return { valid, failures };
}
