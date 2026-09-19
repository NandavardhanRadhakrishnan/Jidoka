export interface RawItem {
  externalId: string;
  title: string;
  body: string;
  url?: string;
  metadata?: Record<string, unknown>;
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
