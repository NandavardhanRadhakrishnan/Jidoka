export const PARTICIPANT_ROLES = ["from", "to", "cc", "author", "assignee", "commenter"] as const;

export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export function isParticipantRole(value: unknown): value is ParticipantRole {
  return typeof value === "string" && (PARTICIPANT_ROLES as readonly string[]).includes(value);
}

/** A relationship group seen from the user's org — not a legal company. */
export interface Org {
  id: string;
  name: string;
  /** The user's own org. Exactly one exists; it becomes the workspace in multiplayer. */
  isHome: boolean;
  /** Hints for attributing unknown senders; never moves a person by itself. */
  domains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Person {
  id: string;
  displayName: string;
  /** Always confirmed by the user; null is "No org". */
  orgId: string | null;
  /** The user. Exactly one exists. */
  isSelf: boolean;
  /** Namespaced, oldest first: "email:bob@acme.test", "github:bobsmith". */
  identities: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Roster {
  orgs: Org[];
  people: Person[];
}

/** A person on an item, as a source reports it. */
export interface SourceParticipant {
  identity: string;
  name?: string;
  role: ParticipantRole;
}

export interface ResolvedParticipant {
  id: string;
  role: ParticipantRole | "added";
  addedBy: "source" | "human";
  /** The raw identity a source reported; null on hand-added rows. */
  identity: string | null;
  /** The source's display name for this identity, if it gave one. */
  sourceName: string | null;
  /** The roster person this row resolves to; null while the identity is unknown. */
  person: {
    id: string;
    displayName: string;
    isSelf: boolean;
    identities: string[];
    org: { id: string; name: string; isHome: boolean } | null;
  } | null;
}

export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
]);

export const ROSTER_MESSAGES = {
  malformedIdentity: "Use namespace:value, e.g. email:bob@acme.test",
  malformedDomain: "Enter a domain like acme.test",
  publicDomain: (domain: string) => `${domain} is a public email domain`,
  domainTaken: (domain: string, orgName: string) => `${domain} is already on ${orgName}`,
  identityOwned: (identity: string, personName: string) => `${identity} belongs to ${personName}`,
  identityAlreadyOn: (identity: string, personName: string) => `${identity} is already on ${personName}`,
  homeOrgDelete: "Your org can't be deleted",
  selfDelete: "You can't delete yourself from the roster",
  selfOrg: "You always belong to your org",
  sourceParticipantRemove: "People reported by the source can't be removed",
} as const;

/** A request the roster refuses; the message is shown to the user verbatim. */
export class RosterConflictError extends Error {
  override name = "RosterConflictError";
}

/** An org, person, task or participant id that doesn't exist. */
export class RosterNotFoundError extends Error {
  override name = "RosterNotFoundError";
}

const NAMESPACE = /^[a-z0-9][a-z0-9_-]*$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lowercases, trims, strips a leading "@". Null when it isn't a domain. */
export function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/^@/, "");
  return DOMAIN.test(domain) ? domain : null;
}

/** Lowercases the namespace, and the whole value for `email:`. Null when malformed. */
export function normalizeIdentity(raw: string): string | null {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const namespace = trimmed.slice(0, colon).toLowerCase();
  const value = trimmed.slice(colon + 1);
  if (!NAMESPACE.test(namespace) || !value || /\s/.test(value)) return null;
  if (namespace !== "email") return `${namespace}:${value}`;
  const address = value.toLowerCase();
  const parts = address.split("@");
  if (parts.length !== 2 || !parts[0] || !DOMAIN.test(parts[1] ?? "")) return null;
  return `email:${address}`;
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain);
}

/** "acme.test" for "email:bob@acme.test"; null for any other namespace. */
export function emailDomainOf(identity: string): string | null {
  if (!identity.startsWith("email:")) return null;
  const at = identity.lastIndexOf("@");
  return at === -1 ? null : identity.slice(at + 1);
}
