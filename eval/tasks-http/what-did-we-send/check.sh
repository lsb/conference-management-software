# The customer's "must have": the submitter confirmation email.
#
# Asked from the organizer's side, because that is the side an agent works from
# and the side where the question actually arrives -- a speaker writes in saying
# nothing came, and somebody has to find out what was sent.
#
# Scored on quoting the real subject line, which cannot be guessed and cannot be
# reached without finding the message body. The outbox list carries envelopes
# only; the body is behind /api/events/<event>/outbox/<id>.
answer=$(cat)

subject=$(sqlite3 data/conference.db \
  "SELECT o.subject FROM outbox o
     JOIN event e ON e.id = o.event_id
     JOIN person p ON p.id = o.to_person_id
    WHERE e.slug='manzanita-2026' AND o.kind='submission_confirmation'
      AND p.email='meilin.chen@example.com' LIMIT 1;")

if [ -z "$subject" ]; then
  echo "the seed has no confirmation for that speaker; this task cannot be scored"
  exit 2
fi

echo "expected subject: $subject"
# Compared on the distinctive words rather than the whole string, so trailing
# punctuation or a quoted-and-trimmed line still counts.
ok=1
for word in $(printf '%s' "$subject" | tr -cs 'A-Za-z0-9' ' '); do
  case "$word" in
    [Tt]he|[Aa]|[Ff]or|[Yy]our|[Ii]s|[Tt]o|[Oo]f) continue ;;
  esac
  printf '%s' "$answer" | grep -qi -- "$word" || { echo "missing: $word"; ok=0; }
done
[ "$ok" = "1" ]
