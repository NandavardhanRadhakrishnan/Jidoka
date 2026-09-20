# Trying Jidoka

Two ways to drive the app by hand: import the Postman collection at
`docs/postman/jidoka.postman_collection.json`, or paste the curls below.

Postman can also import the curls directly (Import → Raw text), so either route
gets you the same requests.

## Start the server

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # or JIDOKA_AI_PROVIDER=openai + OPENAI_API_KEY
export JIDOKA_SAMPLE_DIR=./samples      # optional: also ingests the files in samples/
bun run dev                             # http://localhost:3000
```

Triage and rule building are real model calls, so a working key is required.
Without one, injection still stores the task but returns 502 with the error.

> The examples use `BASE=http://localhost:3000` and `jq` to pull ids out of the
> responses. On Windows PowerShell, use the Postman collection instead — it does
> the same id-passing for you.

```bash
BASE=http://localhost:3000
```

## 1. Inject a task — triage runs immediately

```bash
curl -s -X POST "$BASE/api/tasks" \
  -H 'content-type: application/json' \
  -d '{
    "title": "Where is my order?",
    "body": "I placed order 4821 last Tuesday and the tracking link still says label created. Can you check what happened?",
    "metadata": { "from": "customer@example.com" }
  }' | jq
```

In an empty system there is no type to match, so triage proposes one and the task
lands in `needs_onboarding` with a freshly created `typeId`.

| Code | Meaning |
|---|---|
| 201 | Stored and triaged |
| 400 | `title` missing |
| 409 | `sourceId` + `externalId` already exist |
| 502 | Model call failed — the task is stored anyway; body has `task` and `error` |

Optional fields: `url`, `sourceId` (default `manual`), `externalId` (default a
UUID), `metadata`.

## 2. Look at the board and the registry

```bash
curl -s "$BASE/api/tasks" | jq '.tasks[] | {state, title, typeId, typeCandidates}'
curl -s "$BASE/api/types" | jq '.types[] | {id, name, status, activeRuleId}'
```

Task states: `ingested`, `needs_type_confirmation`, `needs_onboarding`,
`processing`, `assigned_ai`, `assigned_human`, `done`, `failed`.

## 3. Answer triage when it is unsure

A task in `needs_type_confirmation` lists its `typeCandidates`. Pick one:

```bash
TASK=$(curl -s "$BASE/api/tasks" | jq -r '.tasks[] | select(.state=="needs_type_confirmation") | .id' | head -1)
TYPE=$(curl -s "$BASE/api/types" | jq -r '.types[0].id')

curl -s -X POST "$BASE/api/tasks/$TASK/type" \
  -H 'content-type: application/json' \
  -d "{\"typeId\": \"$TYPE\"}" | jq '.task | {state, typeId}'
```

Your answer is saved as an example on that type, so the next similar task is
classified without asking.

## 4. Onboard the type — describe it, an agent builds the rule

```bash
TYPE=$(curl -s "$BASE/api/types" | jq -r '.types[0].id')

RULE=$(curl -s -X POST "$BASE/api/types/$TYPE/onboard" \
  -H 'content-type: application/json' \
  -d '{
    "description": "Summarize what the customer is asking in two sentences. Then decide whether this is a simple status question or a complaint: label it status or complaint. Status questions go to AI, complaints go to a human with the summary attached."
  }' | tee /dev/stderr | jq -r '.rule.id')
```

This returns a **draft** — nothing runs yet. Read the definition first:

```bash
curl -s "$BASE/api/rules/$RULE" | jq '.rule.definition'
```

Step kinds it can use: `ai` (one prompt), `agent` (loops over MCP tools until
done), `mcp_tool` (one known call), `branch` (on an earlier step's output),
`assign` (`ai` or `human`), `call_rule`. `agent` and `mcp_tool` steps only
appear when MCP servers are configured through `JIDOKA_MCP_SERVERS`.

The builder rejects rules that reference tools you don't have or that can
finish without assigning the task, and retries the model once before giving up
with 502.

Rename or re-describe the type while you are here — the description is what
triage reads:

```bash
curl -s -X PATCH "$BASE/api/types/$TYPE" \
  -H 'content-type: application/json' \
  -d '{"name": "Customer order query", "description": "An external customer asking about the status of an order they placed"}' | jq
```

Two near-duplicate types? Merge one into the other (its tasks move across):

```bash
curl -s -X PATCH "$BASE/api/types/$DUPLICATE" \
  -H 'content-type: application/json' \
  -d "{\"mergeInto\": \"$TYPE\"}" | jq
```

## 5. Activate — waiting tasks get processed

```bash
curl -s -X POST "$BASE/api/rules/$RULE/activate" | jq '.rule | {version, status}'
curl -s "$BASE/api/tasks" | jq '.tasks[] | {state, assignee, title, context}'
```

Activation publishes the draft, marks the type active, and runs the rule over
every task of that type still in `needs_onboarding`. Any previous version becomes
`superseded`.

Don't want a rule for a task right now?

```bash
curl -s -X POST "$BASE/api/tasks/$TASK/skip-onboarding" | jq '.task | {state, assignee}'
```

It goes to a human as-is and the type stays `proposed` for later.

## 6. The payoff — a new task flows straight through

```bash
curl -s -X POST "$BASE/api/tasks" \
  -H 'content-type: application/json' \
  -d '{
    "title": "Order 5190 still not delivered",
    "body": "Two weeks now and no parcel. This is the second time and I would like a refund.",
    "metadata": { "from": "another.customer@example.com" }
  }' | jq '.task | {state, assignee, context}'
```

No questions asked this time: triage matches the existing type, the rule runs,
and the task arrives assigned. `context` holds each step's output and
`context.ruleLog` lists which steps ran. A `failed` task carries
`context.error`.

## Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/tasks` | Everything on the board |
| `POST` | `/api/tasks` | Inject a task and triage it |
| `POST` | `/api/tasks/:id/type` | Answer an ambiguous triage |
| `POST` | `/api/tasks/:id/skip-onboarding` | Assign to a human without a rule |
| `POST` | `/api/tasks/:id/pick-up` | Stamp `pickedUpAt` and return the handoff targets |
| `POST` | `/api/tasks/:id/run-command` | Launch a handoff command by `label` (needs `JIDOKA_TERMINAL`) |
| `POST` | `/api/tasks/:id/complete` | Mark done, with an optional `note` |
| `POST` | `/api/tasks/:id/reopen` | Undo a completion |
| `GET` | `/api/types` | Type registry with rule versions |
| `PATCH` | `/api/types/:id` | Rename, re-describe, or `mergeInto` another type |
| `POST` | `/api/types/:id/onboard` | Build a draft rule from a description |
| `GET` | `/api/rules/:id` | Read a rule definition |
| `POST` | `/api/rules/:id/activate` | Publish it and process waiting tasks |

Across every write route: a body that isn't valid JSON, or a missing required
field (`title`, `typeId`, `description`), returns 400; an unknown id returns 404;
a failed model call returns 502.
