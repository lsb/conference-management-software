# The question is an attendee's, so the right answer is what an attendee can
# actually attend: accepted AND published. The seed also carries an unsubmitted
# draft called "Notes on Long-Context Retrieval", which `conf submissions --q
# retrieval` and a database query both return. Telling an attendee about it
# would be telling them about a talk that is not happening, so naming it fails.
answer=$(cat)

norm() { sed 's/[^A-Za-z0-9]/ /g' | tr 'A-Z' 'a-z' | tr -s ' ' | sed 's/^ //;s/ $//'; }
na=$(printf '%s' "$answer" | norm)

MATCHES="(lower(s.title) LIKE '%retrieval%' OR lower(s.description) LIKE '%retrieval%')"

public=$(sqlite3 data/conference.db \
  "SELECT s.title FROM submission s JOIN event e ON e.id = s.event_id
    WHERE e.slug='manzanita-2026' AND s.status='accepted' AND s.published=1 AND $MATCHES;")

hidden=$(sqlite3 data/conference.db \
  "SELECT s.title FROM submission s JOIN event e ON e.id = s.event_id
    WHERE e.slug='manzanita-2026' AND NOT (s.status='accepted' AND s.published=1) AND $MATCHES;")

speakers=$(sqlite3 data/conference.db \
  "SELECT DISTINCT p.last_name FROM person p
     JOIN submission_participant sp ON sp.person_id = p.id
     JOIN submission s ON s.id = sp.submission_id
     JOIN event e ON e.id = s.event_id
    WHERE e.slug='manzanita-2026' AND s.status='accepted' AND s.published=1 AND $MATCHES;")

if [ -z "$public" ]; then
  echo "no published session mentions retrieval; this task cannot be scored"
  exit 2
fi

fail=0

while IFS= read -r title; do
  [ -z "$title" ] && continue
  nt=$(printf '%s' "$title" | norm)
  case "$na" in
    *"$nt"*) echo "named: $title" ;;
    *) echo "MISSING: $title"; fail=1 ;;
  esac
done <<EOF
$public
EOF

while IFS= read -r title; do
  [ -z "$title" ] && continue
  nt=$(printf '%s' "$title" | norm)
  case "$na" in
    *"$nt"*) echo "NOT ON THE SCHEDULE, must not be offered: $title"; fail=1 ;;
  esac
done <<EOF
$hidden
EOF

for surname in $speakers; do
  ns=$(printf '%s' "$surname" | norm)
  case "$na" in
    *"$ns"*) echo "speaker named: $surname" ;;
    *) echo "MISSING speaker: $surname"; fail=1 ;;
  esac
done

exit $fail
