# Evaluating whether a small local model can use this app

## The bar

`gemma4:12b-cpu` — a 12-billion-parameter model running on CPU, no GPU — must
complete each core task **at least 3 times out of 5 attempts**.

This used to be "at least once in three", and that was the right bar while the
answer was often no: it asks whether the app is *possible* to use. Once features
work, the question that matters is whether they work *reliably*. A flow that
succeeds one time in three is one a real organizer gets wrong two evenings out
of three, and they will not run it five times to find out whether they were
unlucky. Majority-of-five is a consistency bar, and it is the one worth holding.

It is deliberately not 5-of-5. A small model on CPU is genuinely stochastic, and
demanding perfection would mean chasing noise rather than fixing anything.

This is a design constraint, not a benchmark we are chasing. Every failure is
first treated as a bug in the app — an ambiguous URL, a silent error, an
undocumented route — and only then as a limitation of the model.

Attempts stop as soon as the outcome cannot change: three passes, or three
failures. Each attempt costs a minute or more of CPU inference, so a task that
works reliably costs three attempts and one that is hopeless costs three; only
genuinely marginal tasks cost all five. Override with `EVAL_ATTEMPTS` and
`EVAL_REQUIRED` if you want a different shape.

## Running one question

```sh
eval/ask-local.sh <working-dir> "<prompt>"
```

Prints the model's final answer on stdout and nothing else.

```sh
$ eval/ask-local.sh . "How many .sql files are in src/migrations? Answer with just the number."
2
```

Environment: `LOCAL_MODEL` (default `gemma4:12b-cpu`), `LOCAL_TIMEOUT` (seconds,
default 420), `LOCAL_TRACE` (file to capture the tool trace, default discarded).

## Running the suite

```sh
node eval/run-eval.js              # every task
node eval/run-eval.js <task-id>    # just one

EVAL_ATTEMPTS=3 EVAL_REQUIRED=1 node eval/run-eval.js   # the old, looser bar
```

Results are written to `eval/runs/<timestamp>/` and summarised on stdout. Append
the summary to `USABILITY-LOG.md` when it represents a real checkpoint.

## Writing a task

One directory per task under `eval/tasks/`:

```
eval/tasks/count-pending-decisions/
  prompt.txt    what we ask the model
  setup.sh      optional; resets the app to a known state before each attempt
  check.sh      receives the model's answer on stdin; exit 0 means success
```

`check.sh` may also inspect the database, which is how we test tasks whose point
is a side effect ("accept SESS-3") rather than an answer.

### Rules for a fair task

**Ask for something that cannot be guessed.** A yes/no question passes 50% of the
time by luck. Ask for a count, a name, or a state change.

**Never ask the model what day it is.** opencode injects the current date into
its system prompt, so the model answers correctly from context with *zero tool
calls*. It looks like a passing tool-use test and tests nothing. Any fact you
want the model to *fetch* has to be one that cannot be in a system prompt: a file
on disk, a row in the database, a response from our HTTP server.

**Phrase it the way an organizer would.** "Which speakers still owe us a
headshot?" is the real question. If it only passes when phrased as "run
`bin/conf tasks list --status todo --requirement file`", we have tested our
ability to write a command line, not the app's legibility.

**Reset state between attempts.** Attempt 2 must not be able to succeed because
attempt 1 already did the work.

## Timing

Expect **40–330 seconds per attempt**, dominated by model load/unload rather
than prompt size. At 3-of-5 with early stopping, a healthy 10-task suite costs
about 30 attempts and runs for roughly an hour; a suite with several marginal
tasks can reach 50 attempts and take closer to two.

Exactly one inference runs at a time — `ask-local.sh` takes a lock directory and
refuses to overlap. Two CPU inferences at once make both crawl and make the
recorded timings meaningless.

## How the harness works

```sh
ollama launch opencode --model gemma4:12b-cpu -- run --dir <CWD> "<PROMPT>" </dev/null
```

Things that took a while to establish, recorded so nobody re-derives them:

- opencode's non-interactive mode is the **`run` subcommand** with a **`--dir`
  flag**. The natural-looking `opencode . --prompt "..."` is the TUI path: it
  paints escape sequences and never exits.
- Everything after `--` is passed verbatim to the `opencode` binary.
- **stdout carries only the final answer**; the banner and tool trace go to
  stderr. That split is what makes this scriptable.
- `ollama launch` does not write any config file. It injects an entire ephemeral
  opencode config — including the ollama provider pointed at
  `http://127.0.0.1:11434/v1` — through the `OPENCODE_CONFIG_CONTENT`
  environment variable, per invocation. `opencode models` on its own will not
  list any ollama model; that is expected.
- `--config` does not work headlessly: it demands an interactive terminal even
  when `--model` is supplied. Do not add it.
- Do not pass `-c`/`--continue`. Each run must start from a clean session, or the
  eval is not reproducible. Sessions accumulate in
  `~/.local/share/opencode/opencode.db`; prune it occasionally.
- Redirect stdin from `/dev/null` to defeat any TTY probe.
- `--format json` emits NDJSON events (`step_start`, `text`, `tool_use`,
  `step_finish`) if you need to assert that a tool was actually called.
