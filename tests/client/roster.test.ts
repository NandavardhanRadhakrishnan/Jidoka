import { test, expect } from "bun:test";
import {
  checkDomainLocally,
  checkIdentityLocally,
  guessOrgForIdentity,
  offersCreate,
  peopleInGroup,
  pickerMatches,
  rosterSummary,
  sortOrgs,
} from "../../src/client/roster";
import type { Org, Person, Roster } from "../../src/domain/roster";

const at = "2026-10-07T00:00:00.000Z";
const org = (id: string, name: string, isHome = false, domains: string[] = []): Org => ({
  id,
  name,
  isHome,
  domains,
  createdAt: at,
  updatedAt: at,
});
const person = (
  id: string,
  displayName: string,
  orgId: string | null,
  identities: string[] = [],
  isSelf = false,
): Person => ({ id, displayName, orgId, isSelf, identities, createdAt: at, updatedAt: at });

const acme = org("o1", "Acme", true, ["acme.test"]);
const supplier = org("o2", "Supplier Ltd", false, ["supplier.test", "broker.test"]);
const northwind = org("o3", "Northwind");
const me = person("p0", "Me", "o1", ["github:me"], true);
const bob = person("p1", "Bob Smith", "o1", ["email:bob@acme.test"]);
const ana = person("p2", "Ana", "o1");
const dana = person("p3", "Dana Okoye", "o2", ["email:dana@supplier.test"]);
const ines = person("p4", "Ines", null);
const roster: Roster = { orgs: [supplier, northwind, acme], people: [bob, me, ana, dana, ines] };

test("sortOrgs pins your org, then alphabetical", () => {
  expect(sortOrgs(roster.orgs).map((o) => o.name)).toEqual(["Acme", "Northwind", "Supplier Ltd"]);
});

test("peopleInGroup puts Me first, then alphabetical; null is No org", () => {
  expect(peopleInGroup(roster.people, "o1").map((p) => p.displayName)).toEqual(["Me", "Ana", "Bob Smith"]);
  expect(peopleInGroup(roster.people, null).map((p) => p.displayName)).toEqual(["Ines"]);
});

test("rosterSummary counts with singulars", () => {
  expect(rosterSummary(roster)).toBe("3 orgs · 5 people");
  expect(rosterSummary({ orgs: [acme], people: [me] })).toBe("1 org · 1 person");
});

test("guessOrgForIdentity matches an exact email domain only", () => {
  expect(guessOrgForIdentity(roster.orgs, "email:j@broker.test")).toEqual({ org: supplier, domain: "broker.test" });
  expect(guessOrgForIdentity(roster.orgs, "email:j@eu.supplier.test")).toEqual({ org: null, domain: "eu.supplier.test" });
  expect(guessOrgForIdentity(roster.orgs, "github:j")).toEqual({ org: null, domain: null });
});

test("pickerMatches searches names and identities, excludes people on the task, caps at the limit", () => {
  expect(pickerMatches(roster.people, "dana", new Set()).map((p) => p.id)).toEqual(["p3"]);
  expect(pickerMatches(roster.people, "supplier.test", new Set()).map((p) => p.id)).toEqual(["p3"]);
  expect(pickerMatches(roster.people, "", new Set(["p0", "p1"])).map((p) => p.id)).toEqual(["p2", "p3", "p4"]);
  expect(pickerMatches(roster.people, "", new Set(), 2)).toHaveLength(2);
});

test("offersCreate only for a non-empty name nobody has", () => {
  expect(offersCreate(roster.people, "dana okoye")).toBe(false);
  expect(offersCreate(roster.people, "Sam")).toBe(true);
  expect(offersCreate(roster.people, "  ")).toBe(false);
});

test("checkDomainLocally mirrors the server's messages", () => {
  expect(checkDomainLocally(roster, "o1", "@Broker.test")).toEqual({ error: "broker.test is already on Supplier Ltd" });
  expect(checkDomainLocally(roster, "o1", "gmail.com")).toEqual({ error: "gmail.com is a public email domain" });
  expect(checkDomainLocally(roster, "o1", "nope")).toEqual({ error: "Enter a domain like acme.test" });
  expect(checkDomainLocally(roster, "o3", "Northwind.test")).toEqual({ value: "northwind.test" });
});

test("checkIdentityLocally mirrors the server's messages", () => {
  expect(checkIdentityLocally(roster, "p2", "email:bob@acme.test")).toEqual({
    error: "email:bob@acme.test belongs to Bob Smith",
  });
  expect(checkIdentityLocally(roster, "p1", "Email:BOB@acme.test")).toEqual({
    error: "email:bob@acme.test is already on Bob Smith",
  });
  expect(checkIdentityLocally(roster, "p2", "ana")).toEqual({ error: "Use namespace:value, e.g. email:bob@acme.test" });
  expect(checkIdentityLocally(roster, "p2", "github:ana")).toEqual({ value: "github:ana" });
});
