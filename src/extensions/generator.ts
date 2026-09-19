import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRunner } from "../agent/runner";
import { ExtensionManifestSchema, type ExtensionManifest } from "../domain/extension";
import type { ExtensionSourceDeps, TaskSource } from "../sources/types";

export interface GenerateInput {
  kind: "create";
  description: string;
}

export interface FixInput {
  kind: "fix";
  targetId: string;
  currentManifest: string;
  currentSource: string;
  error: string;
}

export interface GeneratedExtension {
  manifest: ExtensionManifest;
  source: string;
}

const SYSTEM_PROMPT = `You write Jidoka extensions: a manifest.json describing an integration and a source.ts that polls it.

Reply with exactly two fenced code blocks, in this order:

\`\`\`json
{ "id": "...", "name": "...", "version": "1.0.0", "summary": "...", "readOnly": true, "auth": { ... } }
\`\`\`

\`\`\`typescript
export function createSource(deps) {
  return {
    async poll(cursor) {
      // return { items: [...], cursor: "..." }
    },
  };
}
\`\`\`

Manifest rules:
- "id" is a short kebab-case identifier for the integration (e.g. "notion", "linear-issues").
- "summary" is one plain-language sentence describing what it reads, shown to a non-technical user reviewing whether to install it. Do not describe the code.
- "readOnly" is true unless the description explicitly asks for writing back to the target system.
- "auth" must be exactly one of these three shapes:
  { "mode": "api-key", "label": "<what to prompt the user for, e.g. 'Personal Access Token'>" }
  { "mode": "oauth2-device-code", "deviceCodeUrl": "...", "tokenUrl": "...", "clientId": "...", "scopes": [...] }
  { "mode": "oauth2-auth-code-pkce", "authorizeUrl": "...", "tokenUrl": "...", "clientId": "...", "scopes": [...] }
  Pick whichever the target API actually supports, using real values from its real documentation. If the target has no public OAuth client id, prefer "api-key" instead of inventing one.

source.ts rules:
- Export exactly one function: createSource(deps) -> { poll(cursor) }. Do not add TypeScript type annotations or import anything from Jidoka's own source tree — nothing resolves that path at runtime; write plain, untyped JavaScript-shaped code.
- "deps.getToken()" returns a Promise<string> — the current valid token or API key. Call it inside poll(), never store it.
- "poll(cursor)" takes the last cursor (a string, or null on the first call) and must return { items: RawItem[], cursor: string | null }.
- Each RawItem is { externalId: string, title: string, body: string, url?: string, metadata?: Record<string, unknown> }. "externalId" must be stable and unique per item — it is used to avoid re-ingesting the same item twice.
- Use "cursor" to avoid re-fetching items already seen; do not keep in-memory state across calls — poll() may run in a fresh process.`;

function userMessage(input: GenerateInput | FixInput, feedback?: string): string {
  const base =
    input.kind === "create"
      ? `Build an extension for this: ${input.description}`
      : `This extension (id "${input.targetId}") failed a real test run. Fix it.

Current manifest.json:
${input.currentManifest}

Current source.ts:
${input.currentSource}

The error from testing it against the real API:
${input.error}`;

  return feedback
    ? `${base}\n\nYour previous attempt was rejected: ${feedback}\nFix it and reply with corrected output.`
    : base;
}

function extractBlocks(text: string): { json: string; source: string } | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  // The negative lookahead keeps "js" from matching as a prefix of the "json"
  // tag on the manifest's own fence (e.g. "```json" would otherwise satisfy
  // the "js" alternative and hijack the source block's content).
  const sourceMatch = text.match(/```(?:typescript|javascript|ts|js)(?![a-zA-Z])\s*([\s\S]*?)```/);
  if (!jsonMatch || !sourceMatch) return null;
  return { json: jsonMatch[1]!.trim(), source: sourceMatch[1]!.trim() };
}

async function checkSourceShape(source: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "jidoka-gen-"));
  const path = join(dir, "source.ts");
  await writeFile(path, source);
  try {
    const mod = (await import(pathToFileURL(path).href)) as {
      createSource?: (deps: ExtensionSourceDeps) => TaskSource;
    };
    if (typeof mod.createSource !== "function") {
      return "source.ts must export a function named createSource";
    }
    const created = mod.createSource({ getToken: async () => "stub-token" });
    if (!created || typeof created.poll !== "function") {
      return "createSource(deps) must return an object with a poll(cursor) function";
    }
    return null;
  } catch (error) {
    return `source.ts threw while loading: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function generateExtension(
  runAgent: AgentRunner,
  input: GenerateInput | FixInput,
  allowedTools: string[],
): Promise<GeneratedExtension> {
  let feedback: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runAgent.run({
      systemPrompt: SYSTEM_PROMPT,
      prompt: userMessage(input, feedback),
      allowedTools,
      maxTurns: 10,
    });

    const blocks = extractBlocks(result.text);
    if (!blocks) {
      feedback = "reply must contain exactly one ```json``` block and one ```typescript``` block";
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(blocks.json);
    } catch (error) {
      feedback = `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }

    const manifestResult = ExtensionManifestSchema.safeParse(parsedJson);
    if (!manifestResult.success) {
      feedback = manifestResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      continue;
    }

    const shapeError = await checkSourceShape(blocks.source);
    if (shapeError) {
      feedback = shapeError;
      continue;
    }

    const manifest =
      input.kind === "fix" ? { ...manifestResult.data, id: input.targetId } : manifestResult.data;

    return { manifest, source: blocks.source };
  }

  throw new Error(`extension generator failed after a retry: ${feedback}`);
}
