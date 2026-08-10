// Creating and configuring an event: its details, its rooms, its tracks, and
// the vocabulary its forms and its programme are built from.
//
// This is the first screen a new organizer meets and the one they return to
// least often, so it favours being obvious over being quick. Everything is a
// plain form; nothing is hidden behind a wizard step you cannot go back to.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, forbidden, notFound } from '../http/router.js';
import { now, uniqueSlug } from '../db.js';
import { findEvent, requireOrganizer, organizerNav, empty, tabs, dateOnly } from './shared.js';

const TAXONOMY_KINDS = ['format', 'level', 'language', 'tag'];

export function mountSetup(router) {
  router.get('/e/new', newEventForm, 'Create a new event.');
  router.post('/e/new', createEvent, 'Create an event. Body: name, starts_at, ends_at, location, timezone.');

  router.get('/e/:event/settings', settings,
    'Event details, rooms, tracks, and vocabulary.');
  router.post('/e/:event/settings', updateEvent,
    'Save event details.');

  router.post('/e/:event/settings/rooms', addRoom, 'Add a room. Body: name, capacity.');
  router.post('/e/:event/settings/rooms/:room/delete', deleteRoom, 'Remove a room.');
  router.post('/e/:event/settings/tracks', addTrack, 'Add a track. Body: name.');
  router.post('/e/:event/settings/tracks/:track/delete', deleteTrack, 'Remove a track.');
  router.post('/e/:event/settings/options', addOption,
    'Add a format, level, language, or tag. Body: kind, label.');
  router.post('/e/:event/settings/options/:kind/:option/delete', deleteOption,
    'Remove one of those.');
}

// --- creating --------------------------------------------------------------

/** The timezones offered. A short list beats a 400-entry dropdown nobody reads. */
const COMMON_TIMEZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'Europe/London', 'Europe/Berlin', 'Europe/Lisbon', 'UTC',
  'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
];

function newEventForm(ctx) {
  const existing = ctx.db.prepare('SELECT slug, name FROM event ORDER BY starts_at DESC').all();

  return ok(page({
    title: 'New event',
    body: html`
      <h1>New event</h1>
      <p class="sub">A conference, a summit, a single day of talks. You can run
        several at once, and speakers carry across all of them.</p>

      <form method="post" action="/e/new">
        <fieldset>
          <legend>The basics</legend>
          <label for="name">Name <span class="req">*</span>
            <small>What attendees will see, including the year.</small></label>
          <input type="text" id="name" name="name" required placeholder="DevFlow Conf 2027">

          <div class="row">
            <div><label for="starts_at">First day <span class="req">*</span></label>
              <input type="date" id="starts_at" name="starts_at" required></div>
            <div><label for="ends_at">Last day <span class="req">*</span></label>
              <input type="date" id="ends_at" name="ends_at" required></div>
            <div><label for="timezone">Timezone</label>
              <select id="timezone" name="timezone">
                ${COMMON_TIMEZONES.map((tz) => html`
                  <option value="${tz}" ${tz === 'America/Los_Angeles' ? raw('selected') : ''}>${tz}</option>`)}
              </select></div>
          </div>

          <div class="row">
            <div><label for="location">Location</label>
              <input type="text" id="location" name="location" placeholder="Moscone West, San Francisco, CA"></div>
            <div><label for="event_type">Type</label>
              <input type="text" id="event_type" name="event_type" value="Conference"></div>
            <div><label for="website_url">Website</label>
              <input type="url" id="website_url" name="website_url" placeholder="https://example.com"></div>
          </div>

          <label for="description">What is it about?</label>
          <textarea id="description" name="description"></textarea>
        </fieldset>

        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="with_defaults" value="1" checked>
          Start me off with the usual session formats and levels
        </label>

        <div class="actions"><button type="submit">Create event</button></div>
      </form>

      ${existing.length > 0 ? html`
        <h2>Existing events</h2>
        <ul>${existing.map((e) => html`<li><a href="/e/${e.slug}">${e.name}</a></li>`)}</ul>` : ''}
    `,
  }));
}

function createEvent(ctx) {
  // Somebody has to be signed in, for two reasons that point the same way. A
  // stranger who can reach the origin should not be able to fill the instance
  // with events; and an event created by nobody has no owner, so nobody can
  // ever administer it -- it is unreachable from the moment it exists. Being
  // signed in is the whole requirement: any speaker may propose a conference,
  // and whoever does becomes its owner below.
  if (!ctx.person) {
    throw forbidden('creating an event needs an account',
      'sign in at /login, or ask for a link at /portal/sign-in, then try again');
  }

  const name = ctx.fields.require('name', 'for example: DevFlow Conf 2027');
  const startsOn = ctx.fields.require('starts_at', 'the first day, as YYYY-MM-DD');
  const endsOn = ctx.fields.require('ends_at', 'the last day, as YYYY-MM-DD');

  if (endsOn < startsOn) {
    throw badRequest(`the last day (${endsOn}) is before the first (${startsOn})`,
      'swap them, or fix whichever is wrong');
  }

  const timezone = ctx.fields.get('timezone', 'UTC');
  const slug = uniqueSlug(name, (s) => ctx.db.prepare('SELECT 1 FROM event WHERE slug = ?').get(s));
  const t = now();

  const event = ctx.db.prepare(
    `INSERT INTO event (slug, name, event_type, website_url, location, timezone,
                        starts_at, ends_at, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(slug, name, ctx.fields.get('event_type', 'Conference'), ctx.fields.get('website_url'),
    ctx.fields.get('location'), timezone,
    `${startsOn}T00:00:00Z`, `${endsOn}T23:59:59Z`, ctx.fields.get('description'), t, t);

  // An event with no formats and no levels cannot have a usable submission form,
  // and making somebody type "Talk (30 min)" before they can do anything is a
  // poor first five minutes. All of it is editable and deletable.
  if (ctx.fields.bool('with_defaults')) {
    const defaults = [
      ['format', ['Keynote (45 min)', 'Talk (30 min)', 'Lightning Talk (10 min)',
        'Workshop (120 min)', 'Panel (45 min)']],
      ['level', ['Beginner', 'Intermediate', 'Advanced']],
      ['language', ['English']],
    ];
    for (const [kind, labels] of defaults) {
      labels.forEach((label, i) => insertOption(ctx.db, event.id, kind, label, i + 1));
    }
  }

  // Whoever created it can administer it. Without this, an event created off
  // loopback would be immediately unreachable by its own author.
  if (ctx.person) {
    ctx.db.prepare(
      `INSERT OR IGNORE INTO event_membership (event_id, person_id, role) VALUES (?, ?, 'owner')`,
    ).run(event.id, ctx.person.id);
  }

  return redirect(`/e/${event.slug}/settings?created=1`);
}

// --- configuring -----------------------------------------------------------

function insertOption(db, eventId, kind, label, sortOrder) {
  const slug = uniqueSlug(label, (s) => db.prepare(
    'SELECT 1 FROM taxonomy_option WHERE event_id = ? AND kind = ? AND slug = ?').get(eventId, kind, s));
  return db.prepare(
    `INSERT INTO taxonomy_option (event_id, kind, slug, label, sort_order)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, kind, slug, label, sortOrder);
}

function settings(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const rooms = ctx.db.prepare(
    `SELECT r.*, (SELECT count(*) FROM submission s WHERE s.room_id = r.id) AS scheduled
       FROM room r WHERE r.event_id = ? ORDER BY r.sort_order, r.name`,
  ).all(event.id);

  const tracks = ctx.db.prepare(
    `SELECT t.*, (SELECT count(*) FROM submission s WHERE s.track_id = t.id) AS used
       FROM track t WHERE t.event_id = ? ORDER BY t.sort_order, t.name`,
  ).all(event.id);

  const options = Object.fromEntries(TAXONOMY_KINDS.map((kind) => [kind,
    ctx.db.prepare('SELECT * FROM taxonomy_option WHERE event_id = ? AND kind = ? ORDER BY sort_order, label')
      .all(event.id, kind)]));

  const created = ctx.query.get('created');
  const day = (iso) => (iso ?? '').slice(0, 10);

  return ok(page({
    title: `Settings - ${event.name}`,
    nav: organizerNav(event, 'Settings'),
    wide: true,
    body: html`
      <h1>Settings</h1>
      <p class="sub">Everything the rest of the event is built from.</p>
      ${created ? html`<p class="flash">Event created. Add your rooms and tracks below,
        then build a <a href="/e/${event.slug}/forms">call for speakers</a>.</p>` : ''}

      <h2>Details</h2>
      <form method="post" action="/e/${event.slug}/settings">
        <div class="row">
          <div><label for="name">Name</label>
            <input type="text" id="name" name="name" value="${event.name}" required></div>
          <div><label for="event_type">Type</label>
            <input type="text" id="event_type" name="event_type" value="${event.event_type}"></div>
        </div>
        <div class="row">
          <div><label for="starts_at">First day</label>
            <input type="date" id="starts_at" name="starts_at" value="${day(event.starts_at)}"></div>
          <div><label for="ends_at">Last day</label>
            <input type="date" id="ends_at" name="ends_at" value="${day(event.ends_at)}"></div>
          <div><label for="timezone">Timezone</label>
            <select id="timezone" name="timezone">
              ${[...new Set([event.timezone, ...COMMON_TIMEZONES])].map((tz) => html`
                <option value="${tz}" ${tz === event.timezone ? raw('selected') : ''}>${tz}</option>`)}
            </select></div>
        </div>
        <div class="row">
          <div><label for="location">Location</label>
            <input type="text" id="location" name="location" value="${event.location}"></div>
          <div><label for="website_url">Website</label>
            <input type="url" id="website_url" name="website_url" value="${event.website_url}"></div>
        </div>
        <label for="description">About</label>
        <textarea id="description" name="description">${event.description}</textarea>
        <div class="actions"><button type="submit">Save details</button></div>
      </form>

      <h2>Rooms</h2>
      <p class="sub">Conflict detection reads these: one session per room at a time.</p>
      ${rooms.length === 0 ? empty('No rooms yet. Sessions cannot be scheduled without one.') : html`
        <table>
          <thead><tr><th>Room</th><th class="num">Seats</th><th class="num">Scheduled</th><th></th></tr></thead>
          <tbody>
            ${rooms.map((r) => html`
              <tr>
                <td>${r.name} <code class="muted">${r.slug}</code></td>
                <td class="num">${r.capacity ?? html`<span class="muted">-</span>`}</td>
                <td class="num">${r.scheduled}</td>
                <td>${r.scheduled === 0 ? html`
                  <form method="post" class="inline"
                        action="/e/${event.slug}/settings/rooms/${r.slug}/delete">
                    <button type="submit" class="secondary">Remove</button>
                  </form>` : html`<span class="muted">in use</span>`}</td>
              </tr>`)}
          </tbody>
        </table>`}
      <form method="post" action="/e/${event.slug}/settings/rooms" class="row">
        <div><label for="room_name">Add a room</label>
          <input type="text" id="room_name" name="name" required placeholder="Main Stage"></div>
        <div><label for="room_capacity">Seats <small>optional</small></label>
          <input type="number" id="room_capacity" name="capacity" min="1"></div>
        <div style="flex:0 0 auto"><button type="submit">Add room</button></div>
      </form>

      <h2>Tracks</h2>
      <p class="sub">Parallel streams an attendee follows through the programme.</p>
      ${tracks.length === 0 ? empty('No tracks yet.') : html`
        <table>
          <thead><tr><th>Track</th><th class="num">Submissions</th><th></th></tr></thead>
          <tbody>
            ${tracks.map((t) => html`
              <tr>
                <td>${t.name} <code class="muted">${t.slug}</code></td>
                <td class="num">${t.used}</td>
                <td>${t.used === 0 ? html`
                  <form method="post" class="inline"
                        action="/e/${event.slug}/settings/tracks/${t.slug}/delete">
                    <button type="submit" class="secondary">Remove</button>
                  </form>` : html`<span class="muted">in use</span>`}</td>
              </tr>`)}
          </tbody>
        </table>`}
      <form method="post" action="/e/${event.slug}/settings/tracks" class="row">
        <div><label for="track_name">Add a track</label>
          <input type="text" id="track_name" name="name" required placeholder="AI Engineering"></div>
        <div style="flex:0 0 auto"><button type="submit">Add track</button></div>
      </form>

      <h2>Vocabulary</h2>
      <p class="sub">The dropdowns your submission forms offer.</p>
      <div class="grid2">
        ${TAXONOMY_KINDS.map((kind) => html`
          <div>
            <h3 style="text-transform:capitalize">${kind}s</h3>
            ${options[kind].length === 0 ? html`<p class="muted">None yet.</p>` : html`
              <table><tbody>
                ${options[kind].map((o) => html`
                  <tr>
                    <td>${o.label}</td>
                    <td><form method="post" class="inline"
                          action="/e/${event.slug}/settings/options/${kind}/${o.slug}/delete">
                      <button type="submit" class="secondary">Remove</button>
                    </form></td>
                  </tr>`)}
              </tbody></table>`}
            <form method="post" action="/e/${event.slug}/settings/options" class="row">
              <input type="hidden" name="kind" value="${kind}">
              <div><input type="text" name="label" required
                     aria-label="New ${kind}" placeholder="New ${kind}"></div>
              <div style="flex:0 0 auto"><button type="submit">Add</button></div>
            </form>
          </div>`)}
      </div>
    `,
  }));
}

function updateEvent(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const startsOn = ctx.fields.get('starts_at');
  const endsOn = ctx.fields.get('ends_at');
  if (startsOn && endsOn && endsOn < startsOn) {
    throw badRequest(`the last day (${endsOn}) is before the first (${startsOn})`);
  }

  ctx.db.prepare(
    `UPDATE event SET name = ?, event_type = ?, website_url = ?, location = ?,
                      timezone = ?, starts_at = ?, ends_at = ?, description = ?, updated_at = ?
      WHERE id = ?`,
  ).run(ctx.fields.require('name'), ctx.fields.get('event_type', event.event_type),
    ctx.fields.get('website_url'), ctx.fields.get('location'),
    ctx.fields.get('timezone', event.timezone),
    startsOn ? `${startsOn}T00:00:00Z` : event.starts_at,
    endsOn ? `${endsOn}T23:59:59Z` : event.ends_at,
    ctx.fields.get('description'), now(), event.id);

  return redirect(`/e/${event.slug}/settings`);
}

function addRoom(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const name = ctx.fields.require('name', 'for example: Main Stage');
  const slug = uniqueSlug(name, (s) => ctx.db.prepare(
    'SELECT 1 FROM room WHERE event_id = ? AND slug = ?').get(event.id, s));
  const order = ctx.db.prepare('SELECT count(*) AS n FROM room WHERE event_id = ?').get(event.id).n;

  ctx.db.prepare(
    'INSERT INTO room (event_id, slug, name, capacity, sort_order) VALUES (?, ?, ?, ?, ?)',
  ).run(event.id, slug, name, ctx.fields.int('capacity', null), order + 1);

  return redirect(`/e/${event.slug}/settings`);
}

/**
 * Remove a room, refusing while sessions sit in it.
 *
 * Deleting it would set those sessions' room to NULL and quietly unschedule
 * them, which is a worse outcome than being told no.
 */
function deleteRoom(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const room = ctx.db.prepare('SELECT * FROM room WHERE event_id = ? AND slug = ?')
    .get(event.id, ctx.params.room);
  if (!room) throw notFound(`no room '${ctx.params.room}'`);

  const { n } = ctx.db.prepare('SELECT count(*) AS n FROM submission WHERE room_id = ?').get(room.id);
  if (n > 0) {
    throw badRequest(`${room.name} still holds ${n} session${n === 1 ? '' : 's'}`,
      'move them to another room first, or they would silently lose their slot');
  }

  ctx.db.prepare('DELETE FROM room WHERE id = ?').run(room.id);
  return redirect(`/e/${event.slug}/settings`);
}

function addTrack(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const name = ctx.fields.require('name', 'for example: AI Engineering');
  const slug = uniqueSlug(name, (s) => ctx.db.prepare(
    'SELECT 1 FROM track WHERE event_id = ? AND slug = ?').get(event.id, s));
  const order = ctx.db.prepare('SELECT count(*) AS n FROM track WHERE event_id = ?').get(event.id).n;

  ctx.db.prepare(
    'INSERT INTO track (event_id, slug, name, color, sort_order) VALUES (?, ?, ?, \'\', ?)',
  ).run(event.id, slug, name, order + 1);

  return redirect(`/e/${event.slug}/settings`);
}

function deleteTrack(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const track = ctx.db.prepare('SELECT * FROM track WHERE event_id = ? AND slug = ?')
    .get(event.id, ctx.params.track);
  if (!track) throw notFound(`no track '${ctx.params.track}'`);

  const { n } = ctx.db.prepare('SELECT count(*) AS n FROM submission WHERE track_id = ?').get(track.id);
  if (n > 0) {
    throw badRequest(`${track.name} still has ${n} submission${n === 1 ? '' : 's'} on it`,
      'move them to another track first');
  }

  ctx.db.prepare('DELETE FROM track WHERE id = ?').run(track.id);
  return redirect(`/e/${event.slug}/settings`);
}

function addOption(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const kind = ctx.fields.choice('kind', TAXONOMY_KINDS);
  const order = ctx.db.prepare(
    'SELECT count(*) AS n FROM taxonomy_option WHERE event_id = ? AND kind = ?').get(event.id, kind).n;

  insertOption(ctx.db, event.id, kind, ctx.fields.require('label'), order + 1);
  return redirect(`/e/${event.slug}/settings`);
}

function deleteOption(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const kind = ctx.params.kind;
  if (!TAXONOMY_KINDS.includes(kind)) {
    throw badRequest(`unknown kind '${kind}'`, `use one of: ${TAXONOMY_KINDS.join(', ')}`);
  }

  const option = ctx.db.prepare(
    'SELECT * FROM taxonomy_option WHERE event_id = ? AND kind = ? AND slug = ?',
  ).get(event.id, kind, ctx.params.option);
  if (!option) throw notFound(`no ${kind} '${ctx.params.option}'`);

  ctx.db.prepare('DELETE FROM taxonomy_option WHERE id = ?').run(option.id);
  return redirect(`/e/${event.slug}/settings`);
}
