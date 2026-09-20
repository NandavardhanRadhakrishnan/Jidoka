import { useState } from "react";
import type { Task } from "../domain/task";
import type { TypeWithRules } from "./api";

export function TypeConfirm({
  task,
  types,
  onConfirm,
  onClose,
}: {
  task: Task;
  types: TypeWithRules[];
  onConfirm: (typeId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const candidates = task.typeCandidates ?? [];
  const shown = types.filter((t) => candidates.includes(t.id));

  return (
    <div className="dialog">
      <h2>Which type is this?</h2>
      <p className="subject">{task.title}</p>
      {(shown.length ? shown : types).map((type) => (
        <button
          key={type.id}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm(type.id);
            setBusy(false);
            onClose();
          }}
        >
          <strong>{type.name}</strong>
          <span>{type.description}</span>
        </button>
      ))}
      <button className="secondary" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
