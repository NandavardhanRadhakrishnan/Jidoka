import { useCallback, useEffect, useState } from "react";
import { api, type Rule, type TypeWithRules } from "./api";
import { RuleEditor } from "./RuleEditor";

function statusOf(type: TypeWithRules): string {
  if (type.activeRuleId) {
    const active = type.rules.find((r) => r.id === type.activeRuleId);
    return `rule v${active?.version ?? "?"} · active`;
  }
  if (type.rules.length) return "draft pending review";
  return "no rule yet";
}

/** Full-screen "Types & rules" view — left list of task types, right detail + rule editor for the selected one. */
export function Rules() {
  const [types, setTypes] = useState<TypeWithRules[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRule, setSelectedRule] = useState<Rule | null>(null);
  const [loadingRule, setLoadingRule] = useState(false);

  const refresh = useCallback(async () => {
    setTypes(await api.types());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = types.find((t) => t.id === selectedId) ?? types[0] ?? null;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const toLoad = selected.activeRuleId ?? selected.rules.at(-1)?.id;
    if (!toLoad) {
      setSelectedRule(null);
      return;
    }
    setLoadingRule(true);
    api
      .rule(toLoad)
      .then((rule) => {
        if (!cancelled) setSelectedRule(rule);
      })
      .finally(() => {
        if (!cancelled) setLoadingRule(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.activeRuleId]);

  if (types.length === 0) {
    return (
      <div style={{ padding: 20 }}>
        <p className="text-muted">No task types yet.</p>
      </div>
    );
  }

  return (
    <div className="types-screen">
      <div className="type-list">
        {types.map((type) => (
          <button
            key={type.id}
            className={`type-row ${type.id === selected?.id ? "on" : ""}`}
            onClick={() => setSelectedId(type.id)}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
              <span className="name">{type.name}</span>
              <span className="mono rule-status" style={{ color: type.activeRuleId ? "var(--color-neutral-600)" : "var(--color-accent)" }}>
                {statusOf(type)}
              </span>
            </span>
            <span className="desc">{type.description}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="type-detail">
          <div className="type-detail-head">
            <h4 style={{ margin: 0 }}>{selected.name}</h4>
            <span className="tag tag-accent">{statusOf(selected)}</span>
          </div>
          <p className="type-detail-desc">{selected.description}</p>
          {selected.examples.length > 0 && (
            <div className="type-examples">
              {selected.examples.map((ex, i) => (
                <span key={i} className="tag tag-neutral" style={{ fontSize: 11 }}>
                  {ex}
                </span>
              ))}
            </div>
          )}
          <hr className="hr" />

          {loadingRule ? (
            <p className="text-muted">Loading…</p>
          ) : (
            <RuleEditor
              key={selected.id}
              type={selected}
              initialRule={selectedRule ?? undefined}
              onDraftSaved={refresh}
              onSaved={async () => {
                await refresh();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
