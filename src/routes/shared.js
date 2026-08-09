// Pieces shared by more than one screen.

import { html, raw } from '../http/html.js';
import { notFound, forbidden } from '../http/router.js';
import { canOrganize } from '../core/auth.js';
import { localDay, localTime } from '../core/schedule.js';

export const STATUS_LABELS = {
  draft: 'Draft',
  pending: 'Pending',
  accept_queue: 'Accept queue',
  decline_queue: 'Decline queue',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/** The order the organizer's status tabs appear in, mirroring the workflow. */
export const STATUS_TABS = [
  'pending', 'accept_queue', 'decline_queue', 'accepted', 'declined', 'withdrawn', 'draft',
];

export function findEvent(db, slug) {
  const event = db.prepare('SELECT * FROM event WHERE slug = ?').get(slug);
  if (!event) {
    const known = db.prepare('SELECT slug FROM event ORDER BY starts_at DESC').all()
      .map((e) => e.slug);
    throw notFound(`no event with slug '${slug}'`,
      known.length ? `known events: ${known.join(', ')}` : 'no events exist yet; run `npm run seed`');
  }
  return event;
}

export function findSubmission(db, eventId, code) {
  const submission = db.prepare('SELECT * FROM submission WHERE event_id = ? AND code = ?')
    .get(eventId, code.toUpperCase());
  if (!submission) {
    throw notFound(`no submission with code '${code}' in this event`,
      'session codes look like SESS-1; list them at /api/events/<event>/submissions');
  }
  return submission;
}

export function requireOrganizer(ctx, event) {
  if (!canOrganize(ctx.db, event.id, ctx.person)) {
    throw forbidden('organizer access required',
      'sign in at /portal/sign-in with an organizer account');
  }
}

export function statusPill(status) {
  return html`<span class="pill ${status}">${STATUS_LABELS[status] ?? status}</span>`;
}

export function statusCounts(db, eventId) {
  const rows = db.prepare(
    'SELECT status, count(*) AS n FROM submission WHERE event_id = ? GROUP BY status',
  ).all(eventId);
  const counts = Object.fromEntries(STATUS_TABS.map((s) => [s, 0]));
  for (const row of rows) counts[row.status] = row.n;
  counts.all = rows.reduce((sum, r) => sum + r.n, 0);
  return counts;
}

/** The organizer chrome. Kept flat: seven destinations, no nested menus. */
export function organizerNav(event, current) {
  const items = [
    ['', 'Dashboard'],
    ['/submissions', 'Submissions'],
    ['/agenda', 'Agenda'],
    ['/speakers', 'Speakers'],
    ['/tasks', 'Tasks'],
    ['/review', 'Review'],
    ['/outbox', 'Outbox'],
  ];
  return html`
    <header class="bar">
      <div class="inner">
        <strong>${event.name}</strong>
        <nav>
          ${items.map(([path, label]) => html`
            <a href="/e/${event.slug}${path}" ${current === label ? raw('aria-current="page"') : ''}>${label}</a>
          `)}
        </nav>
        <span class="spacer"></span>
        <span class="who"><a href="/agenda/${event.slug}">Public agenda</a></span>
      </div>
    </header>
  `;
}

export function portalNav(event, current, person) {
  const items = [['', 'Home'], ['/submissions', 'Submissions'], ['/profile', 'Profile'], ['/tasks', 'Tasks']];
  return html`
    <header class="bar">
      <div class="inner">
        <strong>${event.name}</strong>
        <nav>
          ${items.map(([path, label]) => html`
            <a href="/portal/${event.slug}${path}" ${current === label ? raw('aria-current="page"') : ''}>${label}</a>
          `)}
        </nav>
        <span class="spacer"></span>
        <span class="who">${person.first_name} ${person.last_name}
          &middot; <a href="/portal/sign-out">Sign out</a></span>
      </div>
    </header>
  `;
}

export function tabs(items) {
  return html`
    <nav class="tabs">
      ${items.map(({ href, label, count, current }) => html`
        <a href="${href}" ${current ? raw('aria-current="page"') : ''}>
          ${label}${count === undefined ? '' : html` <span class="count">${count}</span>`}
        </a>
      `)}
    </nav>
  `;
}

export function empty(message) {
  return html`<p class="empty">${message}</p>`;
}

/** A date and time in the event's own timezone, which is the only one that matters. */
export function when(iso, timezone) {
  if (!iso) return html`<span class="muted">-</span>`;
  return html`${localDay(iso, timezone)} ${localTime(iso, timezone)}`;
}

export function dateOnly(iso, timezone = 'UTC') {
  return iso ? localDay(iso, timezone) : '-';
}

/** Format an instant for a `datetime-local` input, in the event's timezone. */
export function toLocalInput(iso, timezone) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Read a `datetime-local` value as an instant in the event's timezone.
 *
 * The browser hands back wall-clock time with no zone. Interpreting it as UTC
 * would silently shift every session by the event's offset, which is exactly the
 * bug that puts a keynote at 2am, so the offset is resolved explicitly.
 */
export function fromLocalInput(value, timezone) {
  if (!value) return null;
  const naive = `${value.length === 16 ? value : value.slice(0, 16)}:00`;
  const guess = new Date(`${naive}Z`);
  const offsetMs = guess.getTime() - new Date(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(guess).replace(' ', 'T') + 'Z',
  ).getTime();
  return new Date(guess.getTime() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function fullName(person) {
  return `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() || person.email;
}
