import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { SelectTrigger } from "./SelectTrigger";
import type { Org, ResolvedParticipant, Roster } from "../domain/roster";
import { guessOrgForIdentity, offersCreate, pickerMatches, sortOrgs } from "./roster";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function OrgBadge({ org }: { org: { name: string; isHome: boolean } | null }) {
  if (!org) return <span className="org-badge org-none">no org</span>;
  return <span className={`org-badge ${org.isHome ? "org-yours" : "org-external"}`}>{org.name}</span>;
}

export function TaskPeople({ taskId }: { taskId: string }) {
  const [participants, setParticipants] = useState<ResolvedParticipant[]>([]);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [picking, setPicking] = useState(false);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const [nextParticipants, nextRoster] = await Promise.all([api.participants(taskId), api.roster()]);
    setParticipants(nextParticipants);
    setRoster(nextRoster);
  }

  useEffect(() => {
    setPicking(false);
    setAddingFor(null);
    setError(null);
    reload().catch((e) => setError(message(e)));
  }, [taskId]);

  async function remove(participantId: string) {
    try {
      setParticipants(await api.removeParticipant(taskId, participantId));
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <section className="drawer-section">
      <div className="drawer-section-head">
        <h6>People</h6>
        <span className="mono count">{participants.length}</span>
        {/* The future "waiting on" chip goes first in this slot. */}
        <span className="slot">
          {!picking && (
            <button className="btn btn-ghost btn-xs" onClick={() => setPicking(true)}>
              <Icon name="user-plus" size={13} /> Add person
            </button>
          )}
        </span>
      </div>

      {picking && roster && (
        <PersonPicker
          taskId={taskId}
          roster={roster}
          participants={participants}
          onDone={async () => {
            setPicking(false);
            await reload();
          }}
          onCancel={() => setPicking(false)}
        />
      )}

      {participants.length === 0 ? (
        <p className="roster-note">The source didn't report anyone on this item.</p>
      ) : (
        <div className="participant-list">
          {participants.map((p) => (
            <div key={p.id} className="participant-item">
              <div className="participant-row">
                <span className="mono role">{p.role}</span>
                {p.person ? (
                  <>
                    <span className="name">{p.person.displayName}</span>
                    {p.person.isSelf && <span className="me-badge">me</span>}
                    <OrgBadge org={p.person.org} />
                    <span className="mono ident">{p.identity ?? p.person.identities[0] ?? ""}</span>
                    {p.addedBy === "human" && (
                      <button className="btn btn-ghost btn-xs" onClick={() => void remove(p.id)}>
                        Remove
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span className="mono raw-ident">{p.identity}</span>
                    {p.sourceName && <span className="as">as {p.sourceName}</span>}
                    {addingFor !== p.id && (
                      <button className="btn btn-ghost btn-xs participant-action" onClick={() => setAddingFor(p.id)}>
                        <Icon name="user-plus" size={13} /> Add to roster
                      </button>
                    )}
                  </>
                )}
              </div>
              {addingFor === p.id && roster && p.identity && (
                <AddToRosterForm
                  taskId={taskId}
                  identity={p.identity}
                  sourceName={p.sourceName ?? ""}
                  orgs={roster.orgs}
                  onDone={async () => {
                    setAddingFor(null);
                    await reload();
                  }}
                  onCancel={() => setAddingFor(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function AddToRosterForm({
  taskId,
  identity,
  sourceName,
  orgs,
  onDone,
  onCancel,
}: {
  taskId: string;
  identity: string;
  sourceName: string;
  orgs: Org[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const guess = guessOrgForIdentity(orgs, identity);
  const [name, setName] = useState(sourceName);
  const [editedIdentity, setEditedIdentity] = useState(identity);
  const [orgId, setOrgId] = useState(guess.org?.id ?? "");
  const [orgTouched, setOrgTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const org = orgs.find((o) => o.id === orgId);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.addParticipant(taskId, {
        name: name.trim(),
        ...(editedIdentity.trim() ? { identity: editedIdentity.trim() } : {}),
        orgId: orgId || null,
      });
      await onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="participant-add-form">
      <label className="roster-field">
        <span className="roster-label">Display name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="roster-field">
        <span className="roster-label">Identity</span>
        <input className="input mono" value={editedIdentity} onChange={(e) => setEditedIdentity(e.target.value)} />
      </label>
      <div className="roster-field-row">
        <SelectTrigger
          label="org"
          display={<span className="mono">{org ? org.name : "No org"}</span>}
          value={orgId}
          ariaLabel="Org"
          onChange={(value) => {
            setOrgId(value);
            setOrgTouched(true);
          }}
        >
          {sortOrgs(orgs).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value="">No org</option>
        </SelectTrigger>
        {!orgTouched && guess.domain && (
          <span className="roster-note">
            {guess.org ? `Guessed from ${guess.domain}` : `No org has ${guess.domain}`}
          </span>
        )}
      </div>
      <div className="roster-actions">
        <button className="btn btn-secondary btn-sm" disabled={!name.trim() || busy} onClick={() => void submit()}>
          <Icon name="user-plus" size={13} /> Add to roster
        </button>
        <button className="btn btn-ghost btn-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function PersonPicker({
  taskId,
  roster,
  participants,
  onDone,
  onCancel,
}: {
  taskId: string;
  roster: Roster;
  participants: ResolvedParticipant[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const onTask = new Set(participants.flatMap((p) => (p.person ? [p.person.id] : [])));
  const matches = pickerMatches(roster.people, query, onTask);
  const canCreate = offersCreate(roster.people, query);
  const orgById = new Map(roster.orgs.map((o) => [o.id, o]));

  async function add(input: { personId: string } | { name: string }) {
    try {
      await api.addParticipant(taskId, input);
      await onDone();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="participant-picker">
      <div className="roster-add-row">
        <input
          className="input"
          autoFocus
          placeholder="Find someone in the roster, or type a new name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-ghost btn-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {matches.map((person) => (
        <button key={person.id} className="participant-pick" onClick={() => void add({ personId: person.id })}>
          <span className="name">{person.displayName}</span>
          {person.isSelf && <span className="me-badge">me</span>}
          <OrgBadge org={person.orgId ? (orgById.get(person.orgId) ?? null) : null} />
          <span className="mono ident">{person.identities[0] ?? "no identities"}</span>
        </button>
      ))}
      {canCreate && (
        <button className="participant-pick create" onClick={() => void add({ name: query.trim() })}>
          <span className="name">Create “{query.trim()}”</span>
          <span className="roster-note">Adds them to the roster with no org and no identities.</span>
        </button>
      )}
      {!matches.length && !canCreate && <p className="roster-note">Everyone in the roster is already on this task.</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
