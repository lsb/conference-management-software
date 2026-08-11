import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { runReminders, outstandingTasks, completeTask, assignTasksOnAccept } from '../src/core/tasks.js';
import { newEvent, addPerson, addSpeaker, addTaskDefinition, outboxFor, daysFrom } from './helpers.js';

const DUE = '2026-09-01T00:00:00Z';

/** An accepted speaker with one required, dated task outstanding. */
function acceptedSpeakerWithTask(opts = {}) {
  const { db, event } = newEvent();
  const person = addPerson(db);
  const sub = createSubmission(db, { eventId: event.id, title: 'A talk', status: 'pending' });
  addSpeaker(db, sub.id, person.id, { primary: true });
  addTaskDefinition(db, event.id, {
    slug: 'upload-slides', title: 'Upload your slides',
    appliesTo: 'submission', requirement: 'file', dueAt: DUE, ...opts,
  });
  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);
  return { db, event, person, sub };
}

test('reminders go out at 7 days, 1 day, and 1 day overdue', () => {
  const { db, event } = acceptedSpeakerWithTask();

  assert.deepEqual(runReminders(db, event.id, { asOf: daysFrom(DUE, -30) }), [],
    'nothing a month out');

  assert.equal(runReminders(db, event.id, { asOf: daysFrom(DUE, -7) })[0]?.rule, 'due_in_7_days');
  assert.equal(runReminders(db, event.id, { asOf: daysFrom(DUE, -1) })[0]?.rule, 'due_in_1_day');
  assert.equal(runReminders(db, event.id, { asOf: daysFrom(DUE, 1) })[0]?.rule, 'overdue_by_1_day');

  // And then it stops. Three touches, not a daily nag.
  assert.deepEqual(runReminders(db, event.id, { asOf: daysFrom(DUE, 30) }), []);
  assert.equal(outboxFor(db, { kind: 'task_reminder' }).length, 3);
});

test('running the reminder engine repeatedly mails nobody twice', () => {
  const { db, event } = acceptedSpeakerWithTask();
  for (let i = 0; i < 5; i++) runReminders(db, event.id, { asOf: daysFrom(DUE, -7) });
  assert.equal(outboxFor(db, { kind: 'task_reminder' }).length, 1);
});

test('a task past every threshold gets one reminder, and it is the overdue one', () => {
  const { db, event } = acceptedSpeakerWithTask();

  // Reminders switched on after the due date has gone by: a late-configured
  // event, an import, or nobody having run them for a fortnight. All three
  // rungs have been crossed at once.
  const queued = runReminders(db, event.id, { asOf: daysFrom(DUE, 60) });
  assert.equal(queued.length, 1, 'one message, not a burst of three');
  assert.equal(queued[0].rule, 'overdue_by_1_day',
    'telling somebody a thing is "due in 7 days" when it was due two months ago '
    + 'is the wrong rung of the ladder to pick');

  // The bug this replaced: rungs were retired one per run, so running the
  // engine again -- which the docstring promises is safe -- delivered the next
  // one down. Three identical emails, seconds apart, to a speaker who is
  // already late and does not need telling three times.
  runReminders(db, event.id, { asOf: daysFrom(DUE, 60) });
  runReminders(db, event.id, { asOf: daysFrom(DUE, 61) });
  assert.equal(outboxFor(db, { kind: 'task_reminder' }).length, 1,
    'a rung whose moment passed unsent has no message left to deliver');
});

test('finishing the task stops the reminders', () => {
  const { db, event, person } = acceptedSpeakerWithTask();
  const [task] = outstandingTasks(db, event.id, { personId: person.id });

  const fileId = db.prepare(
    `INSERT INTO file (slug, event_id, filename, content_type, byte_size, sha256, storage_path, created_at)
     VALUES ('slides', 1, 's.pdf', 'application/pdf', 10, 'x', 's.pdf', '2026-08-01T00:00:00Z')
     RETURNING id`,
  ).get().id;
  completeTask(db, task.id, { fileId });

  assert.deepEqual(runReminders(db, event.id, { asOf: daysFrom(DUE, 1) }), []);
  assert.equal(outstandingTasks(db, event.id).length, 0);
});

test('reminders reach only the people who still owe something', () => {
  const { db, event } = newEvent();
  addTaskDefinition(db, event.id, { slug: 'headshot', title: 'Headshot',
    appliesTo: 'person', requirement: 'file', dueAt: DUE });

  const behind = addPerson(db, { first: 'Behind', last: 'Person', email: 'behind@example.com' });
  const done = addPerson(db, { first: 'Done', last: 'Person', email: 'done@example.com' });

  for (const person of [behind, done]) {
    const sub = createSubmission(db, { eventId: event.id, title: `Talk by ${person.first_name}`, status: 'pending' });
    addSpeaker(db, sub.id, person.id, { primary: true });
    decide(db, [sub.id], 'accept');
    notify(db, [sub.id]);
  }

  const [doneTask] = outstandingTasks(db, event.id, { personId: done.id });
  db.prepare("UPDATE task_instance SET status = 'done' WHERE id = ?").run(doneTask.id);

  const queued = runReminders(db, event.id, { asOf: daysFrom(DUE, -7) });
  assert.deepEqual(queued.map((q) => q.email), ['behind@example.com']);
});

test('a task with no due date is never chased automatically', () => {
  const { db, event } = acceptedSpeakerWithTask({ dueAt: null });
  assert.deepEqual(runReminders(db, event.id, { asOf: daysFrom(DUE, 365) }), []);
  assert.equal(outstandingTasks(db, event.id).length, 1, 'it still shows in the portal');
});

test('optional tasks are listed but not chased', () => {
  const { db, event } = acceptedSpeakerWithTask({ required: 0 });
  assert.deepEqual(runReminders(db, event.id, { asOf: daysFrom(DUE, 1) }), []);
  assert.equal(outstandingTasks(db, event.id).length, 1);
});

test('dryRun previews the batch without queueing or recording anything', () => {
  const { db, event } = acceptedSpeakerWithTask();
  const preview = runReminders(db, event.id, { asOf: daysFrom(DUE, -7), dryRun: true });

  assert.equal(preview.length, 1);
  assert.equal(outboxFor(db, { kind: 'task_reminder' }).length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM reminder_log').get().n, 0);

  // And the real run still happens afterwards.
  assert.equal(runReminders(db, event.id, { asOf: daysFrom(DUE, -7) }).length, 1);
});

test('reminder mail names the task and resolves every placeholder', () => {
  const { db, event } = acceptedSpeakerWithTask();
  runReminders(db, event.id, {
    asOf: daysFrom(DUE, -7),
    portalUrlFor: (p) => `http://127.0.0.1:8080/portal/${p.slug}`,
  });

  const [mail] = outboxFor(db, { kind: 'task_reminder' });
  assert.match(mail.subject, /Upload your slides/);
  assert.match(mail.body, /http:\/\/127\.0\.0\.1:8080\/portal\/ada-lovelace/);
  assert.doesNotMatch(mail.body, /\{\{/);
  assert.equal(mail.to_email, 'ada@example.com');
});

test('a file task cannot be marked done without a file', () => {
  const { db, event, person } = acceptedSpeakerWithTask();
  const [task] = outstandingTasks(db, event.id, { personId: person.id });
  assert.throws(() => completeTask(db, task.id), /requires a file upload/);
});

test('re-assigning tasks after a retried notification does not duplicate them', () => {
  const { db, sub } = acceptedSpeakerWithTask();
  const before = db.prepare('SELECT count(*) AS n FROM task_instance').get().n;
  assert.equal(assignTasksOnAccept(db, sub.id), 0, 'second pass creates nothing');
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_instance').get().n, before);
});

test('a retried notification does not duplicate a person-level task either', () => {
  // The session-level case above passes on the table's plain UNIQUE constraint.
  // The person-level case has a NULL submission_id, and NULLs do not compare
  // equal in a unique index, so it needs its own partial index to be safe.
  const { db, event, sub, person } = acceptedSpeakerWithTask();
  addTaskDefinition(db, event.id, { slug: 'headshot', title: 'Headshot',
    appliesTo: 'person', requirement: 'file', dueAt: DUE });
  assignTasksOnAccept(db, sub.id);

  assignTasksOnAccept(db, sub.id);
  assignTasksOnAccept(db, sub.id);

  const headshots = db.prepare(
    `SELECT count(*) AS n FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
      WHERE td.slug = 'headshot' AND ti.person_id = ?`,
  ).get(person.id).n;
  assert.equal(headshots, 1);
});

test('a speaker with two accepted sessions still owes one headshot', () => {
  const { db, event, person } = acceptedSpeakerWithTask();
  addTaskDefinition(db, event.id, { slug: 'headshot', title: 'Headshot',
    appliesTo: 'person', requirement: 'file', dueAt: DUE });

  // Same human, a second accepted talk. Personal obligations must not multiply
  // with sessions, or the outstanding-work dashboard overstates reality.
  const second = createSubmission(db, { eventId: event.id, title: 'Second talk', status: 'pending' });
  addSpeaker(db, second.id, person.id, { primary: true });
  decide(db, [second.id], 'accept');
  notify(db, [second.id]);

  const byTask = Object.fromEntries(db.prepare(
    `SELECT td.slug, count(*) AS n FROM task_instance ti
       JOIN task_definition td ON td.id = ti.definition_id
      WHERE ti.person_id = ? GROUP BY td.slug`,
  ).all(person.id).map((r) => [r.slug, r.n]));

  assert.deepEqual(byTask, { headshot: 1, 'upload-slides': 2 },
    'one headshot for the person, one slide upload per session');
});
