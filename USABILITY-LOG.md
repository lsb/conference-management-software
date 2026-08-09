# Usability log

Can a small local model operate this app? We measure it rather than assume it.

The bar is **`gemma4:12b-cpu`** — 12 billion parameters, running on CPU, no GPU —
completing each core task **at least 3 times out of 5 attempts**.

Runs 1 to 5 below used the looser bar this started with, "at least once in
three". That asks whether the app is *possible* to use, which was the right
question while the answer was often no. From Run 6 the bar is majority-of-five,
which asks whether it works *reliably* — because a flow that succeeds one time
in three is one a real organizer gets wrong two evenings out of three.

Every failure is treated first as a bug in the app and only then as a limit of
the model. That rule is the whole value of the exercise: a 12B model failing to
find something is a very cheap signal that a human will struggle too.

How to reproduce: `node eval/run-eval.js`. See `docs/EVAL.md`.

---

## Run 8 — 2026-08-09, the Run 7 failures, fixed one at a time

**All five now pass. The suite is 15/15 at 3 of 5.**

| Task | Run 7 | then | then | then | Run 8 |
| --- | --- | --- | --- | --- | --- |
| `publish-approved-panel` | 0/3 | **3/4** | | | pass |
| `slides-archive` | 0/3 | **3/3** | | | pass |
| `fill-empty-slots` | 0/3 | 1/4 | 2/5 | **3/5** | pass |
| `embed-json-feed` | 0/3 | 0/3 | 1/4 | 0/3 | **3/3** |
| `returning-speaker` | 3/4 | | | | pass |

Four rounds on the last two. Each round the trace named one specific thing, we
fixed that thing, and the number moved. That is the whole method: the score is
not the point, the diagnosis is.

### What each round actually changed

**`publish-approved-panel`** needed the database to refuse `published = 1` on
unapproved content and say why. Nothing else. 0/3 to 3/4 in one change.

**`slides-archive`** needed `conf files --zip` to exist. 0/3 to 3/3.

**`fill-empty-slots`** took three rounds because we kept fixing the wrong
surface. First we added `conf autoschedule` — no effect, because the model never
ran `--help`. Then `conf status` named the command beside the count — it passed
whenever it happened to run `conf status`, and timed out when it started from
`conf submissions`, which listed accepted talks and said nothing about whether
they had a room and a time. Adding a slot column there finished it.

**`embed-json-feed`** is the one worth writing down, because we made it worse.

### We caused a regression, and the eval caught it

It went 1/4, then **0/3**. The cause was the previous commit. Cleaning a stale
inventory out of AGENTS.md, we deleted the concrete curl for creating an embed
along with it.

That was over-applying a rule we had just written. An inventory of commands goes
stale and should not be hand-maintained. A *recipe for a job* does not — "a JSON
feed means creating an embed with `format=json`" is a fact about the design, and
the same commit that removed it argued that facts about the design are exactly
what belongs in a hand-written file.

Underneath that, two real faults:

```
$ ./bin/conf embeds manzanita-2026
EMBED            SHOWS            AS    ENABLED  URL
public-agenda    agenda           html  yes      .../public-agenda
speaker-gallery  speaker_gallery  html  yes      .../speaker-gallery

2 embeds.
```

`conf embeds` taught the create syntax **only when the list was empty**. The seed
ships two embeds. Somebody asked for a JSON feed runs the command, sees two HTML
embeds, and is told nothing about how to make a third. The one hint that mattered
was behind the one condition that never held.

And attempt 2 typed `conf embed`, singular, and got "unknown command, run
--help". Getting a name nearly right and being sent to a help page is a small
cruelty when the answer is one letter away. Unknown commands now suggest the
closest match.

With both fixed: 3 attempts, 3 passes, 164 to 208 seconds each.

### The rule, stated for the fifth time

Every fix in Runs 6, 7 and 8 has been the same shape. Not "add a feature" —
every one of these features already existed and worked. **Say the answer where
the question is asked.**

- `--task`, so "who owes a headshot" is a filter and not a scan.
- The count on every list, so nobody pipes a table to `wc -l` and counts the
  header.
- The next command beside each problem in `conf status`.
- The slot column in `conf submissions`, where somebody asking about scheduling
  actually looks.
- Recipes at the top of `llms.txt` rather than under 200 lines of route dump.
- The create syntax on a populated list, not only an empty one.

Five runs, one lesson. Every one of those would have caught out a tired human at
eleven at night, which is the whole reason a 12B model on a CPU is worth the
electricity.

## Run 7 — 2026-08-09, five new tasks over the last five features

**1/5. Target badly missed.** Four of the five failed every attempt. Eight of
those twelve attempts ended in a 420-second timeout rather than a wrong answer,
and six of them returned an empty string: the model did not get the task wrong,
it ran out of time looking for a command that does not exist.

| Task | Result | Succeeded | Attempts run | Time |
| --- | --- | --- | --- | --- |
| `embed-json-feed` | **FAIL** | 0/3 | 3 | 970s |
| `fill-empty-slots` | **FAIL** | 0/3 | 3 | 1260s |
| `publish-approved-panel` | **FAIL** | 0/3 | 3 | 1146s |
| `returning-speaker` | pass | 3/4 | 4 | 464s |
| `slides-archive` | **FAIL** | 0/3 | 3 | 979s |

The five new tasks cover the five things that shipped since Run 4 and had no
coverage: the embed generator, agenda auto-placement, the approval gate on the
public agenda, the bulk ZIP export, and the cross-event speaker database. The
ten tasks from Run 6 were not re-run; they all passed a few hours earlier
against the same seed.

This is not a worse result than Run 4's 7/10. It is the same result. Run 4 found
three features with a screen and no command; we gave those three a command and
they all passed in Run 5. Then we shipped five more features the same way.

### Nought out of sixteen attempts read the route index

The single most useful number in this run. `curl http://127.0.0.1:8080/llms.txt`
is generated from the route table, so it lists every route that exists and
nothing that does not, and it is the one file we built specifically for this
situation. Across all sixteen attempts — and the two extra traces from a run
that was interrupted and re-done — **it was fetched zero times.** Nine of the
sixteen went to `grep`, `Glob` or `Read src/` instead. Not one attempt ever
curled an organizer route.

AGENTS.md does mention it — one sentence, under "There is also an HTTP server",
after two sections of `bin/conf` commands. That ordering is the bug. We taught
everybody to start with the command line, and then shipped five features that
the command line cannot reach, and the habit we built is the thing that keeps
them away from the file that would have told them.

### "There's no schedule command"

`fill-empty-slots` asks for the accepted talks with no room and no time to be
put in the grid. Three attempts, three timeouts at 420s, no answer written.

Attempt 1 got the analysis exactly right and then had nowhere to go:

```
$ ./bin/conf submissions manzanita-2026 --json
$ ./bin/conf agenda manzanita-2026 --json
  "unscheduled": [ SESS-6, SESS-7, SESS-8 ]
$ ./bin/conf --help
$ ./bin/conf --help
$ ls -F bin/
conf*
```

> Since there is no `add` command in `bin/conf` that automatically finds a room,
> I have to guess or just pick logical ones. […] There's no "schedule" command.
> But wait, if I can't use the tool to add them directly, maybe I should check
> if there's a way to update them?

It read `--help` twice looking for a verb, listed the `bin/` directory to check
there was not a second tool in there, then wrote nine paragraphs of reasoning
about which slots were free and never placed a single session.
Attempt 3 invented `./bin/conf drafts`, got `unknown command 'drafts'`, and
wandered off.

`POST /e/<event>/agenda/autoschedule` does this whole task in one request. It
places all three cleanly, checked against our own conflict detector. It is on
the agenda screen as a button, it is in `llms.txt`, and it is in no other place
a person or a model would look. **`conf agenda` and `conf conflicts` will show
you the schedule and everything wrong with it, and there is no command in this
app that can change it.**

### An organizer set `published = 1` and told us the job was done

`publish-approved-panel` is the write task with a public consequence: SESS-6 is
accepted, has a room and a time, the committee has signed the wording off, and
it is not on the public agenda. Getting it there needs two states — content
approved, and published.

Attempt 2 invented a command, then went round it:

```
$ ./bin/conf put_on_agenda manzanita-2026 SESS-6
error: unknown command 'put_on_agenda'
→ Read src/migrations/001_initial.sql
$ sqlite3 .db "SELECT id, title, status, published FROM submission WHERE code = 'SESS-6';"
Error: in prepare, no such table: submission
$ sqlite3 data/conference.db "UPDATE submission SET published=1 WHERE code='SESS-6';"
```

> The session SESS-6 was found in the database with a `published` status of 0,
> which is why it wasn't appearing on the public agenda. I have updated its
> status to 1 (true).

The session is still not on the public agenda. `content_status` is still
`draft`, and every public surface requires `accepted AND published = 1 AND
content_status = 'approved'`. **The flag whose name is `published` does not
publish anything on its own, and nothing anywhere says so at the moment somebody
sets it.** There is no error, no constraint, and no output. You find out from an
empty website.

We already knew this shape. The WORKLOG records the same regression in Run 4's
week — "the approval gate emptied every public surface, because the seed
published sessions without approving them" — and the fix was a warning on the
organizer dashboard. A warning on a screen nobody visited does not help.

Attempt 3 is the one that stings. It found the right route by grepping, read it,
and decided against it:

> Wait, looking at `src/routes/organizer.js`, there is a route
> `POST /e/:event_id/agenda/publish`. However, for a single item, it might be
> easier to just set that specific flag in the database.

That is a reasonable inference from a route named "publish the agenda", and it
is wrong, and the app never gets a chance to say so. It then spent the rest of
its budget guessing at `sqlite3 .db` and timed out.

Two of the three attempts reached for `sqlite3 .db` before finding
`data/conference.db`, which is how an empty `.db` ended up in the repository
root: `sqlite3` creates the file it cannot find, then reports `no such table`.

### Eleven `jq` invocations against a field that does not exist

`slides-archive` asks for every slide deck in one zip and nothing else in it.
`/e/<event>/files.zip?group=speaker&task=upload-slides` returns exactly that.
Attempt 2 never got near it:

```
$ ./bin/conf submissions manzanita-2026 --json | jq '... | {code: .code, file_ids: .file_count}'
$ ./bin/conf submissions manzanita-2026 --json | jq '... | {code: .code, files: .files}'
$ ./bin/conf submissions manzanita-2026 --json | jq '... | {code: .code, files: .files_detail}'
$ ./bin/conf submissions manzanita-2026 --json | jq '... | {code: .code, filenames: .files.filenames}'
```

Eleven of those in a row, each guessing a different field name, each returning
`null`, until the 420 seconds ran out with an empty answer. It had already tried
`./bin/conf labels manzanita-2026` and been told `unknown command 'labels'`.

`conf submissions --json` returns a fixed five-key shape — `code`, `status`,
`title`, `track`, `speakers` — with no files in it, and `jq` cannot tell the
difference between a key that is missing and a key that is empty. **There is no command anywhere in this app that mentions an
uploaded file.** `conf --help` has no file verb, and neither the file library
nor the archive is named in AGENTS.md. Attempt 1 went looking in
`src/core/zip.js` and `src/core/files.js` instead, which is the Run 1 failure
with a different filename.

### We shipped four formats and pointed the website at the wrong one

`embed-json-feed` asks for the programme as JSON for the conference's own
website. Two of three attempts answered confidently and identically:

> The URL to fetch the programme as JSON is
> `http://127.0.0.1:8080/api/events/manzanita-2026/agenda`.

That is a plausible answer and a bad one. `/api/events/<event>/agenda` sends no
`access-control-allow-origin`, so a browser on the conference's own site cannot
read it at all; and it returns `unscheduled: [SESS-6, SESS-7, SESS-8]` —
accepted talks that are unapproved and unannounced. Taking that answer publishes
three sessions nobody has been told about, from an endpoint that does not work.

The embed feed next door does the right thing: CORS open, a minute of caching,
and only `accepted AND published AND approved`. Nothing points at it. `embed`
does not appear in AGENTS.md, and `/e/<event>/embeds` is reachable only from the
organizer nav.

There is a second trap underneath, which no attempt got far enough to hit. An
embed records its own format, and the extension on the URL is deliberately
cosmetic, so `/embed/manzanita-2026/public-agenda.json` serves **HTML** with
`content-type: text/html`. The reasoning for that is sound and written down in
the source — a URL already pasted into somebody's website keeps working when
they switch it from HTML to JSON. But `llms.txt` documents that route as "An
embed feed as JSON", which is the opposite of what it does.

### The one that passed did it the hard way

`returning-speaker` — who has had a talk accepted at both conferences — passed
3 of 4. Every passing attempt did the same thing: list one event, list the
other, intersect by eye.

```
$ ./bin/conf events
$ ./bin/conf speakers manzanita-2025 && ./bin/conf speakers manzanita-2026
```
> Yusuf Karim

The failure is the interesting one. Attempt 2 used `conf submissions` instead of
`conf speakers`, which meant intersecting a 19-row list against a 2-row list,
with Yusuf Karim's name visible in both. It answered **Mei-Lin Chen**.

That is Run 2's Sam Whitfield and Run 6's off-by-one header, a third time: when
the tool hands over a long mixed list, the reader gets it wrong sometimes, and
the direction of the error is never random — it is whichever row was easiest to
miss.

And there was a command that answers this in one line. `conf people --event
<slug>` and `conf person <slug>` landed about an hour before this run, from the
work that gave the speaker database a screen. **Across all eighteen traces,
`conf people` and `conf person` were used zero times, and `/crm` was fetched
zero times.** The only place either string appears in any trace is inside two
`conf --help` dumps that the model then scrolled past. A command in the last
block of a fifty-five-line help text, absent from AGENTS.md, is not yet
reachable. Shipping the interface was the right call and it did not land.

### What we changed

`AGENTS.md` only, and mostly by deleting things that had become false. It still
said `bin/conf` had no command for reviews, bulk mail or the public session
list, and it still warned that `notify --dry-run` sends for real and that
unknown flags are silently dropped. All four of those were fixed after Run 4 and
the documentation had not caught up: it was telling every reader that the sharp
edge we removed was still there, and hiding three commands we had added.

Added: what `bin/conf` cannot do at all — the schedule, publishing, files, and
embeds — with curl for each; that approval and publishing are both required and
that setting `published` alone does nothing; that `/api/.../agenda` is not a
public feed; `conf people` and `conf person`; the database path; and one rule at
the top of the server section — **if `conf --help` has no verb for it, read
`llms.txt` before you read `src/`.**

Documentation is again the smaller half. The four failures above are missing
commands and a missing guard rail, and those are proposed rather than made.

Two notes on how this run was taken, so the numbers can be trusted. The speaker
database's screen and command landed while the run was in flight; the server was
restarted onto the new code two minutes into the first task, and
`returning-speaker` — the only task that could have used either — ran an hour
after that, so its four attempts had both available and used neither.
`returning-speaker` was also re-run from scratch after the harness killed the
first pass mid-task; the discarded attempt passed, on the same two commands.

---

## Run 6 — 2026-08-09, the first run at the tightened bar

**10/10 at 3 passes out of 5.** Nine of the ten were perfect: three attempts,
three passes, stop.

| Task | Result | Succeeded | Attempts run | Time |
| --- | --- | --- | --- | --- |
| `accept-one` | pass | 3/3 | 3 | 205s |
| `count-pending` | pass | **3/4** | 4 | 236s |
| `decide-then-notify` | pass | 3/3 | 3 | 177s |
| `find-speaker-clash` | pass | 3/3 | 3 | 208s |
| `mail-audience-size` | pass | 3/3 | 3 | 564s |
| `mail-outstanding-send` | pass | 3/3 | 3 | 653s |
| `public-session-search` | pass | 3/3 | 3 | 383s |
| `reviewer-workload` | pass | 3/3 | 3 | 453s |
| `who-owes-headshot` | pass | 3/3 | 3 | 159s |
| `who-owes-slides` | pass | 3/3 | 3 | 385s |

The headline is not the 10/10. It is that the *stricter bar immediately found
something the old one had been hiding*, on the very first task, in the simplest
question in the suite.

### Four rows and a header

`count-pending` — "how many submissions are waiting for a decision?" — passed
three times and failed once. The failing attempt:

```
$ ./bin/conf submissions manzanita-2026 --status pending
$ ./bin/conf submissions manzanita-2026 --status pending | wc -l
```

It answered **5**. There are four. The fifth line was the column header.

Under the old bar this task passed on its first attempt and we would never have
seen it. It had presumably been failing about one time in four all along.

Nothing about that is the model being careless. Piping a list to `wc -l` is what
anybody does, and our table gives a wrong answer to it. So list commands now
state their own count:

```
$ ./bin/conf submissions manzanita-2026 --status pending
CODE     STATUS   TITLE                                          ...
SESS-14  pending  Lightning: Our Worst Outage Was a Retry Loop   ...
SESS-15  pending  Property-Based Testing for Prompt Templates    ...
SESS-16  pending  Teaching Juniors to Review Model-Written Code  ...
SESS-17  pending  Running Open-Weight Models on the Hardware ... ...

4 submissions.
```

Nobody should have to count, and the person who does will sometimes get it wrong
in the same direction. This is the third time in six runs that the fix has been
to *say the answer* rather than to leave it derivable — after `--task` for
filtering tasks, and after naming the three questions the CLI cannot answer.

### What the bar change cost

Thirty-one attempts across ten tasks, about an hour of CPU. Early stopping did
its job: nine tasks cost three attempts each, and only the flaky one paid for a
fourth. A 5-of-5 bar would have cost fifty attempts and told us less, because
the interesting signal is "does this fail sometimes", not "does this ever fail".

---

## Run 5 — 2026-08-09, the three failures re-run after the fixes

**All three pass, each on the first attempt.** Effective suite score: 10/10.

| Task | Run 4 | Run 5 | Time |
| --- | --- | --- | --- |
| `public-session-search` | **FAIL** 3/3 | pass 1/3 | 190s |
| `reviewer-workload` | **FAIL** 3/3 | pass 1/3 | 183s |
| `mail-outstanding-send` | **FAIL** 3/3 | pass 1/3 | 329s |

What each of them did, in full:

```
$ curl -s 'http://127.0.0.1:8080/sessions/manzanita-2026?q=retrieval'
```
> The session "Retrieval Is Not a Vector Database" (SESS-2) will be held on
> 2026-10-12 from 11:00–11:45 in the Cypress Room, and it is presented by
> Yusuf Karim.

```
$ curl -s http://127.0.0.1:8080/e/manzanita-2026/review
```
> Sofia Marchetti

```
$ curl -s -X POST http://127.0.0.1:8080/e/manzanita-2026/mail ...
```

The send task is the one worth dwelling on. Its checker scores both directions:
every person the audience resolver says owes something must appear in the
outbox, **and** nobody else may. In Run 4 the model announced four decisions to
the wrong people and missed five of the seven it was asked to reach. In Run 5 it
posted to the bulk-mail endpoint and hit exactly the seven.

**The unexpected finding: documentation did as much work as code.** Two of the
three went straight to `curl` against the HTTP surfaces, not to the new CLI
commands, because the "Three questions the command line cannot answer" section
added to `AGENTS.md` told them where to look. The commands matter — `conf
reviews`, `conf mail`, `conf sessions` all exist now and all answer correctly —
but on this run the pointer was what got used. Both were worth adding; only one
of them was expensive.

---

## Run 4 — 2026-08-09, five new tasks over the surfaces added since Run 3

**pass@3: 7/10. Target missed.** Three of the five new tasks failed every
attempt. The five original tasks all still pass, four of them first time.

| Task | Result | Attempts | Time |
| --- | --- | --- | --- |
| `accept-one` | pass | 1/3 | 114s |
| `count-pending` | pass | 1/3 | 56s |
| `decide-then-notify` | pass | 1/3 | 63s |
| `find-speaker-clash` | pass | 1/3 | 95s |
| `mail-audience-size` | pass | 2/3 | 177s |
| `mail-outstanding-send` | **FAIL** | 3/3 | 967s |
| `public-session-search` | **FAIL** | 3/3 | 177s |
| `reviewer-workload` | **FAIL** | 3/3 | 913s |
| `who-owes-headshot` | pass | 1/3 | 56s |
| `who-owes-slides` | pass | 1/3 | 72s |

The new tasks are: an attendee's question against the public session list; who
owes slides; who to chase about reviewing; how many people a bulk message would
reach; and actually sending that message, scored on who ended up in the outbox.

The shape of the result is the point. Everything reachable from `bin/conf`
passed. Everything added since Run 3 that lives only on a web page failed, and
failed the same way three times running.

### The command line stops where the new features start

`conf --help` lists sixteen commands. None of them is about reviewers, none is
about bulk email, and none knows what the public can see. Three features
shipped since Run 3 with an organizer screen and no command, and the model
spent its whole budget looking for the command.

`reviewer-workload` asked which reviewer has the most left to do. Attempt 1:

```
$ ./bin/conf tasks manzanita-2026            # speaker paperwork, not reviews
$ ./bin/conf --help                          # no review command
$ ./bin/conf submissions manzanita-2026 --status pending
$ ./bin/conf submissions manzanita-2026 --status unscored
No submissions match.
```

Note the fourth line. `--status unscored` is not a status. `conf tasks --task`
validates its argument and lists the real ones — we added that in Run 3 — but
`conf submissions --status` does not, so an invented filter comes back as a
confident empty list. The JSON API gets this right (`unknown status 'unscored'`,
`use one of: ...`); the command line, which is what AGENTS.md tells everyone to
use, does not. The model read that empty list as evidence and kept going. It
then grepped the source, noted "`src/routes/organizer.js:54` indicates there's a
view for evaluation progress", never fetched it, and ran out of time with an
empty answer.

Attempt 2 gave up on the tool and wrote SQL:

```
$ sqlite3 data/conference.db "... WHERE r.status <> 'done' ..."
Kenji Watanabe
```

There is no `'done'`. The statuses are `assigned`, `in_progress`, `submitted`,
`declined`, and they are written down in exactly one place: a CHECK constraint
in `005_evaluation_rounds.sql`. `<> 'done'` matches every row, so this counts
*all* of Watanabe's nine reviews instead of Marchetti's three outstanding ones.
SQLite answered cheerfully. The wrong name came back with no hedging.

Attempt 3 got the logic right (`status <> 'submitted'`) and then guessed
`src/db/conference.db` and `src/db/data.db` for a file that lives at
`data/conference.db`.

Three attempts, three different wrong roads, one cause: the only correct answer
lives at `/e/manzanita-2026/review` and nothing tells you it is there.

### An organizer asked us to email seven people. We emailed four the wrong thing.

`mail-outstanding-send` is the write task: tell everyone who still owes us
something that the deadline moved. Attempts 1 and 2 timed out at 420s. Attempt
3 finished in 127s and did this:

```
$ ./bin/conf notify manzanita-2026
SESS-7: told 1 speaker(s), now accepted, 4 task(s) assigned
SESS-8: told 1 speaker(s), now accepted, 1 task(s) assigned
SESS-10: told 1 speaker(s), now declined
SESS-9: told 1 speaker(s), now declined

4 sent, 0 skipped. Messages are in the outbox.
```

Then: *"I have notified all speakers who had pending decisions for Manzanita
2026."* It thought it had done the job.

It had announced two acceptances and two rejections. Theo Lambert, who owes us
nothing and whose talk was declined, got told his talk was declined. Five of
the seven people who actually owe paperwork got nothing. `notify` with no codes
is a bulk, irreversible send with no confirmation and no preview, and it is the
only thing in `conf --help` with the word "email" next to it. Asked to email a
group, a tired human reaches for the same command.

Attempt 2 found the sharper version of this. It went looking for a preview:

```
$ ./bin/conf notify manzanita-2026 ---dry-run
4 sent, 0 skipped. Messages are in the outbox.
```

Three dashes instead of two. `parseArgs` accepts any `--`-prefixed token and no
command validates what it got, so the flag was silently dropped and the send
went through. Reproduced by hand afterwards: four submissions moved to
`accepted`/`declined` with `notified_at` set. **A typo in a preview flag mails
the whole decision queue.** That is the most serious thing this suite has found.

Attempt 1 shows why nobody got to the right answer. It tried the reminder
engine, got a true but useless reply, and went looking in the source:

```
$ ./bin/conf remind manzanita-2026 --dry-run
No reminders are due.

✱ Glob "src/core/**/*mail*" 1 match
$ ./bin/conf --help
→ Read src/core/mail.js
```

"No reminders are due" is correct — every seeded due date is still in the
future — but it does not say so, and it does not mention that a deadline
announcement is a different thing from an overdue-task reminder and lives at
`/e/<event>/mail`. The model reads it as a dead end and starts reading source,
which is the Run 1 failure all over again.

### `conf agenda` does not say who is speaking

`public-session-search` is an attendee's question: which sessions are about
retrieval, and who is giving them. All three attempts ran one command and got
half the answer.

```
$ ./bin/conf agenda manzanita-2026
CODE    DAY         TIME         ROOM          TITLE
SESS-2  2026-10-12  11:00-11:45  Cypress Room  Retrieval Is Not a Vector Database
```

Attempt 1 named the session and then stopped: *"To find out who is giving it, I
can look up that specific submission's details."* It never did. Attempts 2 and
3 did not even try.

`/sessions/manzanita-2026?q=retrieval` answers the whole question in one
request — title, time, room, and Yusuf Karim's name under it — and it is the
page an attendee would actually be looking at. Nothing in AGENTS.md points at
it, so it was never fetched, in any attempt.

There is a trap underneath. The obvious command, `conf submissions --q
retrieval`, also returns SESS-18, "Notes on Long-Context Retrieval" — an
unsubmitted draft. Answering an attendee from that list tells them about a talk
that is not happening. The checker fails that answer on purpose. The CLI has no
notion of what is published; only the public pages do.

### The audience picker exists and nobody found it

`mail-audience-size` asked how many people one message would reach. It passed,
but on the second attempt and by hand. Both attempts ran `conf tasks
manzanita-2026`, got twenty rows for seven people, and de-duplicated by eye.
Attempt 1 answered **6** — it missed Yusuf Karim, who appears only in the two
rows furthest down the table. Attempt 2 counted the same list again, wrote "6",
caught itself mid-sentence — *"There are 7 distinct individuals... Wait, let me
re-count"* — and landed on 7.

This is Run 2's Sam Whitfield problem exactly, one level up. We fixed
"who owes a headshot" with `--task`; we did not fix "how many people is that".
`/e/manzanita-2026/mail` prints **Anyone with an outstanding task (7)** in a
dropdown, correct by construction. `conf status` reports the other number —
"20 outstanding speaker tasks" — which is tasks, not people, and is what an
organizer sizing a mailing would misread.

### What we changed

Only `AGENTS.md`, and only to name surfaces that already exist: the three
questions `bin/conf` cannot answer, with curl for each; the `EADDRINUSE`
check before starting a server; that `conf tasks` counts tasks and not people;
and a warning that `notify` with no codes sends everything and that an
unrecognised flag is ignored rather than refused.

Documentation is the smaller half. The failures above are missing commands and
a missing guard rail, and those are listed as proposed code changes rather than
made here.

---

## Run 3 — 2026-08-09, after adding a task filter

`who-owes-headshot`, re-run alone after the fix below.

| Task | Result | Attempts | Time |
| --- | --- | --- | --- |
| `who-owes-headshot` | pass | **1**/3 | 101s |

One command, exact answer, no scanning:

```
$ ./bin/conf tasks manzanita-2026 --task headshot
PERSON          EMAIL                       TASK               FOR  DUE
Rosa Delgado    rosa.delgado@example.com    Upload a headshot  -    2026-09-16
Ananya Iyer     ananya.iyer@example.com     Upload a headshot  -    2026-09-16
Lucas Oliveira  lucas.oliveira@example.com  Upload a headshot  -    2026-09-16
Aisha Rahman    aisha.rahman@example.com    Upload a headshot  -    2026-09-16
Elena Volkova   elena.volkova@example.com   Upload a headshot  -    2026-09-16
Sam Whitfield   sam.whitfield@example.com   Upload a headshot  -    2026-09-16
```

---

## Run 2 — 2026-08-09, the full suite

**pass@3: 5/5. Target met.**

| Task | Result | Attempts | Total time |
| --- | --- | --- | --- |
| `accept-one` | pass | 1/3 | 53s |
| `count-pending` | pass | 1/3 | 42s |
| `decide-then-notify` | pass | 1/3 | 62s |
| `find-speaker-clash` | pass | 1/3 | 53s |
| `who-owes-headshot` | pass | 2/3 | 251s |

Four of five landed on the first attempt in under a minute each. Two results
are worth more than the headline number.

### The two-step decision flow survived contact with a small model

`accept-one` says *"record that decision… do not send any email to the speaker
yet"*. `decide-then-notify` says *"accept SESS-16 and let the speaker know
straight away"*. Both passed first time, and the checkers verify the database,
not the prose: the first requires `status = accept_queue` **and zero decision
emails**; the second requires `status = accepted` **and at least one**.

This was the design's biggest risk. A two-step flow is more to explain than a
single "accept" button, and if a 12B model could not keep the halves apart, that
would have been strong evidence the distinction was too subtle for the humans it
is meant to protect. It kept them apart.

### The one repeated failure was our bug, and we fixed it

`who-owes-headshot` failed its first attempt with **5 of 6 names**. The trace
shows why:

```
$ ./bin/conf submissions manzanita-2026
... 19 rows ...
$ ./bin/conf tasks manzanita-2026
PERSON          EMAIL                       TASK                        FOR   DUE
Rosa Delgado    rosa.delgado@example.com    Sign the speaker agreement  -     2026-09-02
Ananya Iyer     ananya.iyer@example.com     Sign the speaker agreement  -     2026-09-02
...
```

Twenty rows of four different task types, mixed together, and the model had to
visually filter for "Upload a headshot". It missed Sam Whitfield.

That is not a model limitation. **There was no way to ask the question.** "Who
still owes a headshot?" is one of the most common things an organizer asks, and
the tool answered it with a list you had to be careful with. A human doing this
at 11pm before a deadline misses Sam Whitfield too.

Fixed by adding `--task <slug>` to `conf tasks` and `?task=` to the API, listing
the available task slugs in the error when an unknown one is given, and telling
`AGENTS.md` to filter rather than list-and-scan. Run 3 above shows the result.

---

## Run 1 — 2026-08-09, first contact

`count-pending`, one attempt. **Timed out at 300s.** The trace, in full:

```
✱ Grep "Manzanita" 17 matches
→ Read src/seed.js
```

The model searched for the conference name, found `src/seed.js`, and began
reading 1,400 lines of demo data into a 12B CPU model's context. It never
recovered. The answer was one command away.

Again: an app problem, not a model problem. The most discoverable path led into
demo data rather than to the app's own interface. Nothing told a newcomer where
to start.

Fixed by adding `AGENTS.md`: what the app is, the exact command for each common
question, and an explicit instruction not to open `src/seed.js`. The same
question immediately afterwards took **one tool call and 106 seconds**.

---

## What this has cost, and what it has bought

Findings so far, none of which any unit test would have produced:

1. **No entry point.** Fixed with `AGENTS.md`. This also helps human newcomers,
   who were equally uninstructed.
2. **No way to filter tasks by type.** Fixed with `--task`. This is a real
   product improvement that arrived disguised as an eval failure.
3. **Confirmation that the two-step decision flow is learnable** by something
   with very little capacity to hold nuance — the strongest evidence we have
   that it is not too clever for its own good.
4. **A typo in a flag sends the decision queue.** `conf notify <event>
   ---dry-run` mailed everybody. Fixed: flags are declared per command and
   anything else is an error, `notify` refuses to run without codes or `--all`,
   and it has a real `--dry-run`. (Run 4)
5. **Three features shipped with a screen and no command.** Reviewer progress,
   bulk email, and the public session list. Fixed with `conf reviews`,
   `conf mail`/`conf audiences`, and `conf sessions`; all three then passed in
   Run 5. (Run 4)
6. **`conf submissions --status` accepts anything.** Fixed: it now names the
   real statuses, the way `--task` already did. (Run 4)
7. **Five more features shipped with a screen and no command.** The schedule
   cannot be written from the CLI, nor can publishing, files, embeds, or
   approval. This is finding 5 again at four times the size, and the pattern is
   now the most reliable predictor of a failed task in this suite. Open. (Run 7)
8. **`published = 1` on its own does nothing, silently.** A session needs
   `content_status = 'approved'` too. Setting the obviously named flag produces
   no error, no warning, and no visible change. Open. (Run 7)
9. **`/api/events/<event>/agenda` reads like the public feed and is not.** No
   CORS header, and it includes accepted-but-unannounced sessions. It is the
   answer a model gives when asked for a JSON programme. Open. (Run 7)
10. **A new command nobody can find is not a command.** `conf people` and
    `conf person` shipped an hour before Run 7 and were used zero times in
    sixteen attempts, including on the task they exist for. Open. (Run 7)

Runs 1 to 3 found problems in what the app said. Run 4 found problems in what it
does: the worst failure was not a wrong answer but four irreversible emails sent
to the wrong people, twice, by a model that believed it had done as asked. Run 7
found that we keep making the same mistake faster than we fix it — every feature
since Run 4 shipped with a form and no command, and the eval caught all five in
one afternoon.

## Notes on running it

- One inference at a time. `eval/ask-local.sh` takes a lock; two CPU inferences
  at once make both crawl and make the timings meaningless.
- Budget ~2 minutes per attempt; the model spends far more time loading than
  thinking. The full five-task suite takes roughly 10 minutes when things pass
  on the first attempt. Ten tasks with three genuine failures took about 50.
- A task that has no reachable path costs the full `LOCAL_TIMEOUT` every time,
  because the model does not give up, it runs out. Run 7's four failures were
  eight timeouts at 420s out of twelve attempts — 80 minutes for five tasks,
  where Run 6 did ten tasks in about 60.
- Tasks touching a web surface need the server up first
  (`node --no-warnings=ExperimentalWarning src/server.js &`, then check
  `/healthz`). The suite does not start one for you.
- Each task's `setup.sh` re-seeds, so attempt 2 cannot coast on work attempt 1
  already did.
- Checkers read ground truth from the database rather than hardcoding expected
  values, so the tasks stay honest as the seed changes.
