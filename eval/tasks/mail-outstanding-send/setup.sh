source eval/tasks/_setup-common.sh

# This task is judged by what arrived in the outbox during the attempt, so record
# where the outbox stood once the seed is back in place. Anything above this id
# was queued by the model.
sqlite3 data/conference.db 'SELECT coalesce(max(id), 0) FROM outbox;' \
  > "${TMPDIR:-/tmp}/conf-eval-outbox-baseline"
