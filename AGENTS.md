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
./bin/conf sessions <event>            # what the public can actually attend
./bin/conf speakers <event>            # accepted speakers, and what they owe
./bin/conf tasks <event>               # who still owes what
./bin/conf tasks <event> --task headshot   # who owes ONE particular thing
./bin/conf conflicts <event>           # clashes in the schedule
./bin/conf agenda <event>              # the schedule
./bin/conf reviews <event>             # per reviewer: submitted, still to do
./bin/conf audiences <event>           # named groups a message can go to
./bin/conf outbox <event>              # every message the app has generated
```

Two commands take no event argument, because the questions they answer are not
about one conference. They span every event on this instance:

```sh
./bin/conf people --event manzanita-2025   # who has ever spoken at one event
./bin/conf people --never-spoken           # known to us, never on stage
./bin/conf person yusuf-karim              # one person, across every event
```

"Have we had this speaker before?" is `conf person`, in one command. Reading two
`conf speakers` lists and intersecting them by eye gets the wrong name often
enough to matter.

## It changes things too

Not an inventory -- `conf --help` has the current one -- but enough to correct
the impression that this tool only reads:

```sh
./bin/conf accept <event> SESS-3          # record a decision; sends nothing
./bin/conf notify <event> SESS-3          # NOW tell the speaker, irreversibly
./bin/conf autoschedule <event>           # place everything with no slot
./bin/conf schedule <event> SESS-3 --room main-stage --at "2027-05-12T09:00"
./bin/conf mail <event> --audience outstanding-tasks --subject "..." --body "..."
./bin/conf files <event> --zip decks.zip --task upload-slides
./bin/conf embeds <event> --create "Programme" --feed agenda --format json
```

Each one has `--dry-run` or a preview where sending or overwriting is involved.

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

`notify` is irreversible and it refuses to guess. With no session codes it
stops and tells you how many decisions it would have sent; pass the codes you
mean, or `--all` if you really mean all of them. `--dry-run` previews for real,
and an unrecognised flag is an error naming what would have worked. (Both of
those were fixed after Run 4, where `conf notify <event> ---dry-run` — three
dashes — mailed the whole decision queue.)

`notify` announces a decision. `conf mail <event> --audience <key>` sends an
ordinary message to a group, which is what you want for a deadline change or a
paperwork reminder. Start from `conf audiences <event>`.

## There is also an HTTP server

`npm start` serves on `http://127.0.0.1:8080`. Every page has a JSON twin under
`/api`. `curl http://127.0.0.1:8080/llms.txt` lists every route with examples.

Check whether it is already up before starting one. `npm start` against a taken
port dies with a raw `EADDRINUSE` stack trace, which reads like a broken app and
is not:

```sh
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz   # 200 = already running
```

**If `conf --help` has no verb for what you are doing, the feature is on the
server, not missing.** Read `curl -s http://127.0.0.1:8080/llms.txt` before you
read anything under `src/`. It is generated from the route table, so it lists
every route that exists and nothing that does not. Run 7 lost thirteen of
sixteen attempts to models that went straight from a missing command to
`grep`ping the source, and not one of them ever fetched that file.

## Two interfaces, and which to reach for

There is a command line and a web server. They call the same core functions, so
they never disagree about what a clash is or what "required" means.

**Do not trust this file for the list of what each one does.** It has been wrong
twice, both times by claiming a command did not exist after somebody added it.
Ask the things that cannot go stale, because they are generated from the code:

```sh
./bin/conf --help                                  # every command, always current
curl -s http://127.0.0.1:8080/llms.txt             # every route, with recipes at the top
```

`llms.txt` opens with worked examples for the jobs people actually have --
deciding and notifying, scheduling, getting something onto the public agenda,
handing somebody a JSON feed, emailing a group, collecting uploads. Read those
before you read anything under `src/`. Run 7 lost thirteen of sixteen attempts
to going straight from a missing command to `grep`ping the source, and not one
attempt fetched that file.

## Four things that are not obvious from either

These are the rules, not the inventory. They do not change when somebody adds a
command.

**Deciding and telling are separate.** `accept` moves a submission into a queue
and sends nothing. `notify` emails the speakers and finalises it, irreversibly,
and refuses to run without either explicit codes or `--all`. If you were asked
to accept something, accept it. If you were asked to accept it *and tell them*,
do both.

**`notify` is not how you email people.** It announces a decision. For a
deadline change or a nag about paperwork, use `conf mail` / `POST /e/<event>/mail`
with a named audience. `conf audiences <event>` lists them with their sizes.

**A session needs BOTH approval and publication to be public.** Setting
`published` alone does nothing; the database refuses it and tells you why.
Approve the content first, then publish.

**`/api/events/<event>/agenda` is not a public feed.** It is organizer data: no
CORS header, and it includes accepted sessions that are unapproved and
unannounced. The public, cross-origin feed is `/embed/<event>/<slug>`, and an
embed records its own format -- so a JSON feed means *creating* one with
`format=json`. The extension on the URL is cosmetic and converts nothing.

## Counting

`conf tasks` prints one row per task, so seven people owing three things each is
twenty rows. Every list states its own count on the last line; read that rather
than piping to `wc -l`, which counts the header too.

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
- The database is `data/conference.db`. Prefer a command or a route over SQL:
  several columns only mean something in combination, and SQLite will happily
  let you set one of them.
- Timestamps are ISO-8601 UTC text. Each event carries its own display timezone.
- `npm test` runs the suite. `npm run seed` resets the demo data.
- No dependencies, ever. If you reach for a package, reconsider.
