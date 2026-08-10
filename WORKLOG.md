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

## 2026-08-09 — Reading the evaluator

We got hold of the evaluation kit that will judge this. It reshaped the plan
more than anything since the screenshots.

**The evaluator is a browser and nothing else.** A Claude-driven Playwright
agent with thirteen tools — navigate, click, fill, select, drag, upload, press,
scroll, wait, snapshot, screenshot, observe, done. No HTTP client. No shell. No
access to the repository. A separate judge then scores from screenshots and the
agent's written observations.

So **our JSON API and our CLI score zero.** That was a genuinely uncomfortable
thing to read, having built both carefully. They stay, because they are how the
local-model eval drives the app and because they are good, but they stopped
counting as feature coverage. Anything that can only be done with `curl` does not
exist as far as this is concerned.

**The architecture held up, though.** Server-rendered HTML with real forms is
close to the best possible shape for this harness. Its `select` tool needs an
actual `<select>`. Its `upload` tool needs an actual `<input type=file>`. It
takes an automatic screenshot every time the URL changes — and its authors note
drily that "models under-screenshot in practice" — so a full-page-load app
generates far more evidence for the judge than a single-page app would. The
choices we made to be legible to a 12B model turn out to be the same ones that
survive an automated evaluator. That is not luck: both reward an app that says
what it is doing in the markup.

**Two pieces of previously invisible work became visible.** An in-app outbox is
explicitly accepted in place of real email delivery, which is exactly what we
built in D5 for entirely different reasons. And the rubric awards credit for
embed outputs in JSON, XML, and iCalendar — so the API becomes a *feature* the
moment an organizer can pick a format in a UI.

**The uncomfortable finding.** A `127.0.0.1` deployment is unevaluable. Not
penalised — unscored. And there is a coverage floor below which the result is
withheld rather than reported. Local-first is still right for development and for
owning your data, but public reachability stopped being a later step and became a
requirement (D11).

**What we changed the same day.** Public surfaces — sessions, speakers, agenda
grid, itinerary, gallery — all anonymous, all no-script. Real file uploads with
content-addressed storage and magic-byte checking. Speaker-side draft, resume,
edit, and withdraw, with editing locking when the call closes. Job title and
company on people, because "Priya Raman, Principal Engineer, Latticework Systems"
is what a session card is supposed to say and prose cannot be asked for that.

Two techniques carried the no-script rule further than expected: `<details>` for
show-more, and a cookie written by a form POST for the attendee's personal
schedule, which survives a full reload with no account at all.

## 2026-08-09 — The eval sent four emails it should not have

The clearest thing this project has produced, and it is not a feature.

A local model was asked to email everyone who still owed us paperwork. Looking
for a preview, it typed:

```
$ ./bin/conf notify manzanita-2026 ---dry-run
4 sent, 0 skipped. Messages are in the outbox.
```

Three dashes instead of two. `parseArgs` accepted any `--`-prefixed token, no
command validated what it got, so the flag was dropped and the command the model
believed was a preview sent every queued decision for real. Two acceptances and
two rejections went out. Theo Lambert, who owes us nothing, was told his talk
had been declined. Five of the seven people who actually owed something got
nothing.

We reproduced it by hand before changing a line.

Three separate mistakes lined up, and all three are ours:

1. **An unrecognised flag was ignored rather than refused.** The single worst
   default in the codebase. A flag you cannot see is worse than no flag at all,
   because it makes a command look like it did something safe.
2. **`notify` with no arguments meant "everyone".** For an irreversible,
   emotionally loaded email, the default should never be the widest possible
   blast radius.
3. **`notify` was the only thing in `conf --help` with the word "email" next to
   it.** Asked to email a group, a tired human at 11pm reaches for exactly the
   same command. The model was not being stupid; it was being led.

What is worth sitting with is that none of our 126 tests would ever have caught
this. Every one of them calls the functions correctly. It took something that
did not know the tool, trying to do a reasonable thing, under time pressure.
That is the entire argument for driving your own software with a model that is
not clever enough to paper over your mistakes.

Fixed: flags are declared per command and anything else is an error naming what
would have worked; `notify` refuses to run without explicit codes or `--all`,
and has a real `--dry-run`; and `conf mail` now exists as a separate verb, so
"send a message to a group" and "announce a decision" are different words.

The same run found three features that had an organizer screen and no command
at all -- reviews, bulk mail, and what the public can actually see -- and the
model burned its whole budget hunting for commands that were not there. All
three exist now. It also found `conf submissions --status unscored` returning a
confident empty list, which reads exactly like "there are none" and is how a
wrong answer gets believed.

And a regression of our own, caught the same hour: the approval gate added that
morning emptied every public surface, because the seed published sessions
without approving them. The demo agenda was blank and nothing said so. Fixed,
plus a dashboard warning, because ticking "show publicly" on unapproved content
otherwise does precisely nothing and you find out from an empty website.

## Open questions

- Which direction the registration-platform integration should run. "One-way" is
  specified; which way is not.
- Whether conditional form logic is needed for the real event or is aspirational.
  It is the most expensive item in the first feature.
- File uploads are currently recorded by name rather than stored. Real storage is
  straightforward but needs a decision about where bytes live.

---

## 2026-08-10 — Two interfaces, one of them imaginary

The day started with a question about state and ended with most of the app's
write paths rewritten. The thread running through it: **a write that is correct
in a browser and destructive over curl**, five separate times.

`conf schedule` wrote room and time straight onto the row. The web form did the
same and then sent the calendar invite. So moving a talk from the command line
left every speaker holding the old time, silently. CLAUDE.md claimed the two
interfaces "call the same core functions, so they never disagree"; they shared
`conflictsForSlot`, which is agreement about what a clash is, not about what
happens when there isn't one.

Then the same shape four more times. The schedule route wrote `published` on
every save from a checkbox, and an unchecked checkbox posts nothing — so a curl
caller moving a talk to a new time took it off the public agenda. Form settings
were a full replace, so renaming a form over curl wiped its welcome text, its
close date, and both of the things the customer marked hardest. The JSON
`notify` still meant "everybody" on an empty body, which is Run 4's incident
with a different verb. And the submit handler minted one magic-link token, put
it on the success page, put the same one in the confirmation email, and then
spent it to sign the submitter in — so **the link in the confirmation email
never worked**, for anybody, ever.

That last one is the one to sit with. It is the customer's "must have" and their
"make sure this works", and it was invisible to every kind of testing we had.
In-process the token round-trips fine. By hand you land in your portal, because
the same response sets a cookie. It only fails tomorrow, in somebody else's
inbox, where nobody is watching. What found it was a black-box suite that talks
to a running server over HTTP and nothing else — no imports from `src/` — which
is now `npm run test:http`.

### The exemption that hid the rest

`canOrganize()` returned true whenever `HOST` was loopback. That made this two
products: wide open on a laptop, entirely shut on any public address, and only
the first was ever exercised. The deployed behaviour was the untested one.

It was not merely permissive, it was concealing. Three `/api` routes answered
strangers regardless — including the agenda, which carries unannounced
acceptances. `POST /e/new` was unauthenticated. There was no CSRF defence at
all, which combined with open loopback access was exploitable on every
developer's machine by any web page they visited. And `/login` — the only door a
browser-driven evaluator can use — had been **completely broken for months**,
every persona naming an address no seed creates, because local development never
has to sign in.

Authorization is now a database fact and there is no branch anywhere that asks
what interface the server is bound to. The test suite passes identically under
`npm test` and `HOST=0.0.0.0 npm test`, which is the property worth keeping: if
those ever diverge again, something has grown a dependency on how the server was
started.

Trust on first use, with one gate. The first person to present the setup token
claims the instance and blesses everybody else. The gate is there because a
deployment's URL is public before anybody has claimed it.

Which promptly produced its own lesson: a fresh instance **could not be claimed
at all**. The claim deleted the operator's only copy of the token and then failed
on a constraint, leaving nothing that could ever claim it again. Found by
standing one up by hand. A side effect that destroys somebody's only credential
belongs after the step that might fail, never before it.

### Asking the harder question

The eval suite has always run the model inside the repository, where it has
`AGENTS.md`, `bin/conf`, and the source. That measures whether somebody handed
the project can operate it, which is not the situation anybody meets a
deployment in. `node eval/run-eval.js --http` runs the same tasks from an empty
directory with nothing but a URL and a token.

First result: `count-pending` passed 3 of 4, and both good traces show the model
fetching `/llms.txt` first, unprompted. The failure curled all 25KB of it, read
every one of 167 routes, and ran out of clock with nothing to say — Run 1's
`seed.js` problem with our own documentation as the trap. Completeness and
readability turned out to be different properties and the file only had the
first.

The first fix was wrong in a way worth recording: it put the route list behind
`?brief=1`, and the only place saying that option exists was inside the file you
had to read to find it. An option you learn about by paying its cost is not an
option. The short form is now the default.

A later trace showed a model guess `POST .../submissions/SESS-15/accept`, get a
bare 404, go and read llms.txt, and come back with `/decide` a round trip later.
The router now suggests near misses, which `bin/conf` has done since Run 8.

Every one of these was found by watching something small and stubborn try to use
the app, and not one would have been found by a unit test. The suite went from
189 tests to 336 in the process, and the tests are not what found any of it.
