import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubmission, setStatus, decide, notify, canTransition, peekNextCode,
  TransitionError, awaitingNotification, pendingDecisions,
} from '../src/core/submissions.js';
import { newEvent, addPerson, addSpeaker, addTaskDefinition, outboxFor } from './helpers.js';

/** An event with one pending submission by one speaker. */
function pendingSubmission(opts = {}) {
  const { db, event } = newEvent();
  const person = addPerson(db, opts.person);
  const sub = createSubmission(db, {
    eventId: event.id, title: 'A talk about SQLite', status: 'pending',
    submittedByPersonId: person.id,
  });
  addSpeaker(db, sub.id, person.id, { primary: true });
  return { db, event, person, sub };
}

test('codes are sequential and human-sized', () => {
  const { db, event } = newEvent();
  assert.equal(peekNextCode(db, event.id), 'SESS-1');
  assert.equal(createSubmission(db, { eventId: event.id, title: 'One' }).code, 'SESS-1');
  assert.equal(createSubmission(db, { eventId: event.id, title: 'Two' }).code, 'SESS-2');
  assert.equal(peekNextCode(db, event.id), 'SESS-3');
});

test('a deleted code is retired, never handed to the next submission', () => {
  const { db, event } = newEvent();
  createSubmission(db, { eventId: event.id, title: 'One' });
  createSubmission(db, { eventId: event.id, title: 'Two' });

  db.prepare("DELETE FROM submission WHERE code = 'SESS-2'").run();

  // SESS-2 is already in somebody's inbox. Reusing it would point them at a
  // different session.
  assert.equal(createSubmission(db, { eventId: event.id, title: 'Three' }).code, 'SESS-3');
});

test('codes are allocated per event, so each event starts at 1', () => {
  const { db, event } = newEvent();
  const other = newEvent({ slug: 'conf-2027', name: 'Conf 2027' });
  createSubmission(db, { eventId: event.id, title: 'One' });
  createSubmission(db, { eventId: event.id, title: 'Two' });
  assert.equal(peekNextCode(db, event.id), 'SESS-3');
  assert.equal(peekNextCode(other.db, other.event.id), 'SESS-1');
});

test('a decision can never skip the queue and reach a speaker unannounced', () => {
  assert.ok(!canTransition('pending', 'accepted'));
  assert.ok(!canTransition('pending', 'declined'));
  assert.ok(canTransition('pending', 'accept_queue'));
  assert.ok(canTransition('accept_queue', 'accepted'));

  const { db, sub } = pendingSubmission();
  assert.throws(() => setStatus(db, sub.id, 'accepted'), TransitionError);
});

test('an illegal transition explains what would have been legal', () => {
  const { db, sub } = pendingSubmission();
  try {
    setStatus(db, sub.id, 'accepted');
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /cannot move a submission from 'pending' to 'accepted'/);
    assert.match(err.message, /accept_queue/, 'names the legal alternatives');
  }
});

test('deciding records the decision and sends nothing', () => {
  const { db, sub } = pendingSubmission();

  decide(db, [sub.id], 'accept');
  const after = db.prepare('SELECT * FROM submission WHERE id = ?').get(sub.id);
  assert.equal(after.status, 'accept_queue');
  assert.ok(after.decided_at, 'decision is timestamped');
  assert.equal(after.notified_at, null);
  assert.equal(outboxFor(db).length, 0, 'no mail may be queued by a decision');
});

test('a decision is reversible right up until it is sent', () => {
  const { db, sub } = pendingSubmission();
  decide(db, [sub.id], 'accept');
  decide(db, [sub.id], 'decline');
  decide(db, [sub.id], 'undecide');
  assert.equal(db.prepare('SELECT status FROM submission WHERE id = ?').get(sub.id).status, 'pending');
  assert.equal(outboxFor(db).length, 0);
});

test('decide() rejects an unknown decision by name', () => {
  const { db, sub } = pendingSubmission();
  assert.throws(() => decide(db, [sub.id], 'waitlist'), /unknown decision 'waitlist'.*accept, decline, undecide/s);
});

test('notifying mails every speaker and finalises the status', () => {
  const { db, event, sub } = pendingSubmission();
  const coSpeaker = addPerson(db, { first: 'Grace', last: 'Hopper', email: 'grace@example.com' });
  addSpeaker(db, sub.id, coSpeaker.id, { order: 1 });

  decide(db, [sub.id], 'accept');
  const report = notify(db, [sub.id], { portalUrlFor: (p) => `http://127.0.0.1:8080/portal/${p.slug}` });

  assert.equal(report[0].notified, 2, 'both speakers hear about it');
  assert.equal(report[0].status, 'accepted');

  const after = db.prepare('SELECT * FROM submission WHERE id = ?').get(sub.id);
  assert.equal(after.status, 'accepted');
  assert.ok(after.notified_at);

  const mail = outboxFor(db, { kind: 'decision' });
  assert.equal(mail.length, 2);
  assert.deepEqual(mail.map((m) => m.to_email).sort(), ['ada@example.com', 'grace@example.com']);
  assert.match(mail[0].subject, /accepted for Conf 2026/);
  assert.match(mail[0].body, /A talk about SQLite/);
  assert.match(mail[0].body, /SESS-1/);
  assert.doesNotMatch(mail[0].body, /\{\{/, 'every placeholder was filled in');
});

test('declining sends the declined template, not the accepted one', () => {
  const { db, sub } = pendingSubmission();
  decide(db, [sub.id], 'decline');
  notify(db, [sub.id]);

  const [mail] = outboxFor(db, { kind: 'decision' });
  assert.equal(mail.template_slug, 'decision_declined');
  assert.doesNotMatch(mail.body, /accepted/i);
  assert.equal(db.prepare('SELECT status FROM submission WHERE id = ?').get(sub.id).status, 'declined');
});

test('notifying twice does not mail anybody twice', () => {
  const { db, sub } = pendingSubmission();
  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);
  const second = notify(db, [sub.id]);

  // The status guard is what prevents this: a notified row is no longer queued.
  assert.match(second[0].skipped, /status is 'accepted', not a decision queue/);
  assert.equal(outboxFor(db, { kind: 'decision' }).length, 1);
});

test('a reversed decision can still be communicated', () => {
  const { db, sub } = pendingSubmission();
  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);
  const firstNotifiedAt = db.prepare('SELECT notified_at FROM submission WHERE id = ?')
    .get(sub.id).notified_at;

  // The committee reverses itself, or the speaker drops out. They have to hear
  // about it -- a previous notification must not silence the next one.
  setStatus(db, sub.id, 'decline_queue');
  const report = notify(db, [sub.id]);

  assert.equal(report[0].status, 'declined');
  const mail = outboxFor(db, { kind: 'decision' });
  assert.equal(mail.length, 2);
  assert.equal(mail[1].template_slug, 'decision_declined');
  assert.ok(db.prepare('SELECT notified_at FROM submission WHERE id = ?').get(sub.id).notified_at
    >= firstNotifiedAt, 'notified_at tracks the most recent contact');
});

test('notifying something that was never decided is skipped, not guessed at', () => {
  const { db, sub } = pendingSubmission();
  const report = notify(db, [sub.id]);
  assert.match(report[0].skipped, /status is 'pending', not a decision queue/);
  assert.equal(outboxFor(db).length, 0);
});

test('a bulk notify reports per submission instead of one opaque success', () => {
  const { db, event } = newEvent();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const person = addPerson(db, { first: `P${i}`, last: 'X', email: `p${i}@example.com` });
    const sub = createSubmission(db, { eventId: event.id, title: `Talk ${i}`, status: 'pending' });
    addSpeaker(db, sub.id, person.id, { primary: true });
    ids.push(sub.id);
  }
  decide(db, ids.slice(0, 2), 'accept');   // third stays pending

  const report = notify(db, ids);
  assert.equal(report.filter((r) => r.status === 'accepted').length, 2);
  assert.equal(report.filter((r) => r.skipped).length, 1);
});

test('acceptance assigns the speaker their onboarding tasks immediately', () => {
  const { db, event, sub, person } = pendingSubmission();
  addTaskDefinition(db, event.id, { slug: 'upload-slides', appliesTo: 'submission' });
  addTaskDefinition(db, event.id, { slug: 'sign-agreement', title: 'Sign the speaker agreement',
    appliesTo: 'person', requirement: 'acknowledge' });

  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);

  const tasks = db.prepare(
    `SELECT td.slug FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
      WHERE ti.person_id = ? ORDER BY td.slug`,
  ).all(person.id);
  assert.deepEqual(tasks.map((t) => t.slug), ['sign-agreement', 'upload-slides']);
});

test('a declined submission assigns no tasks', () => {
  const { db, event, sub } = pendingSubmission();
  addTaskDefinition(db, event.id);
  decide(db, [sub.id], 'decline');
  notify(db, [sub.id]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_instance').get().n, 0);
});

test('session-level tasks land on the primary contact only', () => {
  const { db, event, sub, person } = pendingSubmission();
  const co = addPerson(db, { first: 'Grace', last: 'Hopper', email: 'grace@example.com' });
  addSpeaker(db, sub.id, co.id, { order: 1 });
  addTaskDefinition(db, event.id, { slug: 'upload-slides', appliesTo: 'submission' });
  addTaskDefinition(db, event.id, { slug: 'headshot', title: 'Headshot', appliesTo: 'person',
    requirement: 'file' });

  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);

  const slides = db.prepare(
    `SELECT ti.person_id FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
      WHERE td.slug = 'upload-slides'`,
  ).all();
  assert.deepEqual(slides.map((r) => r.person_id), [person.id],
    'slides are uploaded once, by the primary contact');

  const headshots = db.prepare(
    `SELECT ti.person_id FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
      WHERE td.slug = 'headshot' ORDER BY ti.person_id`,
  ).all();
  assert.equal(headshots.length, 2, 'but every speaker owes their own headshot');
});

test('the queues are what the notify screen lists', () => {
  const { db, event } = newEvent();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const sub = createSubmission(db, { eventId: event.id, title: `T${i}`, status: 'pending' });
    ids.push(sub.id);
  }
  assert.equal(pendingDecisions(db, event.id).length, 3);

  decide(db, [ids[0]], 'accept');
  decide(db, [ids[1]], 'decline');

  assert.equal(pendingDecisions(db, event.id).length, 1);
  assert.deepEqual(
    awaitingNotification(db, event.id).map((s) => s.status).sort(),
    ['accept_queue', 'decline_queue'],
  );
});

test('status changes are recorded, because they get contested later', () => {
  const { db, event, sub, person } = pendingSubmission();
  decide(db, [sub.id], 'accept', { actorPersonId: person.id });
  notify(db, [sub.id], { actorPersonId: person.id });

  const trail = db.prepare(
    `SELECT verb, detail FROM activity WHERE subject_type = 'submission' AND subject_id = ?
      ORDER BY id`,
  ).all(sub.id);

  assert.deepEqual(trail.map((a) => a.verb), ['created', 'status_changed', 'status_changed', 'notified']);
  assert.equal(trail[1].detail, 'pending -> accept_queue');
});
