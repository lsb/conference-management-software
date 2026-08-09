import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  storeVersion, versionsOf, addComment, commentsOn,
  setContentStatus, snapshot, revisionsOf, restoreRevision,
} from '../src/core/content.js';
import { createSubmission } from '../src/core/submissions.js';
import { newEvent, addPerson } from './helpers.js';

/** A minimal but honest PDF, so magic-byte checking is satisfied. */
function pdf(text = 'v1') {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
}

function upload(text, filename = 'deck.pdf') {
  return { filename, contentType: 'application/pdf', data: pdf(text) };
}

function seeded() {
  const { db, event } = newEvent();
  const person = addPerson(db);
  const submission = createSubmission(db, {
    eventId: event.id, title: 'Original title', description: 'Original description.',
    status: 'pending',
  });
  return { db, event, person, submission };
}

// --- versions --------------------------------------------------------------

test('a first upload is version 1 and is its own root', () => {
  const { db, event, person } = seeded();
  const file = storeVersion(db, { eventId: event.id, personId: person.id, upload: upload('v1') });

  assert.equal(file.version, 1);
  assert.equal(file.root_file_id, file.id);
  assert.equal(file.superseded_at, null);
});

test('re-uploading keeps the old file and marks it superseded', () => {
  const { db, event, person } = seeded();
  const first = storeVersion(db, { eventId: event.id, personId: person.id, upload: upload('v1') });
  const second = storeVersion(db, {
    eventId: event.id, personId: person.id, upload: upload('v2'), previousId: first.id,
  });

  assert.equal(second.version, 2);
  assert.equal(second.root_file_id, first.id, 'the lineage points at the first upload');

  const reloadedFirst = db.prepare('SELECT * FROM file WHERE id = ?').get(first.id);
  assert.ok(reloadedFirst, 'the old version still exists');
  assert.ok(reloadedFirst.superseded_at, 'and is marked superseded rather than deleted');
});

test('every version stays downloadable, newest first', () => {
  const { db, event, person } = seeded();
  let file = storeVersion(db, { eventId: event.id, personId: person.id, upload: upload('v1') });
  for (const text of ['v2', 'v3']) {
    file = storeVersion(db, {
      eventId: event.id, personId: person.id, upload: upload(text), previousId: file.id,
    });
  }

  const versions = versionsOf(db, file.id);
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  assert.equal(new Set(versions.map((v) => v.root_file_id)).size, 1);
});

test('asking any version for the lineage returns the whole lineage', () => {
  // An organizer who opened v1 from an old email should still see that v3 exists.
  const { db, event, person } = seeded();
  const first = storeVersion(db, { eventId: event.id, personId: person.id, upload: upload('v1') });
  const second = storeVersion(db, {
    eventId: event.id, personId: person.id, upload: upload('v2'), previousId: first.id,
  });

  assert.equal(versionsOf(db, first.id).length, 2);
  assert.equal(versionsOf(db, second.id).length, 2);
});

// --- comments --------------------------------------------------------------

test('a conversation about a file survives a new version of it', () => {
  const { db, event, person } = seeded();
  const first = storeVersion(db, { eventId: event.id, personId: person.id, upload: upload('v1') });
  addComment(db, first.id, person.id, 'Draft deck - final version coming Friday.');

  const second = storeVersion(db, {
    eventId: event.id, personId: person.id, upload: upload('v2'), previousId: first.id,
  });
  addComment(db, second.id, person.id, 'Thanks - please confirm the final version by Tuesday.');

  const thread = commentsOn(db, second.id);
  assert.equal(thread.length, 2, 'the conversation is about the deck, not about one upload of it');
  assert.deepEqual(thread.map((c) => c.version), [1, 2]);
  assert.match(thread[0].body, /coming Friday/);
});

test('comments carry an author and a timestamp', () => {
  const { db, event, person } = seeded();
  const file = storeVersion(db, { eventId: event.id, personId: person.id, upload: upload('v1') });
  addComment(db, file.id, person.id, 'Looks good.');

  const [comment] = commentsOn(db, file.id);
  assert.equal(comment.first_name, 'Ada');
  assert.match(comment.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

// --- approval --------------------------------------------------------------

test('approving records who approved it and when', () => {
  const { db, submission, person } = seeded();
  const after = setContentStatus(db, submission.id, 'approved', { actorPersonId: person.id });

  assert.equal(after.content_status, 'approved');
  assert.equal(after.content_approved_by_person_id, person.id);
  assert.ok(after.content_approved_at);
});

test('un-approving also unpublishes, so nothing marked not-ready stays public', () => {
  const { db, submission, person } = seeded();
  setContentStatus(db, submission.id, 'approved', { actorPersonId: person.id });
  db.prepare('UPDATE submission SET published = 1 WHERE id = ?').run(submission.id);

  const after = setContentStatus(db, submission.id, 'in_review', { actorPersonId: person.id });
  assert.equal(after.content_status, 'in_review');
  assert.equal(after.published, 0);
  assert.equal(after.content_approved_at, null);
});

test('approving does not publish on its own', () => {
  // Approval says the words are right; publishing says the world may read them.
  const { db, submission, person } = seeded();
  const after = setContentStatus(db, submission.id, 'approved', { actorPersonId: person.id });
  assert.equal(after.published, 0);
});

test('an unknown content status is refused by name', () => {
  const { db, submission } = seeded();
  assert.throws(() => setContentStatus(db, submission.id, 'live'),
    /unknown content status 'live'.*draft, in_review, approved/s);
});

// --- revisions -------------------------------------------------------------

test('a snapshot records what the content said before it changed', () => {
  const { db, submission, person } = seeded();
  snapshot(db, submission, { actorPersonId: person.id });
  db.prepare('UPDATE submission SET title = ? WHERE id = ?').run('A better title', submission.id);

  const [revision] = revisionsOf(db, submission.id);
  assert.equal(revision.title, 'Original title');
  assert.equal(revision.first_name, 'Ada');
});

test('restoring puts the content back and is itself undoable', () => {
  const { db, submission, person } = seeded();

  snapshot(db, submission, { actorPersonId: person.id });
  db.prepare('UPDATE submission SET title = ?, description = ? WHERE id = ?')
    .run('Edited title', 'Edited description.', submission.id);

  const [original] = revisionsOf(db, submission.id);
  const restored = restoreRevision(db, submission.id, original.id, { actorPersonId: person.id });

  assert.equal(restored.title, 'Original title');
  assert.equal(restored.description, 'Original description.');

  // The edit that was undone is still in the history, so the undo can be undone.
  const history = revisionsOf(db, submission.id);
  assert.equal(history.length, 2);
  assert.ok(history.some((r) => r.title === 'Edited title'),
    'restoring snapshots the state it replaced rather than discarding it');
});

test('restoring a revision from another submission is refused', () => {
  const { db, event, submission, person } = seeded();
  const other = createSubmission(db, { eventId: event.id, title: 'Someone else', status: 'pending' });
  const foreign = snapshot(db, other, { actorPersonId: person.id });

  assert.throws(() => restoreRevision(db, submission.id, foreign.id),
    /does not belong to that submission/);
});

test('two successive edits produce two restorable points', () => {
  const { db, submission, person } = seeded();

  snapshot(db, submission, { actorPersonId: person.id });
  db.prepare('UPDATE submission SET description = ? WHERE id = ?')
    .run('Original description. Now includes a live demo.', submission.id);

  const afterFirst = db.prepare('SELECT * FROM submission WHERE id = ?').get(submission.id);
  snapshot(db, afterFirst, { actorPersonId: person.id });
  db.prepare('UPDATE submission SET description = ? WHERE id = ?')
    .run('Original description. Now includes a live demo. Bring a laptop.', submission.id);

  const history = revisionsOf(db, submission.id);
  assert.equal(history.length, 2);

  // Restoring the most recent snapshot should undo only the last edit.
  const restored = restoreRevision(db, submission.id, history[0].id);
  assert.match(restored.description, /live demo/);
  assert.doesNotMatch(restored.description, /laptop/);
});
