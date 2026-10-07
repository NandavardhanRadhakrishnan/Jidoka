import {
  ROSTER_MESSAGES as M,
  emailDomainOf,
  isPublicEmailDomain,
  normalizeDomain,
  normalizeIdentity,
  type Org,
  type Person,
  type Roster,
} from "../domain/roster";

/** Your org first, then the rest alphabetically. */
export function sortOrgs(orgs: Org[]): Org[] {
  return [...orgs].sort((a, b) => (a.isHome === b.isHome ? a.name.localeCompare(b.name) : a.isHome ? -1 : 1));
}

function selfFirstThenName(a: Person, b: Person): number {
  return a.isSelf === b.isSelf ? a.displayName.localeCompare(b.displayName) : a.isSelf ? -1 : 1;
}

/** The people in one org (null: No org), Me first, then alphabetical. */
export function peopleInGroup(people: Person[], orgId: string | null): Person[] {
  return people.filter((p) => p.orgId === orgId).sort(selfFirstThenName);
}

export function rosterSummary(roster: Roster): string {
  const orgs = roster.orgs.length;
  const people = roster.people.length;
  return `${orgs} ${orgs === 1 ? "org" : "orgs"} · ${people} ${people === 1 ? "person" : "people"}`;
}

/** The org whose domains contain this email identity's exact domain. */
export function guessOrgForIdentity(orgs: Org[], identity: string): { org: Org | null; domain: string | null } {
  const domain = emailDomainOf(identity);
  if (!domain) return { org: null, domain: null };
  return { org: orgs.find((o) => o.domains.includes(domain)) ?? null, domain };
}

export function pickerMatches(people: Person[], query: string, exclude: Set<string>, limit = 6): Person[] {
  const q = query.trim().toLowerCase();
  return people
    .filter((p) => !exclude.has(p.id))
    .filter((p) => !q || p.displayName.toLowerCase().includes(q) || p.identities.some((i) => i.includes(q)))
    .sort(selfFirstThenName)
    .slice(0, limit);
}

/** "Create “name”" is offered only when nobody has exactly that name. */
export function offersCreate(people: Person[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return q !== "" && !people.some((p) => p.displayName.toLowerCase() === q);
}

/** The server is authoritative; this only saves a round trip with the same
 *  messages. `orgId` mirrors the server call: a domain already on this org
 *  gets the same "already on" message as one on another org. */
export function checkDomainLocally(roster: Roster, orgId: string, raw: string): { value: string } | { error: string } {
  const domain = normalizeDomain(raw);
  if (!domain) return { error: M.malformedDomain };
  if (isPublicEmailDomain(domain)) return { error: M.publicDomain(domain) };
  const owner = roster.orgs.find((o) => o.domains.includes(domain));
  if (owner) return { error: M.domainTaken(domain, owner.name) };
  return { value: domain };
}

export function checkIdentityLocally(
  roster: Roster,
  personId: string,
  raw: string,
): { value: string } | { error: string } {
  const identity = normalizeIdentity(raw);
  if (!identity) return { error: M.malformedIdentity };
  const owner = roster.people.find((p) => p.identities.includes(identity));
  if (owner) {
    return {
      error:
        owner.id === personId
          ? M.identityAlreadyOn(identity, owner.displayName)
          : M.identityOwned(identity, owner.displayName),
    };
  }
  return { value: identity };
}
