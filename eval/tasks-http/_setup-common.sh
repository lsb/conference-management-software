# Reset the conference to its seeded state, then wait for the server to be
# serving that state again.
#
# The HTTP suite talks to a server the harness does not own, so re-seeding under
# it is the one moment the two can disagree. The server holds the database open
# and reads every request fresh, so a reseed is visible immediately -- but a
# request that lands mid-reseed can see a half-built conference, and a task that
# fails for that reason looks exactly like a task the model got wrong.
npm run seed >/dev/null 2>&1

BASE="${BASE_URL:-http://127.0.0.1:8080}"
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = "200" ]; then
    break
  fi
  sleep 0.25
done
