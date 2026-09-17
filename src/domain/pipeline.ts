import { z } from "zod";

export type PipelineStatus = "draft" | "active" | "superseded";

const AiStep = z.object({
  id: z.string(),
  type: z.literal("ai"),
  prompt: z.string(),
  output: z.string(),
});

const AgentStep = z.object({
  id: z.string(),
  type: z.literal("agent"),
  prompt: z.string(),
  tools: z.array(z.string()).min(1),
  maxIterations: z.number().int().min(1).max(20).default(6),
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

const AssignStep = z.object({
  id: z.string(),
  type: z.literal("assign"),
  to: z.enum(["ai", "human"]),
  note: z.string().optional(),
});

const CallPipelineStep = z.object({
  id: z.string(),
  type: z.literal("call_pipeline"),
  typeId: z.string(),
  version: z.number().int().positive(),
});

export type PipelineStep =
  | z.infer<typeof AiStep>
  | z.infer<typeof AgentStep>
  | z.infer<typeof McpToolStep>
  | z.infer<typeof AssignStep>
  | z.infer<typeof CallPipelineStep>
  | { id: string; type: "branch"; on: string; cases: Record<string, PipelineStep[]>; default?: PipelineStep[] };

export const PipelineStepSchema: z.ZodType<PipelineStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    AiStep,
    AgentStep,
    McpToolStep,
    AssignStep,
    CallPipelineStep,
    z.object({
      id: z.string(),
      type: z.literal("branch"),
      on: z.string(),
      cases: z.record(z.string(), z.array(PipelineStepSchema)),
      default: z.array(PipelineStepSchema).optional(),
    }),
  ]),
);

export const PipelineDefinitionSchema = z.object({
  steps: z.array(PipelineStepSchema).min(1),
});

export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

export interface Pipeline {
  id: string;
  typeId: string;
  version: number;
  status: PipelineStatus;
  definition: PipelineDefinition;
  createdAt: string;
}

export interface NewPipeline {
  typeId: string;
  definition: PipelineDefinition;
}
