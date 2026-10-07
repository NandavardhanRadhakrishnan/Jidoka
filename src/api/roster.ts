import { Hono, type Context } from "hono";
import type { Database } from "bun:sqlite";
import { RosterConflictError, RosterNotFoundError } from "../domain/roster";
import {
  addDomain,
  addIdentity,
  createOrg,
  createPerson,
  deleteOrg,
  deletePerson,
  getRoster,
  movePeopleToOrg,
  removeDomain,
  removeIdentity,
  renameOrg,
  unaffiliatedPeopleOnDomain,
  updatePerson,
} from "../repo/roster";
import { createAndTagPerson, listParticipants, removeHumanParticipant, tagPerson } from "../repo/participants";
import { getTask } from "../repo/tasks";

export interface RosterRoutesDeps {
  db: Database;
}

/** The parsed JSON object body, or {} when the client sent something else. */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await c.req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Roster errors onto HTTP: conflicts are 409 with the user-facing message,
 *  unknown ids are 404. Anything else is a real bug and propagates. */
async function guarded(c: Context, fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RosterConflictError) return c.json({ error: error.message }, 409);
    if (error instanceof RosterNotFoundError) return c.json({ error: error.message }, 404);
    throw error;
  }
}

export function createRosterRoutes(deps: RosterRoutesDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  app.get("/api/roster", (c) => c.json(getRoster(db)));

  app.post("/api/orgs", async (c) => {
    const name = nonEmpty((await readBody(c)).name);
    if (!name) return c.json({ error: "name is required" }, 400);
    return c.json({ org: createOrg(db, name) });
  });

  app.patch("/api/orgs/:id", async (c) => {
    const name = nonEmpty((await readBody(c)).name);
    if (!name) return c.json({ error: "name is required" }, 400);
    return guarded(c, () => c.json({ org: renameOrg(db, c.req.param("id"), name) }));
  });

  app.delete("/api/orgs/:id", (c) =>
    guarded(c, () => {
      deleteOrg(db, c.req.param("id"));
      return c.json({ deleted: true });
    }),
  );

  app.post("/api/orgs/:id/domains", async (c) => {
    const domain = (await readBody(c)).domain;
    if (typeof domain !== "string") return c.json({ error: "domain is required" }, 400);
    return guarded(c, () => {
      const org = addDomain(db, c.req.param("id"), domain);
      return c.json({ org, suggestedMoves: unaffiliatedPeopleOnDomain(db, domain) });
    });
  });

  app.delete("/api/orgs/:id/domains/:domain", (c) =>
    guarded(c, () => c.json({ org: removeDomain(db, c.req.param("id"), c.req.param("domain")) })),
  );

  app.post("/api/orgs/:id/people", async (c) => {
    const personIds = (await readBody(c)).personIds;
    if (!Array.isArray(personIds) || !personIds.every((id) => typeof id === "string")) {
      return c.json({ error: "personIds must be a list of ids" }, 400);
    }
    return guarded(c, () => c.json({ moved: movePeopleToOrg(db, c.req.param("id"), personIds as string[]) }));
  });

  app.post("/api/people", async (c) => {
    const body = await readBody(c);
    const name = nonEmpty(body.name);
    if (!name) return c.json({ error: "name is required" }, 400);
    const orgId = typeof body.orgId === "string" ? body.orgId : null;
    return guarded(c, () => c.json({ person: createPerson(db, { name, orgId }) }));
  });

  app.patch("/api/people/:id", async (c) => {
    const body = await readBody(c);
    const patch: { name?: string; orgId?: string | null } = {};
    if (body.name !== undefined) {
      const name = nonEmpty(body.name);
      if (!name) return c.json({ error: "name can't be empty" }, 400);
      patch.name = name;
    }
    if (body.orgId !== undefined) {
      if (body.orgId !== null && typeof body.orgId !== "string") {
        return c.json({ error: "orgId must be an id or null" }, 400);
      }
      patch.orgId = body.orgId;
    }
    return guarded(c, () => c.json({ person: updatePerson(db, c.req.param("id"), patch) }));
  });

  app.delete("/api/people/:id", (c) =>
    guarded(c, () => {
      deletePerson(db, c.req.param("id"));
      return c.json({ deleted: true });
    }),
  );

  app.post("/api/people/:id/identities", async (c) => {
    const identity = (await readBody(c)).identity;
    if (typeof identity !== "string") return c.json({ error: "identity is required" }, 400);
    return guarded(c, () => c.json({ person: addIdentity(db, c.req.param("id"), identity) }));
  });

  app.delete("/api/people/:id/identities/:identity", (c) =>
    guarded(c, () => c.json({ person: removeIdentity(db, c.req.param("id"), c.req.param("identity")) })),
  );

  app.get("/api/tasks/:id/participants", (c) => {
    const taskId = c.req.param("id");
    if (!getTask(db, taskId)) return c.json({ error: `unknown task ${taskId}` }, 404);
    return c.json({ participants: listParticipants(db, taskId) });
  });

  app.post("/api/tasks/:id/participants", async (c) => {
    const taskId = c.req.param("id");
    const body = await readBody(c);
    return guarded(c, () => {
      if (typeof body.personId === "string") {
        tagPerson(db, taskId, body.personId);
      } else {
        const name = nonEmpty(body.name);
        if (!name) return c.json({ error: "personId or name is required" }, 400);
        const identity = nonEmpty(body.identity);
        createAndTagPerson(db, taskId, {
          name,
          ...(identity ? { identity } : {}),
          orgId: typeof body.orgId === "string" ? body.orgId : null,
        });
      }
      return c.json({ participants: listParticipants(db, taskId) });
    });
  });

  app.delete("/api/tasks/:id/participants/:pid", (c) =>
    guarded(c, () => {
      const taskId = c.req.param("id");
      removeHumanParticipant(db, taskId, c.req.param("pid"));
      return c.json({ participants: listParticipants(db, taskId) });
    }),
  );

  return app;
}
