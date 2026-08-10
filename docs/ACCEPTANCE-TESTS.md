# The HTTP acceptance suite

`npm test` proves the code. This suite proves a *deployment*: it talks to a
running server by URL and nothing else, so the same files certify localhost
today and a remote box later.

It imports nothing from `src/`, on purpose. An import would pass against a
remote URL while quietly testing local code, which is the one failure mode this
suite exists to rule out. Everything it knows it read off an HTTP response.

```sh
npm run test:http                                   # against http://127.0.0.1:8080
BASE_URL=https://conf.example.com npm run test:http # against anything else
```

The app must already be running; the suite never starts one. Check first:

```sh
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz   # 200 = up
```

## Environment

| Variable | Default | What it is for |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:8080` | The origin under test. No trailing slash needed. |
| `ACCEPTANCE_ORGANIZER_EMAIL` | none | Who to sign in as. Required off loopback — see below. |
| `ACCEPTANCE_RETRIES` | `5` | Retries for requests that never reached a server. Only connection failures are retried; an HTTP status is always a result. |

## It is safe to run against a live deployment

Every run creates its own event through `POST /e/new` and does all of its work
inside it. It treats every other event as read-only, and refuses to continue if
`POST /e/new` ever hands back a seeded slug. It sends no real email: this app
queues messages into an outbox rather than delivering them, and the assertions
are against `GET /e/:event/outbox`. People it invents get addresses in
`.invalid`, which can never be routed even if a deployment later wires up SMTP.
Where it must exercise the irreversible `notify`, it does so with exactly one
decision queued in its own event, so the worst case is one message to one
address that cannot exist.

**It cannot fully clean up after itself.** There is no HTTP route that deletes
an event, a form, a submission or a person — only rooms, tracks, taxonomy
options, form fields, conditions, embeds and scorecard criteria can be removed.
So each run leaves one event behind, and prints where. Everything it creates is
named `Acceptance … <timestamp>-<random>`, so anything matching
`acceptance-conf-<timestamp>` is litter from a test run and safe to delete
directly if that ever matters.

## Signing in

The app behaves the same way wherever it is running: everything under `/e/` and
`/api/` needs an organizer, on your laptop exactly as on a deployment. There is
no longer a loopback exemption, so there is no longer a difference between a
local run and a remote one for this suite to work around.

`POST /e/new` records an owner only when somebody is signed in, and an event
created anonymously would be unmanageable by anyone, permanently. So the suite
signs in *before* it creates anything, by whichever door the deployment has
open, most-proving first:

1. **Email and password** at `POST /sign-in`. This is the path a real organizer
   walks and it works on any deployment. Set `ACCEPTANCE_ORGANIZER_EMAIL` and
   `ACCEPTANCE_ORGANIZER_PASSWORD`; they default to the demo administrator that
   `npm run seed` creates and announces.
2. **The setup token** at `POST /setup/claim`, if `ACCEPTANCE_SETUP_TOKEN` is
   set. Claiming is idempotent, so this is safe to run every time, and it is how
   you certify an instance nobody has claimed yet.
3. **A demo persona** at `POST /login`, which only exists where the deployment
   runs with `DEMO_LOGIN=1`.

The order matters. Asking a deployment to switch `DEMO_LOGIN` on so that a test
can run is weakening the thing under test, so it is the last resort rather than
the instruction.

```sh
BASE_URL=https://conf.example.com \
ACCEPTANCE_ORGANIZER_EMAIL=you@your-org.example \
ACCEPTANCE_ORGANIZER_PASSWORD='...' \
  npm run test:http
```

## Reading the output

Two files: `smoke.test.js` is entirely read-only and safe to point anywhere;
`lifecycle.test.js` walks one event from creation to a published, embeddable
agenda, in order, so the first failure is the real one and later ones are
consequences.

Failures print the method, the URL, which persona made the call, what was sent
and what came back, because one day this will fail against a box nobody can
attach a debugger to.

Tests marked `# TODO` assert behaviour the app is *supposed* to have and does
not. They do not fail the run; they are the standing list of what is still
broken, and each one carries the reason in its marker. When one starts passing,
delete the marker.
