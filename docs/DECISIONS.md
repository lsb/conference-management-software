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
at least once in three attempts (pass@3 = 100%). Results are logged in
`USABILITY-LOG.md` with verbatim transcripts. Exactly one inference runs at a time.

**Why.** It is a real requirement from the repo owner, and it doubles as a design
forcing function: legible URLs, honest errors, one obvious way to do each thing. See
`docs/DESIGN.md`.

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

## D10 — No JavaScript, and the two techniques that make that hold

**Decision.** The public surfaces use no script at all. Where interactivity is
genuinely needed, use the platform:

- `<details>`/`<summary>` for show-more disclosure. Native, keyboard accessible,
  and legible to anything driving the page.
- A cookie written by an ordinary form POST for the attendee's personal
  schedule. It survives a full reload with no account and no script.

**Why.** Every JavaScript-dependent interaction is a thing that can fail under a
10-second timeout, in a screen reader, or under an agent that only sees the
accessibility tree. The two hard cases turned out to have plain-HTML answers, so
the cost of the rule is close to zero.

**Where this bends.** Drag-and-drop scheduling cannot be done without script.
That stays progressive enhancement over a working forms-based scheduler
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
