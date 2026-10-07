import { test, expect } from "bun:test";
import {
  emailDomainOf,
  isParticipantRole,
  isPublicEmailDomain,
  normalizeDomain,
  normalizeIdentity,
  ROSTER_MESSAGES,
} from "../../src/domain/roster";

test("normalizeIdentity lowercases the namespace and whole email values", () => {
  expect(normalizeIdentity("Email:Bob@Acme.TEST")).toBe("email:bob@acme.test");
  expect(normalizeIdentity(" GitHub:Octocat ")).toBe("github:Octocat");
  expect(normalizeIdentity("slack:U123ABC")).toBe("slack:U123ABC");
});

test("normalizeIdentity rejects malformed identities", () => {
  for (const bad of [
    "octocat",
    ":octocat",
    "github:",
    "git hub:x",
    "github:bob smith",
    "email:not-an-address",
    "email:a@b@c.test",
    "email:a@nodot",
    "",
  ]) {
    expect(normalizeIdentity(bad)).toBeNull();
  }
});

test("normalizeDomain trims, lowercases and strips a leading @", () => {
  expect(normalizeDomain(" @Acme.Test ")).toBe("acme.test");
  expect(normalizeDomain("sub.acme.test")).toBe("sub.acme.test");
  expect(normalizeDomain("acme")).toBeNull();
  expect(normalizeDomain("http://acme.test")).toBeNull();
  expect(normalizeDomain("acme .test")).toBeNull();
});

test("isPublicEmailDomain knows the webmail list", () => {
  expect(isPublicEmailDomain("gmail.com")).toBe(true);
  expect(isPublicEmailDomain("proton.me")).toBe(true);
  expect(isPublicEmailDomain("acme.test")).toBe(false);
});

test("emailDomainOf only answers for email identities", () => {
  expect(emailDomainOf("email:bob@acme.test")).toBe("acme.test");
  expect(emailDomainOf("github:bob")).toBeNull();
});

test("isParticipantRole accepts exactly the six roles", () => {
  for (const role of ["from", "to", "cc", "author", "assignee", "commenter"]) {
    expect(isParticipantRole(role)).toBe(true);
  }
  expect(isParticipantRole("added")).toBe(false);
  expect(isParticipantRole("boss")).toBe(false);
  expect(isParticipantRole(undefined)).toBe(false);
});

test("messages read as the spec says", () => {
  expect(ROSTER_MESSAGES.identityOwned("email:bob@acme.test", "Bob Smith")).toBe(
    "email:bob@acme.test belongs to Bob Smith",
  );
  expect(ROSTER_MESSAGES.domainTaken("broker.test", "Supplier Ltd")).toBe("broker.test is already on Supplier Ltd");
  expect(ROSTER_MESSAGES.publicDomain("gmail.com")).toBe("gmail.com is a public email domain");
});
