import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/db";
import { pollOnce } from "../../src/sources/poller";
import { createSampleFolderSource } from "../../src/sources/sample/folder";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jidoka-sample-"));
}

test("a JSON file becomes a task with its fields", async () => {
  const dir = await freshDir();
  await writeFile(
    join(dir, "order-query.json"),
    JSON.stringify({
      title: "Where is my order?",
      body: "Ordered last week, nothing arrived.",
      url: "https://example.com/tickets/1",
      metadata: { from: "customer@example.com" },
    }),
  );

  const result = await createSampleFolderSource({ dir }).poll(null);

  expect(result.items).toEqual([
    {
      externalId: "order-query.json",
      title: "Where is my order?",
      body: "Ordered last week, nothing arrived.",
      url: "https://example.com/tickets/1",
      metadata: { from: "customer@example.com", file: "order-query.json" },
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("a text file uses its first line as the title and the rest as the body", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "note.txt"), "\nInvoice 42 mismatch\nThe totals differ by 30.\n");

  const result = await createSampleFolderSource({ dir }).poll(null);

  expect(result.items).toEqual([
    {
      externalId: "note.txt",
      title: "Invoice 42 mismatch",
      body: "The totals differ by 30.",
      metadata: { file: "note.txt" },
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("unsupported files are ignored and a missing directory polls empty", async () => {
  const dir = await freshDir();
  await writeFile(join(dir, "photo.png"), "not a task");
  await writeFile(join(dir, "README.md"), "# How this folder works");
  await writeFile(join(dir, ".keep"), "");

  const present = await createSampleFolderSource({ dir }).poll(null);
  expect(present.items).toEqual([]);

  await rm(dir, { recursive: true, force: true });

  const missing = await createSampleFolderSource({ dir }).poll("keep-me");
  expect(missing).toEqual({ items: [], cursor: "keep-me" });
});

test("polling twice ingests each file once", async () => {
  const dir = await freshDir();
  const db = openDb(":memory:");
  migrate(db);
  await writeFile(join(dir, "first.json"), JSON.stringify({ title: "First", body: "one" }));
  const source = createSampleFolderSource({ dir });

  const firstRun = await pollOnce(db, source, async () => {});
  await writeFile(join(dir, "second.json"), JSON.stringify({ title: "Second", body: "two" }));
  const secondRun = await pollOnce(db, source, async () => {});

  expect(firstRun.map((t) => t.title)).toEqual(["First"]);
  expect(secondRun.map((t) => t.title)).toEqual(["Second"]);
  expect(secondRun[0]?.sourceId).toBe("sample");

  await rm(dir, { recursive: true, force: true });
});
