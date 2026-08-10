# Ground truth comes from the database, not a hardcoded number, so this task
# stays correct as the seed changes.
answer=$(cat)
expected=$(sqlite3 data/conference.db \
  "SELECT count(*) FROM submission s JOIN event e ON e.id=s.event_id
    WHERE e.slug='manzanita-2026' AND s.status='pending';")
# Take the last number in the reply: models often narrate before answering.
got=$(printf '%s' "$answer" | grep -oE '[0-9]+' | tail -1)
echo "expected=$expected got=${got:-none}"
[ "$got" = "$expected" ]
