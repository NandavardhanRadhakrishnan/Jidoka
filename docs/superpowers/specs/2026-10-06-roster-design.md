# Roster: people, orgs and task participants

**Status:** design approved, not yet planned/implemented.

## Motivation

Backlog item 1 (waiting state, scheduled re-checks, SLAs and escalation) needs to say *who* a task is waiting on, and to recognise when that person replies. Jidoka has no notion of people at all: the connected user exists only implicitly, as `extensions.resolved_identity` per extension, and nobody else exists anywhere. This spec adds the roster that the waiting design builds on. Waiting itself is a separate spec.

Jidoka is single-user today and will become multiplayer. The roster is shaped so that move needs no redesign: the user is a roster person like any other, and the home org is the future workspace.

## Scope

**In scope:**
- Orgs (one flagged as the user's own), their email domains, people, and people's namespaced identities.
- Task participants: who a source reports on an item, plus people the user tags by hand.
- A `participants` field on the source contract, taught to the extension generator.
- `getIdentity` results filed onto the user's own roster person.
- A People screen and a People section in the task drawer (designed in Claude Design; see UI).

**Explicitly out of scope, decided during brainstorming:**
1. **Waiting on a person or org.** The next spec. The UI reserves room for a "waiting on" chip.
2. **AI extraction of participants.** Participants come from the source or from the user, never from a model guessing addresses.
3. **Auto-adding people.** Unknown participants are offered as "Add to roster", one confirmation at a time. Nothing is written to the roster without the user.
4. **Free-form reference data for the roster.** `docs/superpowers/specs/2026-09-19-reference-data-sets-design.md` modelled a team roster as a JSON blob for prompts. That can't enforce uniqueness or join a sender to a person, so this spec supersedes it for the roster use case. (Reference data for other uses is untouched.)
5. **Moving the "your org" flag.** The home org exists from first startup and is renamed, never switched. In multiplayer it is the workspace, and workspaces don't change company.
6. **Merging duplicate people.** Remove the identity from one and add it to the other.
7. **A `workspace_id` column.** No other table has one; tenancy is a whole-database migration later, and adding it to the roster alone buys nothing.
8. **Using the roster in the relevance check or in prompts.** `extensions.resolved_identity` keeps serving the relevance check unchanged. Feeding roster names into triage or rule prompts is a later idea.
9. **First-run setup.** Naming your org and confirming who you are belongs to the app's first-run flow, recorded as backlog item 9. Until it exists, the startup defaults below are the fallback.

## Concepts

- **Org**: a relationship group seen from the user's org, not a legal company. A vendor's broker or tech partner at a different domain still belongs in the vendor's org. Exactly one org is the user's own (**Your org**); it always exists, can be renamed, and can't be deleted.
- **Org domain**: an email domain attached to an org (`supplier.test`). Domains are only a hint for attributing senders who aren't in the roster. A domain belongs to at most one org (an ambiguous domain would attribute replies to the wrong party, so it's left off every org). Public webmail domains can't be added.
- **Person**: a display name and an optional org. Display names are not unique. The stored org is always confirmed by the user; a domain can *suggest* it but never changes it on its own (see "Domains suggest, never move").
- **Identity**: `namespace:value`, owned by exactly one person: `email:bob@acme.test`, `github:bobsmith`. Namespaces name a *system*, not an extension instance, so the same Bob is matched whether he arrives through an Outlook source, a Gmail source or an MCP server. A person may have no identities (someone dealt with by phone).
- **Me**: the person who is the user. Lives in Your org, always exists, can be renamed, can't be deleted, and gains identities automatically when extensions connect.
- **Participant**: a row tying a person to a task. Source rows carry a raw identity and a role; the person is resolved by joining on the identity when the task is read. Hand-added rows point straight at a person.

Matching happens at read time, not at write time: adding Bob to the roster next week makes every earlier task he was on show him, with no backfill.

### Domains suggest, never move

A person's org is not derived live from their email domain, for four reasons:
1. A person can have addresses on several domains that sit on different orgs, so a derived org has no single answer.
2. Adding a domain to an org would silently reclassify people already filed elsewhere, and once waiting and escalation exist, a person's org (yours or external) changes how their tasks behave.
3. People with no email identity (GitHub-only, phone-only) would have no org.
4. In multiplayer, Your org is the workspace, and "anyone with an @acme.test address is one of us" is a domain auto-join that must be an explicit opt-in, not a side effect of the data model.

Domains are used as suggestions at the two moments they help:
- **On creation:** "Add to roster" prefills the org whose domains contain the identity's email domain (the handoff's "Guessed from …").
- **On adding a domain:** if people in No org have an email identity on that domain, Jidoka offers to move them: *"2 people in No org have @supplier.test addresses. Move them to Supplier Ltd?"* It only offers people in No org, never anyone already in an org, and nothing moves until the user clicks.

## Data model

**`src/db/migrations.ts`** appends:

```sql
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_home INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
CREATE UNIQUE INDEX IF NOT EXISTS orgs_one_home ON orgs (is_home) WHERE is_home = 1

CREATE TABLE IF NOT EXISTS org_domains (
  domain TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
CREATE UNIQUE INDEX IF NOT EXISTS people_one_self ON people (is_self) WHERE is_self = 1

CREATE TABLE IF NOT EXISTS person_identities (
  identity TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS task_participants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  identity TEXT,
  person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
  name TEXT,
  role TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (identity IS NOT NULL OR person_id IS NOT NULL)
)
CREATE UNIQUE INDEX IF NOT EXISTS task_participants_source
  ON task_participants (task_id, identity, role) WHERE added_by = 'source'
CREATE UNIQUE INDEX IF NOT EXISTS task_participants_human
  ON task_participants (task_id, person_id) WHERE added_by = 'human'
CREATE INDEX IF NOT EXISTS task_participants_identity ON task_participants (identity)
```

- The primary keys on `org_domains.domain` and `person_identities.identity` enforce "one domain, one org" and "one identity, one person".
- `is_self` lives on `people` (mirroring `is_home` on `orgs`) rather than in settings: settings is the config overlay of environment variables, and keeping both flags in the roster tables keeps the roster self-contained. Code never reads `is_self` directly; it calls `getSelf()` (below), which becomes "the signed-in user's person" in multiplayer.
- Source rows: `identity` set, `person_id` null, `name` is the source's display name, `role` is one of the participant roles, `added_by = 'source'`.
- Hand-added rows: `person_id` set, `identity` null, `role = 'added'`, `added_by = 'human'`.

**`src/domain/roster.ts`** (new): the types and every validation rule, so the repo, the API and the poller share one definition.

```ts
export type ParticipantRole = "from" | "to" | "cc" | "author" | "assignee" | "commenter";

export interface Org { id: string; name: string; isHome: boolean; domains: string[]; createdAt: string; updatedAt: string }
export interface Person { id: string; displayName: string; orgId: string | null; isSelf: boolean; identities: string[]; createdAt: string; updatedAt: string }
export interface Roster { orgs: Org[]; people: Person[] }

export interface ResolvedParticipant {
  id: string;
  role: ParticipantRole | "added";
  addedBy: "source" | "human";
  /** The raw identity a source reported; null on hand-added rows. */
  identity: string | null;
  /** The source's display name for an unresolved identity. */
  sourceName: string | null;
  person: {
    id: string; displayName: string; isSelf: boolean; identities: string[];
    org: { id: string; name: string; isHome: boolean } | null;
  } | null;
}

/** Lowercases the namespace, and the whole value for `email:`. Returns null when malformed. */
export function normalizeIdentity(raw: string): string | null;
/** Lowercases, trims, strips a leading "@". Returns null when not a domain. */
export function normalizeDomain(raw: string): string | null;
export function isPublicEmailDomain(domain: string): boolean;
export function emailDomainOf(identity: string): string | null;

export class RosterConflictError extends Error {}
```

- Identity format: namespace matches `/^[a-z0-9][a-z0-9_-]*$/`, the value is non-empty, and an `email:` value must contain exactly one `@` with a valid domain after it.
- Public domains: `gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, yahoo.com, icloud.com, me.com, aol.com, proton.me, protonmail.com, gmx.com`.

## Repo

**`src/repo/roster.ts`** (new) holds all roster SQL:

- Orgs: `listOrgs`, `createOrg`, `renameOrg`, `deleteOrg` (refuses the home org), `addDomain`, `removeDomain`.
- `unaffiliatedPeopleOnDomain(db, domain): Person[]`: people with `org_id IS NULL` who own an `email:` identity on exactly that domain.
- `movePeopleToOrg(db, orgId, personIds)`: one transaction; moves only people who are still in No org, and returns those it moved.
- People: `createPerson`, `updatePerson` (name, org), `deletePerson` (refuses Me), `addIdentity`, `removeIdentity`.
- `getRoster(db): Roster`, one payload for the People screen.
- `getSelf(db): Person`.
- `ensureRosterDefaults(db)`: called from `src/main.ts` right after `migrate()`. Creates the home org ("My org") and Me ("Me", in that org) when either is missing. Idempotent.
- Participants:
  - `upsertSourceParticipants(db, taskId, participants)`: `INSERT OR IGNORE` against the source unique index.
  - `addHumanParticipant(db, taskId, personId)`.
  - `removeHumanParticipant(db, taskId, participantId)`: refuses source rows.
  - `listParticipants(db, taskId): ResolvedParticipant[]`: source rows `LEFT JOIN person_identities` on `identity`, then `people` and `orgs`; hand-added rows join on `person_id`.
  - `moveParticipants(db, fromTaskId, toTaskId)`: `INSERT OR IGNORE` copies.

Every conflict throws `RosterConflictError` with the exact user-facing message:

| Case | Message |
|---|---|
| Identity owned by someone else | `email:bob@acme.test belongs to Bob Smith` |
| Identity already on this person | `email:bob@acme.test is already on Bob Smith` |
| Domain on another org | `broker.test is already on Supplier Ltd` |
| Public webmail domain | `gmail.com is a public email domain` |
| Malformed identity | `Use namespace:value, e.g. email:bob@acme.test` |
| Malformed domain | `Enter a domain like acme.test` |
| Deleting the home org | `Your org can't be deleted` |
| Deleting Me | `You can't delete yourself from the roster` |

Deleting an org cascades its domains and moves its people to No org (`ON DELETE SET NULL`).

## Source contract and ingestion

**`src/sources/types.ts`**: `RawItem` gains

```ts
/** People on this item, as the source system reports them. Identities are
 *  namespaced by system ("email:bob@acme.test", "github:bobsmith"); prefer
 *  a stable identifier (address, login) over a display name. Omit when the
 *  system reports nobody; the user can still tag people by hand. */
participants?: { identity: string; name?: string; role: ParticipantRole }[];
```

**`src/sources/poller.ts`**:
- New items: the task and its participants are inserted in one transaction. Each participant goes through `normalizeIdentity`; a malformed one, or one with an unknown role, is dropped with a single `console.warn` naming the source. It never fails the poll.
- Already-known items: their participants are upserted on every poll that reports them, regardless of state or revision. The upsert is idempotent, so a naive source that returns the same items every tick writes nothing new, and a new commenter on a reopened item is recorded even when the relevance check declines the reopen. Nothing is ever removed by a poll, and hand-added rows are never touched.
- `NewTask` gains `participants?` so `insertTask` can write them in its transaction.

**Task merge** (`mergeTasks` in `src/orchestrator.ts`): the duplicate is deleted, which would cascade its participants away, so `moveParticipants(duplicate → target)` runs first.

## Extensions

**Generator** (`src/extensions/generator.ts` prompt):
- The `RawItem` description gains `participants`, with a rule along these lines: *"When items have people on them (sender, recipients, author, assignees, commenters), return them in `participants` with a role, using namespaced identities: `email:` for addresses, `<system>:` for logins (`github:octocat`). Prefer stable identifiers over display names, and put the display name in `name`."*
- The `getIdentity` instruction changes to return a namespaced identity (`github:octocat`, `email:you@acme.test`).
- The shape check does not verify participants: it only calls `createSource` with a stub token, and calling `poll` would hit the network. The poller's validation (drop and warn) is the runtime guard.

**Your own identities** (`refreshIdentity` in `src/api/extensions.ts`): after `setResolvedIdentity`, if the identity normalizes as namespaced, `addIdentity(getSelf(db).id, identity)`.
- Already on Me: no-op.
- Owned by another person: `console.warn` and skip. The connect still succeeds.
- A bare (un-namespaced) result from an older extension is still stored for the relevance check, but isn't added to the roster.

**`extensions/github-issues-test/source.ts`** (local, untracked): return `github:<login>` from `getIdentity`, and report the author, assignees and commenters as participants. This exercises the convention live before the email extension exists.

## API

**`src/api/roster.ts`** (new route module, mounted like `src/api/extensions.ts`):

```
GET    /api/roster                          Roster
POST   /api/orgs                            { name } → Org
PATCH  /api/orgs/:id                        { name }
DELETE /api/orgs/:id
POST   /api/orgs/:id/domains                { domain } → { org, suggestedMoves: Person[] }
DELETE /api/orgs/:id/domains/:domain
POST   /api/orgs/:id/people                 { personIds } → { moved: Person[] }   accepts a domain suggestion
POST   /api/people                          { name, orgId: string | null } → Person
PATCH  /api/people/:id                      { name?, orgId? }
DELETE /api/people/:id
POST   /api/people/:id/identities           { identity }
DELETE /api/people/:id/identities/:identity
GET    /api/tasks/:id/participants          { participants: ResolvedParticipant[] }
POST   /api/tasks/:id/participants          { personId } | { name, identity?, orgId? }
DELETE /api/tasks/:id/participants/:pid     hand-added rows only
```

- `RosterConflictError` maps to `409 { error: message }`. An unknown id returns 404.
- The `{ name, identity?, orgId? }` form of `POST /api/tasks/:id/participants` backs both "Add to roster" on an unknown row and "Create" in the picker. In one transaction it creates the person, adds the identity when given, and then adds a hand-added row **only if no participant on this task already resolves to that person**. Adding to roster from an unknown source row therefore turns that row known instead of duplicating it, and if the user edited the prefilled identity, the person still ends up on the task.

## UI

Designed in Claude Design, project `Jidoka` (`f9eff891-e467-4c9a-be09-0e44d889c08d`). The handoff is `design_handoff_roster/README.md` in that project, synced against main on 2026-10-06. It is the UI spec: a People screen between "Types & rules" and "Extensions", a People section in the task drawer between "Merged from" and "Task content", the exact copy and empty states, the class list for `modernist.css`, five new Lucide icons, and 13 acceptance checks.

**Addition not in the handoff: the domain suggestion.** When `POST /api/orgs/:id/domains` returns a non-empty `suggestedMoves`, the org detail shows a notice under the domains add row, styled like `.roster-intro`: *"2 people in No org have @supplier.test addresses. Move them to Supplier Ltd?"* (singular for one), listing their names, with `[Move them]` (`.btn-secondary`, small) and `[Not now]` (ghost). Move calls `POST /api/orgs/:id/people` and reloads the roster; Not now dismisses it. The notice isn't persisted: it appears only right after the domain is added.

Two deliberate deviations from the handoff:
- **Hover styles follow the repo.** The handoff asks for ramp-token hovers (`--color-neutral-200`, `--color-accent-100`). `modernist.css` uses `color-mix()` tints for row and ghost hovers almost everywhere (`.type-row`, `.pane-row`, `.btn-ghost`), so the new classes do too. `.participant-pick` copies `.candidate-btn`, which already uses `accent-100`, so it keeps that.
- **Pure helpers move out of components.** Guessing an org from a domain, filtering and sorting the picker, and sorting the org list live in `src/client/roster.ts` so they can be tested, like `columns.ts` and `search.ts`.

## Error handling

- Every validation rule lives in `src/domain/roster.ts`. The client pre-checks with the same strings to save a round trip, but the server is authoritative.
- Roster problems never break ingestion or connecting: malformed participants are dropped with a warning, and an identity conflict on connect is logged and skipped.
- `ensureRosterDefaults` makes "no home org" and "no Me" unreachable, so no other code handles those cases.

## Testing

All in-memory database, no network, following the existing layout:
- `tests/domain/roster.test.ts`: identity and domain normalization, malformed input, public domains, `emailDomainOf`.
- `tests/repo/roster.test.ts`:
  - each uniqueness rule and its message
  - deleting an org moves its people to No org and drops its domains
  - the home org and Me can't be deleted
  - `ensureRosterDefaults` run twice leaves one home org and one Me
  - read-time resolution: an identity added after ingestion resolves an earlier task's participant
  - `moveParticipants`
  - `unaffiliatedPeopleOnDomain` finds only No-org people on that exact domain (not a subdomain, not people already in an org); `movePeopleToOrg` skips anyone who joined an org in the meantime
- `tests/sources/poller.test.ts`: participants written with a new task, upserted for a known item without duplicates, malformed ones dropped.
- `tests/orchestrator.test.ts`: merging tasks keeps the duplicate's participants.
- `tests/api/extensions.test.ts`: a namespaced `getIdentity` lands on Me, a bare one doesn't, and an identity owned by someone else doesn't fail the connect.
- `tests/api/roster.test.ts`: every route, each 409 string, the add-to-roster no-duplicate rule (with the prefilled identity and with an edited one), and adding a domain returns `suggestedMoves` without moving anyone.
- `tests/client/roster.test.ts`: the pure helpers.
- `tests/db/migrations.test.ts`: the new tables and partial indexes exist, and `migrate()` stays re-runnable.

**Live check:** reconnect the GitHub test extension and confirm Me gains `github:<you>`, then open a real issue's task and confirm its author and commenters appear in the drawer, known or offered as "Add to roster".
