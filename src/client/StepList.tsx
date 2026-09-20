import type { RuleStep } from "../domain/rule";
import type { ModelOption, TypeWithRules } from "./api";
import type { ToolSpec } from "../ai/provider";

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
    <label>
      Model {value === undefined ? "(auto — none set)" : ""}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(unset — falls back to the default)</option>
        {ctx.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} — {m.blurb}
          </option>
        ))}
      </select>
    </label>
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
  return (
    <div className="rule-step">
      <div className="rule-step-header">
        <strong>{step.type}</strong>
        <button className="link" onClick={onRemove}>
          Remove
        </button>
      </div>

      {step.type === "ai" && (
        <>
          <label>
            Prompt
            <textarea rows={2} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
          </label>
          <label>
            Output key
            <input value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </label>
          <ModelPicker value={step.model} onChange={(model) => onChange({ ...step, model })} ctx={ctx} />
        </>
      )}

      {step.type === "agent" && (
        <>
          <label>
            Prompt
            <textarea rows={2} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
          </label>
          <label>
            Tools
            <select
              multiple
              value={step.tools}
              onChange={(e) =>
                onChange({ ...step, tools: Array.from(e.target.selectedOptions, (o) => o.value) })
              }
            >
              {ctx.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Max iterations
            <input
              type="number"
              min={1}
              max={20}
              value={step.maxIterations}
              onChange={(e) => onChange({ ...step, maxIterations: Number(e.target.value) })}
            />
          </label>
          <label>
            Output key
            <input value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </label>
          <ModelPicker value={step.model} onChange={(model) => onChange({ ...step, model })} ctx={ctx} />
        </>
      )}

      {step.type === "mcp_tool" && (
        <>
          <label>
            Tool
            <select
              value={step.server && step.tool ? `${step.server}__${step.tool}` : ""}
              onChange={(e) => {
                const [server, tool] = e.target.value.split("__");
                onChange({ ...step, server: server ?? "", tool: tool ?? "" });
              }}
            >
              <option value="">(choose a tool)</option>
              {ctx.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Input (JSON)
            <textarea
              rows={2}
              value={JSON.stringify(step.input)}
              onChange={(e) => {
                try {
                  onChange({ ...step, input: JSON.parse(e.target.value) });
                } catch {
                  // ignore invalid JSON while the user is still typing
                }
              }}
            />
          </label>
          <label>
            Output key
            <input value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value })} />
          </label>
          <p className="meta">no model — logic</p>
        </>
      )}

      {step.type === "assign" && (
        <>
          <label>
            Assign to
            <select value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value as "ai" | "human" })}>
              <option value="ai">ai</option>
              <option value="human">human</option>
            </select>
          </label>
          <label>
            Note
            <input value={step.note ?? ""} onChange={(e) => onChange({ ...step, note: e.target.value })} />
          </label>
          <p className="meta">no model — logic</p>
        </>
      )}

      {step.type === "branch" && (
        <>
          <label>
            Branch on context key
            <input value={step.on} onChange={(e) => onChange({ ...step, on: e.target.value })} />
          </label>
          <p className="meta">no model — logic</p>
          {Object.entries(step.cases).map(([value, caseSteps]) => (
            <div key={value} className="rule-branch-case">
              <div className="rule-step-header">
                <span>case "{value}"</span>
                <button
                  className="link"
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
            className="link"
            onClick={() => {
              const value = window.prompt("Case value?");
              if (!value) return;
              onChange({ ...step, cases: { ...step.cases, [value]: [] } });
            }}
          >
            Add case
          </button>
          <div className="rule-branch-case">
            <span className="meta">default</span>
            <StepList
              steps={step.default ?? []}
              onChange={(next) => onChange({ ...step, default: next })}
              ctx={ctx}
            />
          </div>
        </>
      )}

      {step.type === "call_rule" && (
        <>
          <label>
            Type
            <select value={step.typeId} onChange={(e) => onChange({ ...step, typeId: e.target.value })}>
              <option value="">(choose a type)</option>
              {ctx.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version
            <input
              type="number"
              min={1}
              value={step.version}
              onChange={(e) => onChange({ ...step, version: Number(e.target.value) })}
            />
          </label>
          <p className="meta">no model — logic</p>
        </>
      )}
    </div>
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
  return (
    <div className="rule-step-list">
      {steps.map((step, index) => (
        <StepBox
          key={step.id}
          step={step}
          ctx={ctx}
          onChange={(next) => onChange(steps.map((s, i) => (i === index ? next : s)))}
          onRemove={() => onChange(steps.filter((_, i) => i !== index))}
        />
      ))}
      <label>
        Add step
        <select
          value=""
          onChange={(e) => {
            const type = e.target.value as RuleStep["type"];
            if (type) onChange([...steps, defaultStep(type)]);
          }}
        >
          <option value="">(choose a step type)</option>
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
