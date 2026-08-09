# Ground truth is the same ranking the app's own review-progress screen shows:
# "still to do" is every assigned review that has not been submitted, ordered
# descending. See reviewProgress() in src/routes/organizer.js.
#
# The prompt asks for one name, so naming a second reviewer as well is a wrong
# answer: "here is the whole table" is not the thing an organizer asked for.
answer=$(cat)

RANK="SELECT p.last_name, sum(rv.status != 'submitted') AS remaining
        FROM review rv
        JOIN person p ON p.id = rv.reviewer_person_id
        JOIN evaluation_plan ep ON ep.id = rv.plan_id
        JOIN event e ON e.id = ep.event_id
       WHERE e.slug='manzanita-2026'
       GROUP BY p.id ORDER BY remaining DESC, p.last_name"

top=$(sqlite3 data/conference.db "$RANK LIMIT 1;")
busiest=${top%%|*}
most=${top##*|}
runner_up=$(sqlite3 data/conference.db "$RANK LIMIT 1 OFFSET 1;")

if [ -z "$busiest" ]; then
  echo "no reviews in this seed; this task cannot be scored"
  exit 2
fi
if [ "$most" = "${runner_up##*|}" ]; then
  echo "the busiest reviewer is tied with the next; this task cannot be scored"
  exit 2
fi

echo "busiest is $busiest with $most outstanding"

fail=0
if ! printf '%s' "$answer" | grep -qi -- "$busiest"; then
  echo "MISSING: $busiest"
  fail=1
fi

others=$(sqlite3 data/conference.db "$RANK;" | tail -n +2 | cut -d'|' -f1)
for surname in $others; do
  if printf '%s' "$answer" | grep -qi -- "$surname"; then
    echo "ALSO NAMED (the question asked for one): $surname"
    fail=1
  fi
done

exit $fail
