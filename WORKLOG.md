# Working log

How the app should work, and how our understanding of that changed. Newest at
the bottom. This is the narrative companion to `docs/DECISIONS.md`, which holds
the conclusions without the story.

---

## 2026-08-08 — Reading the brief

Three sources: research on the incumbent product, ~35 annotated screenshots of
it, and a written brief. The brief is short; the annotations are where the
signal is.

**The annotations reorder our priorities.** Payments are struck out entirely
("NOT NEEDED"), which removes a whole subsystem. The two strongest notes —
"must have" on the submitter confirmation email, and "make sure this works" on
the success page and auto-redirect into the speaker portal — both land on the
*same seam*: the handoff from submitting a proposal to being a speaker with a
portal. That is not a coincidence, and it told us what to build first.

**The status filter has five states, not three.** Accepted, Accept Queue,
Pending, Decline Queue, Declined — plus Withdrawn and Drafts as tabs, and a
separate `Notified` column. We nearly modelled this as accept/reject/waitlist
from the research summary alone. The screenshot is what caught it.

Once seen, the reason is obvious: the queues let an organizer decide in bulk and
notify deliberately. Acceptance emails are irreversible and land in people's
lives; a dropdown that sends one as a side effect is a bad dropdown. So decision
and notification became two separate operations, and that shaped everything
downstream.

**"Drag-and-drop scheduling" is not the feature.** The feature is being told
immediately that you have put someone in two rooms at once. Dragging is an input
method. We build conflict detection first, as its own screen (the incumbent has a
Conflicts tab, which is the right call), with forms as the input. Dragging can be
layered on later without changing anything underneath.

## 2026-08-08 — The data model

The load-bearing decision: **a submission and a session are the same row**.

Research called out the incumbent's differentiator as data continuity — a speaker
confirmed through the CFP appears in speaker management with fields
pre-populated, their session appears in the agenda builder, their bio flows into
content. The way to guarantee that is not to copy carefully; it is to have
nothing to copy. So `submission` carries the scheduling columns, and accepting
advances a status rather than creating a session record.

A nice consequence fell out of this: a NULL `starts_at` on an accepted row *is*
the dashboard's "still needs a time slot" warning. No separate flag, no way for
the warning to disagree with reality.

Similarly, `person` is global across events rather than per-event. That is what
makes the multi-event speaker CRM possible — "have we had this person before" is
a join, not a fuzzy name match.

**Two bugs the tests found immediately**, both worth recording because both were
the kind that only bite in production:

1. Session codes were derived from the highest existing code, so deleting SESS-2
   handed that code to the next submission — pointing a speaker at somebody
   else's session from an email already in their inbox. Now a counter on the
   event, which only goes up.

2. `notify()` refused to send if `notified_at` was already set. That looked like
   sensible double-send protection and was actually wrong: an organizer who moves
   an accepted session back to decline_queue *has* to be able to tell the
   speaker. Double sends were already prevented by the status guard, since a
   notified row is no longer in a queue. Removed.

## 2026-08-08 — Making it legible to a small model

The requirement is that `gemma4:12b-cpu` can drive the app at pass@3. This is
not decoration; it changed concrete decisions:

- **Slugs and session codes everywhere, no UUIDs in URLs.** A 12B model
  transcribing `f47ac10b-58cc-...` between two tool calls will corrupt it. It
  will not corrupt `SESS-3`.
- **Explicit `/api/...` paths rather than content negotiation.** A small model
  reliably gets a URL right and unreliably gets an `Accept:` header right.
- **Errors carry a hint.** `{"error":"unknown status 'waitlist'","hint":"use one
  of: pending, accept_queue, ..."}`. A bare 400 makes the next attempt a guess.
- **A CLI as well as HTTP**, because a coding agent already has a shell.
- **`/llms.txt` generated from the route table**, so it cannot drift.

**A trap worth writing down.** Our first instinct for testing tool use was "ask
it what day it is". It answers correctly — and makes *zero tool calls*, because
opencode injects the current date into its system prompt. It looked like a
passing test and tested nothing. Eval facts have to be things that cannot be in
a system prompt: a file on disk, a row in the database, a response from our own
server.

## 2026-08-08 — Judgment calls

Places we deliberately diverged from the incumbent, per the brief's own
invitation ("cloning the exact design is not a requirement"):

- **Speakers never see queue states.** Their portal says "Under review" until we
  actually send. Showing `accept_queue` would be telling them by accident.
- **Session-level tasks go to the primary contact only.** Slides get uploaded
  once. Giving all three co-speakers their own copy of "upload the slides" would
  make the outstanding-work dashboard overstate reality by 3x.
- **Reminders stop after three touches.** A week before, the day before, the day
  after. The complaint that sells this software is chasing people by hand; the
  complaint that makes speakers hate it is being nagged daily.
- **All mail goes to an inspectable outbox first**, and delivery is a separate
  pluggable step. The reminder *logic* is the feature; SMTP is plumbing. This also
  makes the whole communications story demonstrable with no configuration.
- **The dashboard is sentences, not donuts.** "2 accepted speakers are missing a
  bio or headshot" with a link to exactly those two beats a pie chart.
- **Organizer screens are open on loopback**, and require a signed-in member
  otherwise. A login form in front of a SQLite file you can already read protects
  nothing and taxes every demo, script, and eval run.

## Open questions

- Which direction the registration-platform integration should run. "One-way" is
  specified; which way is not.
- Whether conditional form logic is needed for the real event or is aspirational.
  It is the most expensive item in the first feature.
- File uploads are currently recorded by name rather than stored. Real storage is
  straightforward but needs a decision about where bytes live.
