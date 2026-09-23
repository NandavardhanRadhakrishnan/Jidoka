import { useState } from "react";
import { api } from "./api";

/** Inject-a-task dialog — the quickest way to exercise triage on a hand-typed case. */
export function NewTask({ onCreated, onClose }: { onCreated: () => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.createTask({ title, body, ...(url.trim() ? { url: url.trim() } : {}) });
      await onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" style={{ width: "min(520px, 100%)" }}>
        <span className="dialog-title">Inject a task</span>
        <p className="dialog-body">It goes through triage exactly like a polled one — useful for testing a rule on an edge case.</p>
        <div className="field">
          <label>Title</label>
          <input
            className="input"
            autoFocus
            value={title}
            placeholder="Policy JID-40218 issued without endorsement schedule"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Body</label>
          <textarea
            className="input"
            rows={6}
            value={body}
            placeholder="Paste the email, the issue, the ticket…"
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div className="field">
          <label>URL (optional)</label>
          <input className="input" value={url} placeholder="https://github.com/org/repo/pull/123" onChange={(e) => setUrl(e.target.value)} />
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="dialog-actions">
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
            {busy ? "Adding…" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}
