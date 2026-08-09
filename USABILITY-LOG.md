# Usability log

Can a small local model operate this app? We measure it rather than assume it.

The bar is **`gemma4:12b-cpu`** — 12 billion parameters, running on CPU, no GPU —
completing each core task **at least once in three attempts** (pass@3 = 100%).

Every failure is treated first as a bug in the app and only then as a limit of
the model. That rule is the whole value of the exercise: a 12B model failing to
find something is a very cheap signal that a human will struggle too.

How to reproduce: `node eval/run-eval.js`. See `docs/EVAL.md`.

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

Three findings so far, none of which any unit test would have produced:

1. **No entry point.** Fixed with `AGENTS.md`. This also helps human newcomers,
   who were equally uninstructed.
2. **No way to filter tasks by type.** Fixed with `--task`. This is a real
   product improvement that arrived disguised as an eval failure.
3. **Confirmation that the two-step decision flow is learnable** by something
   with very little capacity to hold nuance — the strongest evidence we have
   that it is not too clever for its own good.

## Notes on running it

- One inference at a time. `eval/ask-local.sh` takes a lock; two CPU inferences
  at once make both crawl and make the timings meaningless.
- Budget ~2 minutes per attempt; the model spends far more time loading than
  thinking. The full five-task suite takes roughly 10 minutes when things pass
  on the first attempt.
- Each task's `setup.sh` re-seeds, so attempt 2 cannot coast on work attempt 1
  already did.
- Checkers read ground truth from the database rather than hardcoding expected
  values, so the tasks stay honest as the seed changes.
