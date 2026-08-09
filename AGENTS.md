# Working in this repository

Conference management software: a call for speakers, review and decisions, a
speaker portal, and a schedule. Plain Node, plain SQLite, no dependencies.

## To answer a question about the conference, run a command

Do not read the source or the database to answer a question about the data. Use
the command line. It is fast and it prints a table.

```sh
./bin/conf events                      # which conferences exist
./bin/conf status <event>              # what needs attention right now
./bin/conf submissions <event>         # every submission
./bin/conf submissions <event> --status pending
./bin/conf show <event> SESS-3         # one submission in full
./bin/conf speakers <event>            # accepted speakers, and what they owe
./bin/conf tasks <event>               # who still owes what
./bin/conf tasks <event> --task headshot   # who owes ONE particular thing
./bin/conf conflicts <event>           # clashes in the schedule
./bin/conf agenda <event>              # the schedule
./bin/conf outbox <event>              # every message the app has generated
```

Add `--json` to any of them for machine-readable output. `./bin/conf --help`
lists everything.

When a question is about one particular kind of thing ("who owes a headshot",
"which submissions are pending"), filter with a flag rather than listing
everything and reading through it. A filtered list is a complete answer; a long
mixed list is one you have to be careful with.

The event you almost certainly want is `manzanita-2026`.

## To change something

```sh
./bin/conf accept <event> SESS-3       # record an acceptance. Sends nothing.
./bin/conf decline <event> SESS-3      # record a decline. Sends nothing.
./bin/conf notify <event> SESS-3       # NOW email the speakers about it
./bin/conf remind <event> --dry-run    # preview overdue-task reminders
```

**Recording a decision and telling the speaker are two separate steps.**
`accept` moves a submission into a queue and sends no email. `notify` is what
emails people and makes the decision final. If you are asked to accept
something, use `accept`. If you are asked to accept it *and tell the speaker*,
use `accept` and then `notify`.

## There is also an HTTP server

`npm start` serves on `http://127.0.0.1:8080`. Every page has a JSON twin under
`/api`. `curl http://127.0.0.1:8080/llms.txt` lists every route with examples.

## Files worth reading, and one to skip

- `src/migrations/001_initial.sql` — the entire data model, commented. Start here
  if you need to understand how things relate.
- `src/core/` — the domain logic: submissions, tasks, schedule, mail, auth.
- `docs/DESIGN.md`, `docs/DECISIONS.md` — why it is shaped this way.
- **`src/seed.js` is 1,400 lines of demo data. Do not read it.** It will tell you
  nothing that `./bin/conf` will not tell you faster.

## Conventions

- Records are addressed by readable slugs (`manzanita-2026`, `ada-lovelace`) and
  session codes (`SESS-1`). There are no UUIDs to copy.
- Timestamps are ISO-8601 UTC text. Each event carries its own display timezone.
- `npm test` runs the suite. `npm run seed` resets the demo data.
- No dependencies, ever. If you reach for a package, reconsider.
