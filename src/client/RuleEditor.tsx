import { useEffect, useState } from "react";
import type { RuleDefinition } from "../domain/rule";
import type { ToolSpec } from "../ai/provider";
import { api, type ModelOption, type Rule, type TypeWithRules } from "./api";
import { StepList } from "./StepList";

export function RuleEditor({
  type,
  initialRule,
  onSaved,
  onDraftSaved,
  beforeGenerate,
}: {
  type: TypeWithRules;
  initialRule?: Rule;
  onSaved: () => Promise<void>;
  onDraftSaved?: () => Promise<void>;
  beforeGenerate?: () => Promise<void>;
}) {
  const [description, setDescription] = useState("");
  const [definition, setDefinition] = useState<RuleDefinition | null>(initialRule?.definition ?? null);
  const [draftId, setDraftId] = useState<string | null>(initialRule?.status === "draft" ? initialRule.id : null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [tools, setTools] = useState<ToolSpec[]>([]);
  const [allTypes, setAllTypes] = useState<TypeWithRules[]>([type]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.models().then((r) => setModels(r.models));
    void api.mcpTools().then(setTools);
    void api.types().then(setAllTypes);
  }, []);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      if (beforeGenerate) await beforeGenerate();
      const rule = await api.onboard(type.id, description);
      setDefinition(rule.definition);
      setDraftId(rule.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAsNewVersion() {
    if (!definition) return;
    setBusy(true);
    setError(null);
    try {
      const rule = await api.saveRule(type.id, definition);
      setDraftId(rule.id);
      if (onDraftSaved) await onDraftSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    try {
      await api.activate(draftId);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label>
        How should tasks of this type be handled?
        <textarea
          rows={4}
          value={description}
          placeholder="e.g. Summarize the email, pull the order status, then assign it to a human"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <button disabled={busy || !description.trim()} onClick={regenerate}>
        {busy ? "Building…" : definition ? "Regenerate" : "Build rule"}
      </button>

      {error && <p className="error">{error}</p>}

      {definition && (
        <>
          <h3>Steps</h3>
          <StepList
            steps={definition.steps}
            onChange={(steps) => setDefinition({ ...definition, steps })}
            ctx={{ models, tools, types: allTypes }}
          />
          <button disabled={busy} onClick={saveAsNewVersion}>
            Save as new version
          </button>
          {draftId && (
            <button disabled={busy} onClick={activate}>
              Activate
            </button>
          )}
        </>
      )}
    </div>
  );
}
