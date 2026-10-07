import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { insertTask, deleteTask } from "../../src/repo/tasks";
import * as roster from "../../src/repo/roster";
import {
  createAndTagPerson,
  listParticipants,
  moveParticipants,
  removeHumanParticipant,
  tagPerson,
  upsertSourceParticipants,
} from "../../src/repo/participants";
import { RosterConflictError } from "../../src/domain/roster";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  roster.ensureRosterDefaults(db);
  return db;
}

function newTask(db: ReturnType<typeof freshDb>, externalId = "m1") {
  return insertTask(db, { sourceId: "src", externalId, title: "T", body: "B" });
}

test("source participants resolve to people at read time, including people added later", () => {
  const db = freshDb();
  const task = newTask(db);
  upsertSourceParticipants(db, task.id, [{ identity: "email:bob@acme.test", name: "Bob S", role: "from" }]);

  const [before] = listParticipants(db, task.id);
  expect(before).toMatchObject({ identity: "email:bob@acme.test", sourceName: "Bob S", addedBy: "source", person: null });

  const supplier = roster.createOrg(db, "Supplier Ltd");
  const bob = roster.createPerson(db, { name: "Bob Smith", orgId: supplier.id });
  roster.addIdentity(db, bob.id, "email:bob@acme.test");

  const [after] = listParticipants(db, task.id);
  expect(after?.person).toMatchObject({
    id: bob.id,
    displayName: "Bob Smith",
    isSelf: false,
    org: { id: supplier.id, name: "Supplier Ltd", isHome: false },
  });
});

test("the same identity and role is stored once; another role is another row", () => {
  const db = freshDb();
  const task = newTask(db);
  upsertSourceParticipants(db, task.id, [
    { identity: "github:bob", role: "author" },
    { identity: "github:bob", role: "author" },
  ]);
  upsertSourceParticipants(db, task.id, [
    { identity: "github:bob", role: "author" },
    { identity: "github:bob", role: "commenter" },
  ]);

  expect(listParticipants(db, task.id).map((p) => p.role)).toEqual(["author", "commenter"]);
});

test("tagPerson adds a hand-added row unless the person is already on the task", () => {
  const db = freshDb();
  const task = newTask(db);
  const bob = roster.createPerson(db, { name: "Bob", orgId: null });
  roster.addIdentity(db, bob.id, "github:bob");
  const priya = roster.createPerson(db, { name: "Priya", orgId: roster.getHomeOrg(db).id });
  upsertSourceParticipants(db, task.id, [{ identity: "github:bob", role: "author" }]);

  tagPerson(db, task.id, bob.id);
  tagPerson(db, task.id, priya.id);
  tagPerson(db, task.id, priya.id);

  const rows = listParticipants(db, task.id);
  expect(rows.map((p) => [p.role, p.addedBy, p.person?.displayName])).toEqual([
    ["author", "source", "Bob"],
    ["added", "human", "Priya"],
  ]);
});

test("createAndTagPerson with the source's identity turns the unknown row known, without a second row", () => {
  const db = freshDb();
  const task = newTask(db);
  upsertSourceParticipants(db, task.id, [{ identity: "email:jide@supplier.test", name: "Jide", role: "cc" }]);

  const jide = createAndTagPerson(db, task.id, { name: "Jide Okafor", identity: "email:jide@supplier.test" });

  const rows = listParticipants(db, task.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.person?.id).toBe(jide.id);
});

test("createAndTagPerson with an edited identity still puts the person on the task", () => {
  const db = freshDb();
  const task = newTask(db);
  upsertSourceParticipants(db, task.id, [{ identity: "email:jide@supplier.test", role: "cc" }]);

  const jide = createAndTagPerson(db, task.id, { name: "Jide", identity: "email:j.okafor@supplier.test" });

  const rows = listParticipants(db, task.id);
  expect(rows.map((p) => [p.addedBy, p.person?.id ?? null])).toEqual([
    ["source", null],
    ["human", jide.id],
  ]);
});

test("createAndTagPerson rolls back the new person when the identity is taken", () => {
  const db = freshDb();
  const task = newTask(db);
  const bob = roster.createPerson(db, { name: "Bob Smith", orgId: null });
  roster.addIdentity(db, bob.id, "email:bob@acme.test");
  const peopleBefore = roster.listPeople(db).length;

  expect(() => createAndTagPerson(db, task.id, { name: "Robert", identity: "email:bob@acme.test" })).toThrow(
    RosterConflictError,
  );
  expect(roster.listPeople(db)).toHaveLength(peopleBefore);
  expect(listParticipants(db, task.id)).toEqual([]);
});

test("only hand-added rows can be removed", () => {
  const db = freshDb();
  const task = newTask(db);
  upsertSourceParticipants(db, task.id, [{ identity: "github:bob", role: "author" }]);
  tagPerson(db, task.id, roster.getSelf(db).id);
  const [source, human] = listParticipants(db, task.id);

  expect(() => removeHumanParticipant(db, task.id, source!.id)).toThrow("People reported by the source can't be removed");
  removeHumanParticipant(db, task.id, human!.id);
  expect(listParticipants(db, task.id).map((p) => p.addedBy)).toEqual(["source"]);
});

test("deleting a person drops their hand-added rows and unresolves their source rows", () => {
  const db = freshDb();
  const task = newTask(db);
  const bob = roster.createPerson(db, { name: "Bob", orgId: null });
  roster.addIdentity(db, bob.id, "github:bob");
  const dana = roster.createPerson(db, { name: "Dana", orgId: null });
  upsertSourceParticipants(db, task.id, [{ identity: "github:bob", role: "author" }]);
  tagPerson(db, task.id, dana.id);

  roster.deletePerson(db, bob.id);
  roster.deletePerson(db, dana.id);

  const rows = listParticipants(db, task.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ identity: "github:bob", person: null });
});

test("moveParticipants copies rows without duplicating people already on the target", () => {
  const db = freshDb();
  const target = newTask(db, "m0");
  const dup = newTask(db, "m1");
  const bob = roster.createPerson(db, { name: "Bob", orgId: null });
  roster.addIdentity(db, bob.id, "github:bob");
  upsertSourceParticipants(db, target.id, [{ identity: "github:bob", role: "author" }]);
  upsertSourceParticipants(db, dup.id, [
    { identity: "github:bob", role: "author" },
    { identity: "github:carol", role: "commenter" },
  ]);
  tagPerson(db, dup.id, bob.id); // no-op: Bob already resolves on dup
  tagPerson(db, dup.id, roster.getSelf(db).id);

  moveParticipants(db, dup.id, target.id);
  moveParticipants(db, dup.id, target.id);

  expect(listParticipants(db, target.id).map((p) => [p.role, p.identity ?? p.person?.displayName])).toEqual([
    ["author", "github:bob"],
    ["commenter", "github:carol"],
    ["added", "Me"],
  ]);
});

test("deleting a task deletes its participants", () => {
  const db = freshDb();
  const task = newTask(db);
  upsertSourceParticipants(db, task.id, [{ identity: "github:bob", role: "author" }]);
  deleteTask(db, task.id);
  expect(db.query("SELECT COUNT(*) AS n FROM task_participants").get()).toEqual({ n: 0 });
});

test("a hand-added person later reported by the source is listed once, by the source row", () => {
  const db = freshDb();
  const task = newTask(db);
  const bob = roster.createPerson(db, { name: "Bob", orgId: null });
  roster.addIdentity(db, bob.id, "github:bob");
  tagPerson(db, task.id, bob.id);

  upsertSourceParticipants(db, task.id, [{ identity: "github:bob", role: "commenter" }]);

  expect(listParticipants(db, task.id).map((p) => [p.role, p.addedBy, p.person?.displayName])).toEqual([
    ["commenter", "source", "Bob"],
  ]);
});
