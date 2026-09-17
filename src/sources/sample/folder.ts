import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PollResult, RawItem, TaskSource } from "../types";

export interface SampleFolderOptions {
  /** Directory scanned on every poll. Missing directory is not an error. */
  dir: string;
  /** Source id recorded on the tasks. Defaults to "sample". */
  id?: string;
}

const EXTENSIONS = [".json", ".txt", ".md"];

interface SampleFile {
  title?: unknown;
  body?: unknown;
  url?: unknown;
  metadata?: unknown;
}

function fromText(name: string, text: string): RawItem {
  const lines = text.split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
  const title = firstNonEmpty === -1 ? name : lines[firstNonEmpty]!.trim();
  const body = firstNonEmpty === -1 ? "" : lines.slice(firstNonEmpty + 1).join("\n").trim();
  return { externalId: name, title, body, metadata: { file: name } };
}

function fromJson(name: string, parsed: SampleFile): RawItem {
  const metadata =
    parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
      ? (parsed.metadata as Record<string, unknown>)
      : {};

  return {
    externalId: name,
    title: typeof parsed.title === "string" ? parsed.title : name,
    body: typeof parsed.body === "string" ? parsed.body : "",
    ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
    metadata: { ...metadata, file: name },
  };
}

/**
 * A task source for trying Jidoka out without credentials: every .json, .txt or
 * .md file in `dir` becomes one task, keyed by filename.
 *
 * A .json file may set title, body, url and metadata. A .txt/.md file uses its
 * first non-empty line as the title and the rest as the body.
 *
 * Files are re-read on every poll; the poller skips filenames already ingested,
 * so editing a file does not create a second task — rename it to re-ingest.
 */
export function createSampleFolderSource(options: SampleFolderOptions): TaskSource {
  const dir = options.dir;

  return {
    id: options.id ?? "sample",

    async poll(cursor: string | null): Promise<PollResult> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], cursor };
        throw error;
      }

      const files = names
        .filter((name) => {
          const lower = name.toLowerCase();
          // Dotfiles and the folder's own readme are documentation, not tasks.
          if (lower.startsWith(".") || lower.startsWith("readme.")) return false;
          return EXTENSIONS.some((extension) => lower.endsWith(extension));
        })
        .sort();

      const items: RawItem[] = [];
      for (const name of files) {
        const text = await readFile(join(dir, name), "utf8");

        if (name.toLowerCase().endsWith(".json")) {
          try {
            items.push(fromJson(name, JSON.parse(text) as SampleFile));
          } catch {
            items.push(fromText(name, text));
          }
        } else {
          items.push(fromText(name, text));
        }
      }

      return { items, cursor };
    },
  };
}
