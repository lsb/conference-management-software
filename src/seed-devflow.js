// Build the DevFlow Conf 2027 fixture.
//
//   npm run seed:devflow                  # into data/conference.db
//   npm run seed:devflow /tmp/demo.db     # or anywhere else
//
// Unlike `npm run seed`, this one is additive: it removes and rebuilds its own
// event and leaves everything else -- both Manzanita conferences, their people,
// their outbox -- exactly where it was. Two events from two different seeds
// living side by side is the point: multi-event support is only demonstrated by
// an instance that actually holds more than one conference.
//
// DevFlow is deliberately empty of submissions. Its call for papers is open and
// its vocabulary is complete, so the interesting thing -- a stranger filling in
// the form and coming out the other side as a speaker with a portal -- happens
// live rather than having been done for them.
//
// Run order matters only in that `npm run seed` wipes the whole database, so it
// goes first:
//
//   npm run seed && npm run seed:devflow

import { DEFAULT_DB_PATH, openDatabase, now, uniqueSlug } from './db.js';
import { localDay } from './core/schedule.js';

// ---------------------------------------------------------------------------
// A virtual clock
//
// Same device, and for the same reason, as src/seed.js: every insert stamps its
// row with db.js's now(), which reads the wall clock, so two runs an hour apart
// would produce two different databases. at() moves the clock to a moment in
// this conference's story and each read advances it a second, which keeps rows
// written in one step in the order they happened and keeps every run identical.
//
// "Today", for everything this data implies, is 8 August 2026: the same today
// src/seed.js uses, so the two events agree about when now is.
// ---------------------------------------------------------------------------

const TODAY = '2026-08-08T17:00:00Z';

const RealDate = Date;
let clock = RealDate.parse(TODAY);

globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(clock);
      clock += 1000;
    } else {
      super(...args);
    }
  }

  static now() {
    const t = clock;
    clock += 1000;
    return t;
  }
};

/** Run `fn` as if it were `iso`. */
function at(iso, fn) {
  clock = RealDate.parse(iso);
  return fn();
}

/**
 * A wall-clock time in San Francisco, as the UTC string the schema stores.
 *
 * Every date here falls between March and November, when America/Los_Angeles is
 * PDT (UTC-7) without exception, so a fixed offset is honest and no timezone
 * library is needed. `event.timezone` is what the UI formats with.
 */
function pdt(day, time) {
  const [h, m] = time.split(':').map(Number);
  const ms = RealDate.parse(`${day}T00:00:00Z`) + (h + 7) * 3_600_000 + m * 60_000;
  return new RealDate(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const DB_PATH = process.argv[2] ?? DEFAULT_DB_PATH;
const db = openDatabase(DB_PATH);

const EVENT_SLUG = 'devflow-2027';
const FORM_SLUG = 'cfp-2027';

// ---------------------------------------------------------------------------
// Insert helpers
//
// Literal SQL, one small function per table, in the style of src/seed.js and
// test/helpers.js. No query builder: what is written is what runs.
// ---------------------------------------------------------------------------

function addEvent({ slug, name, website, location, startsAt, endsAt, description }) {
  const t = now();
  return db.prepare(
    `INSERT INTO event (slug, name, event_type, website_url, location, timezone,
                        starts_at, ends_at, description, created_at, updated_at)
     VALUES (?, ?, 'Conference', ?, ?, 'America/Los_Angeles', ?, ?, ?, ?, ?)
     RETURNING *`,
  ).get(slug, name, website, location, startsAt, endsAt, description, t, t);
}

/**
 * One person row per human, found by email.
 *
 * `person` is global across events by design, so this seed must never insert a
 * second row for somebody `npm run seed` already created, and must survive being
 * run twice without duplicating its own four. Email is the identity, exactly as
 * it is on the public call-for-papers form.
 */
function upsertPerson({ first, last, email, jobTitle = '', company = '',
  pronouns = '', biography = '', linkedin = '', x = '', website = '' }) {
  const t = now();
  const existing = db.prepare('SELECT * FROM person WHERE email = ? COLLATE NOCASE').get(email);

  if (existing) {
    return db.prepare(
      `UPDATE person SET first_name = ?, last_name = ?, job_title = ?, company = ?,
                         pronouns = ?, biography = ?, link_linkedin = ?, link_x = ?,
                         link_website = ?, updated_at = ?
        WHERE id = ? RETURNING *`,
    ).get(first, last, jobTitle, company, pronouns, biography, linkedin, x, website, t, existing.id);
  }

  const slug = uniqueSlug(`${first} ${last}`,
    (s) => Boolean(db.prepare('SELECT 1 FROM person WHERE slug = ?').get(s)));

  return db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, job_title, company,
                         pronouns, biography, link_linkedin, link_x, link_website,
                         created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(slug, email, first, last, jobTitle, company, pronouns, biography,
    linkedin, x, website, t, t);
}

function addMembership(eventId, personId, role) {
  db.prepare('INSERT INTO event_membership (event_id, person_id, role) VALUES (?, ?, ?)')
    .run(eventId, personId, role);
}

function addTrack(eventId, slug, name, color, order) {
  return db.prepare(
    `INSERT INTO track (event_id, slug, name, color, sort_order)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, slug, name, color, order);
}

function addRoom(eventId, slug, name, capacity, order) {
  return db.prepare(
    `INSERT INTO room (event_id, slug, name, capacity, sort_order)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, slug, name, capacity, order);
}

function addOption(eventId, kind, slug, label, order) {
  return db.prepare(
    `INSERT INTO taxonomy_option (event_id, kind, slug, label, sort_order)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, kind, slug, label, order);
}

function addForm(eventId, f) {
  const t = now();
  return db.prepare(
    `INSERT INTO form (event_id, slug, kind, internal_name, external_title, page_heading,
                       welcome_message, collect_participants, close_at, submission_limit,
                       allow_multiple_drafts, auto_redirect_to_portal, success_message,
                       send_confirmation_email, confirmation_email_body, created_at, updated_at)
     VALUES (?, ?, 'submission', ?, ?, ?, ?, 1, ?, ?, 0, 1, ?, 1, '', ?, ?) RETURNING *`,
  ).get(eventId, f.slug, f.internalName, f.externalTitle, f.pageHeading, f.welcomeMessage,
    f.closeAt, f.submissionLimit ?? null, f.successMessage, t, t);
}

function addField(formId, f) {
  return db.prepare(
    `INSERT INTO form_field (form_id, section, slug, label, help_text, field_type,
                             options_kind, maps_to, required, locked, max_chars, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(formId, f.section, f.slug, f.label, f.help ?? '', f.type, f.optionsKind ?? null,
    f.mapsTo ?? null, f.required ?? 0, f.locked ?? 0, f.maxChars ?? null, f.order);
}

/**
 * Remove a previous run of this seed.
 *
 * Everything DevFlow owns hangs off its event row by a cascading foreign key, so
 * deleting the event takes its tracks, rooms, taxonomy, form, fields and
 * memberships with it. People are deliberately left alone: they are global, they
 * are shared with any other event they turn up at, and upsertPerson updates them
 * in place, so re-running this script neither duplicates nor orphans a human.
 */
function removePreviousRun() {
  db.prepare('DELETE FROM event WHERE slug = ?').run(EVENT_SLUG);
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

db.exec('BEGIN');

try {
  removePreviousRun();

  // -------------------------------------------------------------------------
  // People
  //
  // Four humans, one row each, every address @example.com -- the domain reserved
  // for exactly this, which can never reach a real inbox by accident.
  //
  // Two of these names already exist at Manzanita as different people (a
  // different Priya, a different Marcus, a second Sam Whitfield). That is the
  // realistic case, not a mistake to seed around: the address is the identity,
  // and src/routes/demo-auth.js is where the consequences of that are handled.
  // -------------------------------------------------------------------------

  const p = at('2026-06-01T16:00:00Z', () => ({
    jordan: upsertPerson({
      first: 'Jordan', last: 'Alvarez', email: 'sbek-organizer@example.com',
      jobTitle: 'Event Organizer', company: 'Admin', pronouns: 'they/them',
      biography: 'Jordan chairs DevFlow and has run it since it was a single-track day in a borrowed lecture hall. They do the schedule, the budget, and the apologising.',
    }),
    priya: upsertPerson({
      first: 'Priya', last: 'Raman', email: 'sbek-speaker@example.com',
      jobTitle: 'Principal Engineer', company: 'Latticework Systems', pronouns: 'she/her',
      biography: 'Priya is a principal engineer at Latticework Systems, where she looks after the build and release path for around two thousand engineers. She has spent the last three years making a fifty-minute CI pipeline into a four-minute one, and is candid about which of those minutes were the hard ones.',
      x: 'https://x.com/priyabuilds',
    }),
    marcus: upsertPerson({
      first: 'Marcus', last: 'Okafor', email: 'sbek-speaker2@example.com',
      jobTitle: 'Staff Developer Advocate', company: 'Cloudreach Labs', pronouns: 'he/him',
      biography: 'Marcus is a staff developer advocate at Cloudreach Labs and a former platform engineer, which is why his talks tend to include the pager rotation as well as the architecture diagram. He writes about developer experience and reviews far too many internal RFCs.',
    }),
    sam: upsertPerson({
      first: 'Sam', last: 'Whitfield', email: 'sbek-reviewer@example.com',
      jobTitle: 'Program Committee Reviewer', company: '', pronouns: 'they/them',
      biography: 'Sam sits on the DevFlow program committee. They read proposals on the train and argue for the ones nobody else championed.',
    }),
  }));

  // -------------------------------------------------------------------------
  // The event and its vocabulary
  // -------------------------------------------------------------------------

  const event = at('2026-06-15T17:00:00Z', () => addEvent({
    slug: EVENT_SLUG,
    name: 'DevFlow Conf 2027',
    website: 'https://devflow.example.com',
    location: 'Moscone West, San Francisco, CA',
    startsAt: pdt('2027-05-12', '09:00'),
    endsAt: pdt('2027-05-14', '17:30'),
    description: 'The developer workflow conference. Three days on the tools, platforms and habits that decide how quickly an idea becomes something running in production.',
  }));

  const track = {};
  const room = {};
  const option = {};   // keyed 'kind:slug', because that is how a form field looks one up

  at('2026-06-15T17:30:00Z', () => {
    addMembership(event.id, p.jordan.id, 'owner');
    addMembership(event.id, p.sam.id, 'reviewer');

    const tracks = [
      ['ai-engineering', 'AI Engineering', '#2f6f4e'],
      ['platform-infra', 'Platform & Infra', '#365d9b'],
      ['developer-experience', 'Developer Experience', '#6b4b9a'],
    ];
    tracks.forEach(([slug, name, color], i) => { track[slug] = addTrack(event.id, slug, name, color, i + 1); });

    // Capacities are real numbers the conflict view and the workshop cap read.
    const rooms = [
      ['main-stage', 'Main Stage', 900],
      ['room-2a', 'Room 2A', 220],
      ['room-2b', 'Room 2B', 220],
      ['workshop-lab', 'Workshop Lab', 40],
    ];
    rooms.forEach(([slug, name, capacity], i) => { room[slug] = addRoom(event.id, slug, name, capacity, i + 1); });

    // Formats carry their length in the label because that is the only place a
    // submitter sees it, and choosing a format is choosing how long you talk for.
    const options = [
      ['format', 'keynote', 'Keynote (45 min)'],
      ['format', 'talk', 'Talk (30 min)'],
      ['format', 'lightning-talk', 'Lightning Talk (10 min)'],
      ['format', 'workshop', 'Workshop (120 min)'],
      ['format', 'panel', 'Panel (45 min)'],
      ['level', 'beginner', 'Beginner'],
      ['level', 'intermediate', 'Intermediate'],
      ['level', 'advanced', 'Advanced'],
      ['language', 'english', 'English'],
    ];
    const seen = {};
    for (const [kind, slug, label] of options) {
      seen[kind] = (seen[kind] ?? 0) + 1;
      option[`${kind}:${slug}`] = addOption(event.id, kind, slug, label, seen[kind]);
    }

  });

  // -------------------------------------------------------------------------
  // The call for papers
  //
  // Open, and open for a long time: it closes on 30 April 2027, a fortnight
  // before the doors. Locked fields carry a `maps_to` and land on a column;
  // everything else would be a custom question, and this form has none, because
  // every answer on it is something the rest of the app needs to be able to read.
  //
  // Help text sits inside the <label> element, so it is part of the accessible
  // name of every field. That is deliberate: it is what lets somebody -- or
  // something -- looking for "Description" find the field labelled "Abstract".
  // -------------------------------------------------------------------------

  const form = at('2026-07-01T16:00:00Z', () => addForm(event.id, {
    slug: FORM_SLUG,
    internalName: 'DevFlow Conf 2027 call for papers',
    externalTitle: 'DevFlow Conf 2027 Call for Papers',
    pageHeading: 'Submit a talk to DevFlow Conf 2027',
    welcomeMessage:
      'DevFlow is about the developer workflow: the tools, the platforms and the habits between an idea and something running in production.\n\n'
      + 'We want talks from people who have built and operated the thing they are describing. Submissions close on 30 April 2027 and every submitter hears back either way.',
    closeAt: pdt('2027-04-30', '23:59'),
    successMessage:
      'That is in. We have emailed you a copy, and your speaker portal is where you can follow it from here.',
  }));

  at('2026-07-01T16:20:00Z', () => {
    const abstract = [
      { slug: 'title', label: 'Title', type: 'text', mapsTo: 'submission.title',
        required: 1, locked: 1, maxChars: 200,
        help: 'The title as it should appear in the programme.' },
      { slug: 'description', label: 'Abstract', type: 'textarea',
        mapsTo: 'submission.description', required: 1, maxChars: 5000,
        help: 'A description of the talk. What will somebody be able to do afterwards that they could not before?' },
      // See the tag mirror above for why a track dropdown declares 'tag'.
      { slug: 'track', label: 'Track', type: 'select', optionsKind: 'tag',
        mapsTo: 'submission.track_id', required: 1,
        help: 'Which of the three tracks this belongs in.' },
      { slug: 'format', label: 'Format', type: 'select', optionsKind: 'format',
        mapsTo: 'submission.format_option_id', required: 1,
        help: 'How long you want, and in what shape.' },
      { slug: 'level', label: 'Audience level', type: 'select', optionsKind: 'level',
        mapsTo: 'submission.level_option_id',
        help: 'Who this is pitched at. Optional.' },
    ];
    abstract.forEach((f, i) => addField(form.id, { ...f, section: 'abstract', order: i + 1 }));

    const participant = [
      { slug: 'first-name', label: 'First name', type: 'text', mapsTo: 'person.first_name',
        required: 1, locked: 1 },
      { slug: 'last-name', label: 'Last name', type: 'text', mapsTo: 'person.last_name',
        required: 1, locked: 1 },
      { slug: 'email', label: 'Email', type: 'email', mapsTo: 'person.email',
        required: 1, locked: 1,
        help: 'Your email address. It identifies you across events and is where your portal link goes.' },
      { slug: 'biography', label: 'Speaker bio', type: 'textarea', mapsTo: 'person.biography',
        maxChars: 1200,
        help: 'A short biography for the programme and the website.' },
    ];
    participant.forEach((f, i) => addField(form.id, { ...f, section: 'participant', order: i + 1 }));
  });

  clock = RealDate.parse(TODAY);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

// ---------------------------------------------------------------------------
// Summary
//
// Read back out of the database rather than counted while writing it, so if this
// script and the schema ever disagree, this is where it shows.
// ---------------------------------------------------------------------------

const event = db.prepare('SELECT * FROM event WHERE slug = ?').get(EVENT_SLUG);
const form = db.prepare('SELECT * FROM form WHERE event_id = ? AND slug = ?')
  .get(event.id, FORM_SLUG);

const labels = (sql, ...args) => db.prepare(sql).all(...args).map((r) => r.label).join(', ');

const broken = db.prepare('PRAGMA foreign_key_check').all();
if (broken.length > 0) throw new Error(`seed left ${broken.length} broken foreign key reference(s)`);

const pad = (s) => String(s).padEnd(16);
// Dates are stored in UTC and read in San Francisco, where the last afternoon and
// the closing minute of the call both fall on the day before their UTC one.
const day = (iso) => localDay(iso, event.timezone);

console.log(`\n${event.name} seeded into ${DB_PATH}\n`);
console.log(`  ${pad('event')}${event.slug}, ${day(event.starts_at)} to ${day(event.ends_at)}, ${event.location}`);
console.log(`  ${pad('tracks')}${labels(
  'SELECT name AS label FROM track WHERE event_id = ? ORDER BY sort_order', event.id)}`);
console.log(`  ${pad('formats')}${labels(
  `SELECT label FROM taxonomy_option WHERE event_id = ? AND kind = 'format' ORDER BY sort_order`, event.id)}`);
console.log(`  ${pad('rooms')}${labels(
  'SELECT name AS label FROM room WHERE event_id = ? ORDER BY sort_order', event.id)}`);
console.log(`  ${pad('levels')}${labels(
  `SELECT label FROM taxonomy_option WHERE event_id = ? AND kind = 'level' ORDER BY sort_order`, event.id)}`);
console.log(`  ${pad('call for papers')}open until ${day(form.close_at)}, ${db.prepare(
  'SELECT count(*) AS n FROM form_field WHERE form_id = ?').get(form.id).n} questions`);
console.log(`  ${pad('submissions')}${db.prepare(
  'SELECT count(*) AS n FROM submission WHERE event_id = ?').get(event.id).n
} -- the proposals are meant to be submitted through the form, not seeded`);

console.log(`\n  Public call for papers   /submit/${event.slug}/${form.slug}`);
console.log(`  One-click sign-in        /login\n`);

for (const row of db.prepare(
  `SELECT p.first_name || ' ' || p.last_name AS name, p.email,
          COALESCE(m.role, 'speaker') AS role
     FROM person p
     LEFT JOIN event_membership m ON m.person_id = p.id AND m.event_id = ?
    WHERE p.email IN ('sbek-organizer@example.com', 'sbek-speaker@example.com',
                      'sbek-speaker2@example.com', 'sbek-reviewer@example.com')
    ORDER BY CASE p.email
      WHEN 'sbek-organizer@example.com' THEN 1 WHEN 'sbek-speaker@example.com' THEN 2
      WHEN 'sbek-speaker2@example.com' THEN 3 ELSE 4 END`,
).all(event.id)) {
  console.log(`  ${pad(row.role)}${row.name.padEnd(16)}${row.email}`);
}

console.log(`\n  Also on this instance: ${db.prepare(
  'SELECT slug FROM event WHERE slug != ? ORDER BY starts_at DESC').all(event.slug)
  .map((e) => e.slug).join(', ') || 'nothing else yet'}\n`);

db.close();
