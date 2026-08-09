// The public, embeddable surfaces: sessions, speakers, agenda, itinerary, gallery.
//
// Everything here is reachable with no account and no redirect. That is a
// deliberate, load-bearing property: these pages are what a conference puts on
// its own website, and an attendee deciding whether to buy a ticket must not
// meet a login form.
//
// Two techniques keep these rich without a line of JavaScript:
//
//   * `<details>` for "show more" disclosure. It is native, keyboard
//     accessible, and works for anything driving the page programmatically.
//   * A cookie for the personal schedule, written by an ordinary form POST.
//     It survives a full page reload without an account and without script.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, notFound, badRequest } from '../http/router.js';
import { localDay, localTime } from '../core/schedule.js';
import { buildIcs, uidFor } from '../core/ics.js';
import { cookieHeader } from '../http/request.js';
import { fullName, empty, dateOnly } from './shared.js';

const ITINERARY_COOKIE = 'my_schedule';

export function mountWidgets(router) {
  // Both `/sessions` and `/sessions/<event>` work. The bare form picks the
  // soonest upcoming event, so a visitor who guesses the obvious URL lands
  // somewhere useful instead of on a 404.
  const surfaces = [
    ['sessions', sessionsList, 'Public session list with search and filters.'],
    ['speakers', speakersList, 'Public speaker directory, ordered by surname.'],
    ['agenda', agendaView, 'Public agenda grid: rooms across, time down, one day at a time.'],
    ['schedule', itineraryView, 'Public schedule itinerary, with a personal schedule you can build.'],
    ['gallery', galleryView, 'Public speaker gallery: photographs.'],
  ];

  for (const [name, handler, doc] of surfaces) {
    router.get(`/${name}`, handler, `${doc} Defaults to the next event.`);
    router.get(`/${name}/:event`, handler, doc);
  }

  router.get('/event/:event', eventHub, 'Public landing page linking every public surface.');

  router.get('/sessions/:event/:code', sessionDetail,
    'One public session: full description, time, room, track, format, and its speakers.');
  router.get('/agenda/:event/block/:code', sessionDetail,
    'The detail behind one block in the agenda grid.');
  router.get('/speakers/:event/:person', speakerDetail,
    'One public speaker: photograph, bio, affiliation, and their sessions.');
  router.get('/gallery/:event/:person', galleryDetail,
    'One speaker from the gallery.');

  router.post('/schedule/:event/toggle', toggleItinerary,
    'Add or remove a session from your personal schedule. Stored in a cookie; no account needed.');
  router.get('/schedule/:event/mine', myItinerary,
    'The sessions you added to your personal schedule.');
  router.get('/schedule/:event/mine.ics', myItineraryIcs,
    'Your personal schedule as an iCalendar file.');
}

// --- shared ----------------------------------------------------------------

/** The event being browsed: the one named in the URL, or the next one running. */
function publicEvent(db, slug) {
  if (slug) {
    const found = db.prepare('SELECT * FROM event WHERE slug = ?').get(slug);
    if (found) return found;
    const known = db.prepare('SELECT slug FROM event').all().map((e) => e.slug);
    throw notFound(`no event '${slug}'`,
      known.length ? `events are: ${known.join(', ')}` : 'no events exist yet');
  }

  const event = db.prepare(
    `SELECT * FROM event ORDER BY (ends_at < date('now')) , starts_at LIMIT 1`,
  ).get();
  if (!event) throw notFound('no events exist yet');
  return event;
}

/**
 * Sessions the public may see.
 *
 * Two gates, both deliberate: the session must be accepted, and its content must
 * be approved for publication. An organizer mid-edit is not broadcasting drafts.
 */
function publicSessions(db, eventId) {
  return db.prepare(
    `SELECT s.id, s.code, s.title, s.description, s.starts_at, s.ends_at,
            r.name AS room_name, r.slug AS room_slug,
            t.name AS track_name, t.slug AS track_slug,
            f.label AS format_label, f.slug AS format_slug,
            l.label AS level_label
       FROM submission s
       LEFT JOIN room r  ON r.id = s.room_id
       LEFT JOIN track t ON t.id = s.track_id
       LEFT JOIN taxonomy_option f ON f.id = s.format_option_id
       LEFT JOIN taxonomy_option l ON l.id = s.level_option_id
      WHERE s.event_id = ? AND s.status = 'accepted' AND s.published = 1
      ORDER BY s.starts_at IS NULL, s.starts_at, r.sort_order, s.code`,
  ).all(eventId);
}

function speakersOf(db, submissionId) {
  return db.prepare(
    `SELECT p.slug, p.first_name, p.last_name, p.job_title, p.company, p.biography,
            p.headshot_file_id, f.slug AS headshot
       FROM submission_participant sp
       JOIN person p ON p.id = sp.person_id
       LEFT JOIN file f ON f.id = p.headshot_file_id
      WHERE sp.submission_id = ? ORDER BY sp.sort_order, p.last_name`,
  ).all(submissionId);
}

/** Everyone appearing on a published session, once each, surname order. */
function publicSpeakers(db, eventId) {
  return db.prepare(
    `SELECT DISTINCT p.slug, p.first_name, p.last_name, p.job_title, p.company,
            p.biography, p.link_website, p.link_linkedin, p.link_x,
            f.slug AS headshot
       FROM person p
       JOIN submission_participant sp ON sp.person_id = p.id
       JOIN submission s ON s.id = sp.submission_id
       LEFT JOIN file f ON f.id = p.headshot_file_id
      WHERE s.event_id = ? AND s.status = 'accepted' AND s.published = 1
      ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`,
  ).all(eventId);
}

/** "Principal Engineer, Latticework Systems" — whichever halves exist. */
function affiliation(person) {
  return [person.job_title, person.company].filter(Boolean).join(', ');
}

function publicNav(event, current) {
  const items = [
    ['sessions', 'Sessions'],
    ['speakers', 'Speakers'],
    ['agenda', 'Agenda'],
    ['schedule', 'Itinerary'],
    ['gallery', 'Gallery'],
  ];
  return html`
    <header class="bar">
      <div class="inner">
        <strong><a href="/event/${event.slug}" style="color:inherit;text-decoration:none">${event.name}</a></strong>
        <nav>
          ${items.map(([path, label]) => html`
            <a href="/${path}/${event.slug}" ${current === label ? raw('aria-current="page"') : ''}>${label}</a>`)}
        </nav>
        <span class="spacer"></span>
        <span class="who">${dateOnly(event.starts_at, event.timezone)}
          &ndash; ${dateOnly(event.ends_at, event.timezone)}</span>
      </div>
    </header>`;
}

/** A description with native show-more disclosure, no script involved. */
function description(text, { limit = 180 } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return html`<p class="muted">No description yet.</p>`;
  if (body.length <= limit) return html`<p>${body}</p>`;

  return html`
    <details>
      <summary>${body.slice(0, limit).trimEnd()}&hellip; <strong>Show more</strong></summary>
      <p>${body}</p>
    </details>`;
}

function whenLine(session, event) {
  if (!session.starts_at) return html`<span class="muted">Time to be confirmed</span>`;
  return html`${localDay(session.starts_at, event.timezone)},
    ${localTime(session.starts_at, event.timezone)}&ndash;${localTime(session.ends_at, event.timezone)}`;
}

// --- hub -------------------------------------------------------------------

function eventHub(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const sessions = publicSessions(ctx.db, event.id);
  const speakers = publicSpeakers(ctx.db, event.id);
  const form = ctx.db.prepare(
    `SELECT slug, close_at FROM form WHERE event_id = ? AND kind = 'submission'
      ORDER BY close_at IS NULL DESC, close_at DESC LIMIT 1`,
  ).get(event.id);

  return ok(page({
    title: event.name,
    nav: publicNav(event, null),
    body: html`
      <h1>${event.name}</h1>
      <p class="sub">${dateOnly(event.starts_at, event.timezone)} &ndash;
        ${dateOnly(event.ends_at, event.timezone)}
        ${event.location ? html` &middot; ${event.location}` : ''}</p>
      ${event.description ? html`<p>${event.description}</p>` : ''}

      <div class="cards">
        <div class="card"><div class="n">${sessions.length}</div>
          <div class="label"><a href="/sessions/${event.slug}">Sessions</a></div></div>
        <div class="card"><div class="n">${speakers.length}</div>
          <div class="label"><a href="/speakers/${event.slug}">Speakers</a></div></div>
        <div class="card"><div class="label"><a href="/agenda/${event.slug}">Agenda grid</a></div></div>
        <div class="card"><div class="label"><a href="/schedule/${event.slug}">Schedule itinerary</a></div></div>
        <div class="card"><div class="label"><a href="/gallery/${event.slug}">Speaker gallery</a></div></div>
      </div>

      ${form ? html`
        <h2>Call for speakers</h2>
        <p><a class="button" href="/submit/${event.slug}/${form.slug}">Submit a talk</a></p>` : ''}
    `,
  }));
}

// --- sessions --------------------------------------------------------------

function sessionsList(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const all = publicSessions(ctx.db, event.id);

  const query = (ctx.query.get('q') ?? '').trim();
  const track = ctx.query.get('track') ?? '';
  const format = ctx.query.get('format') ?? '';
  const room = ctx.query.get('room') ?? '';

  const withSpeakers = all.map((s) => ({ ...s, speakers: speakersOf(ctx.db, s.id) }));

  // Search covers speaker names as well as titles: attendees look for people at
  // least as often as they look for topics.
  const needle = query.toLowerCase();
  const results = withSpeakers.filter((s) => {
    if (track && s.track_slug !== track) return false;
    if (format && s.format_slug !== format) return false;
    if (room && s.room_slug !== room) return false;
    if (!needle) return true;
    return s.title.toLowerCase().includes(needle)
      || (s.description ?? '').toLowerCase().includes(needle)
      || s.speakers.some((p) => fullName(p).toLowerCase().includes(needle));
  });

  const facet = (rows, key, label) => html`
    <div>
      <label for="${key}">${label}</label>
      <select id="${key}" name="${key}">
        <option value="">All</option>
        ${rows.map((r) => html`
          <option value="${r.slug}" ${r.slug === ctx.query.get(key) ? raw('selected') : ''}>${r.label}</option>`)}
      </select>
    </div>`;

  const tracks = ctx.db.prepare('SELECT slug, name AS label FROM track WHERE event_id = ? ORDER BY sort_order')
    .all(event.id);
  const formats = ctx.db.prepare(
    "SELECT slug, label FROM taxonomy_option WHERE event_id = ? AND kind = 'format' ORDER BY sort_order",
  ).all(event.id);
  const rooms = ctx.db.prepare('SELECT slug, name AS label FROM room WHERE event_id = ? ORDER BY sort_order')
    .all(event.id);

  return ok(page({
    title: `Sessions - ${event.name}`,
    nav: publicNav(event, 'Sessions'),
    wide: true,
    body: html`
      <h1>Sessions</h1>
      <p class="sub">Showing <strong>${results.length}</strong> of ${all.length} sessions.</p>

      <form method="get" class="row" style="margin-bottom:1.5rem">
        <div>
          <label for="q">Search</label>
          <input type="text" id="q" name="q" value="${query}"
                 placeholder="a title, a topic, or a speaker's name">
        </div>
        ${facet(tracks, 'track', 'Track')}
        ${facet(formats, 'format', 'Format')}
        ${facet(rooms, 'room', 'Location')}
        <div style="flex:0 0 auto">
          <button type="submit">Filter</button>
          <a class="button secondary" href="/sessions/${event.slug}">Clear</a>
        </div>
      </form>

      ${results.length === 0 ? empty('No sessions match. Try clearing the filters.') : html`
        <div class="stack">
          ${results.map((s) => html`
            <div class="card">
              <h3 style="margin:0 0 .25rem">
                <a href="/sessions/${event.slug}/${s.code}">${s.title}</a>
              </h3>
              <p class="muted" style="margin:0 0 .5rem">
                ${whenLine(s, event)}${s.room_name ? html` &middot; ${s.room_name}` : ''}
              </p>
              <p style="margin:0 0 .5rem">
                ${s.format_label ? html`<span class="pill draft">${s.format_label}</span> ` : ''}
                ${s.track_name ? html`<span class="pill accepted">${s.track_name}</span> ` : ''}
                ${s.level_label ? html`<span class="pill pending">${s.level_label}</span>` : ''}
              </p>
              ${description(s.description)}
              ${s.speakers.length > 0 ? html`
                <p class="muted" style="margin:.5rem 0 0">
                  ${s.speakers.map((p) => html`
                    <a href="/speakers/${event.slug}/${p.slug}">${fullName(p)}</a>${affiliation(p) ? html` &mdash; ${affiliation(p)}` : ''}<br>`)}
                </p>` : ''}
            </div>`)}
        </div>`}
    `,
  }));
}

function sessionDetail(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const session = publicSessions(ctx.db, event.id)
    .find((s) => s.code.toUpperCase() === String(ctx.params.code).toUpperCase());
  if (!session) {
    throw notFound(`no published session '${ctx.params.code}'`,
      `the full list is at /sessions/${event.slug}`);
  }

  const speakers = speakersOf(ctx.db, session.id);
  const inSchedule = itineraryCodes(ctx.cookies, event.slug).includes(session.code);

  return ok(page({
    title: `${session.title} - ${event.name}`,
    nav: publicNav(event, 'Sessions'),
    body: html`
      <p class="sub"><a href="/sessions/${event.slug}">&larr; Back to all sessions</a></p>
      <h1>${session.title}</h1>
      <p class="sub">
        ${whenLine(session, event)}${session.room_name ? html` &middot; ${session.room_name}` : ''}
      </p>
      <p>
        ${session.format_label ? html`<span class="pill draft">${session.format_label}</span> ` : ''}
        ${session.track_name ? html`<span class="pill accepted">${session.track_name}</span> ` : ''}
        ${session.level_label ? html`<span class="pill pending">${session.level_label}</span>` : ''}
      </p>

      <p>${session.description || html`<span class="muted">No description yet.</span>`}</p>

      <form method="post" action="/schedule/${event.slug}/toggle">
        <input type="hidden" name="code" value="${session.code}">
        <input type="hidden" name="return_to" value="/sessions/${event.slug}/${session.code}">
        <div class="actions">
          <button type="submit">${inSchedule ? 'Remove from my schedule' : 'Add to my schedule'}</button>
          <a class="button secondary" href="/agenda/${event.slug}/${session.code}.ics">Add to calendar</a>
        </div>
      </form>

      <h2>${speakers.length === 1 ? 'Speaker' : 'Speakers'}</h2>
      ${speakers.length === 0 ? empty('No speakers listed.') : html`
        <div class="grid2">
          ${speakers.map((p) => html`
            <div class="card">
              ${p.headshot ? html`<p><img src="/files/${p.headshot}" alt="${fullName(p)}"
                style="width:5rem;height:5rem;object-fit:cover;border-radius:50%"></p>` : ''}
              <strong><a href="/speakers/${event.slug}/${p.slug}">${fullName(p)}</a></strong>
              ${affiliation(p) ? html`<p class="muted" style="margin:.25rem 0">${affiliation(p)}</p>` : ''}
              ${description(p.biography, { limit: 140 })}
            </div>`)}
        </div>`}
    `,
  }));
}

// --- speakers --------------------------------------------------------------

function speakersList(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const all = publicSpeakers(ctx.db, event.id);
  const query = (ctx.query.get('q') ?? '').trim().toLowerCase();

  const results = query
    ? all.filter((p) => fullName(p).toLowerCase().includes(query)
      || (p.company ?? '').toLowerCase().includes(query))
    : all;

  return ok(page({
    title: `Speakers - ${event.name}`,
    nav: publicNav(event, 'Speakers'),
    wide: true,
    body: html`
      <h1>Speakers</h1>
      <p class="sub">Showing <strong>${results.length}</strong> of ${all.length}, by surname.</p>

      <form method="get" class="row" style="margin-bottom:1.5rem">
        <div>
          <label for="q">Search by name or company</label>
          <input type="text" id="q" name="q" value="${ctx.query.get('q') ?? ''}">
        </div>
        <div style="flex:0 0 auto">
          <button type="submit">Search</button>
          <a class="button secondary" href="/speakers/${event.slug}">Clear</a>
        </div>
      </form>

      ${results.length === 0 ? empty('Nobody matches that search.') : html`
        <div class="scroll">
        <table>
          <thead><tr><th></th><th>Name</th><th>Role</th><th>About</th></tr></thead>
          <tbody>
            ${results.map((p) => html`
              <tr>
                <td>${p.headshot
                  ? html`<img src="/files/${p.headshot}" alt="${fullName(p)}"
                      style="width:3rem;height:3rem;object-fit:cover;border-radius:50%">`
                  : html`<span class="muted">no photo</span>`}</td>
                <td><a href="/speakers/${event.slug}/${p.slug}"><strong>${fullName(p)}</strong></a></td>
                <td>${p.job_title || html`<span class="muted">-</span>`}<br>
                    <span class="muted">${p.company}</span></td>
                <td>${description(p.biography, { limit: 120 })}</td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}
    `,
  }));
}

function findPublicSpeaker(ctx, event, slug) {
  const person = publicSpeakers(ctx.db, event.id).find((p) => p.slug === slug);
  if (!person) {
    throw notFound(`no speaker '${slug}' at this event`,
      `the directory is at /speakers/${event.slug}`);
  }
  return person;
}

function sessionsBySpeaker(ctx, event, slug) {
  return publicSessions(ctx.db, event.id)
    .map((s) => ({ ...s, speakers: speakersOf(ctx.db, s.id) }))
    .filter((s) => s.speakers.some((p) => p.slug === slug));
}

function speakerDetail(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const person = findPublicSpeaker(ctx, event, ctx.params.person);
  const sessions = sessionsBySpeaker(ctx, event, person.slug);

  return ok(page({
    title: `${fullName(person)} - ${event.name}`,
    nav: publicNav(event, 'Speakers'),
    body: html`
      <p class="sub"><a href="/speakers/${event.slug}">&larr; All speakers</a></p>
      ${person.headshot ? html`<p><img src="/files/${person.headshot}" alt="${fullName(person)}"
        style="width:8rem;height:8rem;object-fit:cover;border-radius:8px"></p>` : ''}
      <h1>${fullName(person)}</h1>
      ${affiliation(person) ? html`<p class="sub">${affiliation(person)}</p>` : ''}
      ${person.biography ? html`<p>${person.biography}</p>` : ''}

      <p>
        ${person.link_website ? html`<a href="${person.link_website}">Website</a> ` : ''}
        ${person.link_linkedin ? html`<a href="${person.link_linkedin}">LinkedIn</a> ` : ''}
        ${person.link_x ? html`<a href="${person.link_x}">X</a>` : ''}
      </p>

      <h2>Sessions (${sessions.length})</h2>
      ${sessions.length === 0 ? empty('No sessions listed yet.') : html`
        <table>
          <tbody>
            ${sessions.map((s) => html`
              <tr>
                <td><a href="/sessions/${event.slug}/${s.code}"><strong>${s.title}</strong></a></td>
                <td>${whenLine(s, event)}</td>
                <td>${s.room_name ?? html`<span class="muted">-</span>`}</td>
              </tr>`)}
          </tbody>
        </table>`}
    `,
  }));
}

// --- agenda grid -----------------------------------------------------------

function agendaView(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const sessions = publicSessions(ctx.db, event.id).filter((s) => s.starts_at);

  const days = [...new Set(sessions.map((s) => localDay(s.starts_at, event.timezone)))].sort();
  const day = ctx.query.get('day') ?? days[0] ?? null;

  if (day && days.length > 0 && !days.includes(day)) {
    throw badRequest(`nothing is scheduled on ${day}`, `days with sessions: ${days.join(', ')}`);
  }

  const onDay = sessions.filter((s) => localDay(s.starts_at, event.timezone) === day);
  const rooms = ctx.db.prepare('SELECT * FROM room WHERE event_id = ? ORDER BY sort_order, name')
    .all(event.id).filter((r) => onDay.some((s) => s.room_name === r.name));
  const times = [...new Set(onDay.map((s) => s.starts_at))].sort();

  return ok(page({
    title: `Agenda - ${event.name}`,
    nav: publicNav(event, 'Agenda'),
    wide: true,
    body: html`
      <h1>Agenda</h1>
      <p class="sub">Rooms across, time down. ${sessions.length} sessions over ${days.length} day${days.length === 1 ? '' : 's'}.</p>

      ${days.length === 0 ? empty('The schedule is not published yet.') : html`
        <nav class="tabs">
          ${days.map((d) => html`
            <a href="/agenda/${event.slug}?day=${d}" ${d === day ? raw('aria-current="page"') : ''}>${d}</a>`)}
        </nav>

        <div class="scroll">
        <table>
          <thead>
            <tr><th>Time</th>${rooms.map((r) => html`<th>${r.name}</th>`)}</tr>
          </thead>
          <tbody>
            ${times.map((startsAt) => html`
              <tr>
                <td><strong>${localTime(startsAt, event.timezone)}</strong><br>
                  <span class="muted">${localTime(onDay.find((s) => s.starts_at === startsAt).ends_at, event.timezone)}</span></td>
                ${rooms.map((r) => {
                  const cell = onDay.find((s) => s.starts_at === startsAt && s.room_name === r.name);
                  return html`<td>${cell ? html`
                    <a href="/agenda/${event.slug}/block/${cell.code}"><strong>${cell.title}</strong></a>
                    <br>${cell.track_name ? html`<span class="pill accepted">${cell.track_name}</span>` : ''}
                    ${cell.format_label ? html`<span class="pill draft">${cell.format_label}</span>` : ''}
                  ` : html`<span class="muted">-</span>`}</td>`;
                })}
              </tr>`)}
          </tbody>
        </table>
        </div>`}
    `,
  }));
}

// --- itinerary and the personal schedule -----------------------------------

/** The session codes this visitor has starred, read from their cookie. */
function itineraryCodes(cookies, eventSlug) {
  const raw = cookies?.[`${ITINERARY_COOKIE}_${eventSlug}`] ?? cookies?.[ITINERARY_COOKIE] ?? '';
  return String(raw).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
}

function itineraryView(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const all = publicSessions(ctx.db, event.id).filter((s) => s.starts_at)
    .map((s) => ({ ...s, speakers: speakersOf(ctx.db, s.id) }));

  const query = (ctx.query.get('q') ?? '').trim().toLowerCase();
  const track = ctx.query.get('track') ?? '';
  const sessions = all.filter((s) => (!track || s.track_slug === track)
    && (!query || s.title.toLowerCase().includes(query)
      || s.speakers.some((p) => fullName(p).toLowerCase().includes(query))));

  const days = [...new Set(all.map((s) => localDay(s.starts_at, event.timezone)))].sort();
  const day = ctx.query.get('day') ?? days[0] ?? null;
  const onDay = sessions.filter((s) => localDay(s.starts_at, event.timezone) === day);

  const mine = itineraryCodes(ctx.cookies, event.slug);
  const tracks = ctx.db.prepare('SELECT slug, name FROM track WHERE event_id = ? ORDER BY sort_order')
    .all(event.id);

  return ok(page({
    title: `Schedule - ${event.name}`,
    nav: publicNav(event, 'Itinerary'),
    wide: true,
    body: html`
      <h1>Schedule itinerary</h1>
      <p class="sub">Star the sessions you want. Your picks are kept in this browser &mdash;
        no account needed &mdash; and survive a reload.
        ${mine.length > 0 ? html`<a href="/schedule/${event.slug}/mine">See my ${mine.length} selected</a>.` : ''}</p>

      ${days.length === 0 ? empty('The schedule is not published yet.') : html`
        <nav class="tabs">
          ${days.map((d) => html`
            <a href="/schedule/${event.slug}?day=${d}" ${d === day ? raw('aria-current="page"') : ''}>${d}</a>`)}
        </nav>

        <form method="get" class="row" style="margin-bottom:1.5rem">
          <input type="hidden" name="day" value="${day}">
          <div>
            <label for="q">Search</label>
            <input type="text" id="q" name="q" value="${ctx.query.get('q') ?? ''}">
          </div>
          <div>
            <label for="track">Track</label>
            <select id="track" name="track">
              <option value="">All tracks</option>
              ${tracks.map((t) => html`
                <option value="${t.slug}" ${t.slug === track ? raw('selected') : ''}>${t.name}</option>`)}
            </select>
          </div>
          <div style="flex:0 0 auto">
            <button type="submit">Filter</button>
            <a class="button secondary" href="/schedule/${event.slug}?day=${day}">Clear</a>
          </div>
        </form>

        ${onDay.length === 0 ? empty('Nothing matches on this day.') : html`
          <div class="stack">
            ${onDay.map((s) => sessionCard(ctx, event, s, mine.includes(s.code), `/schedule/${event.slug}?day=${day}`))}
          </div>`}`}
    `,
  }));
}

function sessionCard(ctx, event, s, starred, returnTo) {
  return html`
    <div class="card">
      <p style="margin:0 0 .35rem">
        ${s.track_name ? html`<span class="pill accepted">${s.track_name}</span> ` : ''}
        ${s.format_label ? html`<span class="pill draft">${s.format_label}</span>` : ''}
      </p>
      <h3 style="margin:0 0 .25rem"><a href="/sessions/${event.slug}/${s.code}">${s.title}</a></h3>
      <p class="muted" style="margin:0 0 .5rem">
        ${whenLine(s, event)}${s.room_name ? html` &middot; ${s.room_name}` : ''}
      </p>
      ${description(s.description)}
      ${s.speakers.length > 0 ? html`
        <p class="muted" style="margin:.5rem 0 0">
          ${s.speakers.map((p) => html`
            ${fullName(p)}${affiliation(p) ? html` &mdash; ${affiliation(p)}` : ''}<br>`)}
        </p>` : ''}
      <form method="post" action="/schedule/${event.slug}/toggle" class="inline">
        <input type="hidden" name="code" value="${s.code}">
        <input type="hidden" name="return_to" value="${returnTo}">
        <div class="actions">
          <button type="submit" class="${starred ? '' : 'secondary'}">
            ${starred ? 'Remove from my schedule' : 'Add to my schedule'}
          </button>
        </div>
      </form>
    </div>`;
}

function toggleItinerary(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const code = ctx.fields.require('code', 'the session code, e.g. SESS-3').toUpperCase();

  const exists = publicSessions(ctx.db, event.id).some((s) => s.code === code);
  if (!exists) {
    throw badRequest(`no published session '${code}'`, `browse them at /sessions/${event.slug}`);
  }

  const current = itineraryCodes(ctx.cookies, event.slug);
  const next = current.includes(code)
    ? current.filter((c) => c !== code)
    : [...current, code];

  const back = ctx.fields.get('return_to') || `/schedule/${event.slug}`;
  return redirect(back, {
    headers: {
      'set-cookie': cookieHeader(`${ITINERARY_COOKIE}_${event.slug}`, next.join(','),
        { maxAge: 60 * 60 * 24 * 180 }),
    },
  });
}

function myItinerary(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const mine = itineraryCodes(ctx.cookies, event.slug);
  const sessions = publicSessions(ctx.db, event.id)
    .filter((s) => mine.includes(s.code))
    .map((s) => ({ ...s, speakers: speakersOf(ctx.db, s.id) }));

  return ok(page({
    title: `My schedule - ${event.name}`,
    nav: publicNav(event, 'Itinerary'),
    body: html`
      <p class="sub"><a href="/schedule/${event.slug}">&larr; Full schedule</a></p>
      <h1>My schedule</h1>
      <p class="sub">${sessions.length} session${sessions.length === 1 ? '' : 's'}, in time order.
        Kept in this browser, so it survives a reload without an account.</p>

      ${sessions.length === 0
        ? empty('You have not added anything yet. Star a session on the schedule.')
        : html`
          <p><a class="button" href="/schedule/${event.slug}/mine.ics">Download as a calendar file</a></p>
          <div class="stack">
            ${sessions.map((s) => sessionCard(ctx, event, s, true, `/schedule/${event.slug}/mine`))}
          </div>`}
    `,
  }));
}

function myItineraryIcs(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const mine = itineraryCodes(ctx.cookies, event.slug);
  const sessions = publicSessions(ctx.db, event.id).filter((s) => mine.includes(s.code) && s.starts_at);

  // One VCALENDAR holding every starred session, so importing it is one action
  // rather than one per talk.
  const events = sessions.map((s) => buildIcs({
    uid: uidFor(event.slug, s.code),
    title: `${s.title} (${event.name})`,
    description: s.description,
    location: [s.room_name, event.location].filter(Boolean).join(', '),
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    url: event.website_url,
  }));

  const merged = events.length === 0
    ? buildIcsShell()
    : events[0].replace(/END:VCALENDAR\r\n$/,
      events.slice(1).map(extractVevent).join('') + 'END:VCALENDAR\r\n');

  return {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${event.slug}-my-schedule.ics"`,
    },
    body: merged,
  };
}

function extractVevent(ics) {
  const start = ics.indexOf('BEGIN:VEVENT');
  const end = ics.indexOf('END:VEVENT') + 'END:VEVENT\r\n'.length;
  return ics.slice(start, end);
}

function buildIcsShell() {
  return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//conference management//EN\r\nEND:VCALENDAR\r\n';
}

// --- gallery ---------------------------------------------------------------

function galleryView(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const all = publicSpeakers(ctx.db, event.id);
  const query = (ctx.query.get('q') ?? '').trim().toLowerCase();
  const results = query ? all.filter((p) => fullName(p).toLowerCase().includes(query)) : all;

  return ok(page({
    title: `Speaker gallery - ${event.name}`,
    nav: publicNav(event, 'Gallery'),
    wide: true,
    body: html`
      <h1>Speaker gallery</h1>
      <p class="sub">${results.length} of ${all.length} speakers.</p>

      <form method="get" class="row" style="margin-bottom:1.5rem">
        <div>
          <label for="q">Search by name</label>
          <input type="text" id="q" name="q" value="${ctx.query.get('q') ?? ''}">
        </div>
        <div style="flex:0 0 auto">
          <button type="submit">Search</button>
          <a class="button secondary" href="/gallery/${event.slug}">Clear</a>
        </div>
      </form>

      ${results.length === 0 ? empty('Nobody matches that search.') : html`
        <div class="cards">
          ${results.map((p) => html`
            <div class="card" style="text-align:center">
              <a href="/gallery/${event.slug}/${p.slug}">
                ${p.headshot
                  ? html`<img src="/files/${p.headshot}" alt="${fullName(p)}"
                      style="width:7rem;height:7rem;object-fit:cover;border-radius:50%">`
                  : html`<span class="pill draft" style="display:inline-block;width:7rem;height:7rem;
                      line-height:7rem;border-radius:50%">No photo</span>`}
              </a>
              <p style="margin:.5rem 0 0"><strong>
                <a href="/gallery/${event.slug}/${p.slug}">${fullName(p)}</a></strong></p>
              <p class="muted" style="margin:.15rem 0 0">${p.job_title}</p>
              <p class="muted" style="margin:0">${p.company}</p>
            </div>`)}
        </div>`}
    `,
  }));
}

function galleryDetail(ctx) {
  const event = publicEvent(ctx.db, ctx.params.event);
  const person = findPublicSpeaker(ctx, event, ctx.params.person);
  const sessions = sessionsBySpeaker(ctx, event, person.slug);

  return ok(page({
    title: `${fullName(person)} - ${event.name}`,
    nav: publicNav(event, 'Gallery'),
    body: html`
      <p class="sub"><a href="/gallery/${event.slug}">&larr; Back to the gallery</a></p>
      ${person.headshot ? html`<p><img src="/files/${person.headshot}" alt="${fullName(person)}"
        style="width:9rem;height:9rem;object-fit:cover;border-radius:50%"></p>` : ''}
      <h1>${fullName(person)}</h1>
      ${person.job_title ? html`<p class="sub">${person.job_title}</p>` : ''}
      ${person.company ? html`<p class="sub">${person.company}</p>` : ''}
      ${description(person.biography, { limit: 220 })}

      <h2>Sessions (${sessions.length})</h2>
      ${sessions.length === 0 ? empty('No sessions listed yet.') : html`
        <table><tbody>
          ${sessions.map((s) => html`
            <tr>
              <td><a href="/sessions/${event.slug}/${s.code}"><strong>${s.title}</strong></a></td>
              <td>${whenLine(s, event)}</td>
              <td>${s.room_name ?? ''}</td>
            </tr>`)}
        </tbody></table>`}
    `,
  }));
}
