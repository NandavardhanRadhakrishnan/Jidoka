# Jidoka

Task management that polls your sources, triages each task with AI, and runs a
per-type pipeline you describe in plain language.

A task flows like this: a **source** polls a system and creates tasks → **AI triage**
assigns a task type, proposes a new one, or asks you when it is ambiguous → if the
type has no pipeline yet you are offered **onboarding** (and can skip it) → the type's
**pipeline** runs (AI steps, agent steps that call MCP tools in a loop, branches) →
the task lands on the **board**, assigned to AI or a human.

## Run it

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...        # or JIDOKA_AI_PROVIDER=openai + OPENAI_API_KEY
export JIDOKA_OUTLOOK_CLIENT_ID=<azure app registration client id>
bun src/main.ts login-outlook              # one-time device-code login
bun run dev                                # http://localhost:3000
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JIDOKA_DB` | `./jidoka.db` | SQLite file |
| `JIDOKA_PORT` | `3000` | HTTP port |
| `JIDOKA_POLL_INTERVAL_MS` | `60000` | How often sources are polled |
| `JIDOKA_AI_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `JIDOKA_AI_MODEL` | `claude-opus-5` | Model id for the chosen provider |
| `JIDOKA_OUTLOOK_CLIENT_ID` | — | Azure app registration (public client, `Mail.Read`) |
| `JIDOKA_OUTLOOK_TENANT` | `common` | Azure tenant |
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
