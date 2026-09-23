import { useState } from "react";
import type { RuleStep, HandoffTarget } from "../domain/rule";
import type { ModelOption, TypeWithRules } from "./api";
import type { ToolSpec } from "../ai/provider";
import { TOOL_SEPARATOR, splitToolName } from "../mcp/names";
import { Icon, stepKindIcon, stepKindColors, toolPerm } from "./icons";

let nextId = 1;
function freshStepId(): string {
  return `s${Date.now()}_${nextId++}`;
}

function defaultStep(type: RuleStep["type"]): RuleStep {
  const id = freshStepId();
  switch (type) {
    case "ai":
      return { id, type: "ai", prompt: "", output: "" };
    case "agent":
      return { id, type: "agent", prompt: "", tools: [], maxIterations: 6, output: "" };
    case "mcp_tool":
      return { id, type: "mcp_tool", server: "", tool: "", input: {}, output: "" };
    case "assign":
      return { id, type: "assign", to: "human" };
    case "branch":
      return { id, type: "branch", on: "", cases: {} };
    case "call_rule":
      return { id, type: "call_rule", typeId: "", version: 1 };
  }
}

const STEP_TYPES: RuleStep["type"][] = ["ai", "agent", "mcp_tool", "branch", "assign", "call_rule"];

interface Ctx {
  models: ModelOption[];
  tools: ToolSpec[];
  types: TypeWithRules[];
}

function ModelPicker({
  value,
  onChange,
  ctx,
}: {
  value: string | undefined;
  onChange: (model: string | undefined) => void;
  ctx: Ctx;
}) {
  return (
    <div className="field">
      <label>Model {value === undefined ? "(auto — none set)" : ""}</label>
      <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(unset — falls back to the default)</option>
        {ctx.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} — {m.blurb}
          </option>
        ))}
      </select>
    </div>
  );
}

function groupToolsByServer(tools: ToolSpec[]): Map<string, ToolSpec[]> {
  const groups = new Map<string, ToolSpec[]>();
  for (const t of tools) {
    const { server } = splitToolName(t.name);
    const group = groups.get(server) ?? [];
    group.push(t);
    groups.set(server, group);
  }
  return groups;
}

function ToolPicker({
  tools,
  selected,
  onChange,
}: {
  tools: ToolSpec[];
  selected: string[];
  onChange: (names: string[]) => void;
}) {
  const groups = groupToolsByServer(tools);
  function toggle(name: string, checked: boolean) {
    onChange(checked ? [...selected, name] : selected.filter((n) => n !== name));
  }
  return (
    <div className="tool-picker">
      {[...groups.entries()].map(([server, serverTools]) => (
        <details key={server} className="tool-picker-group">
          <summary>
            {server} ({serverTools.filter((t) => selected.includes(t.name)).length}/{serverTools.length})
          </summary>
          {serverTools.map((t) => {
            const perm = toolPerm(t.annotations);
            return (
              <label key={t.name} className="tool-picker-row">
                <input type="checkbox" checked={selected.includes(t.name)} onChange={(e) => toggle(t.name, e.target.checked)} />
                <span className="tool-name mono">{splitToolName(t.name).tool}</span>
                <span className={`perm-badge ${perm.cls}`}>{perm.label}</span>
              </label>
            );
          })}
        </details>
      ))}
      {groups.size === 0 && <p className="text-muted" style={{ fontSize: 12 }}>no MCP tools available</p>}
    </div>
  );
}

function McpToolFields({
  step,
  onChange,
  ctx,
}: {
  step: Extract<RuleStep, { type: "mcp_tool" }>;
  onChange: (step: RuleStep) => void;
  ctx: Ctx;
}) {
  const [rawInput, setRawInput] = useState(() => JSON.stringify(step.input));

  return (
    <>
      <div className="field">
        <label>Tool</label>
        <select
          className="input"
          value={step.server && step.tool ? `${step.server}${TOOL_SEPARATOR}${step.tool}` : ""}
          onChange={(e) => {
            const value = e.target.value;
            const index = value.indexOf(TOOL_SEPARATOR);
            const server = index === -1 ? "" : value.slice(0, index);
            const tool = index === -1 ? "" : value.slice(index + TOOL_SEPARATOR.length);
            onChange({ ...step, server, tool });
          }}
        >
          <option value="">(choose a tool)</option>
          {[...groupToolsByServer(ctx.tools).entries()].map(([server, serverTools]) => (
            <optgroup key={server} label={server}>
              {serverTools.map((t) => (
                <option key={t.name} value={t.name}>
                  {splitToolName(t.name).tool}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Input (JSON)</label>
        <textarea
          className="input"
          rows={2}
          value={rawInput}
          onChange={(e) => {
            const text = e.target.value;
            setRawInput(text);
            try {
              onChange({ ...step, input: JSON.parse(text) });
            } catch {
              // leave step.input as-is; the message below flags the mismatch
            }
          }}
        />
      </div>
      {(() => {
        try {
          JSON.parse(rawInput);
          return null;
        } catch {
          return <p className="error-text">Invalid JSON — not saved</p>;
        }
      })()}
      <div className="field">
        <label>Output key</label>
        <input className="input" value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
      </div>
      <p className="text-muted" style={{ fontSize: 12 }}>
        no model — logic
      </p>
    </>
  );
}

function defaultHandoffTarget(kind: HandoffTarget["kind"]): HandoffTarget {
  switch (kind) {
    case "url":
      return { kind: "url", label: "", url: "" };
    case "draft":
      return { kind: "draft", label: "", content: "" };
    case "command":
      return { kind: "command", label: "", command: "" };
    case "session":
      return { kind: "session", label: "", sessionId: "" };
  }
}

function HandoffTargetRow({
  target,
  onChange,
  onRemove,
}: {
  target: HandoffTarget;
  onChange: (target: HandoffTarget) => void;
  onRemove: () => void;
}) {
  return (
    <div className="card" style={{ gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          className="input"
          style={{ maxWidth: 130 }}
          value={target.kind}
          onChange={(e) => onChange(defaultHandoffTarget(e.target.value as HandoffTarget["kind"]))}
        >
          <option value="url">url</option>
          <option value="draft">draft</option>
          <option value="command">command</option>
          <option value="session">session</option>
        </select>
        <input
          className="input"
          placeholder="label"
          style={{ flex: 1 }}
          value={target.label}
          onChange={(e) => onChange({ ...target, label: e.target.value })}
        />
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: 0 }} onClick={onRemove}>
          Remove
        </button>
      </div>
      {target.kind === "url" && (
        <input
          className="input mono"
          placeholder="{{task.url}}"
          value={target.url}
          onChange={(e) => onChange({ ...target, url: e.target.value })}
        />
      )}
      {target.kind === "draft" && (
        <textarea
          className="input"
          rows={2}
          placeholder="draft content"
          value={target.content}
          onChange={(e) => onChange({ ...target, content: e.target.value })}
        />
      )}
      {target.kind === "command" && (
        <input
          className="input mono"
          placeholder="command"
          value={target.command}
          onChange={(e) => onChange({ ...target, command: e.target.value })}
        />
      )}
      {target.kind === "session" && (
        <input
          className="input mono"
          placeholder="context key holding the session id"
          value={target.sessionId}
          onChange={(e) => onChange({ ...target, sessionId: e.target.value })}
        />
      )}
    </div>
  );
}

function HandoffTargetsEditor({ targets, onChange }: { targets: HandoffTarget[]; onChange: (targets: HandoffTarget[]) => void }) {
  return (
    <div className="field">
      <label>Open (what a human sees when they pick this up)</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {targets.map((target, index) => (
          <HandoffTargetRow
            key={index}
            target={target}
            onChange={(next) => onChange(targets.map((t, i) => (i === index ? next : t)))}
            onRemove={() => onChange(targets.filter((_, i) => i !== index))}
          />
        ))}
        <button
          className="btn btn-ghost"
          style={{ alignSelf: "flex-start", fontSize: 12, padding: 0 }}
          onClick={() => onChange([...targets, defaultHandoffTarget("url")])}
        >
          + Add target
        </button>
      </div>
    </div>
  );
}

function StepBox({
  step,
  onChange,
  onRemove,
  ctx,
}: {
  step: RuleStep;
  onChange: (step: RuleStep) => void;
  onRemove: () => void;
  ctx: Ctx;
}) {
  const kc = stepKindColors(step.type);
  return (
    <div className="card" style={{ gap: "var(--space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="mono"
          style={{ fontSize: 10.5, padding: "3px 8px", background: kc.bg, color: kc.fg, display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <Icon name={stepKindIcon(step.type)} size={13} />
          {step.type}
        </span>
        <button className="btn btn-ghost" style={{ marginLeft: "auto", fontSize: 12, padding: 0 }} onClick={onRemove}>
          Remove
        </button>
      </div>

      {step.type === "ai" && (
        <>
          <div className="field">
            <label>Prompt</label>
            <textarea className="input" rows={2} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
          </div>
          <div className="field">
            <label>Output key</label>
            <input className="input" value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </div>
          <ModelPicker value={step.model} onChange={(model) => onChange({ ...step, model })} ctx={ctx} />
        </>
      )}

      {step.type === "agent" && (
        <>
          <div className="field">
            <label>Prompt</label>
            <textarea className="input" rows={2} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
          </div>
          <div className="field">
            <label>Tools</label>
            <ToolPicker tools={ctx.tools} selected={step.tools} onChange={(tools) => onChange({ ...step, tools })} />
          </div>
          <div className="field">
            <label>Max iterations</label>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={step.maxIterations}
              onChange={(e) => onChange({ ...step, maxIterations: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Output key</label>
            <input className="input" value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </div>
          <ModelPicker value={step.model} onChange={(model) => onChange({ ...step, model })} ctx={ctx} />
        </>
      )}

      {step.type === "mcp_tool" && <McpToolFields step={step} onChange={onChange} ctx={ctx} />}

      {step.type === "assign" && (
        <>
          <div className="field">
            <label>Assign to</label>
            <select className="input" value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value as "ai" | "human" })}>
              <option value="ai">ai</option>
              <option value="human">human</option>
            </select>
          </div>
          <div className="field">
            <label>Note</label>
            <input className="input" value={step.note ?? ""} onChange={(e) => onChange({ ...step, note: e.target.value })} />
          </div>
          <HandoffTargetsEditor targets={step.open ?? []} onChange={(open) => onChange({ ...step, open })} />
          <p className="text-muted" style={{ fontSize: 12 }}>
            no model — logic
          </p>
        </>
      )}

      {step.type === "branch" && (
        <>
          <div className="field">
            <label>Branch on context key</label>
            <input className="input" value={step.on} onChange={(e) => onChange({ ...step, on: e.target.value })} />
          </div>
          <p className="text-muted" style={{ fontSize: 12 }}>
            no model — logic
          </p>
          {Object.entries(step.cases).map(([value, caseSteps]) => (
            <div key={value} style={{ borderLeft: "2px solid var(--color-divider)", paddingLeft: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="tag tag-accent">case "{value}"</span>
                <button
                  className="btn btn-ghost"
                  style={{ marginLeft: "auto", fontSize: 12, padding: 0 }}
                  onClick={() => {
                    const { [value]: _removed, ...rest } = step.cases;
                    onChange({ ...step, cases: rest });
                  }}
                >
                  Remove case
                </button>
              </div>
              <StepList
                steps={caseSteps}
                onChange={(next) => onChange({ ...step, cases: { ...step.cases, [value]: next } })}
                ctx={ctx}
              />
            </div>
          ))}
          <button
            className="btn btn-ghost"
            style={{ alignSelf: "flex-start", fontSize: 12, padding: 0 }}
            onClick={() => {
              const value = window.prompt("Case value?");
              if (!value) return;
              onChange({ ...step, cases: { ...step.cases, [value]: [] } });
            }}
          >
            + Add case
          </button>
          <div style={{ borderLeft: "2px solid var(--color-divider)", paddingLeft: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="tag tag-neutral" style={{ alignSelf: "flex-start" }}>
              default
            </span>
            <StepList steps={step.default ?? []} onChange={(next) => onChange({ ...step, default: next })} ctx={ctx} />
          </div>
        </>
      )}

      {step.type === "call_rule" && (
        <>
          <div className="field">
            <label>Type</label>
            <select className="input" value={step.typeId} onChange={(e) => onChange({ ...step, typeId: e.target.value })}>
              <option value="">(choose a type)</option>
              {ctx.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Version</label>
            <input
              className="input"
              type="number"
              min={1}
              value={step.version}
              onChange={(e) => onChange({ ...step, version: Number(e.target.value) })}
            />
          </div>
          <p className="text-muted" style={{ fontSize: 12 }}>
            no model — logic
          </p>
        </>
      )}
    </div>
  );
}

function InsertStepControl({ onInsert }: { onInsert: (type: RuleStep["type"]) => void }) {
  return (
    <select
      className="step-insert-select"
      value=""
      onChange={(e) => {
        const type = e.target.value as RuleStep["type"];
        if (type) onInsert(type);
      }}
    >
      <option value="">+ insert step</option>
      {STEP_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

export function StepList({
  steps,
  onChange,
  ctx,
}: {
  steps: RuleStep[];
  onChange: (steps: RuleStep[]) => void;
  ctx: Ctx;
}) {
  function insertAt(index: number, type: RuleStep["type"]) {
    const next = [...steps];
    next.splice(index, 0, defaultStep(type));
    onChange(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <InsertStepControl onInsert={(type) => insertAt(0, type)} />
      {steps.map((step, index) => (
        <div key={step.id} style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <StepBox
            step={step}
            ctx={ctx}
            onChange={(next) => onChange(steps.map((s, i) => (i === index ? next : s)))}
            onRemove={() => onChange(steps.filter((_, i) => i !== index))}
          />
          <InsertStepControl onInsert={(type) => insertAt(index + 1, type)} />
        </div>
      ))}
    </div>
  );
}
