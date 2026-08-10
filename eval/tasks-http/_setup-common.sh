# Reset the conference to its seeded state, then wait for the server to be
# serving that state again.
#
# The HTTP suite talks to a server the harness does not own, so re-seeding under
# it is the one moment the two can disagree. The server holds the database open
# and reads every request fresh, so a reseed is visible immediately -- but a
# request that lands mid-reseed can see a half-built conference, and a task that
# fails for that reason looks exactly like a task the model got wrong.
# Not >/dev/null 2>&1. A seed that fails half-way leaves the previous attempt's
# state in place, and every later attempt then runs against whatever the last one
# did -- which is the exact thing re-seeding exists to prevent. It failed exactly
# this way once, silently, because a trigger added months after this line was
# written aborted the wipe. If it fails, say so and stop; run-eval.js treats a
# non-zero setup as fatal for the task.
if ! seed_output=$(npm run seed 2>&1); then
  echo "re-seeding failed, so this attempt would run on the last one's state:" >&2
  printf '%s\n' "$seed_output" | tail -20 >&2
  exit 1
fi

BASE="${BASE_URL:-http://127.0.0.1:8080}"
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = "200" ]; then
    break
  fi
  sleep 0.25
done
