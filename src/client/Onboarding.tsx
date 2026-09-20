import { useState } from "react";
import type { Task } from "../domain/task";
import { api, type TypeWithRules } from "./api";
import { RuleEditor } from "./RuleEditor";

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
  const [busy, setBusy] = useState(false);

  async function saveTypeEdits() {
    if (name !== type.name || description !== type.description) {
      await api.patchType(type.id, { name, description });
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

      <RuleEditor
        type={{ ...type, name, description }}
        beforeGenerate={saveTypeEdits}
        onDraftSaved={onDone}
        onSaved={async () => {
          await saveTypeEdits();
          await onDone();
          onClose();
        }}
      />

      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await saveTypeEdits();
          await api.skipOnboarding(task.id);
          await onDone();
          onClose();
        }}
      >
        Skip — assign to a human for now
      </button>
    </div>
  );
}
