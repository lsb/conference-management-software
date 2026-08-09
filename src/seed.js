// Build the demo conference.
//
//   npm run seed                    # into data/conference.db
//   npm run seed /tmp/demo.db       # or anywhere else
//
// Two events. Manzanita 2026 is live: its call for speakers has closed, the
// programme committee has been through most of it, and a submission is sitting
// in every state the machine allows, so every organizer screen has something on
// it. Manzanita 2025 is over, which is what gives the multi-event speaker CRM a
// past to show -- two of this year's people were there last year.
//
// The data is written through the same functions the app uses -- createSubmission,
// decide, notify, assignTasksOnAccept, completeTask, queueEmail -- rather than by
// raw INSERT, so the activity log, the outbox and the task lists fill in the way
// they will in production. If a seeded row looks wrong, the app is wrong too.

import { DEFAULT_DB_PATH, openDatabase, now, uniqueSlug } from './db.js';
import { createSubmission, decide, notify, setStatus, logActivity } from './core/submissions.js';
import { completeTask } from './core/tasks.js';
import { queueEmail, getTemplate } from './core/mail.js';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UPLOAD_DIR } from './core/files.js';

// ---------------------------------------------------------------------------
// A virtual clock
//
// Every core function stamps its rows with db.js's now(), which reads the wall
// clock. A seed run at 09:14 would therefore differ from the same seed run at
// 09:15, and the evals diff against these rows. So for the length of this script
// the clock is virtual: at() moves it to a moment in the conference's story, and
// each read advances it a second, which keeps rows written in one step sorted in
// the order they happened without ever making two runs disagree.
//
// "Today", for everything this data implies, is 8 August 2026.
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
 * A wall-clock time in the venue's timezone, as the UTC string the schema stores.
 *
 * Both events run in October, when America/Los_Angeles is PDT (UTC-7) for every
 * day involved, so a fixed offset is honest here and a timezone library is not
 * needed. `event.timezone` is what the UI formats with.
 */
function pdt(day, time) {
  const [h, m] = time.split(':').map(Number);
  const ms = RealDate.parse(`${day}T00:00:00Z`) + (h + 7) * 3_600_000 + m * 60_000;
  return new RealDate(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function plusDays(iso, days) {
  return new RealDate(RealDate.parse(iso) + days * 86_400_000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Opening and emptying the database
// ---------------------------------------------------------------------------

const DB_PATH = process.argv[2] ?? DEFAULT_DB_PATH;
const db = openDatabase(DB_PATH);

/**
 * Empty every data table, leaving the schema and the migration log alone.
 *
 * Deleting just the demo events would not be enough. `person` is deliberately
 * global -- that is what makes the multi-event CRM work -- so last run's people
 * would survive, and the integer ids every other row is keyed by would drift.
 * A full wipe is what lets two consecutive runs produce the same database.
 *
 * Foreign keys go off for the duration because the order tables are emptied in
 * should not matter, and this is the one place in the app allowed to say that.
 */
function wipe() {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migration'
      ORDER BY name`,
  ).all().map((r) => r.name);

  db.exec('PRAGMA foreign_keys = OFF');
  for (const name of tables) db.exec(`DELETE FROM ${name}`);
  db.exec('PRAGMA foreign_keys = ON');
}

// ---------------------------------------------------------------------------
// Insert helpers
//
// Literal SQL, one small function per table, in the style of test/helpers.js.
// No query builder: what is written is what runs.
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

function addPerson({ first, last, email, pronouns = '', phone = '', biography = '',
  linkedin = '', x = '', website = '' }) {
  const t = now();
  const slug = uniqueSlug(`${first} ${last}`,
    (s) => Boolean(db.prepare('SELECT 1 FROM person WHERE slug = ?').get(s)));
  return db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, pronouns, phone, biography,
                         link_linkedin, link_x, link_website, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(slug, email, first, last, pronouns, phone, biography, linkedin, x, website, t, t);
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?) RETURNING *`,
  ).get(eventId, f.slug, f.kind ?? 'submission', f.internalName, f.externalTitle ?? '',
    f.pageHeading ?? '', f.welcomeMessage ?? '', f.collectParticipants ?? 1,
    f.closeAt ?? null, f.submissionLimit ?? null, f.allowMultipleDrafts ?? 0,
    f.autoRedirect ?? 1, f.successMessage ?? '', f.sendConfirmationEmail ?? 1, t, t);
}

function addField(formId, f) {
  return db.prepare(
    `INSERT INTO form_field (form_id, section, slug, label, help_text, field_type,
                             options_kind, maps_to, required, locked, max_chars, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(formId, f.section, f.slug, f.label, f.help ?? '', f.type, f.optionsKind ?? null,
    f.mapsTo ?? null, f.required ?? 0, f.locked ?? 0, f.maxChars ?? null, f.order);
}

function addCondition(fieldId, whenFieldId, operator, value) {
  db.prepare(
    `INSERT INTO form_field_condition (field_id, when_field_id, operator, value)
     VALUES (?, ?, ?, ?)`,
  ).run(fieldId, whenFieldId, operator, value);
}

function addCharLimit(formId, label, maxChars, fieldIds) {
  const limit = db.prepare(
    'INSERT INTO form_char_limit (form_id, label, max_chars) VALUES (?, ?, ?) RETURNING *',
  ).get(formId, label, maxChars);
  for (const id of fieldIds) {
    db.prepare('INSERT INTO form_char_limit_field (limit_id, field_id) VALUES (?, ?)')
      .run(limit.id, id);
  }
  return limit;
}

function addTaskDefinition(eventId, d) {
  return db.prepare(
    `INSERT INTO task_definition (event_id, slug, title, instructions, applies_to,
                                  requirement, form_id, due_at, required, assign_when, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'on_accept', ?) RETURNING *`,
  ).get(eventId, d.slug, d.title, d.instructions, d.appliesTo, d.requirement,
    d.formId ?? null, d.dueAt ?? null, d.required ?? 1, d.order);
}

function addTemplate(eventId, slug, name, subject, body) {
  const t = now();
  return db.prepare(
    `INSERT INTO email_template (event_id, slug, name, subject, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, slug, name, subject, body, t, t);
}

function addResourcePage(eventId, p) {
  const t = now();
  return db.prepare(
    `INSERT INTO resource_page (event_id, slug, title, body, published, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, p.slug, p.title, p.body, p.published ?? 1, p.order, t, t);
}

function addEmbed(eventId, e) {
  return db.prepare(
    `INSERT INTO embed (event_id, slug, name, feed, enabled, filter_track_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, e.slug, e.name, e.feed, e.enabled ?? 1, e.filterTrackId ?? null, now());
}

function addParticipant(submissionId, personId, { role = 'speaker', primary = false, order = 0 }) {
  db.prepare(
    `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(submissionId, personId, role, primary ? 1 : 0, order);
}

/**
 * A seeded file, with real bytes on disk.
 *
 * These used to be metadata-only rows, which meant the demo's speaker gallery
 * rendered a grid of broken images -- the sort of thing that is invisible in a
 * database and obvious to the first person who opens the page. Generated images
 * are deterministic (derived from the filename), so re-seeding produces
 * byte-identical files and the content hashes stay stable.
 */
function addFile(eventId, personId, { filename, contentType }) {
  const data = contentType.startsWith('image/')
    ? placeholderPng(filename)
    : Buffer.from(`Placeholder for ${filename}. Seeded demo data.\n`);

  const sha256 = createHash('sha256').update(data).digest('hex');
  const storagePath = join(sha256.slice(0, 2), sha256.slice(2));
  const absolute = join(UPLOAD_DIR, storagePath);
  if (!existsSync(absolute)) {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, data);
  }

  const slug = uniqueSlug(filename.replace(/\.[^.]+$/, ''),
    (s) => Boolean(db.prepare('SELECT 1 FROM file WHERE slug = ?').get(s)));

  return db.prepare(
    `INSERT INTO file (slug, event_id, uploaded_by_person_id, filename, content_type,
                       byte_size, sha256, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(slug, eventId, personId, filename, contentType.startsWith('image/') ? 'image/png' : contentType,
    data.length, sha256, storagePath, now());
}

/**
 * A small solid-colour PNG, coloured from a hash of the name so the gallery
 * shows distinguishable tiles rather than one repeated square.
 *
 * Written by hand because the app has no image library and does not need one.
 */
function placeholderPng(seed) {
  const digest = createHash('sha256').update(seed).digest();
  const [r, g, b] = [digest[0], digest[1], digest[2]];
  const size = 64;

  // One filter byte per row, then RGB triples.
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }

  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(payload) >>> 0);
    return Buffer.concat([length, payload, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

// Checked after task assignment; see where it is set.
let duplicateTasks = 0;

wipe();
db.exec('BEGIN');

try {
  // -------------------------------------------------------------------------
  // People
  //
  // One row per human across both events. Emails are all @example.com, which is
  // reserved for exactly this and can never reach a real inbox by accident.
  // -------------------------------------------------------------------------

  const p = {};
  const PEOPLE = {
    naomi: { first: 'Naomi', last: 'Okafor', email: 'naomi.okafor@example.com', pronouns: 'she/her',
      phone: '+1 510 555 0142',
      biography: 'Naomi runs the platform group at a payments company in Oakland and has chaired Manzanita since it was forty people in a co-working space. She is happiest when a schedule survives contact with reality.',
      linkedin: 'https://www.linkedin.com/in/example-naomi-okafor', website: 'https://naomiokafor.example.com' },
    diego: { first: 'Diego', last: 'Herrera', email: 'diego.herrera@example.com', pronouns: 'he/him',
      biography: 'Programme chair. Diego is a staff engineer on developer tooling and reads more incident reviews than release notes.',
      linkedin: 'https://www.linkedin.com/in/example-diego-herrera' },
    priya: { first: 'Priya', last: 'Raghunathan', email: 'priya.raghunathan@example.com', pronouns: 'she/her',
      phone: '+1 415 555 0177',
      biography: 'Priya looks after speaker operations. By day she leads a small ML infrastructure team and maintains two tracing libraries.',
      website: 'https://priyar.example.com' },
    marcus: { first: 'Marcus', last: 'Bell', email: 'marcus.bell@example.com',
      biography: 'Marcus handles venue, AV and every part of a conference nobody writes a talk about. Former sound engineer, current engineering manager.' },

    sofia: { first: 'Sofia', last: 'Marchetti', email: 'sofia.marchetti@example.com', pronouns: 'she/her',
      biography: 'Sofia is a research engineer working on retrieval over legal documents. She reviews for Manzanita because she likes reading proposals more than writing them.' },
    kenji: { first: 'Kenji', last: 'Watanabe', email: 'kenji.watanabe@example.com',
      biography: 'Kenji builds inference infrastructure at a hardware startup and has opinions about batching that he will share unprompted.',
      x: 'https://x.com/example_kenjiw' },
    amara: { first: 'Amara', last: 'Diallo', email: 'amara.diallo@example.com', pronouns: 'she/her',
      biography: 'Amara spoke at Manzanita 2025 on incident response for model-backed systems and came back as a reviewer. She leads reliability at a healthcare data company.',
      linkedin: 'https://www.linkedin.com/in/example-amara-diallo' },

    yusuf: { first: 'Yusuf', last: 'Karim', email: 'yusuf.karim@example.com', pronouns: 'he/him',
      phone: '+1 206 555 0119',
      biography: 'Yusuf works on search and ranking at a large retailer. He has been arguing that retrieval is the hard part since long before it was fashionable.',
      website: 'https://yusufkarim.example.com' },
    hannah: { first: 'Hannah', last: 'Reinhardt', email: 'hannah.reinhardt@example.com', pronouns: 'she/her',
      biography: 'Hannah is an observability engineer. She writes about tracing, sampling, and the gap between a dashboard and an explanation.',
      x: 'https://x.com/example_hreinhardt' },
    lucas: { first: 'Lucas', last: 'Oliveira', email: 'lucas.oliveira@example.com', pronouns: 'he/him',
      biography: 'Lucas is a performance engineer in Sao Paulo who spends his days making inference cheaper without making it worse.' },
    meilin: { first: 'Mei-Lin', last: 'Chen', email: 'meilin.chen@example.com', pronouns: 'she/her',
      phone: '+1 650 555 0188',
      biography: 'Mei-Lin leads an evaluation team and has shipped three generations of internal eval harness, each simpler than the last.',
      linkedin: 'https://www.linkedin.com/in/example-meilin-chen', website: 'https://meilinchen.example.com' },
    seun: { first: 'Oluwaseun', last: 'Adeyemi', email: 'oluwaseun.adeyemi@example.com', pronouns: 'he/him',
      biography: 'Oluwaseun is a platform engineer in Lagos. He moved four hundred services onto a shared model gateway and lived to describe it.' },
    elena: { first: 'Elena', last: 'Volkova', email: 'elena.volkova@example.com', pronouns: 'she/her',
      biography: 'Elena teaches testing to engineers who are sure they do not need it, and maintains a property-based testing library.',
      website: 'https://volkova.example.com' },
    aisha: { first: 'Aisha', last: 'Rahman', email: 'aisha.rahman@example.com', pronouns: 'she/her',
      biography: 'Aisha works on application security, mostly where models meet untrusted input.' },
    theo: { first: 'Theo', last: 'Lambert', email: 'theo.lambert@example.com', pronouns: 'he/him',
      biography: 'Theo is a compiler engineer turned security researcher, based in Montreal.' },
    rosa: { first: 'Rosa', last: 'Delgado', email: 'rosa.delgado@example.com', pronouns: 'she/her',
      biography: 'Rosa is an engineering director who has built three AI-adjacent teams, two of which she would build differently now.',
      linkedin: 'https://www.linkedin.com/in/example-rosa-delgado' },
    sam: { first: 'Sam', last: 'Whitfield', email: 'sam.whitfield@example.com', pronouns: 'they/them',
      biography: 'Sam is an SRE. Their favourite talks are the ones where something went badly wrong and somebody explains why.' },
    ananya: { first: 'Ananya', last: 'Iyer', email: 'ananya.iyer@example.com', pronouns: 'she/her',
      biography: 'Ananya works on developer experience for internal ML platforms and cares a great deal about error messages.' },
  };

  at('2026-02-02T18:00:00Z', () => {
    for (const [key, data] of Object.entries(PEOPLE)) p[key] = addPerson(data);
  });

  // -------------------------------------------------------------------------
  // Last year's event
  //
  // Small on purpose: it exists so "have we had this speaker before" has an
  // answer. Yusuf spoke in 2025 and is speaking again; Amara spoke in 2025 and
  // came back as a reviewer, which is the CRM's whole point.
  // -------------------------------------------------------------------------

  const past = at('2025-03-11T17:00:00Z', () => addEvent({
    slug: 'manzanita-2025',
    name: 'Manzanita 2025',
    website: 'https://manzanita.example.com/2025',
    location: 'Ironworks Center, Oakland, California',
    startsAt: pdt('2025-10-06', '09:00'),
    endsAt: pdt('2025-10-07', '17:30'),
    description: 'The first two-day Manzanita. Two rooms, one track each, and a hallway that was too small.',
  }));

  const was = {};   // last year's vocabulary, only as much of it as 2025 needed

  at('2025-03-11T17:10:00Z', () => {
    addMembership(past.id, p.naomi.id, 'owner');
    addMembership(past.id, p.diego.id, 'organizer');

    was.reliability = addTrack(past.id, 'reliability', 'Reliability', '#2f6f4e', 1);
    was.retrieval = addTrack(past.id, 'retrieval', 'Retrieval', '#365d9b', 2);
    was.mainHall = addRoom(past.id, 'main-hall', 'Main Hall', 300, 1);
    was.sideRoom = addRoom(past.id, 'side-room', 'Side Room', 90, 2);
    addOption(past.id, 'format', 'keynote', 'Keynote', 1);
    was.talk = addOption(past.id, 'format', 'talk', 'Talk', 2);
    addOption(past.id, 'level', 'intermediate', 'Intermediate', 2);
    addOption(past.id, 'language', 'english', 'English', 1);
  });

  const pastSubs = at('2025-06-15T16:30:00Z', () => {
    const incident = createSubmission(db, {
      eventId: past.id, status: 'pending', submittedByPersonId: p.amara.id,
      trackId: was.reliability.id,
      title: 'Incident Response When the Model Is the Bug',
      description: 'A postmortem-shaped talk about an outage whose root cause was a prompt change, and what we had to add to our runbooks before we could debug it at all.',
    });
    addParticipant(incident.id, p.amara.id, { primary: true });

    const ranking = createSubmission(db, {
      eventId: past.id, status: 'pending', submittedByPersonId: p.yusuf.id,
      trackId: was.retrieval.id,
      title: 'Ranking Is the Hard Part',
      description: 'Everyone reaches for embeddings first. This is what happened when we spent a quarter on the ranker instead, and the numbers either side of it.',
    });
    addParticipant(ranking.id, p.yusuf.id, { primary: true });

    for (const s of [incident, ranking]) {
      db.prepare('UPDATE submission SET format_option_id = ? WHERE id = ?').run(was.talk.id, s.id);
    }
    return { incident, ranking };
  });

  at('2025-07-21T22:00:00Z', () => decide(db, [pastSubs.incident.id, pastSubs.ranking.id], 'accept',
    { actorPersonId: p.diego.id }));

  at('2025-07-28T16:45:00Z', () => notify(db, [pastSubs.incident.id, pastSubs.ranking.id], {
    actorPersonId: p.naomi.id, portalUrlFor: portalUrl,
  }));

  at('2025-08-19T20:00:00Z', () => {
    db.prepare(
      `UPDATE submission SET room_id = ?, starts_at = ?, ends_at = ?, published = 1, updated_at = ?
        WHERE id = ?`,
    ).run(was.mainHall.id, pdt('2025-10-06', '10:00'), pdt('2025-10-06', '10:45'),
      now(), pastSubs.incident.id);
    db.prepare(
      `UPDATE submission SET room_id = ?, starts_at = ?, ends_at = ?, published = 1, updated_at = ?
        WHERE id = ?`,
    ).run(was.sideRoom.id, pdt('2025-10-07', '14:00'), pdt('2025-10-07', '14:45'),
      now(), pastSubs.ranking.id);
  });

  // -------------------------------------------------------------------------
  // This year's event and its vocabulary
  // -------------------------------------------------------------------------

  const event = at('2026-02-02T18:30:00Z', () => addEvent({
    slug: 'manzanita-2026',
    name: 'Manzanita 2026',
    website: 'https://manzanita.example.com',
    location: 'Ironworks Center, Oakland, California',
    startsAt: pdt('2026-10-12', '09:00'),
    endsAt: pdt('2026-10-14', '18:00'),
    description: 'A working conference for the people who build and operate AI systems: evaluation, retrieval, serving, and the unglamorous engineering that keeps any of it running. Three days, five rooms, no vendor keynotes.',
  }));

  const track = {};
  const room = {};
  const option = {};   // keyed 'kind:slug', because that is how a form field looks one up

  at('2026-02-03T19:00:00Z', () => {
    addMembership(event.id, p.naomi.id, 'owner');
    for (const key of ['diego', 'priya', 'marcus']) addMembership(event.id, p[key].id, 'organizer');
    for (const key of ['sofia', 'kenji', 'amara']) addMembership(event.id, p[key].id, 'reviewer');

    const tracks = [
      ['building-with-models', 'Building with Models', '#2f6f4e'],
      ['evaluation-and-reliability', 'Evaluation and Reliability', '#8a4b2a'],
      ['serving-and-infrastructure', 'Serving and Infrastructure', '#365d9b'],
      ['developer-experience', 'Developer Experience', '#6b4b9a'],
      ['teams-and-practice', 'Teams and Practice', '#4a5b66'],
    ];
    tracks.forEach(([slug, name, color], i) => { track[slug] = addTrack(event.id, slug, name, color, i + 1); });

    // Capacities are real numbers the conflict view and the workshop cap read.
    const rooms = [
      ['redwood-hall', 'Redwood Hall', 600],
      ['cypress-room', 'Cypress Room', 240],
      ['alder-room', 'Alder Room', 120],
      ['madrone-studio', 'Madrone Studio', 60],
      ['foyer-stage', 'Foyer Stage', 80],
    ];
    rooms.forEach(([slug, name, capacity], i) => { room[slug] = addRoom(event.id, slug, name, capacity, i + 1); });

    const options = [
      ['format', 'keynote', 'Keynote'],
      ['format', 'talk', 'Talk'],
      ['format', 'workshop', 'Workshop'],
      ['format', 'lightning-talk', 'Lightning Talk'],
      ['format', 'panel', 'Panel'],
      ['level', 'beginner', 'Beginner'],
      ['level', 'intermediate', 'Intermediate'],
      ['level', 'advanced', 'Advanced'],
      ['language', 'english', 'English'],
      ['language', 'spanish', 'Spanish'],
      ['language', 'portuguese', 'Portuguese'],
      ['tag', 'agents', 'Agents'],
      ['tag', 'evaluation', 'Evaluation'],
      ['tag', 'retrieval', 'Retrieval'],
      ['tag', 'fine-tuning', 'Fine-tuning'],
      ['tag', 'observability', 'Observability'],
      ['tag', 'security', 'Security'],
      ['tag', 'cost-and-performance', 'Cost and Performance'],
      ['tag', 'open-weights', 'Open Weights'],
    ];
    const seen = {};
    for (const [kind, slug, label] of options) {
      seen[kind] = (seen[kind] ?? 0) + 1;
      option[`${kind}:${slug}`] = addOption(event.id, kind, slug, label, seen[kind]);
    }
  });

  // -------------------------------------------------------------------------
  // The call for speakers
  //
  // Built the way the seven-step wizard builds one: an internal name organizers
  // recognise in a list, an external title submitters see, then the abstract and
  // participant sections as an ordered field list. Locked fields carry a
  // `maps_to` and land on a column; everything else is a custom question whose
  // answer goes to submission_answer.
  // -------------------------------------------------------------------------

  const form = at('2026-03-24T17:00:00Z', () => addForm(event.id, {
    slug: 'cfs-2026',
    internalName: 'CFS 2026 (main round)',
    externalTitle: 'Manzanita 2026 Call for Speakers',
    pageHeading: 'Tell us what you would talk about',
    welcomeMessage:
      'Manzanita is a working conference: we want talks from people who have actually shipped and operated the thing they are describing, including the parts that went badly.\n\n'
      + 'You may submit up to three proposals. Submissions close on 5 July at 23:59 Pacific, and every submitter hears back by 7 August whether the answer is yes or no.',
    closeAt: pdt('2026-07-05', '23:59'),
    submissionLimit: 3,
    successMessage:
      'That is in. We have emailed you a copy, and your speaker portal is where you can edit it until submissions close.',
    sendConfirmationEmail: 1,
  }));

  const field = {};

  at('2026-03-24T17:20:00Z', () => {
    const abstract = [
      { slug: 'title', label: 'Title', type: 'text', mapsTo: 'submission.title',
        required: 1, locked: 1, maxChars: 255,
        help: 'The title in the printed programme. Say what the talk is, not what it is called.' },
      { slug: 'description', label: 'Description', type: 'richtext', mapsTo: 'submission.description',
        required: 1, maxChars: 5000,
        help: 'What will an attendee be able to do afterwards that they could not before?' },
      { slug: 'format', label: 'Format', type: 'select', optionsKind: 'format',
        mapsTo: 'submission.format_option_id', required: 1 },
      { slug: 'tags', label: 'Tags', type: 'multiselect', optionsKind: 'tag',
        mapsTo: 'submission.tags', help: 'Up to three. Reviewers filter on these.' },
      // Tracks live in their own table rather than in taxonomy_option, so this
      // dropdown has no options_kind to point at; the UI reads `track` directly.
      { slug: 'track', label: 'Track', type: 'select', mapsTo: 'submission.track_id', required: 1 },
      { slug: 'level', label: 'Level', type: 'select', optionsKind: 'level',
        mapsTo: 'submission.level_option_id' },
      { slug: 'language', label: 'Language', type: 'select', optionsKind: 'language',
        mapsTo: 'submission.language_option_id' },
      { slug: 'previously-presented', label: 'Have you given this talk before?', type: 'checkbox',
        help: 'A previously given talk is welcome. We only need to know so we do not surprise the audience.' },
      { slug: 'previous-venue', label: 'Where did you give it, and is there a recording?', type: 'url' },
      { slug: 'why-you', label: 'Why are you the right person to give this talk?', type: 'textarea',
        maxChars: 600, help: 'Two or three sentences. This is the question reviewers argue about.' },
    ];
    abstract.forEach((f, i) => { field[f.slug] = addField(form.id, { ...f, section: 'abstract', order: i + 1 }); });

    const participant = [
      { slug: 'first-name', label: 'First Name', type: 'text', mapsTo: 'person.first_name', required: 1, locked: 1 },
      { slug: 'last-name', label: 'Last Name', type: 'text', mapsTo: 'person.last_name', required: 1, locked: 1 },
      { slug: 'email', label: 'Email', type: 'email', mapsTo: 'person.email', required: 1, locked: 1 },
      { slug: 'mobile-phone', label: 'Mobile Phone', type: 'phone', mapsTo: 'person.phone',
        help: 'Used only during the event, and only by the stage manager.' },
      { slug: 'biography', label: 'Biography', type: 'textarea', mapsTo: 'person.biography',
        required: 1, maxChars: 1200 },
      { slug: 'travel-support', label: 'Would you need travel support to attend?', type: 'checkbox',
        help: 'Answering yes does not affect the review. Reviewers never see this.' },
    ];
    participant.forEach((f, i) => { field[f.slug] = addField(form.id, { ...f, section: 'participant', order: i + 1 }); });

    // The conditional-logic example: only ask where a talk was given once the
    // submitter has said it was given somewhere.
    addCondition(field['previous-venue'].id, field['previously-presented'].id, 'equals', '1');

    // The printed programme block is one fixed column width, so title and
    // description are capped together rather than separately.
    addCharLimit(form.id, 'Printed programme block (title + description)', 700,
      [field.title.id, field.description.id]);
  });

  // A second, still-open round.
  //
  // The main call closed in July and the programme is being decided now, which
  // is the state the rest of this seed depicts. But a demo with no open form
  // cannot show the thing that matters most -- a stranger submitting a proposal
  // and landing in their portal already signed in -- so the lightning-talk round
  // is genuinely open. Real conferences run exactly this way: a late, shorter
  // round after the main one closes.
  const lightningForm = at('2026-08-03T16:00:00Z', () => addForm(event.id, {
    slug: 'lightning-2026',
    internalName: 'Lightning talks 2026 (late round)',
    externalTitle: 'Manzanita 2026 Lightning Talks',
    pageHeading: 'Got five minutes worth saying?',
    welcomeMessage:
      'The main call is closed, but we hold back a lightning-talk block on the last afternoon.\n\n'
      + 'Five minutes, no slides required, one idea. Tell us what you would say and why it matters. '
      + 'We decide these on a rolling basis, so the earlier you send it the better your odds.',
    closeAt: pdt('2026-09-15', '23:59'),
    submissionLimit: 2,
    successMessage:
      'That is in. We read lightning proposals weekly and will let you know either way by the end of September.',
    sendConfirmationEmail: 1,
  }));

  at('2026-08-03T16:10:00Z', () => {
    const abstract = [
      { slug: 'title', label: 'Title', type: 'text', mapsTo: 'submission.title',
        required: 1, locked: 1, maxChars: 120,
        help: 'Shorter than a full talk title. It goes on one line of the programme.' },
      { slug: 'description', label: 'What is the idea?', type: 'textarea',
        mapsTo: 'submission.description', required: 1, maxChars: 1000,
        help: 'One paragraph. Five minutes is one idea, not three.' },
      { slug: 'track', label: 'Track', type: 'select', mapsTo: 'submission.track_id' },
    ];
    abstract.forEach((f, i) => addField(lightningForm.id, { ...f, section: 'abstract', order: i + 1 }));

    const participant = [
      { slug: 'first-name', label: 'First Name', type: 'text', mapsTo: 'person.first_name', required: 1, locked: 1 },
      { slug: 'last-name', label: 'Last Name', type: 'text', mapsTo: 'person.last_name', required: 1, locked: 1 },
      { slug: 'email', label: 'Email', type: 'email', mapsTo: 'person.email', required: 1, locked: 1 },
      { slug: 'biography', label: 'One line about you', type: 'text', mapsTo: 'person.biography',
        maxChars: 200 },
    ];
    participant.forEach((f, i) => addField(lightningForm.id, { ...f, section: 'participant', order: i + 1 }));
  });

  // A third form, kind 'contact', that a task hangs off. Its fields have to
  // declare `section`, which only knows the two CFS sections, so a task form
  // sits in 'participant': everything on it is about the person.
  const travelForm = at('2026-03-24T17:40:00Z', () => addForm(event.id, {
    slug: 'travel-and-hotel',
    kind: 'contact',
    internalName: 'Travel and hotel details 2026',
    externalTitle: 'Travel and hotel',
    pageHeading: 'How are you getting here?',
    welcomeMessage: 'We book speaker hotel rooms in one batch on 20 September. After that we can still help, but you book it yourself.',
    collectParticipants: 0,
    sendConfirmationEmail: 0,
  }));

  const travelField = {};
  at('2026-03-24T17:45:00Z', () => {
    const fields = [
      { slug: 'arrival-date', label: 'Arrival date', type: 'date', required: 1 },
      { slug: 'departure-date', label: 'Departure date', type: 'date', required: 1 },
      { slug: 'hotel-needed', label: 'Do you need us to book a hotel room?', type: 'checkbox' },
      { slug: 'dietary-notes', label: 'Anything we should know about food?', type: 'textarea', maxChars: 300 },
    ];
    fields.forEach((f, i) => {
      travelField[f.slug] = addField(travelForm.id, { ...f, section: 'participant', order: i + 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Speaker tasks
  //
  // Defined before any notification goes out, because notify() assigns them the
  // moment a submission becomes accepted. Nothing here is assigned by hand.
  // -------------------------------------------------------------------------

  const taskDef = {};
  at('2026-04-07T18:00:00Z', () => {
    const defs = [
      { slug: 'speaker-agreement', title: 'Sign the speaker agreement',
        instructions: 'The short version: you own your material, we may record and publish it, and you will tell us as soon as you know you cannot make it.',
        appliesTo: 'person', requirement: 'acknowledge', dueAt: pdt('2026-09-01', '17:00') },
      { slug: 'headshot', title: 'Upload a headshot',
        instructions: 'Square, at least 800x800, and recognisably you. It goes on the website and the printed programme.',
        appliesTo: 'person', requirement: 'file', dueAt: pdt('2026-09-15', '17:00') },
      { slug: 'travel-and-hotel', title: 'Travel and hotel form',
        instructions: 'Tell us when you arrive and whether you need a room. No deadline, but the block booking closes on 20 September.',
        appliesTo: 'person', requirement: 'form', formId: travelForm.id, dueAt: null, required: 0 },
      { slug: 'upload-slides', title: 'Upload your slides',
        instructions: 'PDF preferred. We load every deck onto the room machine the night before; anything that arrives later you present from your own laptop.',
        appliesTo: 'submission', requirement: 'file', dueAt: pdt('2026-09-25', '17:00') },
    ];
    defs.forEach((d, i) => { taskDef[d.slug] = addTaskDefinition(event.id, { ...d, order: i + 1 }); });
  });

  // -------------------------------------------------------------------------
  // Email templates
  //
  // Only the three that go to submitters are customised. `task_reminder` is left
  // out on purpose, so the built-in default in core/mail.js is exercised too.
  // -------------------------------------------------------------------------

  at('2026-04-08T16:00:00Z', () => {
    addTemplate(event.id, 'submission_confirmation', 'Submission received',
      'We have your proposal: {{submission_title}}',
      `Hi {{first_name}},

Thanks for proposing "{{submission_title}}" for {{event_name}}.

It is logged as {{submission_code}}. Quote that code if you write to us about it.
You can edit the proposal in your speaker portal until submissions close:

  {{portal_url}}

Every submitter hears back by 7 August, yes or no. We do not keep anyone waiting
past that date.

- Naomi, on behalf of the {{event_name}} programme committee`);

    addTemplate(event.id, 'decision_accepted', 'Decision: accepted',
      'You are on the {{event_name}} programme',
      `Hi {{first_name}},

"{{submission_title}}" ({{submission_code}}) is on the programme for {{event_name}},
12-14 October at the Ironworks Center in Oakland.

Two things now, both in your speaker portal:

  {{portal_url}}

  1. Sign the speaker agreement (due 1 September). We cannot list you publicly
     until this is done.
  2. Send us a headshot (due 15 September) and your slides (due 25 September).

Your time slot is not final yet. We will confirm the room and the hour by mid
September, and you will get a calendar invite you can accept.

- Naomi, on behalf of the {{event_name}} programme committee`);

    addTemplate(event.id, 'decision_declined', 'Decision: not this year',
      'About your {{event_name}} proposal',
      `Hi {{first_name}},

Thank you for proposing "{{submission_title}}" for {{event_name}}. We are not
able to fit it into this year's programme.

We had far more good proposals than slots, and a no here is mostly a statement
about the shape of the schedule. If you would like the reviewers' notes on your
proposal, reply to this message and we will send them to you.

We would genuinely welcome a submission from you next year.

- Naomi, on behalf of the {{event_name}} programme committee`);
  });

  // -------------------------------------------------------------------------
  // Portal content and public embeds
  // -------------------------------------------------------------------------

  at('2026-04-09T17:30:00Z', () => {
    addResourcePage(event.id, {
      slug: 'speaker-faq', title: 'Speaker FAQ', order: 1,
      body: `<h2>Before the event</h2>
<p><strong>When do I find out my time slot?</strong> Rooms and times are confirmed by mid September. You will get a calendar invite you can accept in your own calendar; if we move you, that invite updates rather than a second one arriving.</p>
<p><strong>Can I change my title or abstract?</strong> Yes, until 25 September, in the Submissions tab of your portal. After that the programme has gone to print.</p>
<p><strong>Do I need to be there both days?</strong> No. Tell us which day suits you in the travel form and we will schedule around it where we can.</p>
<h2>On the day</h2>
<p>Arrive at your room fifteen minutes before your slot. A volunteer will be there with a clicker, a countdown timer and water.</p>`,
    });

    addResourcePage(event.id, {
      slug: 'av-and-stage', title: 'AV and stage notes', order: 2,
      body: `<h2>What is in every room</h2>
<p>HDMI and USB-C, a wireless lapel microphone, a confidence monitor and a countdown clock. Redwood Hall also has a handheld microphone for questions.</p>
<h2>Slides</h2>
<p>Upload a PDF through your portal by 25 September and we will load it on the room machine the night before. Presenting from your own laptop is fine, but bring your own adapter and find Marcus at the AV desk during the break before your talk.</p>
<h2>Recording</h2>
<p>Every session in Redwood Hall, the Cypress Room and the Alder Room is recorded. Workshops in Madrone Studio are not. Tell us if you would rather not be recorded; nobody has ever been made to.</p>`,
    });

    addResourcePage(event.id, {
      slug: 'travel-and-hotel', title: 'Travel, hotel and expenses', order: 3,
      body: `<h2>Hotel</h2>
<p>We hold a block at the Lakeside Hotel, four minutes' walk from the venue, and book it in one batch on 20 September. Fill in the travel form in your portal before then and the room is on us for the nights either side of your session.</p>
<h2>Getting here</h2>
<p>The Ironworks Center is a ten minute walk from 19th Street BART. There is no speaker parking; there is a public garage on Telegraph.</p>
<h2>Expenses</h2>
<p>We reimburse travel for speakers who need it, no questions asked. Tick the box on the travel form and Priya will follow up.</p>`,
    });

    addEmbed(event.id, {
      slug: 'public-agenda', name: 'Agenda (marketing site)', feed: 'agenda',
    });
    addEmbed(event.id, {
      slug: 'speaker-gallery', name: 'Speaker gallery (marketing site)', feed: 'speaker_gallery',
    });
  });

  // -------------------------------------------------------------------------
  // Submissions
  //
  // In arrival order, which is also code order: the first proposal in is SESS-1.
  // Status is not set here -- everything arrives as a draft or as pending, and
  // the decision batches further down move it, so the activity log reads like a
  // history instead of a fixture.
  // -------------------------------------------------------------------------

  const SUBMISSIONS = [
    {
      key: 'feedback-loop', arrival: '2026-05-14T16:22:00Z', by: 'meilin',
      title: 'The Ten-Minute Feedback Loop: Evaluation as an Engineering Discipline',
      description: 'We spent two years unable to answer "is this change better?" in under a week, and the honest reason was not the models. This is what we cut, what we automated, and what a ten-minute answer costs to keep.',
      track: 'evaluation-and-reliability', format: 'keynote', level: 'intermediate',
      language: 'english', tags: ['evaluation', 'observability'],
      answers: { 'why-you': 'I have built this loop three times, badly twice. The talk is mostly about the two bad ones.', 'previously-presented': '0' },
    },
    {
      key: 'retrieval', arrival: '2026-05-18T21:05:00Z', by: 'yusuf',
      title: 'Retrieval Is Not a Vector Database',
      description: 'A walk through a retrieval stack that started as one embedding index and ended as four stages, only one of which involves vectors. Includes the quality numbers at each step and what each stage cost to run.',
      track: 'building-with-models', format: 'talk', level: 'intermediate',
      language: 'english', tags: ['retrieval', 'cost-and-performance'],
      answers: {
        'why-you': 'I own the ranking stack for a catalogue of forty million items and I have the before-and-after graphs.',
        'previously-presented': '1',
        'previous-venue': 'https://videos.example.com/manzanita-2025/ranking-is-the-hard-part',
      },
    },
    {
      key: 'observability', arrival: '2026-05-21T15:40:00Z', by: 'hannah', co: ['yusuf'],
      title: 'Observability for Model-Backed Services',
      description: 'Traces, sampling and cost control for services where the expensive span is a model call. What we log, what we deliberately do not, and how we answer "why did this one request go wrong" six weeks after it did.',
      track: 'serving-and-infrastructure', format: 'talk', level: 'advanced',
      language: 'english', tags: ['observability', 'cost-and-performance'],
      answers: { 'why-you': 'Yusuf and I built this together across two teams and we still disagree about sampling, which makes for a better talk.', 'previously-presented': '0' },
    },
    {
      key: 'inference-cost', arrival: '2026-05-27T23:18:00Z', by: 'lucas',
      title: 'Cutting Inference Cost by Two Thirds Without Touching the Model',
      description: 'Batching, caching, routing and quantisation, in the order we tried them, with the savings and the regressions each one caused. No model was retrained in the making of this talk.',
      track: 'serving-and-infrastructure', format: 'talk', level: 'advanced',
      language: 'english', tags: ['cost-and-performance', 'open-weights'],
      answers: { 'why-you': 'This was my whole job for eleven months and the invoice went down every month.' },
    },
    {
      key: 'eval-harness', arrival: '2026-06-02T17:55:00Z', by: 'elena', co: ['aisha'],
      title: 'Workshop: Building an Eval Harness for a Codebase You Did Not Write',
      description: 'Three hours, laptops open. We take an unfamiliar repository, find the behaviour worth protecting, and leave with a harness that fails when the behaviour changes. Bring a machine that can run Python.',
      track: 'evaluation-and-reliability', format: 'workshop', level: 'intermediate',
      language: 'english', tags: ['evaluation', 'agents'],
      capacity: 40,
      answers: { 'why-you': 'We teach this internally four times a year and have watched every way it can go wrong in a room.', 'travel-support': '1' },
    },
    {
      key: 'hiring-panel', arrival: '2026-06-05T19:10:00Z', by: 'rosa',
      co: ['sam', 'ananya'], moderator: true,
      title: 'Panel: Hiring and Growing an AI Engineering Team',
      description: 'Three people who have built these teams from nothing, on what they screen for now that they did not two years ago, and what they have stopped pretending to interview for.',
      track: 'teams-and-practice', format: 'panel', level: 'beginner',
      language: 'english', tags: [],
      answers: { 'why-you': 'Between the three of us we have hired about sixty people into these roles and fired a few of our own assumptions.' },
    },
    {
      key: 'gateway', arrival: '2026-06-09T14:02:00Z', by: 'seun',
      title: 'What We Learned Migrating Four Hundred Services to a Shared Model Gateway',
      description: 'The gateway was the easy part. This is about the eighteen months of migration around it: the teams that would not move, the two rollbacks, and the quota system we should have built first.',
      track: 'serving-and-infrastructure', format: 'talk', level: 'advanced',
      language: 'english', tags: ['cost-and-performance', 'observability'],
      answers: { 'why-you': 'I led it, including the parts I would not do again.', 'travel-support': '1' },
    },
    {
      key: 'guardrails', arrival: '2026-06-12T18:44:00Z', by: 'aisha',
      title: 'Guardrails That Do Not Get in the Way',
      description: 'Every input filter we shipped made the product worse before it made it safer. Here is the design we landed on, the measurements that justified it, and what we let through on purpose.',
      track: 'building-with-models', format: 'talk', level: 'intermediate',
      language: 'english', tags: ['security', 'agents'],
      answers: { 'why-you': 'I run the security review for a product with untrusted input on every request.', 'previously-presented': '0' },
    },
    {
      key: 'prompt-injection', arrival: '2026-06-16T20:30:00Z', by: 'theo',
      title: 'Prompt Injection: A Practical Threat Model',
      description: 'A threat model you can actually apply on a Tuesday: what an attacker controls, what they gain, and which mitigations are theatre. Worked examples from three real applications.',
      track: 'building-with-models', format: 'talk', level: 'advanced',
      language: 'english', tags: ['security'],
      answers: { 'why-you': 'I have written the security review for three of these systems and broken two others with permission.' },
    },
    {
      key: 'data-platform', arrival: '2026-06-19T16:12:00Z', by: 'ananya',
      title: 'Our Data Platform Journey: From Warehouse to Lakehouse',
      description: 'A retrospective on a two-year data platform migration, the tooling we chose, and the organisational lessons we took from it.',
      track: 'serving-and-infrastructure', format: 'talk', level: 'intermediate',
      language: 'english', tags: [],
      answers: { 'why-you': 'I was the tech lead for the migration.' },
    },
    {
      key: 'yaml', arrival: '2026-06-22T22:47:00Z', by: 'yusuf',
      title: 'Ten Things I Hate About YAML',
      description: 'A light closing-slot talk about configuration formats, with strong opinions and a live demo of the Norway problem.',
      track: 'developer-experience', format: 'lightning-talk', level: 'beginner',
      language: 'english', tags: [],
      answers: { 'why-you': 'Nobody is the right person for this talk. I would like to give it anyway.' },
    },
    {
      key: 'vendor-observability', arrival: '2026-06-24T15:33:00Z', by: 'hannah',
      title: 'How Our Platform Gives You Full-Stack AI Observability',
      description: 'An overview of our observability product, its integrations, and a customer case study showing 40% faster incident resolution.',
      track: 'serving-and-infrastructure', format: 'talk', level: 'beginner',
      language: 'english', tags: ['observability'],
      answers: {},
    },
    {
      key: 'feature-store', arrival: '2026-06-26T19:20:00Z', by: 'seun',
      title: 'Scaling a Feature Store to a Billion Rows a Day',
      description: 'Storage layout, backfills, and the day we discovered our freshness metric was measuring the wrong clock.',
      track: 'serving-and-infrastructure', format: 'talk', level: 'advanced',
      language: 'english', tags: ['cost-and-performance'],
      answers: { 'why-you': 'I own the feature store and the pager that comes with it.' },
    },
    {
      key: 'retry-loop', arrival: '2026-06-29T17:58:00Z', by: 'sam',
      title: 'Lightning: Our Worst Outage Was a Retry Loop',
      description: 'Eight minutes on a four-hour outage. One retry, no jitter, a queue with no ceiling, and a bill that arrived before the postmortem did.',
      track: 'evaluation-and-reliability', format: 'lightning-talk', level: 'beginner',
      language: 'english', tags: ['observability'],
      answers: { 'why-you': 'I was on call. I have the graph.', 'previously-presented': '0' },
    },
    {
      key: 'property-testing', arrival: '2026-07-01T21:14:00Z', by: 'theo',
      title: 'Property-Based Testing for Prompt Templates',
      description: 'Templates are code, and code has invariants. Generating adversarial inputs against a template, and the three classes of bug this found in a system nobody thought was fragile.',
      track: 'evaluation-and-reliability', format: 'talk', level: 'intermediate',
      language: 'english', tags: ['evaluation', 'security'],
      answers: { 'why-you': 'I maintain the generator library the examples use.' },
    },
    {
      key: 'reviewing-model-code', arrival: '2026-07-02T18:36:00Z', by: 'rosa',
      title: 'Teaching Juniors to Review Model-Written Code',
      description: 'Our review standards did not survive a codebase where half the diffs were generated. What we changed in the rubric, in the tooling, and in what we say out loud to people in their first job.',
      track: 'teams-and-practice', format: 'talk', level: 'intermediate',
      language: 'english', tags: ['agents'],
      answers: { 'why-you': 'I rewrote our review guide twice this year and watched a team of nine work through it.' },
    },
    {
      key: 'open-weights', arrival: '2026-07-04T23:41:00Z', by: 'lucas',
      title: 'Running Open-Weight Models on the Hardware You Already Own',
      description: 'What fits, what it costs, and where the honest quality cliff is. Benchmarks on three machines a normal company already has in a rack.',
      track: 'serving-and-infrastructure', format: 'talk', level: 'intermediate',
      language: 'english', tags: ['open-weights', 'cost-and-performance'],
      answers: { 'why-you': 'I ran every benchmark in the talk on hardware I could borrow, which is the point.', 'travel-support': '1' },
    },
    // Two drafts, both started in the last hours before the form closed and
    // never submitted. This is what the Drafts tab is for.
    {
      key: 'long-context', arrival: '2026-07-05T04:10:00Z', by: 'meilin', draft: true,
      title: 'Notes on Long-Context Retrieval',
      description: 'Rough outline: when a longer window replaces retrieval, when it quietly does not, and how we measured the difference.',
      track: 'building-with-models', format: 'talk', level: 'advanced',
      language: 'english', tags: ['retrieval'],
      answers: {},
    },
    {
      key: 'nondeterminism', arrival: '2026-07-05T06:35:00Z', by: 'elena', draft: true,
      title: 'Debugging Nondeterminism',
      description: '',
      track: 'evaluation-and-reliability', format: null, level: null,
      language: 'english', tags: [],
      answers: {},
    },
  ];

  const sub = {};

  for (const s of SUBMISSIONS) {
    at(s.arrival, () => {
      const row = createSubmission(db, {
        eventId: event.id,
        formId: form.id,
        submittedByPersonId: p[s.by].id,
        title: s.title,
        description: s.description,
        trackId: track[s.track].id,
        status: s.draft ? 'draft' : 'pending',
      });
      sub[s.key] = row;

      addParticipant(row.id, p[s.by].id,
        { primary: true, order: 0, role: s.moderator ? 'moderator' : 'speaker' });
      (s.co ?? []).forEach((key, i) => addParticipant(row.id, p[key].id, { order: i + 1 }));

      db.prepare(
        `UPDATE submission
            SET format_option_id = ?, level_option_id = ?, language_option_id = ?,
                capacity = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        s.format ? option[`format:${s.format}`].id : null,
        s.level ? option[`level:${s.level}`].id : null,
        option[`language:${s.language}`].id,
        s.capacity ?? null, now(), row.id,
      );

      for (const tag of s.tags) {
        db.prepare('INSERT INTO submission_tag (submission_id, option_id) VALUES (?, ?)')
          .run(row.id, option[`tag:${tag}`].id);
      }

      for (const [slug, value] of Object.entries(s.answers)) {
        db.prepare('INSERT INTO submission_answer (submission_id, field_id, value) VALUES (?, ?, ?)')
          .run(row.id, field[slug].id, value);
      }

      // The form has send_confirmation_email on, so a real submit queues this
      // the moment the submitter presses the button. A draft has not been
      // submitted, so it gets nothing.
      if (!s.draft) {
        const template = getTemplate(db, event.id, 'submission_confirmation');
        queueEmail(db, {
          eventId: event.id, to: p[s.by], subject: template.subject, body: template.body,
          kind: 'submission_confirmation', templateSlug: 'submission_confirmation',
          submissionId: row.id,
          vars: {
            event_name: event.name, submission_title: row.title, submission_code: row.code,
            portal_url: portalUrl(p[s.by], event),
          },
        });
      }
    });
  }

  // One speaker withdrew before the committee met: new job, no time. Withdrawn
  // is reachable from any state and is not a decision, so it never appears in a
  // notification batch.
  at('2026-07-20T15:25:00Z', () => setStatus(db, sub['feature-store'].id, 'withdrawn', {
    actorPersonId: p['seun'].id, detail: 'withdrawn by the speaker: changed employer',
  }));

  // -------------------------------------------------------------------------
  // Review round one
  // -------------------------------------------------------------------------

  const plan = at('2026-07-08T16:00:00Z', () => db.prepare(
    `INSERT INTO evaluation_plan (event_id, slug, name, round, is_open, created_at)
     VALUES (?, 'round-1', 'Round 1: all submissions', 1, 1, ?) RETURNING *`,
  ).get(event.id, now()));

  const criterion = {};
  at('2026-07-08T16:05:00Z', () => {
    const criteria = [
      ['relevance', 'Relevance', 'Would our audience choose this over the other talks in its slot?', 1.5],
      ['originality', 'Originality', 'Have we, or has anyone, heard this already?', 1.0],
      ['speaker-experience', 'Speaker experience', 'Evidence the speaker has actually done the thing, and can hold a room.', 1.0],
      ['clarity', 'Clarity', 'Is the proposal itself clearly written? It correlates.', 0.5],
    ];
    criteria.forEach(([slug, label, help, weight], i) => {
      criterion[slug] = db.prepare(
        `INSERT INTO criterion (plan_id, slug, label, help_text, scale_min, scale_max, weight, sort_order)
         VALUES (?, ?, ?, ?, 1, 5, ?, ?) RETURNING *`,
      ).get(plan.id, slug, label, help, weight, i + 1);
    });
  });

  // Two reviewers per proposal, spread across the three reviewers plus Priya,
  // who is an organizer and reviews as well. Note that this is expressed by
  // giving her review rows, not by a second membership: event_membership is keyed
  // (event_id, person_id), so one person holds exactly one role per event.
  //
  // Scores are [relevance, originality, speaker experience, clarity]. A short
  // array is a review still in progress -- the reviewer scored what they had an
  // opinion about and stopped.
  const REVIEWS = [
    { sub: 'feedback-loop', by: 'sofia', status: 'submitted', scores: [5, 4, 5, 5],
      comment: 'Opens the conference. The two failed attempts are what make it a keynote rather than a vendor talk.' },
    { sub: 'feedback-loop', by: 'kenji', status: 'submitted', scores: [5, 3, 5, 4],
      comment: 'Nothing here is novel on its own. Nobody else is going to say it plainly to this audience.' },

    { sub: 'retrieval', by: 'amara', status: 'submitted', scores: [5, 4, 5, 4],
      comment: 'Strong. He gave a related talk here last year and the room was full; this is the follow-on, not a repeat.' },
    { sub: 'retrieval', by: 'priya', status: 'submitted', scores: [4, 4, 5, 4] },

    { sub: 'observability', by: 'kenji', status: 'submitted', scores: [4, 4, 4, 5],
      comment: 'Two speakers who disagree about sampling is a feature. Ask them to keep the disagreement in.' },
    { sub: 'observability', by: 'sofia', status: 'submitted', scores: [4, 3, 4, 4] },

    { sub: 'inference-cost', by: 'kenji', status: 'submitted', scores: [5, 4, 4, 4],
      comment: 'Order-of-operations framing is the useful part. Would pair well with the gateway talk if both get in.' },
    { sub: 'inference-cost', by: 'amara', status: 'submitted', scores: [4, 4, 4, 5] },

    { sub: 'eval-harness', by: 'amara', status: 'submitted', scores: [5, 4, 5, 4],
      comment: 'The only hands-on session in the pile, and they have clearly run it in a room before. Cap it at forty.' },
    // Sofia works with Elena and said so before reading it, which is what the
    // conflict_of_interest flag is for.
    { sub: 'eval-harness', by: 'sofia', status: 'declined', conflict: 1,
      comment: 'Recusing: Elena and I are on the same team.' },
    { sub: 'eval-harness', by: 'priya', status: 'submitted', scores: [5, 3, 5, 4] },

    { sub: 'hiring-panel', by: 'sofia', status: 'submitted', scores: [4, 3, 4, 4],
      comment: 'Panels are usually filler. This one has three people who have actually done it, so it is worth the slot.' },
    { sub: 'hiring-panel', by: 'kenji', status: 'submitted', scores: [3, 3, 4, 4] },

    { sub: 'gateway', by: 'amara', status: 'submitted', scores: [4, 4, 5, 4],
      comment: 'Eighteen months of migration told honestly is rarer than the gateway design itself. Accept.' },
    { sub: 'gateway', by: 'kenji', status: 'submitted', scores: [4, 4, 4, 3] },

    { sub: 'guardrails', by: 'sofia', status: 'submitted', scores: [4, 4, 4, 4],
      comment: 'Covers similar ground to the threat-model proposal. We should take one of the two, and this one has measurements.' },
    { sub: 'guardrails', by: 'priya', status: 'submitted', scores: [4, 3, 4, 4] },

    { sub: 'prompt-injection', by: 'amara', status: 'submitted', scores: [3, 3, 4, 4],
      comment: 'Good proposal, but it overlaps the guardrails talk almost exactly and that one is further along.' },
    { sub: 'prompt-injection', by: 'kenji', status: 'submitted', scores: [3, 2, 4, 4] },

    { sub: 'data-platform', by: 'sofia', status: 'submitted', scores: [2, 2, 3, 3],
      comment: 'A competent talk for a different conference. Nothing here is about the thing our audience came for.' },
    { sub: 'data-platform', by: 'amara', status: 'submitted', scores: [2, 2, 3, 3] },

    { sub: 'yaml', by: 'kenji', status: 'submitted', scores: [2, 3, 4, 4],
      comment: 'Funny, and he can hold a room. It is still not a Manzanita talk.' },
    { sub: 'yaml', by: 'priya', status: 'submitted', scores: [2, 2, 4, 3] },

    { sub: 'vendor-observability', by: 'amara', status: 'submitted', scores: [1, 1, 3, 3],
      comment: 'Product pitch with a case study attached. Decline, and point her at the CFS guidance for next year.' },
    // The AI pass: Diego ran every proposal through an assistant to get a first
    // read before the committee met. reviewer_person_id is NOT NULL, so a machine
    // review has to be filed under the human who ran it -- source = 'ai' is what
    // keeps it out of the human average.
    { sub: 'vendor-observability', by: 'diego', source: 'ai', status: 'submitted', scores: [1, 2, 3, 4],
      comment: 'Machine-assisted first read. Marketing register throughout ("full-stack", "40% faster"), a single vendor-supplied case study, and no failure described anywhere in the abstract. Flagged as a probable product pitch.' },

    // Still open. These four are why the review-progress screen is not all green.
    { sub: 'retry-loop', by: 'kenji', status: 'submitted', scores: [4, 3, 4, 5],
      comment: 'Eight minutes, one graph, a real outage. Take it.' },
    { sub: 'retry-loop', by: 'sofia', status: 'in_progress', scores: [4, 3] },
    { sub: 'property-testing', by: 'amara', status: 'in_progress', scores: [4] },
    { sub: 'property-testing', by: 'priya', status: 'assigned' },
    { sub: 'reviewing-model-code', by: 'sofia', status: 'assigned' },
    { sub: 'open-weights', by: 'kenji', status: 'assigned' },
  ];

  at('2026-07-09T17:00:00Z', () => {
    const insertReview = db.prepare(
      `INSERT INTO review (plan_id, submission_id, reviewer_person_id, source, status,
                           comment, conflict_of_interest, assigned_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    );
    const insertScore = db.prepare(
      'INSERT INTO score (review_id, criterion_id, value) VALUES (?, ?, ?)',
    );
    const order = ['relevance', 'originality', 'speaker-experience', 'clarity'];

    REVIEWS.forEach((r, i) => {
      // Reviews came back over the fortnight the plan was open rather than all
      // at once, so "review progress over time" is a curve and not a spike.
      const done = r.status === 'submitted' || r.status === 'declined';
      const row = insertReview.get(
        plan.id, sub[r.sub].id, p[r.by].id, r.source ?? 'human', r.status,
        r.comment ?? '', r.conflict ?? 0, now(),
        done ? plusDays('2026-07-13T18:00:00Z', i % 9) : null,
      );
      (r.scores ?? []).forEach((value, n) => insertScore.run(row.id, criterion[order[n]].id, value));
    });
  });

  // -------------------------------------------------------------------------
  // Decisions
  //
  // Two batches, on purpose. The July batch was decided and then notified, so
  // those rows are final and carry a notified_at. The August batch has been
  // decided and NOT notified: it is sitting in accept_queue and decline_queue
  // with notified_at NULL, which is exactly the list the notify screen works on.
  // -------------------------------------------------------------------------

  const JULY_ACCEPT = ['feedback-loop', 'retrieval', 'observability', 'inference-cost',
    'eval-harness', 'hiring-panel'];
  const JULY_DECLINE = ['yaml', 'vendor-observability'];

  at('2026-07-27T22:30:00Z', () => {
    decide(db, JULY_ACCEPT.map((k) => sub[k].id), 'accept', { actorPersonId: p.diego.id });
    decide(db, JULY_DECLINE.map((k) => sub[k].id), 'decline', { actorPersonId: p.diego.id });
  });

  at('2026-07-28T16:15:00Z', () => notify(db,
    [...JULY_ACCEPT, ...JULY_DECLINE].map((k) => sub[k].id),
    { actorPersonId: p.naomi.id, portalUrlFor: portalUrl }));

  at('2026-08-05T23:40:00Z', () => {
    decide(db, [sub.gateway.id, sub.guardrails.id], 'accept', { actorPersonId: p.diego.id });
    decide(db, [sub['prompt-injection'].id, sub['data-platform'].id], 'decline',
      { actorPersonId: p.diego.id });
  });

  // A regression guard, kept because this seed is the case that catches it.
  //
  // Person-level tasks have a NULL submission_id, and SQLite -- following the
  // SQL standard -- treats every NULL in a unique index as distinct from every
  // other. So the plain UNIQUE (definition_id, person_id, submission_id) never
  // deduped them, and a speaker on two accepted sessions collected two headshot
  // tasks, two agreements and two travel forms. Yusuf Karim is on SESS-2 and
  // SESS-3, so this seed trips that path every run.
  //
  // Migration 003 adds the partial unique index that says what was meant. If it
  // is ever dropped, the dashboard silently starts over-counting what speakers
  // owe -- the one number it exists to get right -- so fail loudly instead.
  duplicateTasks = db.prepare(
    `SELECT count(*) AS n FROM (
       SELECT definition_id, person_id FROM task_instance
        WHERE submission_id IS NULL
        GROUP BY definition_id, person_id HAVING count(*) > 1)`,
  ).get().n;

  if (duplicateTasks > 0) {
    throw new Error(
      `${duplicateTasks} person-level task(s) were assigned more than once. `
      + 'Migration 003 (task_instance_one_per_person) should make that impossible.',
    );
  }

  // -------------------------------------------------------------------------
  // The agenda
  //
  // Five of the six accepted sessions have a room and a time and are published.
  // The panel deliberately does not: it is the "1 accepted session still needs a
  // time slot" the dashboard is supposed to shout about.
  //
  // Two conflicts are planted so the Conflicts view is never empty on a fresh
  // database:
  //
  //   speaker double-booking  SESS-2 (Cypress, Mon 11:00-11:45) against SESS-3
  //     (Alder, Mon 11:30-12:15). Yusuf Karim is the sole speaker on one and a
  //     co-speaker on the other, which is exactly how this happens: whoever built
  //     the grid was looking at titles, not at participant lists.
  //
  //   room double-booking     SESS-4 (Cypress, Tue 14:00-14:45) against SESS-5
  //     (Cypress, Tue 14:30-16:30). The workshop was moved out of Madrone Studio
  //     late and nobody re-checked what was already in the room.
  //
  // Nothing else overlaps, so the view shows two conflicts and no noise.
  // -------------------------------------------------------------------------

  at('2026-08-06T18:00:00Z', () => {
    const place = (key, roomKey, day, from, to) => {
      db.prepare(
        `UPDATE submission SET room_id = ?, starts_at = ?, ends_at = ?, published = 1, updated_at = ?
          WHERE id = ?`,
      ).run(room[roomKey].id, pdt(day, from), pdt(day, to), now(), sub[key].id);
      logActivity(db, {
        eventId: event.id, actorPersonId: p.marcus.id, subjectType: 'submission',
        subjectId: sub[key].id, verb: 'scheduled',
        detail: `${room[roomKey].name}, ${day} ${from}-${to} PDT`,
      });
    };

    place('feedback-loop', 'redwood-hall', '2026-10-12', '09:30', '10:15');
    place('retrieval', 'cypress-room', '2026-10-12', '11:00', '11:45');
    place('observability', 'alder-room', '2026-10-12', '11:30', '12:15');
    place('inference-cost', 'cypress-room', '2026-10-13', '14:00', '14:45');
    place('eval-harness', 'cypress-room', '2026-10-13', '14:30', '16:30');
  });

  // Two accepted sessions carry a session id from the registration platform,
  // which is the one-way integration's only footprint on this table.
  at('2026-08-06T18:30:00Z', () => {
    for (const [key, id] of [['feedback-loop', 'AE-2026-1041'], ['retrieval', 'AE-2026-1042']]) {
      db.prepare('UPDATE submission SET client_session_id = ?, updated_at = ? WHERE id = ?')
        .run(id, now(), sub[key].id);
    }
    db.prepare('UPDATE submission SET ceu_credits = 0.3, updated_at = ? WHERE id = ?')
      .run(now(), sub['eval-harness'].id);
  });

  // -------------------------------------------------------------------------
  // What the speakers have done about it
  //
  // notify() already assigned every task. This is the ten days since: two people
  // are finished, three are partway, and the rest have not opened the portal --
  // which is the mix the "who still owes what" dashboard exists to show.
  // -------------------------------------------------------------------------

  const COMPLETED = [
    { person: 'meilin', task: 'speaker-agreement', on: '2026-07-28T20:12:00Z' },
    { person: 'meilin', task: 'headshot', on: '2026-07-28T20:20:00Z',
      file: { filename: 'mei-lin-chen-headshot.jpg', contentType: 'image/jpeg', bytes: 486_112 } },
    { person: 'meilin', task: 'travel-and-hotel', on: '2026-07-29T17:45:00Z',
      answers: { 'arrival-date': '2026-10-11', 'departure-date': '2026-10-13', 'hotel-needed': '1',
        'dietary-notes': 'Vegetarian. No other requirements.' } },
    { person: 'meilin', task: 'upload-slides', submission: 'feedback-loop', on: '2026-08-04T22:05:00Z',
      file: { filename: 'ten-minute-feedback-loop.pdf', contentType: 'application/pdf', bytes: 4_182_006 } },

    { person: 'hannah', task: 'speaker-agreement', on: '2026-07-29T09:30:00Z' },
    { person: 'hannah', task: 'headshot', on: '2026-07-29T09:34:00Z',
      file: { filename: 'hannah-reinhardt-headshot.jpg', contentType: 'image/jpeg', bytes: 512_884 } },
    { person: 'hannah', task: 'travel-and-hotel', on: '2026-07-29T09:41:00Z',
      answers: { 'arrival-date': '2026-10-12', 'departure-date': '2026-10-12', 'hotel-needed': '0',
        'dietary-notes': '' } },
    { person: 'hannah', task: 'upload-slides', submission: 'observability', on: '2026-08-03T19:18:00Z',
      file: { filename: 'observability-for-model-backed-services.pdf', contentType: 'application/pdf', bytes: 2_904_551 } },

    { person: 'yusuf', task: 'speaker-agreement', on: '2026-07-30T15:02:00Z' },
    { person: 'yusuf', task: 'headshot', on: '2026-08-02T21:47:00Z',
      file: { filename: 'yusuf-karim-headshot.png', contentType: 'image/png', bytes: 733_220 } },

    { person: 'elena', task: 'speaker-agreement', on: '2026-07-31T16:55:00Z' },
    { person: 'elena', task: 'travel-and-hotel', on: '2026-07-31T17:03:00Z',
      answers: { 'arrival-date': '2026-10-12', 'departure-date': '2026-10-14', 'hotel-needed': '1',
        'dietary-notes': 'Coeliac, and it does matter.' } },

    { person: 'lucas', task: 'speaker-agreement', on: '2026-08-04T13:20:00Z' },
  ];

  const findInstance = db.prepare(
    `SELECT ti.id FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
      WHERE td.event_id = ? AND td.slug = ? AND ti.person_id = ? AND ti.submission_id IS ?`,
  );

  for (const c of COMPLETED) {
    at(c.on, () => {
      const instance = findInstance.get(event.id, c.task, p[c.person].id,
        c.submission ? sub[c.submission].id : null);
      const file = c.file ? addFile(event.id, p[c.person].id, c.file) : null;
      completeTask(db, instance.id, { fileId: file?.id ?? null });

      // A headshot is also the person's profile picture, not only a finished
      // task, so the portal writes both.
      if (c.task === 'headshot') {
        db.prepare('UPDATE person SET headshot_file_id = ?, updated_at = ? WHERE id = ?')
          .run(file.id, now(), p[c.person].id);
      }

      for (const [slug, value] of Object.entries(c.answers ?? {})) {
        db.prepare('INSERT INTO task_answer (task_instance_id, field_id, value) VALUES (?, ?, ?)')
          .run(instance.id, travelField[slug].id, value);
      }
    });
  }

  clock = RealDate.parse(TODAY);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

/**
 * Where a speaker's portal lives.
 *
 * The real thing emails a single-use magic link. The seed uses the stable path
 * instead, because a fresh token in every seeded email would make two runs of
 * this script differ and the outbox undiffable.
 */
function portalUrl(person) {
  return `http://127.0.0.1:3000/portal/${person.slug}`;
}

// ---------------------------------------------------------------------------
// Summary
//
// Every number below is read back out of the database rather than counted while
// writing it, so if the seed and the schema ever disagree, this is where it shows.
// ---------------------------------------------------------------------------

const event = db.prepare("SELECT * FROM event WHERE slug = 'manzanita-2026'").get();
const past = db.prepare("SELECT * FROM event WHERE slug = 'manzanita-2025'").get();

const one = (sql, ...args) => db.prepare(sql).get(...args).n;

const statuses = db.prepare(
  `SELECT status, count(*) AS n FROM submission WHERE event_id = ? GROUP BY status
    ORDER BY CASE status
      WHEN 'draft' THEN 1 WHEN 'pending' THEN 2 WHEN 'accept_queue' THEN 3
      WHEN 'decline_queue' THEN 4 WHEN 'accepted' THEN 5 WHEN 'declined' THEN 6
      ELSE 7 END`,
).all(event.id);

// The two queries the Conflicts view is built on, run here so the planted
// conflicts are proved rather than asserted.
const roomConflicts = db.prepare(
  `SELECT a.code AS a, b.code AS b, r.name AS room
     FROM submission a
     JOIN submission b ON b.event_id = a.event_id AND b.id > a.id AND b.room_id = a.room_id
     JOIN room r ON r.id = a.room_id
    WHERE a.event_id = ? AND a.starts_at IS NOT NULL AND b.starts_at IS NOT NULL
      AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at
    ORDER BY a.code`,
).all(event.id);

const speakerConflicts = db.prepare(
  `SELECT a.code AS a, b.code AS b, p.first_name || ' ' || p.last_name AS who
     FROM submission a
     JOIN submission b ON b.event_id = a.event_id AND b.id > a.id
     JOIN submission_participant sa ON sa.submission_id = a.id
     JOIN submission_participant sb ON sb.submission_id = b.id AND sb.person_id = sa.person_id
     JOIN person p ON p.id = sa.person_id
    WHERE a.event_id = ? AND a.starts_at IS NOT NULL AND b.starts_at IS NOT NULL
      AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at
    ORDER BY a.code`,
).all(event.id);

const broken = db.prepare('PRAGMA foreign_key_check').all();
if (broken.length > 0) throw new Error(`seed left ${broken.length} broken foreign key reference(s)`);

const pad = (s) => String(s).padEnd(14);
console.log(`\n${event.name} seeded into ${DB_PATH}\n`);
console.log(`  ${pad('submissions')}${statuses.map((s) => `${s.status} ${s.n}`).join('   ')}`);
console.log(`  ${pad('agenda')}${one(
  `SELECT count(*) AS n FROM submission WHERE event_id = ? AND status = 'accepted' AND starts_at IS NOT NULL`, event.id,
)} of ${one(
  `SELECT count(*) AS n FROM submission WHERE event_id = ? AND status = 'accepted'`, event.id,
)} accepted sessions scheduled, ${one(
  `SELECT count(*) AS n FROM submission WHERE event_id = ? AND status = 'accepted' AND starts_at IS NULL`, event.id,
)} still needs a time slot`);
console.log(`  ${pad('to notify')}${one(
  `SELECT count(*) AS n FROM submission
    WHERE event_id = ? AND status IN ('accept_queue', 'decline_queue') AND notified_at IS NULL`, event.id,
)} decided but not yet told`);

for (const c of speakerConflicts) console.log(`  ${pad('conflict')}${c.a} and ${c.b}: ${c.who} is on both`);
for (const c of roomConflicts) console.log(`  ${pad('conflict')}${c.a} and ${c.b}: both in ${c.room}`);

console.log(`  ${pad('people')}${one('SELECT count(*) AS n FROM person')} (${
  db.prepare('SELECT role, count(*) AS n FROM event_membership WHERE event_id = ? GROUP BY role ORDER BY role')
    .all(event.id).map((r) => `${r.n} ${r.role}`).join(', ')})`);
console.log(`  ${pad('reviews')}${one(
  `SELECT count(*) AS n FROM review
    WHERE plan_id IN (SELECT id FROM evaluation_plan WHERE event_id = ?)`, event.id,
)} assigned, ${one(
  `SELECT count(*) AS n FROM review WHERE status = 'submitted'`,
)} submitted (${one(`SELECT count(*) AS n FROM review WHERE source = 'ai'`)} machine-assisted, ${one(
  `SELECT count(*) AS n FROM review WHERE status IN ('assigned', 'in_progress')`,
)} still open)`);
console.log(`  ${pad('tasks')}${one('SELECT count(*) AS n FROM task_instance')} assigned, ${one(
  `SELECT count(*) AS n FROM task_instance WHERE status = 'done'`,
)} done, ${one(`SELECT count(*) AS n FROM task_instance WHERE status = 'todo'`)} outstanding`);
console.log(`  ${pad('outbox')}${one('SELECT count(*) AS n FROM outbox')} messages (${
  db.prepare('SELECT kind, count(*) AS n FROM outbox GROUP BY kind ORDER BY kind')
    .all().map((r) => `${r.n} ${r.kind}`).join(', ')})`);
// Who came back is the CRM's reason to exist, so the summary answers it directly.
const lastYearsPeople =
  `SELECT DISTINCT sp.person_id
     FROM submission_participant sp JOIN submission s ON s.id = sp.submission_id
    WHERE s.event_id = ?`;

console.log(`  ${pad('last year')}${past.name}, ${one(
  `SELECT count(*) AS n FROM submission WHERE event_id = ? AND status = 'accepted'`, past.id,
)} accepted sessions; ${one(
  `SELECT count(DISTINCT sp.person_id) AS n
     FROM submission_participant sp JOIN submission s ON s.id = sp.submission_id
    WHERE s.event_id = ? AND sp.person_id IN (${lastYearsPeople})`, event.id, past.id,
)} of its speakers submitted again, ${one(
  `SELECT count(*) AS n FROM event_membership
    WHERE event_id = ? AND role = 'reviewer' AND person_id IN (${lastYearsPeople})`, event.id, past.id,
)} came back as a reviewer`);

console.log(`\n  Sign in as naomi.okafor@example.com (owner) or diego.herrera@example.com`);
console.log('  (organizer, programme chair). Speakers have no password either: every');
console.log('  address is @example.com and reaches its portal by magic link.\n');

db.close();
