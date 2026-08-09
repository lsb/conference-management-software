cat > /dev/null   # judged by what changed, not by what was said

BASELINE="${TMPDIR:-/tmp}/conf-eval-outbox-baseline"
if [ ! -f "$BASELINE" ]; then
  echo "no outbox baseline; run this task through setup.sh so it can be scored"
  exit 2
fi
base=$(cat "$BASELINE")

# Who should have been reached, according to the app's own audience resolver --
# the same function the bulk-mail composer uses to build the list.
expected=$(node --no-warnings=ExperimentalWarning --input-type=module -e '
import { openDatabase, DEFAULT_DB_PATH } from "./src/db.js";
import { resolveAudience } from "./src/core/audience.js";
const db = openDatabase(DEFAULT_DB_PATH);
const event = db.prepare("SELECT id FROM event WHERE slug = ?").get("manzanita-2026");
const people = resolveAudience(db, event.id, "outstanding-tasks");
process.stdout.write(people.map((p) => p.email).sort().join("\n"));
')

got=$(sqlite3 data/conference.db \
  "SELECT DISTINCT to_email FROM outbox
    WHERE event_id = (SELECT id FROM event WHERE slug='manzanita-2026')
      AND id > $base ORDER BY to_email;")

echo "reached ${got:-nobody}"

fail=0
for who in $expected; do
  printf '%s\n' "$got" | grep -qxF -- "$who" || { echo "NOT TOLD: $who"; fail=1; }
done

# Mailing people who owe nothing is its own failure: a deadline reminder landing
# on somebody who is already done is how speakers learn to ignore us.
for who in $got; do
  printf '%s\n' "$expected" | grep -qxF -- "$who" || { echo "WRONGLY MAILED: $who"; fail=1; }
done

exit $fail
