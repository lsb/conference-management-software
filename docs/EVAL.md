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

## Two suites, asking two different questions

```sh
node eval/run-eval.js              # every task, in the repository
node eval/run-eval.js <task-id>    # just one

node eval/run-eval.js --http       # every task, from an EMPTY directory
node eval/run-eval.js --http <id>

EVAL_ATTEMPTS=3 EVAL_REQUIRED=1 node eval/run-eval.js   # the old, looser bar
```

**The default suite** runs the model inside the repository. It has `AGENTS.md`,
it has `bin/conf`, it can read the source. That measures whether somebody handed
the project can operate it.

**`--http` runs it in an empty directory** with nothing but a URL and an API
token in its prompt — no repository, no command line, no source. `GET /llms.txt`
and the routes it describes carry the entire load. This is the harder and more
honest question, because it is the situation of everybody who meets a
deployment: an evaluator, a contractor, an agent. Nothing about how the app is
*packaged* can help; only what the app *says* about itself.

It needs a server running (`npm start`) and re-seeds between attempts, so point
it at a throwaway instance, not one you care about:

```sh
npm start &
node eval/run-eval.js --http
BASE_URL=https://conf.example.com node eval/run-eval.js --http   # a deployment
```

Each attempt gets a freshly minted token (`eval/mint-token.js`) and a fresh
empty working directory under `eval/runs/<timestamp>/`, so attempt N cannot
coast on attempt N-1. Prompts use `{{BASE_URL}}` and `{{TOKEN}}` placeholders.

**The model may be remote; the harness may not.** `BASE_URL` moves where the
*model* points, and that part works. But the checkers read ground truth out of
`data/conference.db` with `sqlite3`, and `setup.sh` re-seeds by running
`npm run seed` -- so the harness has to be on the same machine as the app, with
the repository beside it. Pointing it at somebody else's deployment would score
against the wrong database and try to re-seed a conference that is not yours.

That is a deliberate trade rather than an oversight. Ground truth taken from the
database cannot be fooled by the app agreeing with itself, which is the whole
reason the checkers read it directly. Certifying a *remote* deployment is what
`npm run test:http` is for -- it imports nothing and reads no database.

### Watching one

The server's own log is the other half of the trace, and says what the model was
told when it got something wrong:

```sh
CONF_LOG=verbose npm start
403 POST /e/manzanita-2026/notify 0.4ms -- refusing to guess: 4 decisions are waiting | pass the ones you mean as {"codes":["SESS-1"]}, or {"all":true}
```

`CONF_LOG=verbose` adds query strings with tokens redacted, which is what you
want when you are trying to see which parameters a model guessed at.

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
