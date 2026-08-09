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

## D8 — Vendor naming

**Decision.** The incumbent product is not named anywhere in this repository.
Third-party systems we *integrate with* (Accelevents) are named, because an integration
target has to be named to be useful.
