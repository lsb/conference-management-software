source eval/tasks/_setup-common.sh

# Record which sessions had no slot at the start, so the checker can insist that
# those exact ones ended up on the grid. Without it, deleting or declining a
# session would look like scheduling it: the "still unscheduled" list only
# counts sessions that are still in the programme.
#
# Written outside the repository so a run leaves nothing behind.
sqlite3 data/conference.db \
  "SELECT s.code FROM submission s JOIN event e ON e.id = s.event_id
    WHERE e.slug = 'manzanita-2026' AND s.status IN ('accepted', 'accept_queue')
      AND (s.starts_at IS NULL OR s.ends_at IS NULL OR s.room_id IS NULL)
    ORDER BY s.code;" > "${TMPDIR:-/tmp}/conference-eval-unscheduled"
