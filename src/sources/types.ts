import type { SourceParticipant } from "../domain/roster";

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
  /** People on this item, as the source system reports them. Identities are
   *  namespaced by system ("email:bob@acme.test", "github:bobsmith"); prefer
   *  a stable identifier (address, login) over a display name. Omit when the
   *  system reports nobody; the user can still tag people by hand. Malformed
   *  entries are dropped by the poller, never fail a poll. */
  participants?: SourceParticipant[];
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
