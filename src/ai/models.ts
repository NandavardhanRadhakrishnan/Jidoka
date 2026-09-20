export type ModelProviderId = "anthropic" | "openai" | "agent-sdk";

export interface ModelOption {
  id: string;
  label: string;
  blurb: string;
}

const CLAUDE_MODELS: ModelOption[] = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    blurb: "fastest, cheapest — simple classification or extraction",
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    blurb: "balanced default — most drafting and judgment steps",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    blurb: "most capable — nuanced judgment or complex multi-tool agent steps",
  },
];

const OPENAI_MODELS: ModelOption[] = [
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    blurb: "fastest, cheapest — simple classification or extraction",
  },
  { id: "gpt-4.1", label: "GPT-4.1", blurb: "balanced default — most drafting and judgment steps" },
];

/** `agent-sdk` is still Claude, just run through the CLI — same catalog as `anthropic`. */
export function modelCatalog(provider: ModelProviderId): ModelOption[] {
  return provider === "openai" ? OPENAI_MODELS : CLAUDE_MODELS;
}
