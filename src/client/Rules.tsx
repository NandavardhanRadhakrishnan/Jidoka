import { useCallback, useEffect, useState } from "react";
import { api, type Rule, type TypeWithRules } from "./api";
import { RuleEditor } from "./RuleEditor";

export function Rules() {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<TypeWithRules[]>([]);
  const [selected, setSelected] = useState<TypeWithRules | null>(null);
  const [selectedRule, setSelectedRule] = useState<Rule | null>(null);
  const [loadingRule, setLoadingRule] = useState(false);

  const refresh = useCallback(async () => {
    setTypes(await api.types());
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function select(type: TypeWithRules) {
    setSelected(type);
    setSelectedRule(null);
    // Prefer the active version; otherwise load the most recent draft to edit.
    const toLoad = type.activeRuleId ?? type.rules.at(-1)?.id;
    if (!toLoad) return;
    setLoadingRule(true);
    try {
      setSelectedRule(await api.rule(toLoad));
    } finally {
      setLoadingRule(false);
    }
  }

  function statusOf(type: TypeWithRules): string {
    if (type.activeRuleId) {
      const active = type.rules.find((r) => r.id === type.activeRuleId);
      return `active v${active?.version ?? "?"}`;
    }
    if (type.rules.length) return "draft pending review";
    return "no rule yet";
  }

  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>
        Rules
      </button>

      {open && !selected && (
        <div className="dialog extensions">
          <h2>Rules</h2>
          {types.length === 0 && <p className="meta">No task types yet.</p>}
          {types.map((type) => (
            <div key={type.id} className="extension-row">
              <strong>{type.name}</strong>
              <p className="meta">{statusOf(type)}</p>
              <button className="link" onClick={() => void select(type)}>
                {type.rules.length ? "Edit" : "Create"}
              </button>
            </div>
          ))}
          <button className="secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}

      {open && selected && (
        <div className="dialog extensions">
          <h2>{selected.name}</h2>
          {loadingRule ? (
            <p className="meta">Loading…</p>
          ) : (
            <RuleEditor
              key={selected.id}
              type={selected}
              initialRule={selectedRule ?? undefined}
              onSaved={async () => {
                await refresh();
              }}
            />
          )}
          <button className="secondary" onClick={() => setSelected(null)}>
            Back to rules
          </button>
        </div>
      )}
    </>
  );
}
