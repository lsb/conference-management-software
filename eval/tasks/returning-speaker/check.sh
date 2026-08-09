# Recall and precision, both from the database.
#
# `person` is global across events, so "have we had them before" is a join. The
# wrong answer this scores against is the one an organizer actually gives when
# they read two speaker lists side by side: everybody who spoke at either
# conference. Naming somebody who spoke at only one of them fails.
#
# Surnames, because that is the part of a name the two lists agree on.
answer=$(cat)

both=$(sqlite3 data/conference.db \
  "SELECT p.last_name FROM person p
    WHERE EXISTS (SELECT 1 FROM submission_participant sp
                    JOIN submission s ON s.id = sp.submission_id
                    JOIN event e ON e.id = s.event_id
                   WHERE sp.person_id = p.id AND s.status = 'accepted'
                     AND e.slug = 'manzanita-2025')
      AND EXISTS (SELECT 1 FROM submission_participant sp
                    JOIN submission s ON s.id = sp.submission_id
                    JOIN event e ON e.id = s.event_id
                   WHERE sp.person_id = p.id AND s.status = 'accepted'
                     AND e.slug = 'manzanita-2026')
    ORDER BY p.last_name;")

# Everybody who was on stage at exactly one of the two. Each of these is a
# plausible wrong answer, and naming one is a false positive.
onceonly=$(sqlite3 data/conference.db \
  "SELECT DISTINCT p.last_name FROM person p
     JOIN submission_participant sp ON sp.person_id = p.id
     JOIN submission s ON s.id = sp.submission_id
     JOIN event e ON e.id = s.event_id
    WHERE s.status = 'accepted' AND e.slug IN ('manzanita-2025', 'manzanita-2026')
      AND (SELECT count(DISTINCT s2.event_id) FROM submission_participant sp2
             JOIN submission s2 ON s2.id = sp2.submission_id
             JOIN event e2 ON e2.id = s2.event_id
            WHERE sp2.person_id = p.id AND s2.status = 'accepted'
              AND e2.slug IN ('manzanita-2025', 'manzanita-2026')) = 1
    ORDER BY p.last_name;")

if [ -z "$both" ]; then
  echo "nobody spoke at both events in this seed; this task cannot be scored"
  exit 2
fi

fail=0
while read -r surname; do
  [ -z "$surname" ] && continue
  if printf '%s' "$answer" | grep -qi -- "$surname"; then
    echo "named: $surname"
  else
    echo "MISSING: $surname"
    fail=1
  fi
done <<EOF
$both
EOF

while read -r surname; do
  [ -z "$surname" ] && continue
  if printf '%s' "$answer" | grep -qi -- "$surname"; then
    echo "WRONGLY NAMED (spoke at only one of the two): $surname"
    fail=1
  fi
done <<EOF
$onceonly
EOF

exit $fail
