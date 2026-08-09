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

## What `bin/conf` cannot do at all

The command line can read everything and change only decisions and reminders.
Everything below has an organizer screen and a form, and no command.

```sh
# THE SCHEDULE. `conf agenda` and `conf conflicts` are read-only. There is no
# command that puts a session in a room, and none that fills the empty slots.
curl -s -X POST http://127.0.0.1:8080/e/manzanita-2026/agenda/autoschedule
curl -s -X POST http://127.0.0.1:8080/e/manzanita-2026/submissions/SESS-6/schedule \
     --data-urlencode 'room=madrone-studio' \
     --data-urlencode 'starts_at=2026-10-13T11:00' --data-urlencode 'ends_at=2026-10-13T11:45'

# THE PUBLIC AGENDA. A session needs BOTH before anybody can see it: content
# approved, and published. Setting `published` on its own does nothing at all,
# silently -- there is no error and the session still does not appear.
curl -s -X POST http://127.0.0.1:8080/e/manzanita-2026/submissions/SESS-6/content \
     --data-urlencode 'content_status=approved'
curl -s -X POST http://127.0.0.1:8080/e/manzanita-2026/agenda/publish   # publishes every approved, scheduled one

# FILES. Every deck and headshot, their versions, and a bulk download.
curl -s http://127.0.0.1:8080/e/manzanita-2026/files
curl -s -o slides.zip \
  'http://127.0.0.1:8080/e/manzanita-2026/files.zip?group=speaker&task=upload-slides'
# group=speaker|session|flat; omit ?task= for everything. `conf submissions
# --json` has no files in it, and no amount of jq will find any.

# EMBEDS: the feed a conference pastes into its own website. An embed records
# its own format, so JSON means CREATING one with format=json -- the extension
# on the URL is cosmetic and does not convert anything.
curl -s http://127.0.0.1:8080/e/manzanita-2026/embeds
curl -s -X POST http://127.0.0.1:8080/e/manzanita-2026/embeds \
     --data-urlencode 'name=Programme JSON' --data-urlencode 'feed=agenda' \
     --data-urlencode 'format=json'          # feed: agenda|session_list|schedule_itinerary|speaker_list|speaker_gallery
curl -s http://127.0.0.1:8080/embed/manzanita-2026/programme-json

# Bulk email to a named audience, with its exact size and recipient list.
# `conf mail` and `conf audiences` cover the same ground.
curl -s 'http://127.0.0.1:8080/e/manzanita-2026/mail?audience=outstanding-tasks'
```

**Do not hand somebody `/api/events/<event>/agenda` as a public feed.** It is
the organizer's API: it sends no CORS header, so a browser cannot read it, and
it includes accepted sessions that are unapproved and unannounced. The public,
cross-origin, configurable feed is `/embed/<event>/<slug>`.

`conf tasks` prints one row per task, so seven people owing three things each is
twenty rows. To count *people*, read the audience size above rather than
de-duplicating that table by eye.

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
