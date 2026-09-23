import { useEffect, useState } from "react";
import type { RuleDefinition } from "../domain/rule";
import type { ToolSpec } from "../ai/provider";
import { api, type ModelOption, type Rule, type TypeWithRules } from "./api";
import { StepList } from "./StepList";
import { RuleFlow } from "./RuleFlow";

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
  const [view, setView] = useState<"flow" | "editor">("flow");

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
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div className="field">
        <label>How should tasks of this type be handled?</label>
        <textarea
          className="input"
          rows={4}
          value={description}
          placeholder="e.g. Summarize the email, pull the order status, then assign it to a human"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <button className="btn btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy || !description.trim()} onClick={regenerate}>
        {busy ? "Building…" : definition ? "Regenerate" : "Build rule"}
      </button>

      {error && <p className="error-text">{error}</p>}

      {definition && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h6 style={{ margin: 0 }}>Steps</h6>
            <div className="seg" style={{ marginLeft: "auto" }}>
              <button className={`seg-opt ${view === "flow" ? "active" : ""}`} onClick={() => setView("flow")}>
                Flowchart
              </button>
              <button className={`seg-opt ${view === "editor" ? "active" : ""}`} onClick={() => setView("editor")}>
                Editor
              </button>
            </div>
          </div>

          {view === "flow" ? (
            <RuleFlow steps={definition.steps} tools={tools} onPick={() => setView("editor")} />
          ) : (
            <StepList steps={definition.steps} onChange={(steps) => setDefinition({ ...definition, steps })} ctx={{ models, tools, types: allTypes }} />
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-secondary" disabled={busy} onClick={saveAsNewVersion}>
              Save as new version
            </button>
            {draftId && (
              <button className="btn btn-primary" disabled={busy} onClick={activate}>
                Activate
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
