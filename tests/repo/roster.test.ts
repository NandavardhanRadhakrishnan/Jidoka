import { test, expect, spyOn } from "bun:test";
import { openDb, migrate } from "../../src/db";
import * as roster from "../../src/repo/roster";
import { RosterConflictError, RosterNotFoundError } from "../../src/domain/roster";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  roster.ensureRosterDefaults(db);
  return db;
}

/** The message of the RosterConflictError `fn` throws; fails the test otherwise. */
function conflict(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RosterConflictError) return error.message;
    throw error;
  }
  throw new Error("expected a RosterConflictError");
}

test("ensureRosterDefaults creates one home org and one Me, and is idempotent", () => {
  const db = freshDb();
  roster.ensureRosterDefaults(db);

  const { orgs, people } = roster.getRoster(db);
  expect(orgs).toHaveLength(1);
  expect(orgs[0]).toMatchObject({ name: "My org", isHome: true, domains: [] });
  expect(people).toHaveLength(1);
  expect(people[0]).toMatchObject({ displayName: "Me", isSelf: true, orgId: orgs[0]!.id, identities: [] });
  expect(roster.getSelf(db).id).toBe(people[0]!.id);
  expect(roster.getHomeOrg(db).id).toBe(orgs[0]!.id);
});

test("domains are normalized, unique across orgs, and never public", () => {
  const db = freshDb();
  const supplier = roster.createOrg(db, "Supplier Ltd");

  expect(roster.addDomain(db, supplier.id, " @Supplier.TEST ").domains).toEqual(["supplier.test"]);
  expect(conflict(() => roster.addDomain(db, roster.getHomeOrg(db).id, "supplier.test"))).toBe(
    "supplier.test is already on Supplier Ltd",
  );
  expect(conflict(() => roster.addDomain(db, supplier.id, "supplier.test"))).toBe(
    "supplier.test is already on Supplier Ltd",
  );
  expect(conflict(() => roster.addDomain(db, supplier.id, "gmail.com"))).toBe("gmail.com is a public email domain");
  expect(conflict(() => roster.addDomain(db, supplier.id, "not a domain"))).toBe("Enter a domain like acme.test");
  expect(roster.removeDomain(db, supplier.id, "supplier.test").domains).toEqual([]);
});

test("the home org can't be deleted; deleting another moves its people to No org", () => {
  const db = freshDb();
  expect(conflict(() => roster.deleteOrg(db, roster.getHomeOrg(db).id))).toBe("Your org can't be deleted");

  const supplier = roster.createOrg(db, "Supplier Ltd");
  roster.addDomain(db, supplier.id, "supplier.test");
  const dana = roster.createPerson(db, { name: "Dana", orgId: supplier.id });
  roster.deleteOrg(db, supplier.id);

  expect(roster.getPerson(db, dana.id)?.orgId).toBeNull();
  const northwind = roster.createOrg(db, "Northwind");
  expect(roster.addDomain(db, northwind.id, "supplier.test").domains).toEqual(["supplier.test"]);
});

test("an identity belongs to one person", () => {
  const db = freshDb();
  const bob = roster.createPerson(db, { name: "Bob Smith", orgId: null });
  const priya = roster.createPerson(db, { name: "Priya", orgId: null });

  expect(roster.addIdentity(db, bob.id, "Email:Bob@Acme.test").identities).toEqual(["email:bob@acme.test"]);
  expect(conflict(() => roster.addIdentity(db, priya.id, "email:bob@acme.test"))).toBe(
    "email:bob@acme.test belongs to Bob Smith",
  );
  expect(conflict(() => roster.addIdentity(db, bob.id, "email:BOB@acme.test"))).toBe(
    "email:bob@acme.test is already on Bob Smith",
  );
  expect(conflict(() => roster.addIdentity(db, bob.id, "bob"))).toBe(
    "Use namespace:value, e.g. email:bob@acme.test",
  );
  expect(roster.removeIdentity(db, bob.id, "email:bob@acme.test").identities).toEqual([]);
});

test("Me can't be deleted or moved out of the home org; others can", () => {
  const db = freshDb();
  const me = roster.getSelf(db);
  const supplier = roster.createOrg(db, "Supplier Ltd");

  expect(conflict(() => roster.deletePerson(db, me.id))).toBe("You can't delete yourself from the roster");
  expect(conflict(() => roster.updatePerson(db, me.id, { orgId: supplier.id }))).toBe("You always belong to your org");
  expect(roster.updatePerson(db, me.id, { name: "  Priya R  " }).displayName).toBe("Priya R");

  const bob = roster.createPerson(db, { name: "Bob", orgId: null });
  roster.addIdentity(db, bob.id, "github:bob");
  expect(roster.updatePerson(db, bob.id, { orgId: supplier.id }).orgId).toBe(supplier.id);
  roster.deletePerson(db, bob.id);
  expect(roster.getPerson(db, bob.id)).toBeNull();
  // The identity went with him, so someone else can take it.
  expect(roster.addIdentity(db, me.id, "github:bob").identities).toEqual(["github:bob"]);
});

test("unknown ids raise RosterNotFoundError", () => {
  const db = freshDb();
  expect(() => roster.createPerson(db, { name: "X", orgId: "nope" })).toThrow(RosterNotFoundError);
  expect(() => roster.renameOrg(db, "nope", "X")).toThrow(RosterNotFoundError);
  expect(() => roster.addIdentity(db, "nope", "github:x")).toThrow(RosterNotFoundError);
});

test("unaffiliatedPeopleOnDomain finds only No-org people on exactly that domain", () => {
  const db = freshDb();
  const supplier = roster.createOrg(db, "Supplier Ltd");
  const loose = roster.createPerson(db, { name: "Jide", orgId: null });
  roster.addIdentity(db, loose.id, "email:jide@supplier.test");
  const sub = roster.createPerson(db, { name: "Sub", orgId: null });
  roster.addIdentity(db, sub.id, "email:sub@eu.supplier.test");
  const filed = roster.createPerson(db, { name: "Filed", orgId: supplier.id });
  roster.addIdentity(db, filed.id, "email:filed@supplier.test");

  expect(roster.unaffiliatedPeopleOnDomain(db, "supplier.test").map((p) => p.displayName)).toEqual(["Jide"]);
});

test("movePeopleToOrg moves only people still in No org", () => {
  const db = freshDb();
  const supplier = roster.createOrg(db, "Supplier Ltd");
  const northwind = roster.createOrg(db, "Northwind");
  const jide = roster.createPerson(db, { name: "Jide", orgId: null });
  const ana = roster.createPerson(db, { name: "Ana", orgId: northwind.id });

  const moved = roster.movePeopleToOrg(db, supplier.id, [jide.id, ana.id, roster.getSelf(db).id]);

  expect(moved.map((p) => p.displayName)).toEqual(["Jide"]);
  expect(roster.getPerson(db, ana.id)?.orgId).toBe(northwind.id);
});

test("addSelfIdentity files namespaced identities onto Me and never throws", () => {
  const db = freshDb();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const bob = roster.createPerson(db, { name: "Bob", orgId: null });
  roster.addIdentity(db, bob.id, "github:bob");

  expect(roster.addSelfIdentity(db, "github:me")).toBe("added");
  expect(roster.addSelfIdentity(db, "github:me")).toBe("already");
  expect(roster.addSelfIdentity(db, "octocat")).toBe("skipped");
  expect(roster.addSelfIdentity(db, "github:bob")).toBe("skipped");
  expect(roster.getSelf(db).identities).toEqual(["github:me"]);

  const bare = openDb(":memory:");
  migrate(bare); // no ensureRosterDefaults: there is no Me to file onto
  expect(roster.addSelfIdentity(bare, "github:me")).toBe("skipped");
  warn.mockRestore();
});
