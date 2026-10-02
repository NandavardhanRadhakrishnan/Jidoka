import { useCallback, useEffect, useState } from "react";
import { api, type Rule, type TypeWithRules } from "./api";
import { RuleEditor } from "./RuleEditor";
import { SelectTrigger } from "./SelectTrigger";
import { PRIORITIES, type Priority } from "../domain/priority";

function statusOf(type: TypeWithRules): string {
  if (type.activeRuleId) {
    const active = type.rules.find((r) => r.id === type.activeRuleId);
    return `rule v${active?.version ?? "?"} · active`;
  }
  if (type.rules.length) return "draft pending review";
  return "no rule yet";
}

/**
 * "Merge into…" action for a task type: pick another type from a native
 * `<select>`, then a second click confirms before the destructive call —
 * folding this type's tasks into the target and deleting it for good.
 */
function MergeTypeControl({
  type,
  others,
  onMerged,
}: {
  type: TypeWithRules;
  others: TypeWithRules[];
  onMerged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setTarget("");
    setConfirming(false);
    setError(null);
  }

  async function doMerge() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.patchType(type.id, { mergeInto: target });
      await onMerged();
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="btn btn-ghost"
        style={{ fontSize: 11, padding: 0 }}
        disabled={others.length === 0}
        title={others.length === 0 ? "No other type to merge into" : undefined}
        onClick={() => setOpen(true)}
      >
        Merge into…
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
      <div className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <label style={{ margin: 0 }}>Merge &ldquo;{type.name}&rdquo; into</label>
        <select
          className="input"
          autoFocus
          value={target}
          disabled={busy}
          onChange={(e) => {
            setTarget(e.target.value);
            setConfirming(false);
          }}
        >
          <option value="">Select a type…</option>
          {others.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {!confirming ? (
          <button className="btn btn-secondary" disabled={!target || busy} onClick={() => setConfirming(true)}>
            Merge…
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={() => void doMerge()}>
            {busy ? "Merging…" : "Confirm merge — this can't be undone"}
          </button>
        )}
        <button className="btn btn-ghost" style={{ fontSize: 11, padding: 0 }} disabled={busy} onClick={reset}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="error-text" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
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
            <span className="head-actions">
              <SelectTrigger
                label="default priority"
                display={<span className="mono">{selected.defaultPriority.toUpperCase()}</span>}
                value={selected.defaultPriority}
                onChange={(value) =>
                  void api.patchType(selected.id, { defaultPriority: value as Priority }).then(refresh)
                }
                ariaLabel="Default priority"
                title="Every task of this type starts at this priority; triage can raise a task above it, never below"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p[0]!.toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </SelectTrigger>
              <MergeTypeControl
                key={selected.id}
                type={selected}
                others={types.filter((t) => t.id !== selected.id)}
                onMerged={refresh}
              />
            </span>
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
