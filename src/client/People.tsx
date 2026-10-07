import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { SelectTrigger } from "./SelectTrigger";
import type { Org, Person, Roster } from "../domain/roster";
import { checkDomainLocally, checkIdentityLocally, peopleInGroup, rosterSummary, sortOrgs } from "./roster";

type Selection = { kind: "org"; orgId: string } | { kind: "no-org" } | { kind: "person"; personId: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function People({ onSummaryChange }: { onSummaryChange: (summary: string) => void }) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function reload(): Promise<Roster> {
    const next = await api.roster();
    setRoster(next);
    onSummaryChange(rosterSummary(next));
    return next;
  }

  useEffect(() => {
    reload()
      .then((loaded) => {
        const home = loaded.orgs.find((o) => o.isHome);
        if (home) setSelection({ kind: "org", orgId: home.id });
      })
      .catch((error) => setLoadError(message(error)));
  }, []);

  if (loadError) return <p className="error-text roster-detail">{loadError}</p>;
  if (!roster || !selection) return null;

  const orgs = sortOrgs(roster.orgs);
  const person = selection.kind === "person" ? roster.people.find((p) => p.id === selection.personId) : undefined;
  const selectedOrg = selection.kind === "org" ? roster.orgs.find((o) => o.id === selection.orgId) : undefined;
  // Which left-column group is highlighted: an org id, null for No org, undefined for none.
  const activeGroup =
    selection.kind === "org" ? selection.orgId : selection.kind === "no-org" ? null : person ? person.orgId : undefined;
  const groupOf = (orgId: string | null): Selection => (orgId ? { kind: "org", orgId } : { kind: "no-org" });
  const selectPerson = (personId: string) => setSelection({ kind: "person", personId });

  async function addOrg() {
    const org = await api.createOrg("New org");
    await reload();
    setSelection({ kind: "org", orgId: org.id });
  }

  return (
    <div className="people-screen">
      <div className="org-list">
        {orgs.map((org) => (
          <button
            key={org.id}
            className={`org-row ${activeGroup === org.id ? "on" : ""}`}
            onClick={() => setSelection({ kind: "org", orgId: org.id })}
          >
            <span className="org-row-line">
              <span className="name">{org.name}</span>
              {org.isHome && <span className="yours-badge">your org</span>}
              <span className="mono count">{peopleInGroup(roster.people, org.id).length}</span>
            </span>
            <span className="mono domains">{org.domains.length ? org.domains.join(" · ") : "no domains"}</span>
          </button>
        ))}
        <button
          className={`org-row no-org ${activeGroup === null ? "on" : ""}`}
          onClick={() => setSelection({ kind: "no-org" })}
        >
          <span className="org-row-line">
            <span className="name">No org</span>
            <span className="mono count">{peopleInGroup(roster.people, null).length}</span>
          </span>
        </button>
        <div className="org-list-foot">
          <button className="btn btn-secondary btn-sm" onClick={() => void addOrg()}>
            <Icon name="plus" size={13} /> Add org
          </button>
        </div>
      </div>

      <div className="roster-detail">
        {person ? (
          <PersonDetail
            key={person.id}
            roster={roster}
            person={person}
            reload={reload}
            onBack={() => setSelection(groupOf(person.orgId))}
          />
        ) : selectedOrg ? (
          <OrgDetail
            key={selectedOrg.id}
            roster={roster}
            org={selectedOrg}
            reload={reload}
            onSelectPerson={selectPerson}
            onDeleted={() => setSelection({ kind: "no-org" })}
          />
        ) : (
          <>
            <div className="roster-head">
              <h3 className="roster-static-title">No org</h3>
            </div>
            <p className="roster-desc">People who don't belong to any org, such as a freelancer.</p>
            <GroupPeople roster={roster} orgId={null} emptyText="Nobody here." reload={reload} onSelectPerson={selectPerson} />
          </>
        )}
      </div>
    </div>
  );
}

/** A heading-sized input that saves on blur or Enter; an empty value reverts. */
function TitleInput({
  value,
  ariaLabel,
  onSave,
}: {
  value: string;
  ariaLabel: string;
  onSave: (next: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  function commit() {
    const next = draft.trim();
    if (!next) return setDraft(value);
    if (next !== value) void onSave(next);
  }

  return (
    <input
      className="input title-input"
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/** Chips with remove buttons plus an add row: shared by domains and identities. */
function ChipEditor({
  values,
  placeholder,
  emptyText,
  check,
  onAdd,
  onRemove,
}: {
  values: string[];
  placeholder: string;
  emptyText: string;
  check: (raw: string) => { value: string } | { error: string };
  onAdd: (value: string) => Promise<void>;
  onRemove: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const checked = check(draft);
    if ("error" in checked) return setError(checked.error);
    try {
      await onAdd(checked.value);
      setDraft("");
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <>
      {values.length ? (
        <div className="roster-chips">
          {values.map((value) => (
            <span key={value} className="mono roster-chip">
              {value}
              <button
                className="roster-chip-remove"
                aria-label={`Remove ${value}`}
                onClick={() => void onRemove(value).catch((e) => setError(message(e)))}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="roster-note">{emptyText}</p>
      )}
      <div className="roster-add-row">
        <input
          className="input mono"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <button className="btn btn-secondary btn-sm" disabled={!draft.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

function GroupPeople({
  roster,
  orgId,
  emptyText,
  reload,
  onSelectPerson,
}: {
  roster: Roster;
  orgId: string | null;
  emptyText: string;
  reload: () => Promise<Roster>;
  onSelectPerson: (personId: string) => void;
}) {
  const people = peopleInGroup(roster.people, orgId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    try {
      const person = await api.createPerson(name.trim(), orgId);
      await reload();
      onSelectPerson(person.id);
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <section className="roster-section">
      <h6 className="roster-section-head">
        People <span className="mono count">{people.length}</span>
      </h6>
      {people.length ? (
        <div>
          {people.map((p) => (
            <button key={p.id} className="roster-person-row" onClick={() => onSelectPerson(p.id)}>
              <span className="name">{p.displayName}</span>
              {p.isSelf && <span className="me-badge">me</span>}
              <span className="mono ident">
                {p.identities[0] ?? ""}
                {p.identities.length > 1 ? ` +${p.identities.length - 1}` : ""}
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
        </div>
      ) : (
        <p className="roster-note">{emptyText}</p>
      )}
      {adding ? (
        <div className="roster-add-row">
          <input
            className="input"
            autoFocus
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) void add();
            }}
          />
          <button className="btn btn-secondary btn-sm" disabled={!name.trim()} onClick={() => void add()}>
            Add
          </button>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => {
              setAdding(false);
              setName("");
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
            <Icon name="user-plus" size={13} /> Add person
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function DomainSuggestion({
  org,
  domain,
  people,
  onMoved,
  onDismiss,
}: {
  org: Org;
  domain: string;
  people: Person[];
  onMoved: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const lead =
    people.length === 1
      ? `1 person in No org has an @${domain} address.`
      : `${people.length} people in No org have @${domain} addresses.`;

  async function move() {
    try {
      await api.movePeopleToOrg(
        org.id,
        people.map((p) => p.id),
      );
      await onMoved();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="roster-suggestion">
      <p>
        {lead} Move them to {org.name}?
      </p>
      <p className="roster-note">{people.map((p) => p.displayName).join(", ")}</p>
      <div className="roster-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => void move()}>
          Move them
        </button>
        <button className="btn btn-ghost btn-xs" onClick={onDismiss}>
          Not now
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function OrgDetail({
  roster,
  org,
  reload,
  onSelectPerson,
  onDeleted,
}: {
  roster: Roster;
  org: Org;
  reload: () => Promise<Roster>;
  onSelectPerson: (personId: string) => void;
  onDeleted: () => void;
}) {
  const [suggestion, setSuggestion] = useState<{ domain: string; people: Person[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fresh = roster.orgs.length === 1 && roster.people.length === 1;

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <>
      <div className="roster-head">
        <TitleInput value={org.name} ariaLabel="Org name" onSave={(name) => act(() => api.patchOrg(org.id, name))} />
        {org.isHome ? (
          <span className="yours-badge">your org</span>
        ) : (
          <button
            className="btn btn-ghost btn-xs roster-danger"
            title="Its people move to No org"
            onClick={() =>
              void act(async () => {
                await api.deleteOrg(org.id);
                onDeleted();
              })
            }
          >
            Delete org
          </button>
        )}
      </div>
      <p className="roster-desc">
        {org.isHome
          ? "The people you work with. On a task, anyone in this org is shown as one of yours."
          : "An outside party you work with. Group people by relationship, not by legal company."}
      </p>
      {error && <p className="error-text">{error}</p>}
      {fresh && (
        <p className="roster-intro">
          Your roster starts with your org and you. People are added as they turn up on tasks, or by hand here.
        </p>
      )}

      <section className="roster-section">
        <h6>Email domains</h6>
        <ChipEditor
          values={org.domains}
          placeholder="add a domain, e.g. acme.test"
          emptyText={
            org.isHome
              ? "No domains yet. Add your company's email domain so new senders from it are suggested for this org."
              : "No domains. That's fine; people can still be added to this org by hand."
          }
          check={(raw) => checkDomainLocally(roster, org.id, raw)}
          onAdd={async (domain) => {
            const result = await api.addDomain(org.id, domain);
            await reload();
            setSuggestion(result.suggestedMoves.length ? { domain, people: result.suggestedMoves } : null);
          }}
          onRemove={async (domain) => {
            await api.removeDomain(org.id, domain);
            await reload();
          }}
        />
        {suggestion && (
          <DomainSuggestion
            org={org}
            domain={suggestion.domain}
            people={suggestion.people}
            onMoved={async () => {
              setSuggestion(null);
              await reload();
            }}
            onDismiss={() => setSuggestion(null)}
          />
        )}
        <p className="roster-note">
          Domains only suggest this org for unknown senders. A person's org is always set on the person.
        </p>
      </section>

      <GroupPeople
        roster={roster}
        orgId={org.id}
        emptyText="Nobody in this org yet."
        reload={reload}
        onSelectPerson={onSelectPerson}
      />
    </>
  );
}

function PersonDetail({
  roster,
  person,
  reload,
  onBack,
}: {
  roster: Roster;
  person: Person;
  reload: () => Promise<Roster>;
  onBack: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const org = person.orgId ? roster.orgs.find((o) => o.id === person.orgId) : undefined;

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <>
      <button className="btn btn-ghost btn-xs roster-back" onClick={onBack}>
        <Icon name="arrow-left" size={13} /> {org ? org.name : "No org"}
      </button>
      <div className="roster-head">
        <TitleInput
          value={person.displayName}
          ariaLabel="Display name"
          onSave={(name) => act(() => api.patchPerson(person.id, { name }))}
        />
        {person.isSelf ? (
          <span className="me-badge">me</span>
        ) : (
          <button
            className="btn btn-ghost btn-xs roster-danger"
            onClick={() =>
              void act(async () => {
                await api.deletePerson(person.id);
                onBack();
              })
            }
          >
            Delete person
          </button>
        )}
      </div>
      {person.isSelf && (
        <p className="roster-desc">This is you. Connecting an extension adds your identity on that source automatically.</p>
      )}
      {error && <p className="error-text">{error}</p>}

      <section className="roster-section">
        <h6>Org</h6>
        <div className="roster-field-row">
          <SelectTrigger
            label="org"
            display={<span className="mono">{org ? org.name : "No org"}</span>}
            value={person.orgId ?? ""}
            ariaLabel="Org"
            disabled={person.isSelf}
            title={person.isSelf ? "You always belong to your org" : undefined}
            onChange={(value) => void act(() => api.patchPerson(person.id, { orgId: value || null }))}
          >
            {sortOrgs(roster.orgs).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            <option value="">No org</option>
          </SelectTrigger>
          <span className="roster-note">Set by hand. Email domains never move a person between orgs.</span>
        </div>
      </section>

      <section className="roster-section">
        <h6>Identities</h6>
        <ChipEditor
          values={person.identities}
          placeholder="email:name@domain or github:login"
          emptyText={
            person.isSelf
              ? "No identities yet. They're added when you connect an extension."
              : "No identities. That's fine for someone you only deal with by phone."
          }
          check={(raw) => checkIdentityLocally(roster, person.id, raw)}
          onAdd={async (identity) => {
            await api.addIdentity(person.id, identity);
            await reload();
          }}
          onRemove={async (identity) => {
            await api.removeIdentity(person.id, identity);
            await reload();
          }}
        />
      </section>
    </>
  );
}
