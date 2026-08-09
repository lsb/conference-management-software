# Usability log

Can a small local model operate this app? We measure it rather than assume it.

The bar is **`gemma4:12b-cpu`** — 12 billion parameters, running on CPU, no GPU —
completing each core task **at least once in three attempts** (pass@3 = 100%).

Every failure is treated first as a bug in the app and only then as a limit of
the model. That rule is the whole value of the exercise: a 12B model failing to
find something is a very cheap signal that a human will struggle too.

How to reproduce: `node eval/run-eval.js`. See `docs/EVAL.md`.

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
   ---dry-run` mails everybody. Unknown flags are dropped silently and `notify`
   has no preview. Open. (Run 4)
5. **Three features shipped with a screen and no command.** Reviewer progress,
   bulk email, and the public session list are unreachable from `bin/conf`, and
   the model burned entire attempts hunting for commands that do not exist.
   Open. (Run 4)
6. **`conf submissions --status` accepts anything.** An invented status returns
   "No submissions match" instead of the error the JSON API gives. A wrong
   filter looks like a true empty answer. Open. (Run 4)

Runs 1 to 3 found problems in what the app said. Run 4 found problems in what it
does: the worst failure was not a wrong answer but four irreversible emails sent
to the wrong people, twice, by a model that believed it had done as asked.

## Notes on running it

- One inference at a time. `eval/ask-local.sh` takes a lock; two CPU inferences
  at once make both crawl and make the timings meaningless.
- Budget ~2 minutes per attempt; the model spends far more time loading than
  thinking. The full five-task suite takes roughly 10 minutes when things pass
  on the first attempt. Ten tasks with three genuine failures took about 50.
- Tasks touching a web surface need the server up first
  (`node --no-warnings=ExperimentalWarning src/server.js &`, then check
  `/healthz`). The suite does not start one for you.
- Each task's `setup.sh` re-seeds, so attempt 2 cannot coast on work attempt 1
  already did.
- Checkers read ground truth from the database rather than hardcoding expected
  values, so the tasks stay honest as the seed changes.
