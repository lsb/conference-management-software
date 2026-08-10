. eval/tasks-http/_setup-common.sh

# Judged by what arrived in the outbox during the attempt, so record where it
# stood once the seed is back. Anything above this id was queued by the model.
sqlite3 data/conference.db 'SELECT coalesce(max(id), 0) FROM outbox;' \
  > "${TMPDIR:-/tmp}/conf-eval-outbox-baseline"
