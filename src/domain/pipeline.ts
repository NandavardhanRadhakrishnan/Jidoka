export type PipelineStatus = "draft" | "active" | "superseded";

export interface Pipeline {
  id: string;
  typeId: string;
  version: number;
  status: PipelineStatus;
  definition: unknown;
  createdAt: string;
}

export interface NewPipeline {
  typeId: string;
  definition: unknown;
}
