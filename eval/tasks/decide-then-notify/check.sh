cat > /dev/null
status=$(sqlite3 data/conference.db \
  "SELECT s.status FROM submission s JOIN event e ON e.id=s.event_id
    WHERE e.slug='manzanita-2026' AND s.code='SESS-16';")
mail=$(sqlite3 data/conference.db \
  "SELECT count(*) FROM outbox o JOIN submission s ON s.id=o.submission_id
    WHERE s.code='SESS-16' AND o.kind='decision';")
echo "status=$status decision_mail=$mail"
[ "$status" = "accepted" ] && [ "$mail" -ge 1 ]
