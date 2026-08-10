# Judged by what exists afterwards, not by what was said.
#
# Two conditions, and the second is the one that matters. A definition on its own
# is a row nobody is looking at; the point of asking for something is that it
# turns up in the speakers' portals. A model that creates it with
# assign_when=manual satisfies the first and fails the second, and that is
# exactly the distinction worth testing -- as is the retroactive rule, since
# every speaker here was accepted long before the task existed.
#
# The four seeded slugs are excluded so that finding an existing task cannot
# count as creating one.
cat > /dev/null
SEEDED="'speaker-agreement','headshot','travel-and-hotel','upload-slides'"

defs=$(sqlite3 data/conference.db \
  "SELECT count(*) FROM task_definition d JOIN event e ON e.id=d.event_id
    WHERE e.slug='manzanita-2026' AND d.slug NOT IN ($SEEDED);")

owed=$(sqlite3 data/conference.db \
  "SELECT count(*) FROM task_instance ti
     JOIN task_definition d ON d.id=ti.definition_id
     JOIN event e ON e.id=d.event_id
    WHERE e.slug='manzanita-2026' AND d.slug NOT IN ($SEEDED)
      AND ti.status = 'todo';")

echo "new_tasks=$defs outstanding=$owed"
[ "$defs" -ge 1 ] && [ "$owed" -ge 1 ]
