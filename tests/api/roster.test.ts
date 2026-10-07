import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { createRosterRoutes } from "../../src/api/roster";
import { ensureRosterDefaults, getHomeOrg, getSelf } from "../../src/repo/roster";
import { insertTask } from "../../src/repo/tasks";
import { upsertSourceParticipants } from "../../src/repo/participants";

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  ensureRosterDefaults(db);
  const app = createRosterRoutes({ db });
  async function call(method: string, path: string, body?: unknown) {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  return { db, call };
}

test("GET /api/roster returns the defaults", async () => {
  const { call } = setup();
  const { status, body } = await call("GET", "/api/roster");
  expect(status).toBe(200);
  expect(body.orgs.map((o: any) => o.name)).toEqual(["My org"]);
  expect(body.people.map((p: any) => p.displayName)).toEqual(["Me"]);
});

test("orgs: create, rename, domains with suggestions, move, delete", async () => {
  const { call } = setup();
  const org = (await call("POST", "/api/orgs", { name: "Supplier Ltd" })).body.org;
  expect((await call("PATCH", `/api/orgs/${org.id}`, { name: "Supplier" })).body.org.name).toBe("Supplier");

  const jide = (await call("POST", "/api/people", { name: "Jide", orgId: null })).body.person;
  await call("POST", `/api/people/${jide.id}/identities`, { identity: "email:jide@supplier.test" });

  const added = await call("POST", `/api/orgs/${org.id}/domains`, { domain: "Supplier.test" });
  expect(added.status).toBe(200);
  expect(added.body.org.domains).toEqual(["supplier.test"]);
  expect(added.body.suggestedMoves.map((p: any) => p.id)).toEqual([jide.id]);
  // Adding a domain suggests; it never moves anyone by itself.
  expect((await call("GET", "/api/roster")).body.people.find((p: any) => p.id === jide.id).orgId).toBeNull();

  const moved = await call("POST", `/api/orgs/${org.id}/people`, { personIds: [jide.id] });
  expect(moved.body.moved.map((p: any) => p.orgId)).toEqual([org.id]);

  expect((await call("DELETE", `/api/orgs/${org.id}/domains/supplier.test`)).body.org.domains).toEqual([]);
  expect((await call("DELETE", `/api/orgs/${org.id}`)).body).toEqual({ deleted: true });
});

test("conflicts are 409 with the user-facing message; unknown ids are 404; bad bodies are 400", async () => {
  const { db, call } = setup();
  const home = getHomeOrg(db);
  expect(await call("POST", `/api/orgs/${home.id}/domains`, { domain: "gmail.com" })).toEqual({
    status: 409,
    body: { error: "gmail.com is a public email domain" },
  });
  expect(await call("DELETE", `/api/orgs/${home.id}`)).toEqual({
    status: 409,
    body: { error: "Your org can't be deleted" },
  });
  expect(await call("DELETE", `/api/people/${getSelf(db).id}`)).toEqual({
    status: 409,
    body: { error: "You can't delete yourself from the roster" },
  });
  expect((await call("PATCH", "/api/orgs/nope", { name: "X" })).status).toBe(404);
  expect((await call("POST", "/api/orgs", { name: "  " })).status).toBe(400);
  expect((await call("POST", `/api/orgs/${home.id}/people`, { personIds: "x" })).status).toBe(400);
});

test("identities with URL metacharacters are removed exactly", async () => {
  const { call } = setup();
  const ana = (await call("POST", "/api/people", { name: "Ana", orgId: null })).body.person;
  await call("POST", `/api/people/${ana.id}/identities`, { identity: "email:a+b@x.test" });
  await call("POST", `/api/people/${ana.id}/identities`, { identity: "email:ab@x.test" });

  const after = await call("DELETE", `/api/people/${ana.id}/identities/${encodeURIComponent("email:a+b@x.test")}`);

  expect(after.body.person.identities).toEqual(["email:ab@x.test"]);
});

test("participants: list, add to roster without duplicating, create, tag, remove", async () => {
  const { db, call } = setup();
  const task = insertTask(db, { sourceId: "src", externalId: "m1", title: "T", body: "B" });
  upsertSourceParticipants(db, task.id, [{ identity: "email:jide@supplier.test", name: "Jide", role: "cc" }]);

  const listed = await call("GET", `/api/tasks/${task.id}/participants`);
  expect(listed.body.participants).toHaveLength(1);
  expect(listed.body.participants[0].person).toBeNull();

  const added = await call("POST", `/api/tasks/${task.id}/participants`, {
    name: "Jide Okafor",
    identity: "email:jide@supplier.test",
    orgId: null,
  });
  expect(added.body.participants).toHaveLength(1);
  expect(added.body.participants[0].person.displayName).toBe("Jide Okafor");

  const created = await call("POST", `/api/tasks/${task.id}/participants`, { name: "Sam" });
  const sam = created.body.participants.find((p: any) => p.person?.displayName === "Sam");
  expect(sam.addedBy).toBe("human");

  const tagged = await call("POST", `/api/tasks/${task.id}/participants`, { personId: getSelf(db).id });
  expect(tagged.body.participants).toHaveLength(3);

  const removed = await call("DELETE", `/api/tasks/${task.id}/participants/${sam.id}`);
  expect(removed.body.participants).toHaveLength(2);

  const source = removed.body.participants.find((p: any) => p.addedBy === "source");
  expect((await call("DELETE", `/api/tasks/${task.id}/participants/${source.id}`)).status).toBe(409);
  expect((await call("GET", "/api/tasks/nope/participants")).status).toBe(404);
  expect((await call("POST", `/api/tasks/${task.id}/participants`, {})).status).toBe(400);
});
