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

## Off loopback you must sign in first

The app opens every organizer route to anyone when it is bound to `127.0.0.1`,
and closes them everywhere else (`organizerAccessIsOpen`). Two consequences for
a remote run, both of which the suite's failure messages spell out:

1. `POST /e/new` records an owner only when somebody is signed in. An event
   created anonymously on a remote box is unmanageable by anyone, permanently.
   The suite therefore signs in *before* it creates anything.
2. The only sign-in this suite can drive is `POST /login`, which is disabled off
   loopback unless the deployment runs with `DEMO_LOGIN=1`, and which never
   creates a person.

So certifying a remote deployment currently needs both:

```sh
# on the deployment
DEMO_LOGIN=1 HOST=0.0.0.0 npm start

# from anywhere
BASE_URL=https://conf.example.com \
ACCEPTANCE_ORGANIZER_EMAIL=someone@your-org.example \
  npm run test:http
```

where that address already belongs to a person on that instance. There is no
HTTP route that creates the first organizer, or that grants organizer rights on
an event to anybody but its creator.

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
