import { useState } from "react";
import type { Task } from "../domain/task";
import { api, type TypeWithRules } from "./api";
import { RuleEditor } from "./RuleEditor";

const STEPS = ["Review the type", "Describe & build the rule"];

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
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  async function saveTypeEdits() {
    if (name !== type.name || description !== type.description) {
      await api.patchType(type.id, { name, description });
    }
  }

  return (
    <div style={{ padding: "20px 24px 56px", maxWidth: 980 }}>
      <div className="wizard-steps">
        {STEPS.map((label, i) => (
          <div key={label} className={`wizard-step ${step === i + 1 ? "on" : ""}`}>
            <span className="mono n">STEP {i + 1}</span>
            <span className="label">{label}</span>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div>
          <h4 style={{ fontSize: 22, marginBottom: 6 }}>New task type: {type.name}</h4>
          <p className="text-muted" style={{ maxWidth: "64ch" }}>
            First task: {task.title}. Check the name and description below — they are what every future task gets
            classified against.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560, marginTop: 16 }}>
            <div className="field">
              <label>Type name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>Description — how AI should recognise it</label>
              <textarea className="input" style={{ minHeight: 120 }} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ maxWidth: 900 }}>
          <h4 style={{ fontSize: 22, marginBottom: 6 }}>How should these be handled?</h4>
          <p className="text-muted" style={{ maxWidth: "64ch" }}>
            Write it the way you would explain it to a new hire. An agent turns this into a rule you review before
            anything runs.
          </p>
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
        </div>
      )}

      <div className="wizard-actions">
        {step === 1 ? (
          <button className="btn btn-primary" onClick={() => setStep(2)}>
            Looks right — describe the handling
          </button>
        ) : (
          <button className="btn btn-secondary" onClick={() => setStep(1)}>
            Back
          </button>
        )}
        <button
          className="btn btn-ghost"
          style={{ marginLeft: "auto", color: "var(--color-neutral-700)" }}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await saveTypeEdits();
              await api.skipOnboarding(task.id);
              await onDone();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          Skip — let these fall to a human every time
        </button>
      </div>
    </div>
  );
}
