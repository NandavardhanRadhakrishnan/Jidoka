# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun is the only runtime — no Node, no Docker.

```bash
bun install
bun run dev                                          # server + UI on http://localhost:3000
bun test                                             # whole suite
bun test tests/triage/triage.test.ts                 # one file
bun test tests/triage/triage.test.ts -t "ambiguous"  # one case
bun run typecheck                                    # tsc --noEmit, must stay clean
bun run build                                        # single executable: ./jidoka(.exe)
bun src/main.ts login-outlook                        # one-time Outlook device-code login
```

Run with `JIDOKA_SAMPLE_DIR=./samples` to get tasks without any credentials; `README.md` lists every environment variable.

## Code map

- `src/db/` — the only place that touches `bun:sqlite`; `migrations.ts` holds every table.
- `src/domain/` — `Task`, `TaskType`, and the Zod `PipelineDefinitionSchema` (steps: `ai`, `agent`, `mcp_tool`, `branch`, `assign`, `call_pipeline`).
- `src/repo/` — all SQL lives here, one module per table.
- `src/ai/` — the **only** place vendor SDKs may be imported. Everything else depends on the `AiProvider` interface.
- `src/sources/` — ingestion only: the `TaskSource` interface, the poller, the Outlook source, and the sample folder source.
- `src/mcp/` — MCP client; read and write against external systems goes here, never into a source.
- `src/pipeline/` — `executor.ts` runs a definition, `builder.ts` is the agent that writes one.
- `src/orchestrator.ts` — the only module that changes a task's state. Read this first.
- `src/api/server.ts` — thin Hono routes over the orchestrator.
- `src/client/` — React board, served by `src/main.ts` (`/api/*` must stay a more specific route than the HTML catch-all).

The implementation plan, including what was deliberately left out, is `docs/superpowers/plans/2026-09-17-jidoka-skeleton-onboarding.md`.

## Conventions

- Every LLM call goes through `AiProvider`; Anthropic defaults to `claude-opus-5` and must never send `budget_tokens` or `thinking`.
- Tests use stub providers and injected `fetch`/`McpLike` seams — no test hits a network.
- Single user, no auth. IDs are `crypto.randomUUID()`, timestamps are ISO-8601 UTC.

## What Jidoka is

A task management system that pulls work items from many sources (Outlook, GitHub, etc.), uses AI to work out what kind of task each one is, runs a user-defined processing pipeline for that type (deciding AI vs human handling and preparing the task), and shows everything on a kanban board. Users bring their own AI provider. Task sources (ingestion) are third-party extensions, and all reading from and acting on external systems goes through MCP.

## Architecture

Built as described below, except for the items under "Open decisions" and the deferred list at the end of the plan.

### Task flow

1. A **task source** polls a system and normalizes new items into tasks.
2. **AI triage** assigns the task a type from the type registry, proposes a new type, or asks the user when it's ambiguous.
3. If the type has no active pipeline, the user is offered **onboarding** (and can skip it).
4. The type's **pipeline** runs: sub-case branching, AI vs human decision, pre-processing.
5. The task lands on the **board**, assigned to AI or a human.

### Integrations: task sources + MCP

Integrations are split in two. Don't build a custom tool protocol; reading from and acting on external systems is MCP's job.

**Task sources (Jidoka-specific extensions).** Their only job is ingestion: poll a system and convert new items into the common task model. Each task keeps a reference to its source item (e.g. Outlook message ID, GitHub issue URL). The interface should stay minimal: configuration, a poll method, and normalization into a task. Third parties must be able to write sources without changing core code, which needs source discovery/registration plus per-source configuration and credentials.

**MCP servers (everything else).** Reading and acting on external systems goes through standard MCP servers, either existing ones or ones users add:
- **Read:** context gathering, e.g. fetch the full email thread or attachments, find earlier emails from the same sender, get an issue's comments and linked PRs.
- **Act:** write back, e.g. reply to an email, comment on or label an issue, close a ticket.

Jidoka is an **MCP client**. AI steps in pipelines get tools from the MCP servers their pipeline is allowed to use, and the pipeline-building agent chooses from those same tools. Because Jidoka converts MCP tools into each model provider's tool-calling format, MCP stays compatible with bring-your-own-AI.

A task source should declare which MCP server(s) understand its source references, so the agent knows that an Outlook message ID can be used with the Outlook MCP server's tools.

### AI triage and the task type registry

Task types can't be determined by hard-coded rules (an email might be an external customer query, an internal request, or a reconciliation), so triage is an AI stage that runs on every ingested task before any pipeline. Triage is core system behavior; everything after it is user-defined per type.

- **Registry:** each type has a name, a description, and example tasks. These are what the triage prompt classifies against.
- **Discovery:** if no type fits, triage proposes a new one (name, description, and why existing types don't fit). Types come from real tasks, not up-front configuration.
- **Ambiguity:** if more than one type is plausible (including "existing type" vs "new type"), triage does not pick. It asks the user, and the task waits for the answer. The user's choice is saved as an example task for that type.
- **Re-triage:** when a type is merged, renamed, or its description changes, only **open** tasks are re-triaged. Completed tasks keep their original type.

### New type onboarding

Triggered when a task's type has no active pipeline:

1. The user reviews the proposed type: accept, rename, edit its description, or merge it into an existing type.
2. The user describes in natural language how tasks of this type should be handled.
3. An AI agent builds the pipeline from that description, and the user reviews it before activation.

The user can **skip** onboarding. A skipped task goes to a human without a pipeline, and the type stays un-onboarded so onboarding can be started later.

### Per-type pipelines

- Built once by an AI agent (at onboarding, or when the user edits the description) and then executed for every task of that type. The agent never regenerates a pipeline per task. Keep building and execution clearly separated; at execution time, AI steps are the only non-deterministic parts.
- Declarative, versioned, and inspectable/editable by users. Composed of reusable steps: AI prompts, MCP tool calls, and automations.
- Steps decide AI vs human handling and can **pre-process before handoff** (e.g. summarize an email thread and gather context, then assign to a human). Pre-processing is distinct from full AI execution of a task.
- Supports conditional branches driven by AI step output (sub-cases within a type), and branches can call other pipelines. That requires loop detection, a version-pinning rule for called pipelines, and passing errors back to the caller.

### Bring your own AI

Users supply their own model provider (Claude, OpenAI, etc.). Every LLM call (triage, type discovery, pipeline building, AI pipeline steps) goes through a provider-agnostic abstraction; no vendor SDK is hard-wired anywhere.

### UI

- Kanban board with columns for task states: ingested, needs type confirmation, needs onboarding, processing, assigned to AI, assigned to human, done.
- Screens for answering ambiguous triage questions, onboarding new types (type review, handling description, pipeline review), and viewing/editing types and pipelines.

## Open decisions

- Tech stack (backend, frontend, storage, job/polling runner).
- Task source extension mechanism (packaging, loading, sandboxing, credential storage), and whether sources and MCP servers for the same system share credentials.
- How MCP servers are configured and run (local stdio vs remote), which tool calls need user approval, and how pipelines are granted access to MCP servers.
- Pipeline definition format and step catalog.
- Version-pinning rule for pipelines called from other pipelines (fixed version vs latest).
- How triage limits near-duplicate type proposals (e.g. a confidence threshold before proposing a new type).
