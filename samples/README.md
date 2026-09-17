# Sample tasks

Drop files here and the sample source turns each one into a task:

```bash
export JIDOKA_SAMPLE_DIR=./samples
bun run dev
```

- **`.json`** — `{ "title": ..., "body": ..., "url": ..., "metadata": { ... } }`
- **`.txt` / `.md`** — first non-empty line is the title, the rest is the body

Each file is keyed by its filename, so a file is ingested once. Editing a file
does not create a second task — copy it under a new name to ingest it again.

Faster still, with no files at all: the **New task** button on the board posts to
`POST /api/tasks` and runs triage immediately.

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Where is my order?","body":"Nothing arrived."}'
```
