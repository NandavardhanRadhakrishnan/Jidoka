export interface RawItem {
  externalId: string;
  title: string;
  body: string;
  url?: string;
  metadata?: Record<string, unknown>;
  /** Opaque token the source defines meaning for (a revision number, a
   *  last-modified timestamp, a hash of whatever fields that connector cares
   *  about). Jidoka never inspects it — only compares it to what it last
   *  stored, to decide whether an already-known item has genuinely changed.
   *  Omit it and this item never reopens an existing task automatically. */
  revision?: string;
}

export interface PollResult {
  items: RawItem[];
  cursor: string | null;
}

export interface TaskSource {
  readonly id: string;
  poll(cursor: string | null): Promise<PollResult>;
}

/** What an extension's source.ts receives to authenticate — nothing else. */
export interface ExtensionSourceDeps {
  getToken(): Promise<string>;
}
