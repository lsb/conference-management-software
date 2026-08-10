# Decisions

Standing choices and the reasoning behind them. Revisit when the reasoning changes,
not when the choice becomes inconvenient.

---

## D1 — Local-first, on plain Node + SQLite

**Decision.** A zero-dependency Node 22 app using the built-in `node:sqlite`, serving
server-rendered HTML, bound to `127.0.0.1`. No framework, no build step, no
`npm install`.

**Why.** It is what makes the app auditable by a small local model, it is genuinely
fast, and it means the whole state of a conference is one file. The customer's loudest
performance complaint — "we do not want slow SaaS pls" — is answered by not having a
network round trip per click in the first place.

**Cost, stated honestly.** The brief offers bonus points for deploying to Cloudflare
and for persisting to Airtable. We are taking neither by default:

- *Airtable* is the one we are actively declining. Airtable as a primary store would
  make every list view a paginated remote API call, which directly contradicts the
  performance ask. If they want their data in Airtable, a one-way export is a small,
  separable feature — and a much better shape than coupling the app to it.
- *Cloudflare* is not declined, just deferred. The app is written against a narrow
  storage interface, so a D1 backend is a port, not a rewrite. Local deploy first, per
  the brief owner's own instruction to us.

Both are "mild"/"bonus" in the brief; the API bonus and the speed bonus are the two we
can win outright, and we are optimizing for those.

---

## D2 — Decision and notification are separate operations

**Decision.** Implement the observed five-state machine
(`draft → pending → accept_queue|decline_queue → accepted|declined`, plus `withdrawn`)
with `notified_at` as independent state. Changing a decision never sends mail. A
distinct, explicit "notify" action sends mail and advances the queue states.

**Why.** This is the incumbent's best idea. Acceptance emails are irreversible and
emotionally loaded; an organizer bulk-editing a spreadsheet-like grid must not be one
misclick away from telling forty people they got in. The queue states make the batch
explicit and reviewable.

---

## D3 — Acceptance converts; it never copies

**Decision.** One row lineage from submission to session. One `person` row per human
across all events. Accepting promotes and links; it does not duplicate fields into new
records.

**Why.** This is the core differentiator identified in research: data continuity, so
nothing is re-keyed and a multi-event speaker CRM is possible without duplicate
outreach. It is also the thing that is nearly impossible to retrofit, so it goes in
first.

---

## D4 — Drag-and-drop is presentation; the feature is conflict detection

**Decision.** Build scheduling as plain forms plus a first-class **Conflicts** view
(as the incumbent has). Drag-and-drop is progressive enhancement layered on later.

**Why.** "Drag-and-drop" appears in the brief, but what it buys is "move a session and
find out immediately if that breaks something." The detection is the value and the hard
part; the dragging is an input method that excludes keyboard users, screen readers, and
automated agents. Forms-first gets the value to the customer sooner and keeps every
action reachable by `curl`.

**Risk.** A demo-driven evaluation may reward visible dragging. Mitigation: the
enhancement is genuinely planned, not theoretical, and the Conflicts view is a stronger
demo moment than dragging is.

---

## D5 — Email is written to an inspectable outbox before it is sent anywhere

**Decision.** All outbound mail (confirmations, reminders, decisions, calendar invites)
is rendered and persisted to an `outbox` table and viewable in the UI. Actual delivery
is a pluggable sink; locally the sink is "none".

**Why.** The reminder engine's *logic* — target exactly the speakers who still owe
something — is the feature. Delivery is plumbing. This also makes the whole
communications feature testable and demonstrable without configuring SMTP, and makes
"who did we email, and what did it say" answerable, which organizers ask constantly.

---

## D6 — Calendar invites as `.ics`, not per-provider integrations

**Decision.** Generate standards-compliant `.ics` (iCalendar) with a stable `UID` and
incrementing `SEQUENCE`, delivered as a mail attachment and a portal download link.

**Why.** The brief asks for invites landing in "Gmail, Outlook, iCal". All three
consume `.ics`. Three OAuth integrations would be weeks of work and ongoing token
maintenance to reach the same end state. Correct `UID`/`SEQUENCE` handling is what
makes a *reschedule* update the existing calendar entry instead of creating a second
one — that is the part that actually matters and the part naive implementations get
wrong.

---

## D7 — The app must be operable by a small local model, and we measure it

**Decision.** `gemma4:12b-cpu`, driven through `opencode`, must complete each core task
**at least 3 times out of 5 attempts**. Results are logged in `USABILITY-LOG.md` with
verbatim transcripts. Exactly one inference runs at a time.

**Why.** It is a real requirement from the repo owner, and it doubles as a design
forcing function: legible URLs, honest errors, one obvious way to do each thing. See
`docs/DESIGN.md`.

**Why it tightened.** The bar began as "at least once in three", which asks whether the
app is *possible* to use — the right question while the answer was often no. Once every
core flow worked, the question that mattered became whether it works *reliably*, and the
stricter bar found something the looser one had hidden on its very first run: a list
whose count could only be got by piping to `wc -l`, which counts the header. Failing one
time in four had been invisible. See `USABILITY-LOG.md`, Run 6.

---

## D9 — The evaluator is a browser, so the browser is the product surface

**What we learned.** The independent evaluation drives a headless Chromium
through a scripted agent whose entire toolset is navigate, click, fill, select,
drag, upload, press, scroll, screenshot, and observe. There is no HTTP client, no
shell, and no access to the repository. A separate judge scores from screenshots
and the agent's notes.

**Decision.** Every capability must be reachable and demonstrable through
clickable HTML. The JSON API and the CLI stay — they are genuinely useful, they
are how the local-model eval drives the app, and they cost us nothing to keep —
but we stop treating them as coverage for a feature. If a thing can only be done
with `curl`, it does not exist.

**Why this is less painful than it sounds.** Server-rendered HTML with real
forms turns out to be close to the best possible shape for this harness: real
`<select>` elements (its select tool requires them), real `<input type=file>`,
and a URL that changes on every action, which is what triggers its automatic
evidence screenshots. A single-page app would have been actively worse. The
architecture we chose for legibility to a small model is the same architecture
that survives contact with an automated evaluator, which is not a coincidence —
both reward the same honesty.

**Two conversions we take deliberately.** An in-app outbox is explicitly accepted
in place of real email delivery, which vindicates D5. And exposing the API as
selectable *embed output formats* — JSON, XML, iCalendar — turns invisible work
into a visible feature.

---

## D10 — No JavaScript is *required*, and three techniques that make that hold

*Revised 2026-08-09. This decision originally said "no script at all". That was
too absolute, and the revision is recorded rather than quietly edited.*

**Decision.** Nothing requires JavaScript. Every page works, and every action
completes, with scripting off. Where interactivity helps, use the platform
first:

- `<details>`/`<summary>` for show-more disclosure. Native, keyboard accessible,
  and legible to anything driving the page.
- A cookie written by an ordinary form POST for the attendee's personal
  schedule. It survives a full reload with no account and no script.
- Up and down buttons rather than dragging, for reordering form questions.

Script is permitted only as enhancement: something that makes a page nicer and
that nothing depends on. If a page stops working without it, the script is doing
too much. There is currently exactly one, about forty lines, which shows and
hides conditional form questions as somebody answers.

**Why.** Every JavaScript-dependent interaction is a thing that can fail under a
10-second timeout, in a screen reader, or under an agent that only sees the
accessibility tree. Most of the hard cases turned out to have plain-HTML
answers, so the rule is nearly free.

**Why it bent.** Conditional questions were the case where it did not. A form
that asks about workshop prerequisites has no business asking a lightning talk,
and the alternatives were worse: a page round-trip per answer, or a wall of
irrelevant questions. The enhancement is layered over markup the server already
emits, and the server independently re-checks every condition on submit -- so a
question that was not asked is not required, whether or not the script ran.

**The rule the bend has to obey.** The server is the authority. A script may
change what is *shown*; it may never be the thing that decides what is *valid*.
Validation that only exists in the browser is validation that does not exist.

**Where this still bends further.** Drag-and-drop scheduling cannot be done
without script. That stays enhancement over a working forms-based scheduler
(see D4), which is also what keeps it operable by keyboard.

---

## D11 — Public reachability is now an existential requirement

**Decision.** Local-first remains right for development and for owning your data,
but the app must also run behind a single public origin, and we should treat that
deployment as a first-class artifact rather than an afterthought.

**Why.** The evaluator is handed one URL and calls `page.goto()`. There is no
build step, no clone, nothing that could start a local server. A loopback-only
deployment does not score badly; it scores nothing, and below 60% coverage the
result is withheld entirely rather than reported.

**Consequences to respect.** One origin — no `www`/apex split, no separate host
for public pages, and no OAuth, because an off-origin redirect is rolled back by
the harness. Persistent disk for the SQLite file, because state has to survive a
whole run. No cold start longer than 30 seconds. No rate limiting that trips on a
burst of requests from one browser.

---

## D8 — Vendor naming

**Decision.** The incumbent product is not named anywhere in this repository.
Third-party systems we *integrate with* (Accelevents) are named, because an integration
target has to be named to be useful.

---

## D12 — Authorization is a database fact, and behaves the same everywhere

**Decision.** `canOrganize` reads two things: `person.is_admin`, or an
`owner`/`organizer` row in `event_membership`. `organizerAccessIsOpen()` — which
returned true whenever `HOST` was loopback — is deleted, not extended. There is
no branch anywhere that asks what interface the server is bound to.

**Why.** The exemption made this two products. Wide open on a laptop, entirely
shut on any public address, and only the first was ever exercised, so the
deployed behaviour was the untested one. That is backwards, and it hid faults
rather than merely permitting them: `/login` was broken for months — every
persona named an address no seed creates — and nobody noticed, because local
development never has to sign in. Three `/api` routes answered strangers.
`POST /e/new` was unauthenticated. There was no CSRF defence at all, which
combined with open loopback access was exploitable on every developer's machine.

**Trust on first use, with one gate.** The first person to present the setup
token claims the instance and becomes its administrator; they bless everybody
else. The gate exists because a deployment's URL is public before anybody has
claimed it — it gets submitted, written down, shared — so pure TOFU hands the
conference to whoever loads it first, and a redeploy onto a fresh volume reopens
that window with the address already circulating. Gitea ships `INSTALL_LOCK=false`
for this reason. The token is never logged; when the operator supplies none we
generate one, write it at mode 0600, and log only the path (CWE-532).

**Staff have passwords, and that follows from having no SMTP** (D5: mail is
written to an outbox and never sent). A link-only sign-in for the people who run
the conference is not friction at a boundary that deserves it; it is an outage
waiting for its first locked-out organizer. Speakers keep magic links and never
get a password — the requirement is that they reach their portal without a heavy
signup. Scripts send a bearer token, because one header is something an
`llms.txt` recipe can carry and a cookie jar is not.

**Consequences to respect.**

- **`DEMO_LOGIN=1` must be set on the deployment the evaluator drives.** D9 says
  the evaluator is a headless browser handed one URL, with no shell and no
  repository. `/login` is the only door it can use, and it is now off unless
  asked for. If the flip ships to that instance without the flag, the app scores
  nothing — and D11 notes that below 60% coverage the result is withheld
  entirely rather than reported. This is a deployment fact with existential
  consequences, which is why it is here and not in a code comment.
- `PUBLIC_ORIGIN` is now how the app knows what it is called. It sets the
  `Secure` cookie flag, supplies the CSRF target origin, and builds every
  absolute URL — which is what closed the host-header injection where
  `Host: evil.example` put a live sign-in token into the outbox.
- No `__Host-` cookie prefix, against both OWASP and NIST, because Chrome and
  Safari reject prefixed cookies over plain HTTP on loopback and it would make
  local development impossible in two of three browsers. Mitigated by this being
  one origin with no subdomains, per D11.
- Sessions are not bound to IP or User-Agent, against OWASP's "highly
  recommended", because organizers work from phones on conference wifi and the
  failure mode — locked out mid-schedule with no way to mail yourself a link —
  is worse than the attack it prevents against a 256-bit HttpOnly token.
- The test suite must pass identically under `npm test` and
  `HOST=0.0.0.0 npm test`. If those ever differ again, something has grown a
  dependency on how the server was started.
