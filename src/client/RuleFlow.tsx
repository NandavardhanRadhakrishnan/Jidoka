import type { RuleStep } from "../domain/rule";
import type { ToolSpec } from "../ai/provider";
import { splitToolName } from "../mcp/names";
import { Icon, stepKindIcon, stepKindColors, toolPerm } from "./icons";

function stepTitle(step: RuleStep): string {
  switch (step.type) {
    case "ai":
      return step.prompt.slice(0, 60) || "AI step";
    case "agent":
      return step.prompt.slice(0, 60) || "Agent step";
    case "mcp_tool":
      return `${step.server || "?"} · ${step.tool || "?"}`;
    case "assign":
      return `Assign to ${step.to}`;
    case "call_rule":
      return `Call ${step.typeId || "?"} v${step.version}`;
    case "branch":
      return `Branch on ${step.on || "?"}`;
  }
}

function stepDetail(step: RuleStep): string {
  switch (step.type) {
    case "ai":
    case "agent":
      return step.prompt || "no prompt set";
    case "mcp_tool":
      return `input: ${JSON.stringify(step.input)}`;
    case "assign":
      return step.note || "";
    case "call_rule":
      return "";
    case "branch":
      return `${Object.keys(step.cases).length} case(s)${step.default ? " + default" : ""}`;
  }
}

function stepOutput(step: RuleStep): string {
  if (step.type === "ai" || step.type === "agent" || step.type === "mcp_tool") {
    return step.output ? `→ context.${step.output}` : "";
  }
  return "";
}

function AgentToolTags({ step, tools }: { step: RuleStep; tools: ToolSpec[] }) {
  if (step.type !== "agent" || step.tools.length === 0) return null;
  return (
    <span className="flow-step-tools">
      {step.tools.map((name) => {
        const spec = tools.find((t) => t.name === name);
        const perm = toolPerm(spec?.annotations);
        return (
          <span key={name} className="tag tag-neutral mono" style={{ fontSize: 10, display: "inline-flex", alignItems: "center", gap: 4 }}>
            {splitToolName(name).tool}
            <span className={`perm-badge ${perm.cls}`}>{perm.label}</span>
          </span>
        );
      })}
    </span>
  );
}

function AssignOpenTags({ step }: { step: RuleStep }) {
  if (step.type !== "assign" || !step.open?.length) return null;
  return (
    <span className="flow-step-tools">
      {step.open.map((t, i) => (
        <span key={i} className="tag tag-outline mono" style={{ fontSize: 10 }}>
          {t.kind}
          {t.label ? `: ${t.label}` : ""}
        </span>
      ))}
    </span>
  );
}

function FlowNode({ step, tools, onPick }: { step: RuleStep; tools: ToolSpec[]; onPick: (id: string) => void }) {
  const kc = stepKindColors(step.type);
  return (
    <button className="flow-step" onClick={() => onPick(step.id)}>
      <span className="kind-tab" style={{ background: kc.bg, color: kc.fg }}>
        <Icon name={stepKindIcon(step.type)} size={16} />
        <span className="mono n">{step.type.toUpperCase()}</span>
      </span>
      <span className="content">
        <span className="title">{stepTitle(step)}</span>
        {stepDetail(step) && <span className="detail">{stepDetail(step)}</span>}
        {stepOutput(step) && (
          <span className="mono out" style={{ color: "var(--color-accent-700)" }}>
            {stepOutput(step)}
          </span>
        )}
        <AgentToolTags step={step} tools={tools} />
        <AssignOpenTags step={step} />
      </span>
    </button>
  );
}

function CaseColumn({
  label,
  steps,
  tools,
  onPick,
  isDefault,
}: {
  label: string;
  steps: RuleStep[];
  tools: ToolSpec[];
  onPick: (id: string) => void;
  isDefault?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <span className={`tag ${isDefault ? "tag-neutral" : "tag-accent"} flow-case-label`}>{label}</span>
      {steps.length === 0 && (
        <span className="text-muted" style={{ fontSize: 11 }}>
          (empty)
        </span>
      )}
      {steps.map((cs) => {
        const kc = stepKindColors(cs.type);
        return (
          <button key={cs.id} className="flow-case-step" onClick={() => onPick(cs.id)}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-neutral-700)" }}>
              <Icon name={stepKindIcon(cs.type)} size={13} />
              <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em" }}>
                {cs.type.toUpperCase()}
              </span>
            </span>
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 13 }}>{stepTitle(cs)}</span>
            {stepDetail(cs) && (
              <span style={{ fontSize: 11, color: "var(--color-neutral-700)", lineHeight: 1.4 }}>{stepDetail(cs)}</span>
            )}
            <span
              className="mono"
              style={{ background: kc.bg, color: kc.fg, fontSize: 9, alignSelf: "flex-start", padding: "1px 5px" }}
            >
              {cs.type}
            </span>
            <AgentToolTags step={cs} tools={tools} />
            <AssignOpenTags step={cs} />
          </button>
        );
      })}
    </div>
  );
}

export function RuleFlow({
  steps,
  tools,
  onPick,
}: {
  steps: RuleStep[];
  tools: ToolSpec[];
  onPick: (stepId: string) => void;
}) {
  if (!steps.length) {
    return <p className="text-muted">No steps yet.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", maxWidth: 900 }}>
      {steps.map((step, i) => (
        <div key={step.id} style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          {step.type === "branch" ? (
            <div style={{ width: "100%" }}>
              <div className="flow-branch-head">
                <span className="mono n">{i + 1} BRANCH ON</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {step.on}
                </span>
              </div>
              <div className="flow-cases">
                {Object.entries(step.cases).map(([value, caseSteps]) => (
                  <CaseColumn key={value} label={value} steps={caseSteps} tools={tools} onPick={onPick} />
                ))}
                {step.default && <CaseColumn label="default" steps={step.default} tools={tools} onPick={onPick} isDefault />}
              </div>
            </div>
          ) : (
            <>
              <FlowNode step={step} tools={tools} onPick={onPick} />
              {i < steps.length - 1 && <div className="flow-spine" />}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
