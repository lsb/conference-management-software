import { openDatabase, now } from '../src/db.js';

/** An in-memory database with one event, ready for tests to build on. */
export function newEvent({ name = 'Conf 2026', slug = 'conf-2026' } = {}) {
  const db = openDatabase(':memory:');
  const t = now();
  const event = db.prepare(
    `INSERT INTO event (slug, name, timezone, starts_at, ends_at, created_at, updated_at)
     VALUES (?, ?, 'America/Los_Angeles', '2026-10-12T16:00:00Z', '2026-10-14T24:00:00Z', ?, ?)
     RETURNING *`,
  ).get(slug, name, t, t);
  return { db, event };
}

export function addPerson(db, { first = 'Ada', last = 'Lovelace', email = 'ada@example.com' } = {}) {
  const t = now();
  return db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(`${first}-${last}`.toLowerCase(), email, first, last, t, t);
}

export function addSpeaker(db, submissionId, personId, { primary = false, order = 0 } = {}) {
  db.prepare(
    `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
     VALUES (?, ?, 'speaker', ?, ?)`,
  ).run(submissionId, personId, primary ? 1 : 0, order);
}

export function addTaskDefinition(db, eventId, {
  slug = 'upload-slides', title = 'Upload your slides', appliesTo = 'submission',
  requirement = 'file', dueAt = null, assignWhen = 'on_accept', required = 1,
} = {}) {
  return db.prepare(
    `INSERT INTO task_definition (event_id, slug, title, applies_to, requirement, due_at, assign_when, required)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, slug, title, appliesTo, requirement, dueAt, assignWhen, required);
}

export function outboxFor(db, { kind = null } = {}) {
  return kind
    ? db.prepare('SELECT * FROM outbox WHERE kind = ? ORDER BY id').all(kind)
    : db.prepare('SELECT * FROM outbox ORDER BY id').all();
}

/** An ISO timestamp `days` away from `from`, for time-travelling tests. */
export function daysFrom(from, days) {
  return new Date(Date.parse(from) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
