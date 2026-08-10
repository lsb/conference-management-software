# Deploying

The deployment is meant to be mechanical, and to change nothing about how the
app behaves. That is only true because of D12: authorization is a database fact
and no longer consults which interface the server is bound to, so the deployed
app is the same app you have been testing all along. Before that change, "deploy
it" and "change every permission check" were the same action.

Three environment variables and a disk.

```sh
docker build -t conference .
docker run -d --name conference \
  -p 8080:8080 \
  -v conference-data:/app/data \
  -e PUBLIC_ORIGIN=https://conf.example.com \
  -e SETUP_TOKEN="$(openssl rand -base64 32)" \
  conference
```

## The variables

| | |
| --- | --- |
| `PUBLIC_ORIGIN` | **Set this.** What the instance calls itself: `https://conf.example.com`. It decides whether cookies get the `Secure` flag, what origin cross-site writes are checked against, and what host goes into every link in every message. Getting it wrong does not break the app quietly — sign-in links will point at the wrong place. |
| `SETUP_TOKEN` | The secret that claims a fresh instance at `/setup/claim`. At least 32 characters; the app refuses to start with a shorter one. Omit it and the app generates one, writes it to `data/setup-token` at mode 0600, and logs the path — never the token. |
| `DEMO_LOGIN` | Off unless set to `1`. Turns on `/login`, which signs you in as a seeded persona with one click. **The instance an automated browser-based evaluator drives must have this on** — see D9 and D12; it is the only door something with no shell and no repository can use. Never set it on an instance holding a real conference. |
| `HOST`, `PORT` | Default `0.0.0.0` and `8080` in the image. |
| `CONF_LOG` | `quiet`, `normal` (default), or `verbose`. Verbose adds query strings with tokens redacted. |

## The disk is not optional

`/app/data` holds the SQLite database and every file a speaker has uploaded.
Without a volume the container runs perfectly and the first redeploy erases the
conference. There is no second copy anywhere.

Back it up by copying the directory while the app is running — SQLite is in WAL
mode, so `sqlite3 data/conference.db ".backup out.db"` is the safe way to take a
consistent copy without stopping anything.

## Claiming it

A fresh instance has no administrator. Visit `/setup/claim`, present the setup
token, and choose an email and password: that account becomes the instance
administrator and can add everybody else from `/e/<event>/people`.

Claiming is idempotent, and the setup token keeps working afterwards on purpose.
For a tool run by one or two people around a conference, losing the only
administrator is a likelier disaster than somebody guessing 256 bits, and the
token is the way back in. Unset it once you are happy, if you would rather not
have that door.

## Proving the deployment did not change anything

This is what the black-box suite is for. It imports nothing from `src/`, so the
same tests that pass locally can be pointed at the deployment:

```sh
BASE_URL=https://conf.example.com \
ACCEPTANCE_ORGANIZER_EMAIL=you@example.com \
ACCEPTANCE_ORGANIZER_PASSWORD=... \
  npm run test:http
```

It creates its own timestamped event and works only inside it, so it is safe to
run against a live instance. It cannot mail anybody, because nothing in this app
can: messages are written to an outbox and never sent (D5).

There is no route that deletes an event, so each run leaves one behind and says
so on the way out.

## What is deliberately not here

**No Cloudflare Workers.** The storage layer is `node:sqlite` against a file on
disk. A D1 backend is a port rather than a rewrite, but it is still a port, and
the bonus for it is described as mild. See `docs/DECISIONS.md`.

**No SMTP.** Nothing in this app sends email, by design (D5) — messages are
rendered into an inspectable outbox. When that has to change, the shape is a
submission client relaying through an MSA the operator already owns, behind an
`SMTP_URL`, with the outbox remaining the record of what was sent. Direct
delivery from a container does not work and cannot be made to: port 25 is
blocked by default on the major clouds, the address is on Spamhaus PBL by
construction, and SPF/DKIM cannot validate for a domain the container does not
own.

One consequence to notice before that day: `GET /portal/:event/enter?token=...`
consumes a one-time token on a GET, which is fine only while nothing is
delivered. The moment mail is real, link-scanning in mail providers will burn
those tokens before the recipient clicks, and the GET has to become a page with
a button that POSTs.
