# Scored on the database and on the page an attendee would be looking at.
#
# Reaching the public agenda takes two separate states in this app: the content
# has to be approved, and the session has to be published. Checking only one of
# them would pass a half-done job that still shows nothing to anybody.
#
# The precision half matters as much. "Publish everything" is a tempting way to
# make one session appear, and it is exactly what approval exists to prevent, so
# a session that reaches the public agenda without being approved -- or without
# being accepted -- fails this even if SESS-6 itself is fine.
answer=$(cat)
base=http://127.0.0.1:8080
event=manzanita-2026
code=SESS-6

row=$(sqlite3 data/conference.db \
  "SELECT s.content_status || '|' || s.published FROM submission s
     JOIN event e ON e.id = s.event_id
    WHERE e.slug='$event' AND s.code='$code';")

if [ -z "$row" ]; then
  echo "$code is not in this seed; this task cannot be scored"
  exit 2
fi

status=${row%|*}
published=${row#*|}
fail=0

if [ "$status" != "approved" ]; then
  echo "$code content is still '$status', not approved"
  fail=1
fi
if [ "$published" != "1" ]; then
  echo "$code is still unpublished"
  fail=1
fi

leaked=$(sqlite3 data/conference.db \
  "SELECT group_concat(s.code, ' ') FROM submission s JOIN event e ON e.id = s.event_id
    WHERE e.slug='$event' AND s.published=1
      AND (s.content_status <> 'approved' OR s.status <> 'accepted');")
if [ -n "$leaked" ]; then
  echo "PUBLISHED WITHOUT APPROVAL: $leaked"
  fail=1
fi

# And it has to be visible where an attendee would look.
if curl -s -m 20 "$base/sessions/$event" | grep -q "$code"; then
  echo "$code is on the public session list"
else
  echo "$code is not on $base/sessions/$event"
  fail=1
fi

exit $fail
