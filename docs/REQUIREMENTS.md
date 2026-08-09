# Requirements

Distilled from three sources: a written brief, ~35 annotated screenshots of the
incumbent product, and background research. Deliberately vendor-neutral — this
describes what *we* build, not who else builds something like it.

## Context

The customer pays >$40k/year for a closed-source speaker-and-content management
platform and wants to stop. They do **not** use everything it does, which is what makes
a focused open-source replacement viable. Cloning the exact design is explicitly *not*
a requirement; being good enough to actually use is.

Judging is by independent evaluation, with the tiebreaker going to whoever "made
subjective judgment calls for the product we would actually use/buy." That sentence is
the real spec. Where the incumbent is confusing, we are allowed — expected — to be
better rather than faithful.

Stated bonus criteria, in their words: Cloudflare deploy (mild), Airtable persistence,
source hosted on Forge rather than GitHub (very teeny), **speed/performance ("we do not
want slow SaaS pls")**, and a documented **API**.

See `docs/DECISIONS.md` for how we are trading these off against a local-first build.

## The nine primary features

Numbered as the customer numbered them.

1. **Custom call-for-speakers submission forms** with conditional logic and
   category-based routing.
2. **Self-service speaker portal** for bios, headshots, slides, and supporting
   documents.
3. **Automated, templated speaker communications**, including reminders and **calendar
   invites delivered to each speaker's own calendar** (Gmail, Outlook, iCal).
4. **Submission evaluation and scoring workflows**, including optional AI-assisted
   review, across multiple rounds.
5. **Schedule and agenda building** with automatic **conflict detection across rooms
   and tracks**, viewable by list, day, week, track, or room.
6. **Real-time dashboard** showing which speakers still have outstanding onboarding
   tasks.
7. **One-way integration with Accelevents** (their existing registration platform) to
   eliminate manual data re-entry.
8. **Resource and wiki pages** inside the speaker portal, including HTML embed support.
9. **Embeddable, mobile-friendly speaker gallery and schedule itinerary** to post on
   their own website.

## Priority, straight from the annotations

The screenshots carry hand-written margin notes. These are the least ambiguous
prioritization signal we have, so they outrank our own guesses.

| Area | Note | Our reading |
| --- | --- | --- |
| Payments & fees on submission forms | **"NOT NEEDED"** | Do not build. No payment model at all. |
| Submission confirmation email to submitter | **"must have"** | P0. |
| Success page message + auto-redirect into the speaker portal | **"make sure this works"** | P0, and it is the seam between CFP and portal. |
| Form close date | **"kinda impt"** | P1. Enables close-date reminder emails. |
| Speaker editing their own bio/links | **"update your own bio data"** | P0 — this is the point of the portal. |
| Admin notification on new/updated submission | **"nice to have"** | P2. |
| CMS → Embeds | **"OPTIONAL"** | P2, but cheap given feature 9. |
| Dashboard | **"optional but nice to have, best efforts"** | P2. |

Notably, payment is the *only* thing struck outright, and the two things marked
strongest ("must have", "make sure this works") are both about the **handoff from
submission to portal**. That handoff is the product's spine.

## Domain model, as observed

### Submission status is a five-state machine, not three

The incumbent's status filter shows: **Accepted, Accept Queue, Pending, Decline Queue,
Declined**, with **Withdrawn** and **Drafts** as separate tabs. Alongside it is a
distinct **`Notified`** column.

This is the single most important detail in the screenshots. `Accept Queue` and
`Decline Queue` are *staging* states: an organizer makes many decisions, then notifies
in one batch. Decision and notification are deliberately decoupled — you can never
accidentally email a speaker by changing a dropdown.

```
draft ─→ pending ─┬─→ accept_queue ──(notify)──→ accepted
                  └─→ decline_queue ─(notify)──→ declined
        any state ─→ withdrawn
```

### Records

- **Event** — name, slug, type, website URL, location, timezone, starts/ends,
  theme/description, logo + background image, optional exhibitor/sponsor groups.
- **Submission** (an "abstract" pre-decision, a "session" post-decision). Fields seen:
  title, description (rich text), format, tags, track, level, language, starts/ends,
  capacity, CEU credits, client session ID, location, chairperson, files, speakers,
  submitter, created at, rating, notified.
- **Person / participant** — first name, last name, email, mobile phone, biography,
  salutation, honorific, pronouns, gender, and links (LinkedIn, X, Facebook, website).
  Roles are configurable per form, with min/max counts per role (e.g. Speaker).
- **Form** — three kinds: Contact forms, Group forms, Submission forms.
- **Task** — three kinds: Contact tasks, Group tasks, Submission tasks. Examples seen:
  "Hotel and Travel Reservations", "Presentation Upload". A task can require a form or
  a file.
- **File request** — collects documents; notably "files are stored, not attached" —
  they live on the request, not on the session record.
- **Embed** — a styled-HTML feed of agenda / session list / schedule itinerary /
  speaker list / speaker gallery, filterable, auto-updating.

### The submission form builder

A seven-step wizard. Steps: Submission Setup → Welcome Screen → Abstract Information →
Participant Information → ~~Payments & Fees~~ → Form Settings → Notifications.

- **Submission Setup** — collect Abstracts (review before sessions are finalized) or
  Sessions (full proposals); toggle whether to collect participant details.
- **Welcome Screen** — internal name vs external title (a good distinction: organizers
  name forms for themselves, submitters see something else), page heading, rich-text
  welcome message.
- **Abstract Information** — section title, heading, instructions, and an ordered,
  reorderable field list. Default fields: Title (locked, text, 255), Description
  (rich text, 5000), Format (dropdown), Tags (dropdown), Track (dropdown), Level
  (dropdown, optional). Fields are individually required-toggleable; some are *locked*
  and cannot be removed.
- **Participant Information** — participant roles with min/max counts, then fields:
  First Name (locked), Last Name (locked), Email (locked), Mobile Phone, Biography.
- **Form Settings** — close date, submission limit per user, allow multiple drafts,
  auto-redirect to portal, success message, and cross-field character limits ("cap the
  combined length of several text fields, for example a printed program block") with a
  live counter for submitters. That last one is a real, specific need — print programs
  have hard column widths.
- **Notifications** — which admins get alerted; submitter confirmation email.

The public form is a stepper: **Welcome → Account → Submission → Participant →
Review**, with a banner showing the close date and the per-user submission limit.

### The speaker portal

Top-level nav: **Home / Submissions / Profile / Tasks**. Home shows *My Submissions*
(cards with a session code like `SESS-4`, its format, and its status), *My Profile*,
and a *Tasks* panel split into **Submission Tasks** and **My Tasks**. An admin viewing
the portal can switch "Back to Admin Mode".

Session codes like `SESS-4` are worth keeping — they are short, speakable, and
quotable in an email. See `docs/DESIGN.md` on identifiers.

### The agenda

Views: **List / Day / Week / Month / Rooms / Conflicts**. Conflicts is its own view,
not a warning banner — conflict detection is a first-class screen.

### The dashboard

Multiple named dashboards: Today, Review Progress, Speaker Tracking, Submissions
Pipeline. The genuinely useful parts are the sentences, not the charts:

- "1 accepted session still needs a time slot on the agenda."
- "3 session submissions are awaiting a decision."
- "2 accepted speakers are missing a bio or headshot (2 bios, 2 headshots)."

Each is a **count plus a link to the exact filtered list**. We should copy this pattern
and skip most of the donut charts.

## Explicit non-goals

- Payments, invoicing, fees, promo codes.
- Attendee registration and ticketing — the customer keeps their existing platform.
- Exhibitor/sponsor management beyond a toggle (their portal features are sold as an
  upsell in the incumbent; not our problem).

## Open questions for the customer

- Which Accelevents direction matters: pulling registration data in, or pushing
  accepted speakers/sessions out? "One-way" is stated but not which way.
- Is "conditional logic" on forms needed for the real event, or aspirational? It is the
  single most expensive item in feature 1.
