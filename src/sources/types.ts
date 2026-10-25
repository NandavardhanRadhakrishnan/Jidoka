import type { SourceParticipant } from "../domain/roster";

export interface SourceItem {
  /** Immutable and taken from the item itself: a Message-ID, a Gmail message
   *  id, an issue node id. Never a mailbox position (IMAP UID) or a made-up
   *  fallback. */
  key: string;
  /** Items with the same threadKey become one task. Must be computable from
   *  this item alone. Omit it and the item is a task on its own. */
  threadKey?: string;
  /** Changes when the item's content changes (updated_at, an etag). Omit it
   *  for items that never change, like an email. */
  version?: string;
  /** When the item happened, ISO-8601. Orders the items within a thread. */
  occurredAt: string;
  title: string;
  body: string;
  url?: string;
  metadata?: Record<string, unknown>;
  /** People on this item, as the source system reports them. Identities are
   *  namespaced by system ("email:bob@acme.test", "github:bobsmith"); prefer
   *  a stable identifier (address, login) over a display name. Omit when the
   *  system reports nobody; the user can still tag people by hand. Malformed
   *  entries are dropped by the poller, never fail a poll. */
  participants?: SourceParticipant[];
}

export interface ListResult {
  items: SourceItem[];
  /** Items the extension saw but couldn't build. `key` is optional because
   *  sometimes even the id can't be read. */
  failures?: { key?: string; error: string }[];
}

export interface TaskSource {
  readonly id: string;
  /** Return at least every item that changed at or after `since`; returning
   *  more is fine. `since` is null for "everything you have". */
  list(window: { since: string | null }): Promise<ListResult>;
}

/** What an extension's source.ts receives to authenticate — nothing else. */
export interface ExtensionSourceDeps {
  getToken(): Promise<string>;
}
