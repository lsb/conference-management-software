# Scored on the archive, both directions.
#
# Every deck the database says we hold has to be in it, and nothing else may be:
# an archive of everything is a different and wrong answer, and handing a
# contractor a folder of speakers' headshots is worse than handing them nothing.
#
# Only current versions count. A re-uploaded deck supersedes the one before it,
# and the AV team wants the file going on the screen, not four attempts at it.
#
# Paths are compared on the basename, so grouping the archive into folders is
# neither required nor penalised.
answer=$(cat)
archive=av-slides.zip

if [ ! -f "$archive" ]; then
  echo "no $archive in the project directory"
  exit 1
fi

expected=$(sqlite3 data/conference.db \
  "SELECT f.filename FROM file f
     JOIN event e ON e.id = f.event_id
     JOIN task_instance ti ON ti.file_id = f.id
     JOIN task_definition td ON td.id = ti.definition_id
    WHERE e.slug='manzanita-2026' AND td.slug='upload-slides'
      AND f.superseded_at IS NULL
    ORDER BY f.filename;")

if [ -z "$expected" ]; then
  echo "no slide decks in this seed; this task cannot be scored"
  exit 2
fi

found=$(unzip -Z1 "$archive" 2>/dev/null | sed 's#.*/##' | grep -v '^[[:space:]]*$' | sort -u)

if [ -z "$found" ]; then
  echo "$archive is not a readable zip archive"
  exit 1
fi

fail=0
while read -r name; do
  [ -z "$name" ] && continue
  if printf '%s\n' "$found" | grep -qxF "$name"; then
    echo "included: $name"
  else
    echo "MISSING: $name"
    fail=1
  fi
done <<EOF
$expected
EOF

while read -r name; do
  [ -z "$name" ] && continue
  if ! printf '%s\n' "$expected" | grep -qxF "$name"; then
    echo "NOT A SLIDE DECK, SHOULD NOT BE IN THE ARCHIVE: $name"
    fail=1
  fi
done <<EOF
$found
EOF

exit $fail
