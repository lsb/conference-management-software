# Design

Two goals, held simultaneously:

1. A conference organizer can run a real conference with this.
2. A **small local AI assistant** can operate it. Our bar is `gemma4:12b-cpu` — a 12B
   model running on CPU — completing a task at least once in three attempts
   (pass@3 = 100%). See `docs/EVAL.md`.

Goal 2 is not decoration. It is a design constraint that pushes the whole app toward
being simple, legible, and honest, which happens to make it better for humans too.

## Stack

| Choice | Why |
| --- | --- |
| Node 22, no dependencies | `node:sqlite` ships in the runtime. Zero `npm install`, zero supply chain, zero lockfile drift. A small model can read the whole app. |
| SQLite, single file | The entire state of a conference is one file you can copy, diff, and back up. |
| Server-rendered HTML, no build step | No bundler, no transpile, no `dist/`. What is on disk is what runs. |
| Plain `<form>` + POST, no JS required | Every action is reachable with `curl`. JavaScript is progressive enhancement only. |
| Binds `127.0.0.1` by default | Local-first. Nothing leaves the machine until we decide it should. |

There is no framework. Routing is a table of `[method, pattern, handler]`. If that
becomes painful we will feel the pain before we add anything.

## Why this shape is legible to a small model

These are testable claims, not vibes. Each one exists because it changes whether a
12B model succeeds or fails.

**Human-readable stable IDs, never opaque UUIDs.**
A 12B model transcribing `f47ac10b-58cc-4372-a567-0e02b2c3d479` between two tool calls
will corrupt it. It will not corrupt `sess-opening-keynote`. Every user-facing
identifier is a slug. Integer primary keys stay internal.

**Machine-readable twins live at explicit paths, not behind an `Accept:` header.**
A small model reliably gets a URL right and unreliably gets a request header right.
There are two families of twin, and they are deliberately not the same thing:

- *Organizer data* is under `/api/`, mirroring the organizer screens under `/e/`.
  `/e/manzanita-2026/speakers` renders HTML; `/api/events/manzanita-2026/speakers`
  returns JSON. All of it requires organizer access, including the parts that look
  like a published programme, because it contains decisions nobody has been told yet.
- *Public data* is an embed, created on purpose with a format:
  `/embed/<event>/<slug>`. That is the one with a CORS header, and the one that shows
  only what has been approved *and* published.

This paragraph used to claim that `/sessions` had a twin at `/api/sessions`. It never
did, and the invented path outlived several people looking for it. `/sessions`,
`/agenda` and `/speakers` are public pages for humans; the machine-readable public
feed is an embed, and there is no `/api/sessions` because a feed that appears without
anybody choosing to publish it is how an unannounced acceptance escapes.

Coverage is not total and does not claim to be. The builders — the form builder, the
embed and content editors, evaluation setup — are configured over HTML form posts.
`/api/` reads back what they produced (the embeds that exist, the files that arrived)
but does not create it. **`GET /llms.txt` is generated from the route table, so it is
the only list of what exists that cannot be wrong. Prefer it to this file.**

**`/llms.txt` is the front door.**
A single plain-text file listing what the app is, every route, and a copy-pasteable
`curl` example per route. A model that reads one file should be able to do anything.
This file is generated from the route table, so it cannot drift out of date.

**Errors state the fix, not just the fault.**
A real one, from `POST /api/events/manzanita-2026/portal-links` with an empty body:
`{"error": "missing required field: person", "hint": "body: {\"person\":\"ada-lovelace\"}. Slugs are at /api/events/manzanita-2026/speakers"}`.
A model that gets a bare `400` retries randomly. A model that is told what is missing
fixes it on the next call.

**A CLI alongside the HTTP API.**
`bin/conf sessions manzanita-2026`. Small models are frequently better at composing a shell
command than at constructing an HTTP request, and the eval harness drives a coding
agent that already has a shell. Both surfaces call the same core functions — the CLI
is not a reimplementation.

**One obvious way to do each thing.**
No aliases, no optional parameter that changes the response shape, no endpoint that
does two jobs. Ambiguity is where small models fail.

## Domain model sketch

The load-bearing idea from `docs/REQUIREMENTS.md` is that acceptance **converts**
rather than **copies**. Concretely: `submission` and `session` are the same underlying
row lineage, and `person` is the single identity that a submitter, a speaker, and a
reviewer are all facets of. Accepting a submission does not create a new speaker with
copied fields; it promotes an existing record and links it.

Sketch, to be firmed up against the remaining research:

- `person` — one row per human, across all events. This is what makes the multi-event
  CRM possible without duplicate outreach.
- `event` — a conference instance (a year).
- `submission` — a proposal into an event's CFP. Carries the state machine.
- `session` — a scheduled thing. Created by promoting a submission, or directly.
- `review` / `criterion` / `score` — the evaluation workflow.
- `task` — something a speaker owes, with a deadline. Drives both the speaker portal
  and the reminder engine.
- `room` / `track` / `slot` — the agenda, and what conflict detection reads.

## Open questions

- Auth. Speakers must reach their portal without a heavy signup, which points at
  emailed magic links (capability URLs). Deferred until the core records exist.
- Email delivery. The reminder engine's *logic* is the interesting part; actual SMTP
  is a pluggable sink, and locally it writes to an outbox we can inspect.
- Whether to adopt an external local-table library later. Not until plain SQLite hurts.
