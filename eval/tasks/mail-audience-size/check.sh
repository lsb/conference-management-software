# Ground truth comes from the app's own audience resolver -- the same function
# the bulk-mail composer calls -- so this stays right as the seed changes.
#
# The interesting wrong answer is 20: that is the number of outstanding task
# rows, which `conf status` reports and which a list-and-count of `conf tasks`
# produces. Seven people hold those twenty tasks, and an email goes to people.
answer=$(cat)

expected=$(node --no-warnings=ExperimentalWarning --input-type=module -e '
import { openDatabase, DEFAULT_DB_PATH } from "./src/db.js";
import { resolveAudience } from "./src/core/audience.js";
const db = openDatabase(DEFAULT_DB_PATH);
const event = db.prepare("SELECT id FROM event WHERE slug = ?").get("manzanita-2026");
process.stdout.write(String(resolveAudience(db, event.id, "outstanding-tasks").length));
')

# Take the last number in the reply: models often narrate before answering.
got=$(printf '%s' "$answer" | grep -oE '[0-9]+' | tail -1)
echo "expected=$expected got=${got:-none}"
[ "$got" = "$expected" ]
