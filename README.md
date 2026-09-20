# Jidoka

Task management that polls your sources, triages each task with AI, and runs a
per-type rule you describe in plain language.

A task flows like this: a **source** polls a system and creates tasks → **AI triage**
assigns a task type, proposes a new one, or asks you when it is ambiguous → if the
type has no rule yet you are offered **onboarding** (and can skip it) → the type's
**rule** runs (AI steps, agent steps that call MCP tools in a loop, branches) →
the task lands on the **board**, assigned to AI or a human.

## Run it

No API key needed: with `JIDOKA_AI_PROVIDER=agent-sdk`, every model call goes
through the Claude Code CLI, so whatever that CLI is logged in as — a
subscription included — covers triage, rule building and every step.

```bash
bun install
claude                                     # once, to sign the CLI in
export JIDOKA_AI_PROVIDER=agent-sdk
export JIDOKA_AI_MODEL=sonnet              # optional
export JIDOKA_SAMPLE_DIR=./samples
bun run dev                                # http://localhost:3000
```

With an API key instead:

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # or JIDOKA_AI_PROVIDER=openai + OPENAI_API_KEY
export JIDOKA_SAMPLE_DIR=./samples
bun run dev
```

With Outlook:

```bash
export JIDOKA_OUTLOOK_CLIENT_ID=<azure app registration client id>
bun src/main.ts login-outlook              # one-time device-code login
bun run dev
```

## Handoff: picking up a task

When a rule assigns a task to a human, it can also say what that person should
have in front of them. The `assign` step carries an `open` list:

```json
{ "id": "s4", "type": "assign", "to": "human",
  "open": [
    { "kind": "url",     "label": "The email",   "url": "{{task.url}}" },
    { "kind": "draft",   "label": "Draft reply", "content": "{{context.reply}}" },
    { "kind": "session", "label": "Review chat", "sessionId": "{{context.review_session}}" }
  ] }
```

**Pick up** on the task opens the URLs in tabs, shows drafts to copy, and offers
each command. A `session` target resolves to `claude --resume <id>` — the
conversation an `agent` step already had, so a reviewer lands in a chat that has
read the diff instead of starting cold. Agent steps publish their id at
`<output>_session`.

Set `JIDOKA_TERMINAL` to launch commands instead of just copying them, e.g.
`wt.exe -- bash -lc "{{command}}"` or `cmd.exe /c start "" cmd /k {{command}}`.

> Rules are written by a model from task content, so command text is untrusted.
> The server only launches a command already stored on that task's own handoff,
> matched by label, and only in a visible terminal; there is no endpoint that runs
> an arbitrary string, and nothing runs without a click.

## Credentials and signing in

Four ways to authenticate, checked in this order:

1. **API key** — `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` with `JIDOKA_AI_PROVIDER=openai`).
2. **OAuth bearer token** — `ANTHROPIC_AUTH_TOKEN`.
3. **Browser sign-in** — click *sign in* on the board (details below).
4. **Nothing set** — the Anthropic SDK resolves credentials itself, including a
   profile stored on disk by `ant auth login`.

The startup log says which one is in use. `JIDOKA_AI_BASE_URL` points the client at
a gateway or proxy instead of the provider's endpoint.

### Agent steps: API key or subscription

An `agent` rule step runs a tool loop. Two backends run it, chosen with
`JIDOKA_AGENT_RUNNER`:

| | `in-process` (default) | `agent-sdk` |
|---|---|---|
| Loop runs in | Jidoka | the Claude Code CLI, via `@anthropic-ai/claude-agent-sdk` |
| MCP calls by | Jidoka's MCP client | the CLI, using the servers the step is allowed |
| Auth | API key | whatever the CLI is logged in as, including a subscription |
| Needs | a key | `claude` installed and logged in on the host |

Both enforce the step's tool allowlist in Jidoka's own code — the SDK backend
passes `allowedTools` *and* a `canUseTool` callback, and runs in `dontAsk` mode so
anything unlisted is denied rather than prompted. It never uses
`bypassPermissions`, and it clears `ANTHROPIC_API_KEY` from the CLI's environment
so a stray key cannot silently bill the API instead.

Subscription runs share one personal account's limits, so keep them few:
`JIDOKA_AGENT_CONCURRENCY` defaults to 1 for `agent-sdk` and 4 for `in-process`.
`JIDOKA_AGENT_MODEL` and `JIDOKA_AGENT_MAX_BUDGET_USD` bound a run.

Setting `JIDOKA_AI_PROVIDER=agent-sdk` turns agent steps on the CLI too, and
routes triage, the builder and `ai` steps through it as single-shot CLI calls —
that is the no-API-key setup. Each such call costs a process spawn (~1s) plus a
cache read of Claude Code's own system prompt, so it trades throughput for not
needing a key.

### Browser sign-in

`GET /api/auth/<provider>/start` redirects to the provider's login page; the
provider redirects back to `/api/auth/<provider>/callback`, where the code is
exchanged for tokens (authorization code + PKCE, S256). Tokens are stored in the
`oauth_tokens` table and refreshed automatically before they expire. The header
shows each provider's state, with *sign in* / *sign out*.

Configure providers either with the Outlook shortcut (`JIDOKA_OUTLOOK_CLIENT_ID`
is enough — Microsoft's endpoints are known), or explicitly:

```bash
export JIDOKA_OAUTH_PROVIDERS='[{
  "id": "anthropic",
  "clientId": "<your client id>",
  "authorizeUrl": "<provider authorize endpoint>",
  "tokenUrl": "<provider token endpoint>",
  "scopes": ["..."]
}]'
```

An `anthropic` entry here is used for model calls whenever no API key or token is
set in the environment. The equivalent `JIDOKA_ANTHROPIC_OAUTH_CLIENT_ID`,
`..._AUTHORIZE_URL`, `..._TOKEN_URL` and `..._SCOPES` variables do the same thing.

> **About signing in with a Claude subscription:** this is the same shape of flow
> as `/login` in Claude Code, but it needs a client id issued for *your* app.
> Jidoka ships no client id, and reusing another product's would be credential
> misuse. A claude.ai Pro/Max subscription is also billed for Anthropic's own
> apps rather than arbitrary third-party API traffic, so check Anthropic's current
> terms before relying on it. Everything else — redirect, PKCE, callback, storage,
> refresh — is built and waiting for a client id you are entitled to use.

## Feeding it tasks

- **Sample folder** — drop a `.json`, `.txt` or `.md` file into `JIDOKA_SAMPLE_DIR`; see `samples/README.md`.
- **By hand** — the board's **New task** button, or `POST /api/tasks` with `{ "title": ..., "body": ... }`.
- **Outlook** — polled on the interval once you have logged in.

To drive the whole flow by hand — inject, triage, onboard, activate — see
[`docs/try-it.md`](docs/try-it.md) for curls, or import
[`docs/postman/jidoka.postman_collection.json`](docs/postman/jidoka.postman_collection.json)
into Postman (it passes ids between requests for you).

## Configuration

Settings saved through the Settings panel in the UI override the matching
environment variable on a per-field basis once saved. Once a field has a
saved setting, changing its environment variable afterward has no effect
until that setting is cleared or changed again through the UI. Either way,
changes only take effect on the next server restart — nothing here is
applied live.

| Variable | Default | Meaning |
|---|---|---|
| `JIDOKA_DB` | `./jidoka.db` | SQLite file |
| `JIDOKA_PORT` | `3000` | HTTP port |
| `JIDOKA_POLL_INTERVAL_MS` | `60000` | How often sources are polled |
| `JIDOKA_AI_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `agent-sdk` (Claude Code CLI, no key) |
| `JIDOKA_AI_MODEL` | `claude-opus-5` | Model id for the chosen provider |
| `ANTHROPIC_AUTH_TOKEN` | — | OAuth bearer token, used when no API key is set |
| `JIDOKA_AI_BASE_URL` | — | Gateway or proxy instead of the provider's own endpoint |
| `JIDOKA_OUTLOOK_CLIENT_ID` | — | Azure app registration (public client, `Mail.Read`) |
| `JIDOKA_OUTLOOK_TENANT` | `common` | Azure tenant |
| `JIDOKA_SAMPLE_DIR` | — | Folder polled by the sample source (e.g. `./samples`) |
| `JIDOKA_EXTENSIONS_DIR` | `./extensions` | Folder scanned for extension manifests; always on, a missing/empty directory is a no-op |
| `JIDOKA_TERMINAL` | — | Launcher for handoff commands, `{{command}}` substituted; unset means copy-only |
| `JIDOKA_AGENT_RUNNER` | `in-process` | `in-process` (API key) or `agent-sdk` (Claude Code CLI, subscription) |
| `JIDOKA_AGENT_CONCURRENCY` | `1` sdk / `4` in-process | Parallel agent runs |
| `JIDOKA_AGENT_MODEL` | — | Model for agent runs |
| `JIDOKA_AGENT_MAX_BUDGET_USD` | — | Per-run budget ceiling (agent-sdk) |
| `JIDOKA_OAUTH_PROVIDERS` | `[]` | JSON array of sign-in providers (id, clientId, authorizeUrl, tokenUrl, scopes) |
| `JIDOKA_ANTHROPIC_OAUTH_CLIENT_ID` | — | Shortcut for an `anthropic` sign-in provider (with `..._AUTHORIZE_URL`, `..._TOKEN_URL`, `..._SCOPES`) |
| `JIDOKA_MCP_SERVERS` | `[]` | JSON array of `{ name, command, args }` |

MCP servers supply everything beyond ingestion: reading related mail, looking up
records, writing back. Their tools are offered to `agent` rule steps as
`<server>__<tool>`.

## Build a single executable

```bash
bun run build      # -> ./jidoka (or jidoka.exe on Windows)
```

## Tests

```bash
bun test                                   # everything
bun test tests/triage/triage.test.ts       # one file
bun test tests/triage/triage.test.ts -t "ambiguous"   # one case
bun run typecheck
```
