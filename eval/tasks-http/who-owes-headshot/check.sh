answer=$(cat)
names=$(sqlite3 data/conference.db \
  "SELECT p.last_name FROM task_instance ti
     JOIN task_definition td ON td.id = ti.definition_id
     JOIN person p ON p.id = ti.person_id
     JOIN event e ON e.id = td.event_id
    WHERE e.slug='manzanita-2026' AND td.slug='headshot' AND ti.status='todo';")
total=$(printf '%s\n' "$names" | grep -c .)
hit=0
for n in $names; do printf '%s' "$answer" | grep -qi -- "$n" && hit=$((hit+1)); done
echo "matched $hit of $total surnames"
# Every one of them: a partial list is a wrong answer to "who still owes us this".
[ "$hit" = "$total" ]
