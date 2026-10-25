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

export const SYSTEM_PROMPT = `You write Jidoka extensions: a manifest.json describing an integration and a source.ts that lists its items.

Reply with exactly two fenced code blocks, in this order:

\`\`\`json
{ "id": "...", "name": "...", "version": "1.0.0", "summary": "...", "readOnly": true, "auth": { ... } }
\`\`\`

\`\`\`typescript
export function createSource(deps) {
  return {
    async list({ since }) {
      const token = await deps.getToken();
      const items = [];
      const failures = [];
      // Fetch every item that changed at or after since (everything when since is null).
      // For each record the API returns:
      //   if it can't be built (no readable id, a missing field): failures.push({ key, error }) and move on
      //   otherwise: items.push({ key, threadKey, occurredAt, title, body, url, participants })
      return { items, failures };
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
- Export createSource(deps) -> { list({ since }) }. Do not add TypeScript type annotations or import anything from Jidoka's own source tree — nothing resolves that path at runtime; write plain, untyped JavaScript-shaped code.
- "deps.getToken()" returns a Promise<string> — the current valid token or API key. Call it inside list(), never store it.
- "list({ since })" receives "since", an ISO-8601 timestamp string or null, and must return { items: SourceItem[], failures: { key?: string, error: string }[] }.
- Each SourceItem is { key: string, threadKey?: string, version?: string, occurredAt: string, title: string, body: string, url?: string, metadata?: Record<string, unknown>, participants?: { identity: string, name?: string, role: "from" | "to" | "cc" | "author" | "assignee" | "commenter" }[] }:
  - "key": the item's own immutable id, taken from the item itself (a Message-ID, a Gmail message id, an issue comment id). At most 512 characters.
  - "threadKey": items with the same threadKey become one task (an email conversation, an issue and its comments). Omit it and the item is a task on its own.
  - "version": changes when the item's content changes (an updated_at, an etag). Omit it for items that never change, like an email.
  - "occurredAt": when the item happened, ISO-8601. It orders the items within a thread.
  - "title": non-empty. "body": the item's text. "url": a link to the item, when there is one.
- When items have people on them (sender, recipients, author, assignees, commenters), return them in "participants" with a role. Write each identity as namespace:value — "email:" for email addresses, the system's own name for logins and user ids (e.g. "github:octocat", "slack:U123ABC"). Prefer a stable identifier (address, login, user id) over a display name, and put the display name in "name".
- An extension promises exactly three things; Jidoka does everything else (remembering what it has seen, skipping duplicates, grouping items into tasks, noticing changes):
  1. Stable keys: a key is immutable and comes from the item itself, so the same item gets the same key on every call.
  2. Self-contained thread keys: a threadKey is computable from that one item alone, with no lookup across other items, so items can arrive in any order and still group correctly.
  3. A complete window: return at least every item that changed at or after "since". Returning more is fine — a superset is harmless, because Jidoka skips keys it already has. "since" null means everything you have.
- Where common sources get their keys (item key; threadKey; what to avoid):
  - Gmail API: message "id"; "threadId".
  - Gmail over IMAP: X-GM-MSGID; X-GM-THRID; avoid IMAP UIDs (they are per folder and reset).
  - Microsoft Graph: "internetMessageId", or immutable ids; "conversationId"; avoid the default "id" (it changes when a message moves folder).
  - Plain IMAP: the Message-ID header; the first id in References, else In-Reply-To, else the item's own Message-ID; avoid IMAP UIDs, and for a missing Message-ID do not substitute a hash of sender, date and subject.
  - Slack: channel + "ts"; "thread_ts".
  - Teams: message "id"; the parent message id.
  - GitHub / Jira / Zendesk: the comment id, or the issue/ticket id; the issue/ticket.
  - WhatsApp / SMS: the provider's message id; the contact / phone pair.
  - Ledgers (Xero, QuickBooks): the invoice id; no threadKey; use the last-updated time as "version".
- never use IMAP UIDs or mailbox positions as keys. They change when mail moves or a mailbox is rebuilt, and the same email would come back as a new task.
- never invent a fallback key. When an item's id can't be read, don't build one from other fields; report the item in "failures".
- Report items you couldn't build in "failures", never drop them: { key, error } when you know the key, { error } alone when you don't. Jidoka shows every failure to the user, who can retry it once the extension is fixed.
- Keep no cursor; filter by "since". Hold no state across calls and do no paging between calls — list() may run in a fresh process. Page through the API inside one call if you need to, and return the whole window.
- When the target system has an obvious "who am I" endpoint reachable with the same credential (GitHub's GET /user, Microsoft Graph's GET /me, Slack's auth.test), also export \`async function getIdentity(deps)\` — same deps — returning the connected user's identity on that system, namespaced the same way as participants ("github:octocat", "email:you@example.com"). Jidoka uses it to recognise the user's own activity, so their own comments never come back to them as new work. If there is no such endpoint, omit it.`;

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
      createSource?: (deps: ExtensionSourceDeps) => Partial<TaskSource> | null | undefined;
    };
    if (typeof mod.createSource !== "function") {
      return "source.ts must export a function named createSource";
    }
    const created = mod.createSource({ getToken: async () => "stub-token" });
    if (!created || typeof created.list !== "function") {
      return "createSource(deps) must return an object with a list({ since }) function";
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
