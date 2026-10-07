import type { Database } from "bun:sqlite";
import {
  ROSTER_MESSAGES as M,
  RosterConflictError,
  RosterNotFoundError,
  isPublicEmailDomain,
  normalizeDomain,
  normalizeIdentity,
  type Org,
  type Person,
  type Roster,
} from "../domain/roster";

interface OrgRow {
  id: string;
  name: string;
  is_home: number;
  created_at: string;
  updated_at: string;
}

interface PersonRow {
  id: string;
  display_name: string;
  org_id: string | null;
  is_self: number;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

function toOrg(row: OrgRow, domains: string[]): Org {
  return {
    id: row.id,
    name: row.name,
    isHome: row.is_home === 1,
    domains,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPerson(row: PersonRow, identities: string[]): Person {
  return {
    id: row.id,
    displayName: row.display_name,
    orgId: row.org_id,
    isSelf: row.is_self === 1,
    identities,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function groupBy(rows: { key: string; value: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) map.set(row.key, [...(map.get(row.key) ?? []), row.value]);
  return map;
}

export function listOrgs(db: Database): Org[] {
  const domains = groupBy(
    db.query("SELECT org_id AS key, domain AS value FROM org_domains ORDER BY rowid").all() as {
      key: string;
      value: string;
    }[],
  );
  const rows = db.query("SELECT * FROM orgs ORDER BY created_at, rowid").all() as OrgRow[];
  return rows.map((row) => toOrg(row, domains.get(row.id) ?? []));
}

export function getOrg(db: Database, id: string): Org | null {
  const row = db.query("SELECT * FROM orgs WHERE id = ?").get(id) as OrgRow | null;
  if (!row) return null;
  const domains = (
    db.query("SELECT domain FROM org_domains WHERE org_id = ? ORDER BY rowid").all(id) as { domain: string }[]
  ).map((r) => r.domain);
  return toOrg(row, domains);
}

function requireOrg(db: Database, id: string): Org {
  const org = getOrg(db, id);
  if (!org) throw new RosterNotFoundError(`unknown org ${id}`);
  return org;
}

export function getHomeOrg(db: Database): Org {
  const row = db.query("SELECT id FROM orgs WHERE is_home = 1").get() as { id: string } | null;
  if (!row) throw new Error("getHomeOrg: no home org; call ensureRosterDefaults first");
  return requireOrg(db, row.id);
}

export function listPeople(db: Database): Person[] {
  const identities = groupBy(
    db.query("SELECT person_id AS key, identity AS value FROM person_identities ORDER BY rowid").all() as {
      key: string;
      value: string;
    }[],
  );
  const rows = db.query("SELECT * FROM people ORDER BY created_at, rowid").all() as PersonRow[];
  return rows.map((row) => toPerson(row, identities.get(row.id) ?? []));
}

export function getPerson(db: Database, id: string): Person | null {
  const row = db.query("SELECT * FROM people WHERE id = ?").get(id) as PersonRow | null;
  if (!row) return null;
  const identities = (
    db.query("SELECT identity FROM person_identities WHERE person_id = ? ORDER BY rowid").all(id) as {
      identity: string;
    }[]
  ).map((r) => r.identity);
  return toPerson(row, identities);
}

function requirePerson(db: Database, id: string): Person {
  const person = getPerson(db, id);
  if (!person) throw new RosterNotFoundError(`unknown person ${id}`);
  return person;
}

/** The person who is the user. In multiplayer this becomes the signed-in user's person. */
export function getSelf(db: Database): Person {
  const row = db.query("SELECT id FROM people WHERE is_self = 1").get() as { id: string } | null;
  if (!row) throw new Error("getSelf: no self person; call ensureRosterDefaults first");
  return requirePerson(db, row.id);
}

export function getRoster(db: Database): Roster {
  return { orgs: listOrgs(db), people: listPeople(db) };
}

/** Creates the home org ("My org") and Me when either is missing. Safe to run on every startup. */
export function ensureRosterDefaults(db: Database): void {
  db.transaction(() => {
    let home = db.query("SELECT id FROM orgs WHERE is_home = 1").get() as { id: string } | null;
    if (!home) {
      home = { id: crypto.randomUUID() };
      const at = now();
      db.query("INSERT INTO orgs (id, name, is_home, created_at, updated_at) VALUES (?, 'My org', 1, ?, ?)").run(
        home.id,
        at,
        at,
      );
    }
    if (!db.query("SELECT id FROM people WHERE is_self = 1").get()) {
      const at = now();
      db.query(
        "INSERT INTO people (id, display_name, org_id, is_self, created_at, updated_at) VALUES (?, 'Me', ?, 1, ?, ?)",
      ).run(crypto.randomUUID(), home.id, at, at);
    }
  })();
}

function touchOrg(db: Database, id: string): void {
  db.query("UPDATE orgs SET updated_at = ? WHERE id = ?").run(now(), id);
}

export function touchPerson(db: Database, id: string): void {
  db.query("UPDATE people SET updated_at = ? WHERE id = ?").run(now(), id);
}

export function createOrg(db: Database, name: string): Org {
  const id = crypto.randomUUID();
  const at = now();
  db.query("INSERT INTO orgs (id, name, is_home, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(
    id,
    name.trim(),
    at,
    at,
  );
  return requireOrg(db, id);
}

export function renameOrg(db: Database, id: string, name: string): Org {
  requireOrg(db, id);
  db.query("UPDATE orgs SET name = ?, updated_at = ? WHERE id = ?").run(name.trim(), now(), id);
  return requireOrg(db, id);
}

/** Domains go with the org; its people move to No org (ON DELETE SET NULL). */
export function deleteOrg(db: Database, id: string): void {
  const org = requireOrg(db, id);
  if (org.isHome) throw new RosterConflictError(M.homeOrgDelete);
  db.query("DELETE FROM orgs WHERE id = ?").run(id);
}

export function addDomain(db: Database, orgId: string, raw: string): Org {
  const org = requireOrg(db, orgId);
  const domain = normalizeDomain(raw);
  if (!domain) throw new RosterConflictError(M.malformedDomain);
  if (isPublicEmailDomain(domain)) throw new RosterConflictError(M.publicDomain(domain));
  const owner = db
    .query("SELECT o.name FROM org_domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?")
    .get(domain) as { name: string } | null;
  if (owner) throw new RosterConflictError(M.domainTaken(domain, owner.name));
  db.query("INSERT INTO org_domains (domain, org_id) VALUES (?, ?)").run(domain, org.id);
  touchOrg(db, org.id);
  return requireOrg(db, org.id);
}

export function removeDomain(db: Database, orgId: string, raw: string): Org {
  requireOrg(db, orgId);
  const domain = normalizeDomain(raw) ?? raw;
  db.query("DELETE FROM org_domains WHERE domain = ? AND org_id = ?").run(domain, orgId);
  touchOrg(db, orgId);
  return requireOrg(db, orgId);
}

export function createPerson(db: Database, input: { name: string; orgId: string | null }): Person {
  if (input.orgId !== null) requireOrg(db, input.orgId);
  const id = crypto.randomUUID();
  const at = now();
  db.query(
    "INSERT INTO people (id, display_name, org_id, is_self, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  ).run(id, input.name.trim(), input.orgId, at, at);
  return requirePerson(db, id);
}

export function updatePerson(
  db: Database,
  id: string,
  patch: { name?: string; orgId?: string | null },
): Person {
  const person = requirePerson(db, id);
  const orgId = patch.orgId === undefined ? person.orgId : patch.orgId;
  if (orgId !== person.orgId) {
    if (person.isSelf) throw new RosterConflictError(M.selfOrg);
    if (orgId !== null) requireOrg(db, orgId);
  }
  const name = patch.name?.trim() || person.displayName;
  db.query("UPDATE people SET display_name = ?, org_id = ?, updated_at = ? WHERE id = ?").run(name, orgId, now(), id);
  return requirePerson(db, id);
}

/** Identities go with the person; so do their hand-added task rows (cascade). */
export function deletePerson(db: Database, id: string): void {
  const person = requirePerson(db, id);
  if (person.isSelf) throw new RosterConflictError(M.selfDelete);
  db.query("DELETE FROM people WHERE id = ?").run(id);
}

export function identityOwner(db: Database, identity: string): { id: string; displayName: string } | null {
  const row = db
    .query(
      "SELECT p.id, p.display_name FROM person_identities i JOIN people p ON p.id = i.person_id WHERE i.identity = ?",
    )
    .get(identity) as { id: string; display_name: string } | null;
  return row ? { id: row.id, displayName: row.display_name } : null;
}

export function addIdentity(db: Database, personId: string, raw: string): Person {
  const person = requirePerson(db, personId);
  const identity = normalizeIdentity(raw);
  if (!identity) throw new RosterConflictError(M.malformedIdentity);
  const owner = identityOwner(db, identity);
  if (owner) {
    throw new RosterConflictError(
      owner.id === person.id
        ? M.identityAlreadyOn(identity, owner.displayName)
        : M.identityOwned(identity, owner.displayName),
    );
  }
  db.query("INSERT INTO person_identities (identity, person_id) VALUES (?, ?)").run(identity, person.id);
  touchPerson(db, person.id);
  return requirePerson(db, person.id);
}

export function removeIdentity(db: Database, personId: string, raw: string): Person {
  requirePerson(db, personId);
  const identity = normalizeIdentity(raw) ?? raw;
  db.query("DELETE FROM person_identities WHERE identity = ? AND person_id = ?").run(identity, personId);
  touchPerson(db, personId);
  return requirePerson(db, personId);
}

/** People in No org who own an email identity on exactly this domain: the
 *  "move them?" suggestion after a domain is added to an org. */
export function unaffiliatedPeopleOnDomain(db: Database, raw: string): Person[] {
  const domain = normalizeDomain(raw);
  if (!domain) return [];
  const rows = db
    .query(
      `SELECT DISTINCT p.id, p.display_name FROM people p
         JOIN person_identities i ON i.person_id = p.id
        WHERE p.org_id IS NULL
          AND i.identity LIKE 'email:%'
          AND substr(i.identity, instr(i.identity, '@') + 1) = ?
        ORDER BY p.display_name`,
    )
    .all(domain) as { id: string }[];
  return rows.map((row) => requirePerson(db, row.id));
}

/** Accepts a domain suggestion. Only people still in No org move; anyone
 *  filed elsewhere in the meantime is left alone. */
export function movePeopleToOrg(db: Database, orgId: string, personIds: string[]): Person[] {
  requireOrg(db, orgId);
  return db.transaction(() => {
    const moved: Person[] = [];
    for (const id of personIds) {
      const result = db
        .query("UPDATE people SET org_id = ?, updated_at = ? WHERE id = ? AND org_id IS NULL AND is_self = 0")
        .run(orgId, now(), id);
      if (result.changes > 0) moved.push(requirePerson(db, id));
    }
    return moved;
  })();
}
