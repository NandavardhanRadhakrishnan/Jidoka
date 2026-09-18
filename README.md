# Jidoka

Task management that polls your sources, triages each task with AI, and runs a
per-type pipeline you describe in plain language.

A task flows like this: a **source** polls a system and creates tasks → **AI triage**
assigns a task type, proposes a new one, or asks you when it is ambiguous → if the
type has no pipeline yet you are offered **onboarding** (and can skip it) → the type's
**pipeline** runs (AI steps, agent steps that call MCP tools in a loop, branches) →
the task lands on the **board**, assigned to AI or a human.

## Run it

No credentials beyond a model key — tasks come from the `samples/` folder and the
board's **New task** button:

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...        # or JIDOKA_AI_PROVIDER=openai + OPENAI_API_KEY
export JIDOKA_SAMPLE_DIR=./samples
bun run dev                                # http://localhost:3000
```

With Outlook:

```bash
export JIDOKA_OUTLOOK_CLIENT_ID=<azure app registration client id>
bun src/main.ts login-outlook              # one-time device-code login
bun run dev
```

## Credentials and signing in

Four ways to authenticate, checked in this order:

1. **API key** — `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` with `JIDOKA_AI_PROVIDER=openai`).
2. **OAuth bearer token** — `ANTHROPIC_AUTH_TOKEN`.
3. **Browser sign-in** — click *sign in* on the board (details below).
4. **Nothing set** — the Anthropic SDK resolves credentials itself, including a
   profile stored on disk by `ant auth login`.

The startup log says which one is in use. `JIDOKA_AI_BASE_URL` points the client at
a gateway or proxy instead of the provider's endpoint.

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

| Variable | Default | Meaning |
|---|---|---|
| `JIDOKA_DB` | `./jidoka.db` | SQLite file |
| `JIDOKA_PORT` | `3000` | HTTP port |
| `JIDOKA_POLL_INTERVAL_MS` | `60000` | How often sources are polled |
| `JIDOKA_AI_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `JIDOKA_AI_MODEL` | `claude-opus-5` | Model id for the chosen provider |
| `ANTHROPIC_AUTH_TOKEN` | — | OAuth bearer token, used when no API key is set |
| `JIDOKA_AI_BASE_URL` | — | Gateway or proxy instead of the provider's own endpoint |
| `JIDOKA_OUTLOOK_CLIENT_ID` | — | Azure app registration (public client, `Mail.Read`) |
| `JIDOKA_OUTLOOK_TENANT` | `common` | Azure tenant |
| `JIDOKA_SAMPLE_DIR` | — | Folder polled by the sample source (e.g. `./samples`) |
| `JIDOKA_OAUTH_PROVIDERS` | `[]` | JSON array of sign-in providers (id, clientId, authorizeUrl, tokenUrl, scopes) |
| `JIDOKA_ANTHROPIC_OAUTH_CLIENT_ID` | — | Shortcut for an `anthropic` sign-in provider (with `..._AUTHORIZE_URL`, `..._TOKEN_URL`, `..._SCOPES`) |
| `JIDOKA_MCP_SERVERS` | `[]` | JSON array of `{ name, command, args }` |

MCP servers supply everything beyond ingestion: reading related mail, looking up
records, writing back. Their tools are offered to `agent` pipeline steps as
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
