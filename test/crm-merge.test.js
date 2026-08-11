// Folding two records for the same human into one.
//
// `POST /crm/merge` and `mergePeople` had no test between them, which is a
// strange thing to discover about the only operation in this app that deletes a
// person. It reassigns twenty-odd kinds of row and then drops one; every kind
// it forgets is either destroyed by ON DELETE CASCADE or quietly anonymised by
// ON DELETE SET NULL, and neither says a word.
//
// It forgot eleven of them. The two rules worth stating, because the next
// column added to `person` will need them:
//
//   Anything the loser OWNED belongs to the survivor -- including how they sign
//   in. Cascade is the right rule for a person leaving and the wrong one here,
//   because this human has not left.
//
//   Anything the loser AUTHORED stays attributed to them, which now means the
//   survivor. "Ada decided this" must not become "somebody decided this" as a
//   side effect of tidying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, post, failure } from './http-helpers.js';
import { mergePeople } from '../src/core/crm.js';
import { createApiToken, createMagicLink } from '../src/core/auth.js';
import { now } from '../src/db.js';

/** Two records for one human, with everything hanging off the duplicate. */
function twoRecordsOfAda(app) {
  const db = app.db;
  const t = now();
  const event = db.prepare(
    `INSERT INTO event (slug, name, timezone, starts_at, ends_at, created_at, updated_at)
     VALUES ('m-2027', 'M', 'UTC', '2027-05-12T00:00:00Z', '2027-05-13T00:00:00Z', ?, ?)
     RETURNING *`).get(t, t);

  const person = (slug, email) => db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, 'Ada', 'Lovelace', ?, ?) RETURNING *`).get(slug, email, t, t);

  const keep = person('ada-lovelace', 'ada@work.example');
  const dupe = person('a-lovelace', 'a.lovelace@work.example');

  db.prepare('INSERT INTO person_credential (person_id, password_hash, updated_at) VALUES (?, ?, ?)')
    .run(dupe.id, 'scrypt$fake', t);
  createApiToken(db, dupe.id, 'laptop');
  createMagicLink(db, dupe.id, event.id);
  db.prepare('INSERT INTO auth_session (person_id, token_hash, created_at, expires_at) VALUES (?,?,?,?)')
    .run(dupe.id, 'a-session-hash', t, '2030-01-01T00:00:00Z');

  const plan = db.prepare(
    `INSERT INTO evaluation_plan (event_id, slug, name, created_at)
     VALUES (?, 'p1', 'Plan', ?) RETURNING *`).get(event.id, t);
  db.prepare('INSERT INTO plan_reviewer (plan_id, person_id, added_at) VALUES (?, ?, ?)')
    .run(plan.id, dupe.id, t);

  db.prepare(
    `INSERT INTO activity (event_id, actor_person_id, subject_type, subject_id, verb, detail, created_at)
     VALUES (?, ?, 'submission', 1, 'decided', '', ?)`).run(event.id, dupe.id, t);

  // The event is inserted directly, so the signed-in organizer never picked up
  // a membership from creating it. The speaker directory spans events anyway,
  // and an instance admin is who reaches it.
  if (app.signedInAs) {
    db.prepare('UPDATE person SET is_admin = 1 WHERE id = ?').run(app.signedInAs.id);
  }

  return { db, event, keep, dupe, plan };
}

const countFor = (db, table, column, id) => db.prepare(
  `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n;

test('a merged person keeps the way they sign in', () => {
  const app = newApp();
  const { db, keep, dupe } = twoRecordsOfAda(app);

  mergePeople(db, keep.id, dupe.id);

  assert.equal(countFor(db, 'person_credential', 'person_id', keep.id), 1,
    'the password was on the duplicate record, and merging destroyed it');
  assert.equal(countFor(db, 'api_token', 'person_id', keep.id), 1,
    'their scripts stopped working and nothing said why');
  assert.equal(countFor(db, 'auth_session', 'person_id', keep.id), 1);
  assert.equal(countFor(db, 'magic_link', 'person_id', keep.id), 1,
    'the portal link already in their inbox must not start answering 410');
});

test('the survivor keeps its own password rather than inheriting one', () => {
  const app = newApp();
  const { db, keep, dupe } = twoRecordsOfAda(app);
  db.prepare('INSERT INTO person_credential (person_id, password_hash, updated_at) VALUES (?, ?, ?)')
    .run(keep.id, 'scrypt$the-one-they-use', now());

  mergePeople(db, keep.id, dupe.id);

  const credential = db.prepare('SELECT password_hash FROM person_credential WHERE person_id = ?')
    .get(keep.id);
  assert.equal(credential.password_hash, 'scrypt$the-one-they-use',
    'the surviving record is the one they log into; its password is the one to trust');
  assert.equal(db.prepare('SELECT count(*) AS n FROM person_credential').get().n, 1,
    'and the other is gone, not left pointing at a person who no longer exists');
});

test('reviewing duty follows the person, rather than cascading away', () => {
  const app = newApp();
  const { db, keep, dupe, plan } = twoRecordsOfAda(app);

  mergePeople(db, keep.id, dupe.id);

  const reviewers = db.prepare('SELECT person_id FROM plan_reviewer WHERE plan_id = ?').all(plan.id);
  assert.deepEqual(reviewers.map((r) => r.person_id), [keep.id],
    'a plan quietly losing a reviewer surfaces weeks later as a round that will not close');
});

test('what they did stays attributed to them', () => {
  const app = newApp();
  const { db, keep, dupe } = twoRecordsOfAda(app);

  mergePeople(db, keep.id, dupe.id);

  assert.equal(countFor(db, 'activity', 'actor_person_id', keep.id), 1,
    '"Ada decided this" must not become "somebody decided this"');
  assert.equal(db.prepare('SELECT count(*) AS n FROM activity WHERE actor_person_id IS NULL').get().n, 0);
});

test('a merge that cannot finish changes nothing', () => {
  const app = newApp();
  const { db, keep, dupe, plan } = twoRecordsOfAda(app);
  const before = db.prepare('SELECT count(*) AS n FROM person').get().n;

  // Break a table the merge touches part way through. Reviewing duty has
  // already been moved by the time this is reached, which is the point: the
  // assertion below has to be about something that DID change before the
  // failure, or it passes whether or not anything rolls back.
  db.exec('DROP TABLE person_note');

  assert.throws(() => mergePeople(db, keep.id, dupe.id));

  assert.equal(db.prepare('SELECT count(*) AS n FROM person').get().n, before,
    'the duplicate must still be here');
  assert.deepEqual(
    db.prepare('SELECT person_id FROM plan_reviewer WHERE plan_id = ?').all(plan.id)
      .map((r) => r.person_id),
    [dupe.id],
    'a half-finished merge leaves a human split across two records with no sign of it');
});

test('merging over HTTP needs an organizer and refuses to merge somebody into themselves', async () => {
  const app = newApp();
  const { keep, dupe } = twoRecordsOfAda(app);

  const stranger = await failure(post(app, '/crm/merge',
    { keep: keep.slug, merge: dupe.slug }, { cookies: {} }));
  assert.equal(stranger.status, 403);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM person').get().n, 3,
    'the two of them plus the test organizer: nobody was merged');

  const itself = await failure(post(app, '/crm/merge', { keep: keep.slug, merge: keep.slug }));
  assert.equal(itself.status, 400);
});

test('merging over HTTP folds the duplicate in', async () => {
  const app = newApp();
  const { keep, dupe } = twoRecordsOfAda(app);

  await post(app, '/crm/merge', { keep: keep.slug, merge: dupe.slug });

  assert.equal(app.db.prepare('SELECT count(*) AS n FROM person WHERE slug = ?').get(dupe.slug).n, 0);
  assert.equal(countFor(app.db, 'api_token', 'person_id', keep.id), 1);
});
