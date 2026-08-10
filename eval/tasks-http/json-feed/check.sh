# Scored on what the website developer actually receives, not on what we were
# told they would receive.
#
# Two things have to be true. There has to be an enabled JSON embed in the
# database -- that is the state change the organizer was asked to make -- and
# the URL handed over has to return the programme as JSON when fetched. The
# second is the one that matters: an embed records its own format, and the
# extension in the URL is cosmetic, so a URL that looks like JSON can still
# serve HTML. Anything short of "curl it and parse it" would score that as a
# pass.
#
# The session count is read from the database rather than written down here, so
# this stays correct as the seed changes.
answer=$(cat)
base="${BASE_URL:-http://127.0.0.1:8080}"
event=manzanita-2026

expected=$(sqlite3 data/conference.db \
  "SELECT count(*) FROM submission s JOIN event e ON e.id = s.event_id
    WHERE e.slug='$event' AND s.status='accepted'
      AND s.published=1 AND s.content_status='approved';")

if [ "${expected:-0}" -eq 0 ]; then
  echo "nothing is published in this seed; this task cannot be scored"
  exit 2
fi

made=$(sqlite3 data/conference.db \
  "SELECT count(*) FROM embed b JOIN event e ON e.id = b.event_id
    WHERE e.slug='$event' AND b.format='json' AND b.enabled=1;")

if [ "${made:-0}" -eq 0 ]; then
  echo "no enabled JSON feed exists for $event"
  exit 1
fi

# Every /embed/<event>/... URL the answer mentions, with trailing punctuation
# from the surrounding prose removed. '.json' survives; a sentence-ending '.'
# does not.
paths=$(printf '%s' "$answer" \
  | grep -oE "/embed/$event/[A-Za-z0-9._-]+" \
  | sed 's/[.,;:)]*$//' | sort -u)

if [ -z "$paths" ]; then
  echo "the answer does not name a /embed/$event/... URL"
  exit 1
fi

for path in $paths; do
  got=$(curl -s -m 20 "$base$path" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(s);
        process.stdout.write(Array.isArray(parsed.sessions)
          ? String(parsed.sessions.length) : "no sessions array");
      } catch { process.stdout.write("not JSON"); }
    });')

  if [ "$got" = "$expected" ]; then
    echo "$path returns the $expected published sessions as JSON"
    exit 0
  fi
  echo "$path does not serve the programme as JSON (got: $got)"
done

exit 1
