#!/usr/bin/env bash
#
# Ask the local model one question, in one directory, and print its answer.
#
#   eval/ask-local.sh <working-dir> <prompt>
#   eval/ask-local.sh . "How many submissions are awaiting a decision?"
#
# Environment:
#   LOCAL_MODEL     ollama model to use        (default: gemma4:12b-cpu)
#   LOCAL_TIMEOUT   seconds before giving up   (default: 420)
#   LOCAL_TRACE     path to write the tool trace to (default: discarded)
#
# Notes, learned the hard way (see docs/EVAL.md):
#
#   * opencode's non-interactive mode is the `run` SUBCOMMAND with a `--dir`
#     FLAG. The obvious-looking `opencode . --prompt "..."` is the TUI path: it
#     paints escape codes and never exits.
#   * Everything after `--` is passed verbatim to the opencode binary.
#   * stdout carries only the final assistant answer; the banner and the tool
#     trace go to stderr. That split is what makes this scriptable.
#   * stdin is redirected from /dev/null so nothing can probe for a TTY.
#   * `--config` is broken headlessly -- it demands an interactive terminal even
#     when --model is given. Don't add it.
#   * No `-c`/`--continue`: every run must start from a clean session or the
#     eval is not reproducible.

set -euo pipefail

MODEL="${LOCAL_MODEL:-gemma4:12b-cpu}"
TIMEOUT="${LOCAL_TIMEOUT:-420}"
TRACE="${LOCAL_TRACE:-/dev/null}"

if [ $# -lt 2 ]; then
  echo "usage: $0 <working-dir> <prompt>" >&2
  exit 64
fi

DIR="$(cd "$1" && pwd)"
shift
PROMPT="$*"

# This model runs on CPU. Two at once means both crawl and the timings in
# USABILITY-LOG.md stop meaning anything, so the harness refuses to overlap.
LOCK="${TMPDIR:-/tmp}/conference-local-model.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # Is it a live run, or one that was killed before its trap could fire? The
  # second is common -- interrupting a suite leaves the directory behind, and
  # every later attempt then dies in zero seconds with nothing to show for it.
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    echo "note: clearing a lock held by pid $holder, which is gone" >&2
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo "error: could not take $LOCK" >&2; exit 75; }
  else
    echo "error: another local-model run holds $LOCK${holder:+ (pid $holder)}" >&2
    echo "hint: wait for it to finish, or remove the lock if it is stale" >&2
    exit 75
  fi
fi
echo $$ > "$LOCK/pid"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

timeout "$TIMEOUT" \
  ollama launch opencode --model "$MODEL" -- run --dir "$DIR" "$PROMPT" \
  </dev/null 2>"$TRACE"
