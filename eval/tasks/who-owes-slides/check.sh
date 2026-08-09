# Recall AND precision, both derived from the database.
#
# Recall alone would be passed by "here is everybody with any outstanding task",
# which is a different and wrong answer -- three of those seven owe a headshot or
# a travel form, not slides. Handing the AV team three names too many is exactly
# the failure `conf tasks --task <slug>` exists to prevent, so naming somebody
# who does not owe slides fails.
answer=$(cat)

owes=$(sqlite3 data/conference.db \
  "SELECT DISTINCT p.last_name FROM task_instance ti
     JOIN task_definition td ON td.id = ti.definition_id
     JOIN person p ON p.id = ti.person_id
     JOIN event e ON e.id = td.event_id
    WHERE e.slug='manzanita-2026' AND td.slug='upload-slides' AND ti.status='todo';")

# Everyone else the organizer can see on a speaker or task list for this event:
# naming any of them is a false positive.
clear=$(sqlite3 data/conference.db \
  "SELECT DISTINCT p.last_name FROM person p
     JOIN submission_participant sp ON sp.person_id = p.id
     JOIN submission s ON s.id = sp.submission_id
     JOIN event e ON e.id = s.event_id
    WHERE e.slug='manzanita-2026' AND s.status IN ('accept_queue','accepted')
      AND p.id NOT IN (
        SELECT ti.person_id FROM task_instance ti
          JOIN task_definition td ON td.id = ti.definition_id
         WHERE td.event_id = e.id AND td.slug='upload-slides' AND ti.status='todo');")

if [ -z "$owes" ]; then
  echo "nobody owes slides in this seed; this task cannot be scored"
  exit 2
fi

fail=0
for surname in $owes; do
  if printf '%s' "$answer" | grep -qi -- "$surname"; then
    echo "named: $surname"
  else
    echo "MISSING: $surname"
    fail=1
  fi
done

for surname in $clear; do
  if printf '%s' "$answer" | grep -qi -- "$surname"; then
    echo "WRONGLY NAMED (owes no slides): $surname"
    fail=1
  fi
done

exit $fail
