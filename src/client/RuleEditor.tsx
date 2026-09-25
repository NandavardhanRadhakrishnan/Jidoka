import { useCallback, useEffect, useState } from "react";
import type { RuleDefinition, RuleStep } from "../domain/rule";
import type { ToolSpec } from "../ai/provider";
import { api, type Hint, type ModelOption, type Rule, type TypeWithRules } from "./api";
import { StepList } from "./StepList";
import { RuleFlow } from "./RuleFlow";

function flattenSteps(steps: RuleStep[]): RuleStep[] {
  const out: RuleStep[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.type === "branch") {
      for (const caseSteps of Object.values(step.cases)) {
        out.push(...flattenSteps(caseSteps));
      }
      if (step.default) out.push(...flattenSteps(step.default));
    }
  }
  return out;
}

function stepOutputLabel(steps: RuleStep[], stepId: string): string {
  const step = flattenSteps(steps).find((s) => s.id === stepId);
  if (step && (step.type === "ai" || step.type === "agent" || step.type === "mcp_tool")) {
    return step.output;
  }
  return stepId;
}

function promptCapableSteps(steps: RuleStep[]): { id: string; output: string }[] {
  return flattenSteps(steps)
    .filter((s) => s.type === "ai" || s.type === "agent")
    .map((s) => ({ id: s.id, output: s.output }));
}

interface ReconciliationState {
  newRuleId: string;
  oldRuleId: string;
  oldDefinition: RuleDefinition;
  hints: Hint[];
  choices: Record<string, string>;
}

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
  const [hints, setHints] = useState<Hint[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationState | null>(null);

  const ruleIdForHints = draftId ?? initialRule?.id ?? null;

  const loadHints = useCallback(async (ruleId: string) => {
    setHints(await api.ruleHints(ruleId));
  }, []);

  useEffect(() => {
    void api.models().then((r) => setModels(r.models));
    void api.mcpTools().then(setTools);
    void api.types().then(setAllTypes);
  }, []);

  useEffect(() => {
    if (!ruleIdForHints) {
      setHints([]);
      return;
    }
    void loadHints(ruleIdForHints);
  }, [ruleIdForHints, loadHints]);

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
      await loadHints(rule.id);
      if (onDraftSaved) await onDraftSaved();

      if (type.activeRuleId && type.activeRuleId !== rule.id) {
        const oldHints = await api.ruleHints(type.activeRuleId);
        if (oldHints.length > 0) {
          const oldRule = await api.rule(type.activeRuleId);
          setReconciliation({
            newRuleId: rule.id,
            oldRuleId: type.activeRuleId,
            oldDefinition: oldRule.definition,
            hints: oldHints,
            choices: Object.fromEntries(oldHints.map((h) => [h.id, ""])),
          });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmReconciliation() {
    if (!reconciliation || !definition) return;
    setBusy(true);
    setError(null);
    try {
      for (const hint of reconciliation.hints) {
        const chosen = reconciliation.choices[hint.id];
        if (!chosen) continue;
        await api.addRuleHint(reconciliation.newRuleId, {
          stepId: chosen,
          text: hint.text,
          excerpt: hint.excerpt ?? undefined,
        });
      }
      setReconciliation(null);
      await loadHints(reconciliation.newRuleId);
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

  const hintsByStep = hints.reduce<Map<string, Hint[]>>((groups, hint) => {
    const list = groups.get(hint.stepId) ?? [];
    list.push(hint);
    groups.set(hint.stepId, list);
    return groups;
  }, new Map());

  const newStepOptions = definition ? promptCapableSteps(definition.steps) : [];

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

          {ruleIdForHints && hints.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <h6 style={{ margin: 0, fontSize: 13, color: "var(--color-neutral-800)" }}>Hints</h6>
              {[...hintsByStep.entries()].map(([stepId, group]) => (
                <div key={stepId}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--color-neutral-700)" }}>
                    {stepOutputLabel(definition.steps, stepId)}
                  </span>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                    {group.map((hint) => (
                      <li key={hint.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13 }}>
                        <span style={{ flex: 1 }}>{hint.text}</span>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ fontSize: 11, padding: 0 }}
                          disabled={busy}
                          onClick={() =>
                            void (async () => {
                              await api.deleteHint(hint.id);
                              if (ruleIdForHints) await loadHints(ruleIdForHints);
                            })()
                          }
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {reconciliation && definition && (
            <section
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "var(--space-2)",
                border: "1px solid var(--color-neutral-400)",
              }}
            >
              <h6 style={{ margin: 0, fontSize: 13 }}>Carry hints to this version?</h6>
              <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                The previous active rule had saved hints. Point each one at a step in this draft, or leave it behind.
              </p>
              {reconciliation.hints.map((hint) => (
                <div key={hint.id} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                  <span>
                    {hint.text}
                    <span className="text-muted" style={{ fontSize: 11 }}>
                      {" "}
                      (was on {stepOutputLabel(reconciliation.oldDefinition.steps, hint.stepId)})
                    </span>
                  </span>
                  <select
                    className="input"
                    value={reconciliation.choices[hint.id] ?? ""}
                    onChange={(e) =>
                      setReconciliation({
                        ...reconciliation,
                        choices: { ...reconciliation.choices, [hint.id]: e.target.value },
                      })
                    }
                  >
                    <option value="">Don&apos;t carry</option>
                    {newStepOptions.map((step) => (
                      <option key={step.id} value={step.id}>
                        {step.output} ({step.id})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void confirmReconciliation()}>
                  Confirm
                </button>
                <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: 0 }} disabled={busy} onClick={() => setReconciliation(null)}>
                  Skip
                </button>
              </div>
            </section>
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
