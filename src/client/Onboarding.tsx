import { useState } from "react";
import type { Task } from "../domain/task";
import type { Rule } from "../domain/rule";
import { api, type TypeWithRules } from "./api";

export function Onboarding({
  task,
  type,
  onDone,
  onClose,
}: {
  task: Task;
  type: TypeWithRules;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description);
  const [handling, setHandling] = useState("");
  const [draft, setDraft] = useState<Rule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function build() {
    setBusy(true);
    setError(null);
    try {
      if (name !== type.name || description !== type.description) {
        await api.patchType(type.id, { name, description });
      }
      setDraft(await api.onboard(type.id, handling));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!draft) return;
    setBusy(true);
    try {
      await api.activate(draft.id);
      await onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog">
      <h2>New task type: {type.name}</h2>
      <p className="subject">First task: {task.title}</p>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        How should tasks of this type be handled?
        <textarea
          rows={5}
          value={handling}
          placeholder="e.g. Summarize the email, pull the order status, then assign it to a human"
          onChange={(e) => setHandling(e.target.value)}
        />
      </label>

      {error && <p className="error">{error}</p>}

      {!draft ? (
        <>
          <button disabled={busy || !handling.trim()} onClick={build}>
            {busy ? "Building rule…" : "Build rule"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={async () => {
              await api.skipOnboarding(task.id);
              await onDone();
              onClose();
            }}
          >
            Skip — assign to a human for now
          </button>
        </>
      ) : (
        <>
          <h3>Proposed rule (version {draft.version})</h3>
          <pre>{JSON.stringify(draft.definition, null, 2)}</pre>
          <button disabled={busy} onClick={activate}>
            Activate
          </button>
          <button className="secondary" disabled={busy} onClick={() => setDraft(null)}>
            Rewrite the description
          </button>
        </>
      )}
    </div>
  );
}
