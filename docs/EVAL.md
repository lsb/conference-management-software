# Evaluating whether a small local model can use this app

## The bar

`gemma4:12b-cpu` — a 12-billion-parameter model running on CPU, no GPU — must be
able to complete each core task **at least once in three attempts**. We write that
as **pass@3 = 100%**: every task passes, where "passes" means at least one of three
independent attempts succeeded.

Three attempts rather than one because a small model is genuinely stochastic; one
attempt rather than ten because if it takes ten, the app is too confusing.

This is a design constraint, not a benchmark we are chasing. Every failure is
first treated as a bug in the app — an ambiguous URL, a silent error, an
undocumented route — and only then as a limitation of the model.

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
default 300), `LOCAL_TRACE` (file to capture the tool trace, default discarded).

## Running the suite

```sh
node eval/run-eval.js              # every task, up to 3 attempts each
node eval/run-eval.js <task-id>    # just one
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

Expect **5–120 seconds per call**, dominated by model load/unload rather than
prompt size. A tool-using turn costs roughly one extra round trip. Budget ~2
minutes per attempt, so a 10-task suite at 3 attempts is about an hour.

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
