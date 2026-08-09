import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchPeople, personHistory, addNote, notesOn, addTag, tagsOn, removeTag,
  findDuplicates, mergePeople, saveSegment, runSegment,
  stages, board, enroll, moveCard, movesFor,
} from '../src/core/crm.js';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { newEvent, addPerson, addSpeaker, addTaskDefinition } from './helpers.js';
import { now } from '../src/db.js';

/** Two events and three people, one of whom has spoken at both. */
function directory() {
  const { db, event } = newEvent({ slug: 'conf-2026', name: 'Conf 2026' });
  const t = now();
  const past = db.prepare(
    `INSERT INTO event (slug, name, timezone, starts_at, ends_at, created_at, updated_at)
     VALUES ('conf-2025', 'Conf 2025', 'UTC', '2025-10-06T09:00:00Z', '2025-10-07T17:00:00Z', ?, ?)
     RETURNING *`,
  ).get(t, t);

  const regular = addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' });
  const newcomer = addPerson(db, { first: 'Grace', last: 'Hopper', email: 'grace@example.com' });
  const stranger = addPerson(db, { first: 'Alan', last: 'Turing', email: 'alan@example.com' });

  db.prepare("UPDATE person SET company = 'Latticework', job_title = 'Principal Engineer' WHERE id = ?")
    .run(regular.id);

  for (const eventId of [past.id, event.id]) {
    const sub = createSubmission(db, { eventId, title: 'A talk', status: 'pending' });
    addSpeaker(db, sub.id, regular.id, { primary: true });
    decide(db, [sub.id], 'accept');
    notify(db, [sub.id]);
  }

  // Grace submitted but was never accepted; Alan has never submitted at all.
  const rejected = createSubmission(db, { eventId: event.id, title: 'Maybe next year', status: 'pending' });
  addSpeaker(db, rejected.id, newcomer.id, { primary: true });

  return { db, event, past, regular, newcomer, stranger };
}

// --- directory -------------------------------------------------------------

test('the directory spans events, which is the whole point', () => {
  const { db, regular } = directory();
  const [ada] = searchPeople(db, { query: 'Lovelace' });

  assert.equal(ada.id, regular.id);
  assert.equal(ada.events_spoken, 2, 'one person row, two conferences');
  assert.equal(ada.submissions, 2);
});

test('search covers name, email, company, and job title', () => {
  const { db } = directory();
  for (const query of ['Lovelace', 'ada@example', 'Latticework', 'Principal']) {
    assert.equal(searchPeople(db, { query }).length, 1, `searching '${query}' should find Ada`);
  }
});

test('never-spoken finds the people worth inviting', () => {
  const { db } = directory();
  const names = searchPeople(db, { neverSpoken: true }).map((p) => p.last_name).sort();
  assert.deepEqual(names, ['Hopper', 'Turing'],
    'somebody who submitted and was not accepted has still never spoken');
});

test('filtering by an event finds who spoke there', () => {
  const { db, past } = directory();
  assert.deepEqual(searchPeople(db, { spokeAtEventId: past.id }).map((p) => p.last_name),
    ['Lovelace']);
});

test('history lists every event a person has been part of, newest first', () => {
  const { db, regular } = directory();
  const history = personHistory(db, regular.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].event_slug, 'conf-2026', 'newest first');
});

// --- notes and tags --------------------------------------------------------

test('notes persist and carry their author', () => {
  const { db, regular, newcomer } = directory();
  addNote(db, regular.id, newcomer.id, 'Great on stage; needs a hard deadline for slides.');

  const [note] = notesOn(db, regular.id);
  assert.match(note.body, /hard deadline/);
  assert.equal(note.first_name, 'Grace');
});

test('tags are added once, listed, and removed', () => {
  const { db, regular } = directory();
  addTag(db, regular.id, 'keynote material');
  addTag(db, regular.id, 'keynote material');
  addTag(db, regular.id, 'local');

  assert.deepEqual(tagsOn(db, regular.id), ['keynote material', 'local']);
  removeTag(db, regular.id, 'local');
  assert.deepEqual(tagsOn(db, regular.id), ['keynote material']);
});

test('a blank tag is not stored', () => {
  const { db, regular } = directory();
  assert.equal(addTag(db, regular.id, '   '), null);
  assert.deepEqual(tagsOn(db, regular.id), []);
});

test('tags narrow the directory', () => {
  const { db, regular } = directory();
  addTag(db, regular.id, 'keynote material');
  assert.deepEqual(searchPeople(db, { tag: 'keynote material' }).map((p) => p.last_name),
    ['Lovelace']);
  assert.deepEqual(searchPeople(db, { tag: 'nobody-has-this' }), []);
});

// --- segments --------------------------------------------------------------

test('a segment keeps answering the question rather than freezing an answer', () => {
  const { db, regular } = directory();
  const segment = saveSegment(db, { name: 'Never invited', neverSpoken: true });

  assert.equal(runSegment(db, segment).length, 2);

  // Grace now speaks, so she should drop out of the segment by herself.
  const sub = createSubmission(db, { eventId: 1, title: 'She made it', status: 'pending' });
  const grace = db.prepare("SELECT id FROM person WHERE email = 'grace@example.com'").get();
  db.prepare(`INSERT INTO submission_participant (submission_id, person_id, role)
              VALUES (?, ?, 'speaker')`).run(sub.id, grace.id);
  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);

  assert.deepEqual(runSegment(db, segment).map((p) => p.last_name), ['Turing']);
});

test('segments with the same name get distinct slugs', () => {
  const { db } = directory();
  const a = saveSegment(db, { name: 'AI Experts', tag: 'ai' });
  const b = saveSegment(db, { name: 'AI Experts', tag: 'ml' });
  assert.notEqual(a.slug, b.slug);
});

// --- duplicates and merging ------------------------------------------------

test('duplicates are found by name, because email cannot find them', () => {
  const { db } = directory();
  addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@personal.example.com' });

  const dupes = findDuplicates(db);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].n, 2);
  assert.match(dupes[0].name, /ada lovelace/);
});

test('merging keeps everything the loser owned', () => {
  const { db, event, regular } = directory();
  const dupe = addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@personal.example.com' });

  // Give the duplicate a submission, a note, a tag, and a task.
  const sub = createSubmission(db, { eventId: event.id, title: 'From the other address', status: 'pending' });
  addSpeaker(db, sub.id, dupe.id, { primary: true });
  addNote(db, dupe.id, null, 'Wrote in from a personal address.');
  addTag(db, dupe.id, 'duplicate-source');
  addTaskDefinition(db, event.id, { slug: 'headshot', appliesTo: 'person', requirement: 'file' });
  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);

  const tasksBefore = db.prepare('SELECT count(*) AS n FROM task_instance WHERE person_id = ?')
    .get(dupe.id).n;
  assert.ok(tasksBefore > 0, 'the duplicate should own something worth preserving');

  mergePeople(db, regular.id, dupe.id);

  assert.equal(db.prepare('SELECT 1 FROM person WHERE id = ?').get(dupe.id), undefined,
    'the duplicate is gone');
  assert.ok(personHistory(db, regular.id).some((h) => h.title === 'From the other address'),
    'their submission moved across');
  assert.ok(tagsOn(db, regular.id).includes('duplicate-source'));
  assert.ok(notesOn(db, regular.id).some((n) => /personal address/.test(n.body)));
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_instance WHERE person_id = ?')
    .get(regular.id).n >= tasksBefore, true, 'their tasks moved across');
});

test('merging records the address that was folded in', () => {
  const { db, regular } = directory();
  const dupe = addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@personal.example.com' });
  mergePeople(db, regular.id, dupe.id);

  assert.ok(notesOn(db, regular.id).some((n) => n.body.includes('ada@personal.example.com')),
    'the other address is how they will write to us next time');
});

test('merging fills blanks but never overwrites what the survivor already had', () => {
  const { db } = directory();
  const keep = addPerson(db, { first: 'Sam', last: 'Reed', email: 'sam@example.com' });
  db.prepare("UPDATE person SET company = 'Acme', biography = '' WHERE id = ?").run(keep.id);

  const dupe = addPerson(db, { first: 'Sam', last: 'Reed', email: 'sam@other.example.com' });
  db.prepare("UPDATE person SET company = 'Other Co', biography = 'Writes things.' WHERE id = ?")
    .run(dupe.id);

  mergePeople(db, keep.id, dupe.id);
  const after = db.prepare('SELECT * FROM person WHERE id = ?').get(keep.id);

  assert.equal(after.company, 'Acme', 'the survivor keeps what it had');
  assert.equal(after.biography, 'Writes things.', 'and inherits what it lacked');
});

test('merging somebody into themselves is refused', () => {
  const { db, regular } = directory();
  assert.throws(() => mergePeople(db, regular.id, regular.id), /into themselves/);
});

test('a duplicate on the same submission collapses rather than doubling', () => {
  const { db, event, regular } = directory();
  const dupe = addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@personal.example.com' });

  const sub = createSubmission(db, { eventId: event.id, title: 'Co-written', status: 'pending' });
  addSpeaker(db, sub.id, regular.id, { primary: true });
  addSpeaker(db, sub.id, dupe.id, { order: 1 });

  mergePeople(db, regular.id, dupe.id);

  const { n } = db.prepare(
    'SELECT count(*) AS n FROM submission_participant WHERE submission_id = ?',
  ).get(sub.id);
  assert.equal(n, 1, 'the same person is not listed twice on their own talk');
});

// --- pipeline --------------------------------------------------------------

test('the board has its stages even after a wipe', () => {
  const { db } = directory();
  db.exec('DELETE FROM pipeline_stage');
  assert.equal(stages(db).length, 6);
  assert.equal(board(db).length, 6);
});

test('enrolling puts somebody in a stage and records the move', () => {
  const { db, stranger } = directory();
  const card = enroll(db, { personId: stranger.id, score: 85, rationale: 'Strong track record.' });

  assert.equal(card.score, 85);
  const moves = movesFor(db, card.id);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to_name, 'Identified');
  assert.equal(moves[0].from_name, null, 'nothing to come from');
});

test('enrolling twice does not duplicate a card', () => {
  const { db, stranger } = directory();
  const first = enroll(db, { personId: stranger.id });
  const second = enroll(db, { personId: stranger.id });
  assert.equal(first.id, second.id);
});

test('moving records who moved it and from where', () => {
  const { db, stranger } = directory();
  const card = enroll(db, { personId: stranger.id });

  moveCard(db, card.id, 'contacted', { note: 'Left a voicemail.' });
  moveCard(db, card.id, 'interested');

  const moves = movesFor(db, card.id);
  assert.deepEqual(moves.map((m) => m.to_name), ['Identified', 'Contacted', 'Interested']);
  assert.equal(moves[1].from_name, 'Identified');
  assert.match(moves[1].note, /voicemail/);
});

test('moving to a stage that does not exist names the ones that do', () => {
  const { db, stranger } = directory();
  const card = enroll(db, { personId: stranger.id });
  assert.throws(() => moveCard(db, card.id, 'ghosted'),
    /no pipeline stage 'ghosted'.*identified, researching/s);
});

test('moving to the stage somebody is already in changes nothing', () => {
  const { db, stranger } = directory();
  const card = enroll(db, { personId: stranger.id, stageSlug: 'contacted' });
  moveCard(db, card.id, 'contacted');
  assert.equal(movesFor(db, card.id).length, 1, 'no phantom move recorded');
});
