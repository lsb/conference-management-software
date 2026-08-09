# Scored on the schedule, not on the answer.
#
# The list of sessions that needed a slot is written by setup.sh from the
# database, so nothing is hardcoded here and nothing survives from the previous
# attempt. Each of them has to end up with a room and a time and still be in the
# programme -- declining a talk also removes it from the "needs a slot" list,
# and that is not scheduling it.
#
# The clash half is read from the app's own conflict detector rather than
# recomputed. This seed ships with two deliberate clashes among the sessions
# that were already on the grid, so the test is not "no conflicts anywhere": it
# is that none of the newly placed sessions is in one.
answer=$(cat)
base=http://127.0.0.1:8080
event=manzanita-2026
state="${TMPDIR:-/tmp}/conference-eval-unscheduled"

if [ ! -s "$state" ]; then
  echo "nothing needed a slot in this seed; this task cannot be scored"
  exit 2
fi

clashing=$(curl -s -m 20 "$base/api/events/$event/conflicts" | node -e '
  let s = "";
  process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => {
    try {
      const codes = new Set();
      for (const c of JSON.parse(s).conflicts ?? []) {
        if (c.severity === "error") for (const code of c.sessions ?? []) codes.add(code);
      }
      process.stdout.write([...codes].join(" "));
    } catch { process.stdout.write("UNREADABLE"); }
  });')

if [ "$clashing" = "UNREADABLE" ]; then
  echo "could not read $base/api/events/$event/conflicts; is the server up?"
  exit 2
fi

fail=0
while read -r code; do
  [ -z "$code" ] && continue

  row=$(sqlite3 data/conference.db \
    "SELECT s.status || '|' ||
            (s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL AND s.room_id IS NOT NULL)
       FROM submission s JOIN event e ON e.id = s.event_id
      WHERE e.slug='$event' AND s.code='$code';")

  status=${row%|*}
  placed=${row#*|}

  case "$status" in
    accepted|accept_queue) ;;
    '') echo "GONE FROM THE PROGRAMME: $code"; fail=1; continue ;;
    *)  echo "DROPPED RATHER THAN SCHEDULED: $code is now '$status'"; fail=1; continue ;;
  esac

  if [ "$placed" != "1" ]; then
    echo "STILL HAS NO SLOT: $code"
    fail=1
  elif printf ' %s ' "$clashing" | grep -q " $code "; then
    echo "PLACED ON TOP OF SOMETHING: $code"
    fail=1
  else
    echo "scheduled: $code"
  fi
done < "$state"

exit $fail
