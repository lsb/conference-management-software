import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, now, slugify, uniqueSlug } from '../src/db.js';

/** A database with one event and one person, for tests that need a starting point. */
function fixture() {
  const db = openDatabase(':memory:');
  const t = now();
  db.prepare(
    `INSERT INTO event (slug, name, timezone, created_at, updated_at)
     VALUES ('conf-2026', 'Conf 2026', 'America/Los_Angeles', ?, ?)`,
  ).run(t, t);
  db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
     VALUES ('ada-lovelace', 'ada@example.com', 'Ada', 'Lovelace', ?, ?)`,
  ).run(t, t);
  return db;
}

function addSubmission(db, { code = 'SESS-1', status = 'pending' } = {}) {
  const t = now();
  return db
    .prepare(
      `INSERT INTO submission (event_id, code, title, status, created_at, updated_at)
       VALUES (1, ?, 'A talk', ?, ?, ?) RETURNING id`,
    )
    .get(code, status, t, t).id;
}

test('migrations apply cleanly and leave the database consistent', () => {
  const db = openDatabase(':memory:');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  // Assert the shape rather than a literal list, so adding a migration does not
  // require editing this test.
  const applied = db.prepare('SELECT name FROM schema_migration ORDER BY name')
    .all().map((r) => r.name);
  assert.ok(applied.includes('001_initial.sql'));
  assert.deepEqual(applied, [...applied].sort(), 'migrations apply in filename order');
  assert.ok(applied.every((n) => /^\d{3}_\w+\.sql$/.test(n)), 'migrations are numbered');
});

test('migrations are idempotent', () => {
  const db = openDatabase(':memory:');
  const before = db.prepare('SELECT count(*) AS n FROM schema_migration').get().n;
  // Re-running the migrator against the same handle must be a no-op.
  assert.deepEqual(migrate(db), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migration').get().n, before);
});

test('forward-declared foreign keys resolve (person.headshot_file_id -> file)', () => {
  const db = fixture();
  const t = now();
  const fileId = db
    .prepare(
      `INSERT INTO file (slug, event_id, filename, content_type, byte_size, sha256, storage_path, created_at)
       VALUES ('ada-headshot', 1, 'ada.jpg', 'image/jpeg', 1024, 'abc', 'ada.jpg', ?)
       RETURNING id`,
    )
    .get(t).id;

  db.prepare('UPDATE person SET headshot_file_id = ? WHERE id = 1').run(fileId);
  assert.equal(db.prepare('SELECT headshot_file_id AS f FROM person WHERE id = 1').get().f, fileId);

  // And a dangling reference is refused, which proves the constraint is live.
  assert.throws(() => db.prepare('UPDATE person SET headshot_file_id = 999 WHERE id = 1').run(),
    /FOREIGN KEY/i);
});

test('submission status is limited to the documented state machine', () => {
  const db = fixture();
  for (const status of ['draft', 'pending', 'accept_queue', 'decline_queue',
    'accepted', 'declined', 'withdrawn']) {
    assert.doesNotThrow(() => addSubmission(db, { code: `SESS-${status}`, status }),
      `${status} should be a legal status`);
  }
  assert.throws(() => addSubmission(db, { code: 'SESS-BAD', status: 'waitlist' }),
    /CHECK constraint/i);
});

test('session codes are unique within an event but not across events', () => {
  const db = fixture();
  addSubmission(db, { code: 'SESS-1' });
  assert.throws(() => addSubmission(db, { code: 'SESS-1' }), /UNIQUE/i);

  const t = now();
  db.prepare(
    `INSERT INTO event (slug, name, timezone, created_at, updated_at)
     VALUES ('conf-2027', 'Conf 2027', 'UTC', ?, ?)`,
  ).run(t, t);
  assert.doesNotThrow(() =>
    db.prepare(
      `INSERT INTO submission (event_id, code, title, status, created_at, updated_at)
       VALUES (2, 'SESS-1', 'Another talk', 'pending', ?, ?)`,
    ).run(t, t));
});

test('a person is shared across events, which is what makes the CRM work', () => {
  const db = fixture();
  const t = now();
  db.prepare(
    `INSERT INTO event (slug, name, timezone, created_at, updated_at)
     VALUES ('conf-2027', 'Conf 2027', 'UTC', ?, ?)`,
  ).run(t, t);

  const a = addSubmission(db, { code: 'SESS-1' });
  const b = db.prepare(
    `INSERT INTO submission (event_id, code, title, status, created_at, updated_at)
     VALUES (2, 'SESS-1', 'Next year', 'pending', ?, ?) RETURNING id`,
  ).get(t, t).id;

  for (const id of [a, b]) {
    db.prepare(
      `INSERT INTO submission_participant (submission_id, person_id, role) VALUES (?, 1, 'speaker')`,
    ).run(id);
  }

  const events = db.prepare(
    `SELECT count(DISTINCT s.event_id) AS n
       FROM submission_participant sp JOIN submission s ON s.id = sp.submission_id
      WHERE sp.person_id = 1`,
  ).get().n;
  assert.equal(events, 2, 'one person row should span both events');

  // Duplicate email is refused, so the same human cannot fork into two records.
  assert.throws(() =>
    db.prepare(
      `INSERT INTO person (slug, email, created_at, updated_at) VALUES ('ada-2', 'ADA@example.com', ?, ?)`,
    ).run(t, t), /UNIQUE/i);
});

test('deleting an event does not delete the people who spoke at it', () => {
  const db = fixture();
  const id = addSubmission(db);
  db.prepare(`INSERT INTO submission_participant (submission_id, person_id, role)
              VALUES (?, 1, 'speaker')`).run(id);

  db.prepare('DELETE FROM event WHERE id = 1').run();
  assert.equal(db.prepare('SELECT count(*) AS n FROM submission').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM person').get().n, 1);
});

test('slugify produces stable, readable, URL-safe identifiers', () => {
  assert.equal(slugify('Opening Keynote'), 'opening-keynote');
  assert.equal(slugify('  Ada  Lovelace  '), 'ada-lovelace');
  assert.equal(slugify('Café & Crème'), 'cafe-creme');
  assert.equal(slugify('AI/ML: The Good Parts!'), 'ai-ml-the-good-parts');
  assert.equal(slugify(''), 'item', 'never returns an empty slug');
  assert.equal(slugify('a'.repeat(200)).length, 60);
  assert.match(slugify('---'), /^[a-z0-9-]+$/);
});

test('uniqueSlug suffixes until it finds a free slug', () => {
  const taken = new Set(['opening-keynote', 'opening-keynote-2']);
  assert.equal(uniqueSlug('Opening Keynote', (s) => taken.has(s)), 'opening-keynote-3');
  assert.equal(uniqueSlug('Closing Keynote', (s) => taken.has(s)), 'closing-keynote');
});

test('now() is ISO-8601 UTC to the second, so timestamps sort as strings', () => {
  const t = now();
  assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(new Date(t).getTime() > 0);
});
