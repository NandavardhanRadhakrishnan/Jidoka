import { z } from "zod";

export type RuleStatus = "draft" | "active" | "superseded";

const AiStep = z.object({
  id: z.string(),
  type: z.literal("ai"),
  prompt: z.string(),
  /** Catalog id from src/ai/models.ts. Unset falls back to config.ai.model. */
  model: z.string().optional(),
  output: z.string(),
});

const AgentStep = z.object({
  id: z.string(),
  type: z.literal("agent"),
  prompt: z.string(),
  /**
   * Tools the step may use. May be empty: a toolless agent step is still a real
   * session — it reasons over the task and leaves a conversation a human can
   * resume from a handoff, which is the only option when no MCP server is
   * configured.
   */
  tools: z.array(z.string()).default([]),
  maxIterations: z.number().int().min(1).max(20).default(6),
  /** Catalog id from src/ai/models.ts. Unset falls back to config.agent.model. */
  model: z.string().optional(),
  output: z.string(),
});

const McpToolStep = z.object({
  id: z.string(),
  type: z.literal("mcp_tool"),
  server: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.string(),
});

/**
 * What a human should have open when they pick the task up: the source item, a
 * prepared draft, or a command that resumes the agent session the rule
 * already ran. Every field is templated like the rest of a rule.
 */
export const HandoffTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), label: z.string(), url: z.string() }),
  z.object({ kind: z.literal("draft"), label: z.string(), content: z.string() }),
  z.object({ kind: z.literal("command"), label: z.string(), command: z.string() }),
  z.object({
    kind: z.literal("session"),
    label: z.string(),
    /** Context key holding the session id an agent step produced. */
    sessionId: z.string(),
  }),
]);

export type HandoffTarget = z.infer<typeof HandoffTargetSchema>;

const AssignStep = z.object({
  id: z.string(),
  type: z.literal("assign"),
  to: z.enum(["ai", "human"]),
  note: z.string().optional(),
  /** Handoff targets; only meaningful when assigning to a human. */
  open: z.array(HandoffTargetSchema).optional(),
});

const CallRuleStep = z.object({
  id: z.string(),
  type: z.literal("call_rule"),
  typeId: z.string(),
  version: z.number().int().positive(),
});

export type RuleStep =
  | z.infer<typeof AiStep>
  | z.infer<typeof AgentStep>
  | z.infer<typeof McpToolStep>
  | z.infer<typeof AssignStep>
  | z.infer<typeof CallRuleStep>
  | { id: string; type: "branch"; on: string; cases: Record<string, RuleStep[]>; default?: RuleStep[] };

export const RuleStepSchema: z.ZodType<RuleStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    AiStep,
    AgentStep,
    McpToolStep,
    AssignStep,
    CallRuleStep,
    z.object({
      id: z.string(),
      type: z.literal("branch"),
      on: z.string(),
      cases: z.record(z.string(), z.array(RuleStepSchema)),
      default: z.array(RuleStepSchema).optional(),
    }),
  ]),
);

export const RuleDefinitionSchema = z.object({
  steps: z.array(RuleStepSchema).min(1),
});

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

export interface Rule {
  id: string;
  typeId: string;
  version: number;
  status: RuleStatus;
  definition: RuleDefinition;
  createdAt: string;
}

export interface NewRule {
  typeId: string;
  definition: RuleDefinition;
}
