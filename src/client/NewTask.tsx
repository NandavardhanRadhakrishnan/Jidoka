import { useState } from "react";
import { api } from "./api";

/** Hand-typed task injection — the quickest way to exercise triage. */
export function NewTask({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return <button onClick={() => setOpen(true)}>New task</button>;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.createTask({ title, body });
      setTitle("");
      setBody("");
      setOpen(false);
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog">
      <h2>New task</h2>
      <label>
        Title
        <input
          autoFocus
          value={title}
          placeholder="Where is my order?"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Body
        <textarea
          rows={6}
          value={body}
          placeholder="I ordered last week and nothing has arrived."
          onChange={(e) => setBody(e.target.value)}
        />
      </label>

      {error && <p className="error">{error}</p>}

      <button disabled={busy || !title.trim()} onClick={() => void submit()}>
        {busy ? "Triaging…" : "Add and triage"}
      </button>
      <button className="secondary" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
