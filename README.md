# Conference management software

An open-source tool for running a conference call for speakers: collecting
proposals, reviewing them, deciding, telling the speakers, chasing what they owe,
and building the schedule.

It runs on your own machine, stores everything in one SQLite file, and has **no
dependencies at all** — no `npm install`, no build step, no bundler. What is on
disk is what runs.

```sh
npm run migrate     # create data/conference.db
npm run seed        # a demo conference with real-looking data
npm start           # http://127.0.0.1:8080
```

`npm run seed` prints the demo administrator's address and password. Sign in at
`/sign-in`; every organizer screen needs an account, on your laptop exactly as
on a deployment. For scripts, mint a token at `/account` and send it as
`authorization: bearer <token>`.

A fresh instance nobody has seeded or claimed is claimed at `/setup/claim` with
the setup token, which is `SETUP_TOKEN` or the contents of `data/setup-token`.

There is also a command line, which needs no sign-in because it opens the
database directly:

```sh
./bin/conf --help
./bin/conf status <event>
```

## Why it is built this way

**Speed.** No framework, no ORM, no network hop to a database. Pages render in
well under a millisecond. A conference organizer refreshing a list of four
hundred submissions should not have time to notice.

**Legibility.** The whole data model is one commented SQL file. The whole routing
table is a list. You can read this codebase in an afternoon, and so can a small
language model — which is a design constraint we test rather than assume. See
`docs/EVAL.md`.

**It is your data.** One SQLite file you can copy, diff, back up, and read with
any tool that speaks SQL. Nothing phones home, and nothing is emailed anywhere —
every message is rendered into an outbox you can read.

**It behaves the same everywhere.** Who may organize is a row in the database,
never a fact about which interface the server is bound to. There is no "open on
localhost" shortcut, because having one meant the behaviour that shipped was the
one nobody ever exercised.

## The one thing to understand

**Recording a decision and telling the speaker are separate steps.**

Marking a submission accepted moves it into a queue and sends nothing. A separate
"notify" step emails the speakers, finalises the status, and assigns their
onboarding tasks. A programme committee can therefore argue, change its mind,
and reverse itself all afternoon, and nobody is ever one misclick away from
telling forty people they got in.

```
draft ─→ pending ─┬─→ accept queue  ──(notify)──→ accepted
                  └─→ decline queue ─(notify)──→ declined
        any state ─→ withdrawn
```

Speakers never see the queue states. Until you actually send, their portal says
"Under review".

## What it does

- **Custom submission forms** — an ordered field list with required/locked
  fields, conditional questions, per-form deadlines, submission limits, and
  combined character caps for print programmes.
- **Category-based routing** — a rule reads one answer on an arriving proposal
  and decides where it goes: which review round picks it up, and what track it
  belongs to. First match wins, and every proposal records which rule sorted it
  and why.
- **A public call for speakers** that a stranger can complete without making an
  account, and which drops them straight into their speaker portal afterwards.
- **Review and scoring** across multiple rounds, with weighted criteria, per
  reviewer progress, and machine-assisted reviews marked as such rather than
  silently averaged in with human ones.
- **A speaker portal** — their submissions, their own bio and links to edit, and
  every task they owe with its deadline.
- **A reminder engine** that mails exactly the people who have not finished, a
  week before, the day before, and the day after a deadline — and then stops.
- **Schedule building** with first-class conflict detection: speaker
  double-bookings, room clashes, and track collisions. A move that would clash is
  refused rather than accepted and complained about afterwards. Sessions can be
  dragged onto the grid, moved with the keyboard, or placed by a form — all three
  send the same request, so all three are refused by the same code.
- **Speaker tasks you define yourself** — a bio, a headshot, a signed form, a
  deck. A task added after the acceptances have gone out still reaches everybody
  already accepted, and says how many.
- **Calendar invites** as `.ics`, keeping one identity per session, so moving a
  talk revises the entry already in the speaker's calendar instead of adding a
  second one.
- **A dashboard** of sentences rather than charts: "3 submissions awaiting a
  decision", "2 accepted speakers missing a bio or headshot", each linking to the
  exact filtered list.
- **An outbox** holding every message the app has generated, so "what did we tell
  that speaker, and when" is always answerable.
- **Published agenda, speaker gallery, and embeds** for your own website.
- **A JSON API and a CLI** covering the same ground as the UI.

## Layout

```
src/
  migrations/     the entire data model, one commented SQL file
  core/           domain logic: submissions, tasks, schedule, mail, auth
  http/           routing, request parsing, HTML escaping
  routes/         organizer screens, speaker portal, public pages, JSON API
  server.js       the server
  cli.js          the command line
docs/
  REQUIREMENTS.md what we were asked for
  DESIGN.md       how it is put together, and why that shape
  DECISIONS.md    standing choices and their costs
  EVAL.md         how we test that a small local model can drive it
  DEPLOY.md       three environment variables and a disk
  ACCEPTANCE-TESTS.md  certifying a deployment over HTTP
eval/             the local-model usability suite
test/             node:test, no test framework
test/acceptance/  the same, over HTTP, importing nothing
Dockerfile        no build step, because there is nothing to build
```

Start with `src/migrations/001_initial.sql`. It is written to be read.

## Tests

```sh
npm test           # 336 in-process tests, no framework
npm run test:http  # the same app over HTTP, by URL, importing nothing
```

The second suite exists because the first cannot see certain bugs. It talks to a
running server and nothing else, so it can be pointed at a deployment to prove
the deployment did not change anything. It found a confirmation email whose
sign-in link had never worked for anybody: in-process the token round-trips
fine, and by hand you never notice, because the same response signs you in.

There is a third kind of test in `eval/`, which points a small local model at
the app and measures whether it can actually do the job. See `docs/EVAL.md`.

## Deploying

```sh
docker build -t conference .
docker run -d -p 8080:8080 -v conference-data:/app/data \
  -e PUBLIC_ORIGIN=https://conf.example.com \
  -e SETUP_TOKEN="$(openssl rand -base64 32)" conference
```

The volume is not optional: `/app/data` holds the database and every file a
speaker has uploaded, and without it the first redeploy erases the conference.
See `docs/DEPLOY.md` for what each variable does.

## Requirements

Node 22.5 or newer, for the built-in `node:sqlite`. Nothing else.
