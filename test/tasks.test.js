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

test('at most one reminder per task per run, even when several rules are overdue', () => {
  const { db, event } = acceptedSpeakerWithTask();
  // First run happens long after every threshold has passed.
  const queued = runReminders(db, event.id, { asOf: daysFrom(DUE, 60) });
  assert.equal(queued.length, 1, 'one message, not a burst of three');
  assert.equal(queued[0].rule, 'due_in_7_days');
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
