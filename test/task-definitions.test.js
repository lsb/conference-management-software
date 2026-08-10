// Deciding what speakers owe: the definitions behind every task instance.
//
// Until these routes existed, `task_definition` had exactly one writer in the
// whole repository -- src/seed.js. An event built over HTTP could never ask a
// speaker for anything, so the tasks dashboard, the reminder engine, the file
// collector and the portal's task list were all permanently empty on any real
// event. These tests are mostly about the two things that are easy to get
// wrong once you can write the table: who a new task lands on, and what
// deleting one destroys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newApp, get, post, redirectedTo, failure } from './http-helpers.js';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { outstandingTasks, completeTask, taskDefinitions } from '../src/core/tasks.js';
import { openDatabase, now } from '../src/db.js';
import { run } from '../src/cli.js';

const EVENT = 'devflow-conf-2027';

async function newEventOverHttp(app) {
  redirectedTo(await post(app, '/e/new', {
    name: 'DevFlow Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-14',
    timezone: 'America/Los_Angeles', with_defaults: '1',
  }));
  return EVENT;
}

function eventRow(app) {
  return app.db.prepare('SELECT * FROM event WHERE slug = ?').get(EVENT);
}

/** A person, with no dependence on any other test helper's slugging. */
function addPerson(db, first, last, email) {
  const t = now();
  return db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(`${first}-${last}`.toLowerCase(), email, first, last, t, t);
}

/**
 * A speaker who has already been accepted AND told, which is the state that
 * makes "what happens to people already accepted" a real question.
 */
function acceptedSpeaker(app, { first = 'Ada', last = 'Lovelace', email = 'ada@example.com',
  title = 'A talk', extra = [] } = {}) {
  const db = app.db;
  const event = eventRow(app);
  const person = addPerson(db, first, last, email);
  const submission = createSubmission(db, { eventId: event.id, title, status: 'pending' });

  db.prepare(
    `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
     VALUES (?, ?, 'speaker', 1, 0)`,
  ).run(submission.id, person.id);

  extra.forEach((co, i) => {
    db.prepare(
      `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
       VALUES (?, ?, 'speaker', 0, ?)`,
    ).run(submission.id, co.id, i + 1);
  });

  decide(db, [submission.id], 'accept');
  notify(db, [submission.id]);
  return { person, submission };
}

const define = (app, event, fields) => post(app, `/e/${event}/tasks/definitions`, fields);

// --- the gap this closes ----------------------------------------------------

test('an event built over HTTP can now ask its speakers for something', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  acceptedSpeaker(app);

  const before = await get(app, `/e/${event}/tasks/definitions`);
  assert.equal(before.status, 200);
  assert.match(before.body, /No tasks yet/);
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 0);

  const to = redirectedTo(await define(app, event, {
    title: 'Upload your slides', applies_to: 'submission', requirement: 'file',
    due_at: '2027-04-30',
  }));
  assert.match(to, /\/e\/devflow-conf-2027\/tasks\/definitions\/upload-your-slides/);

  const outstanding = outstandingTasks(app.db, eventRow(app).id);
  assert.equal(outstanding.length, 1, 'the speaker should now owe it');
  assert.equal(outstanding[0].task_title, 'Upload your slides');

  // And the dashboard that was permanently empty now has something in it.
  const dashboard = await get(app, `/e/${event}/tasks`);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /Upload your slides/);
});

test('the deadline is stored as end of day, so the due date is still usable', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, { title: 'Headshot', due_at: '2027-04-30' });

  const [definition] = taskDefinitions(app.db, eventRow(app).id);
  assert.equal(definition.due_at, '2027-04-30T23:59:59Z');
});

// --- who a new task lands on ------------------------------------------------

test('a task added later is given to everybody already accepted, and says how many', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);

  acceptedSpeaker(app, { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' });
  acceptedSpeaker(app, { first: 'Grace', last: 'Hopper', email: 'grace@example.com', title: 'Another talk' });

  const to = redirectedTo(await define(app, event, {
    title: 'Sign the speaker agreement', applies_to: 'person',
  }));

  assert.match(to, /assigned=2/,
    'the redirect must state how many people just picked this up; a silent retroactive '
    + 'assignment is as bad as a silent refusal to do one');

  const owed = outstandingTasks(app.db, eventRow(app).id).map((t) => t.email).sort();
  assert.deepEqual(owed, ['ada@example.com', 'grace@example.com']);
});

test('a decision that has not been sent yet does not pick the task up early', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  const db = app.db;
  const eventId = eventRow(app).id;

  // Decided, but the speaker has not been told: still in the accept queue.
  const person = addPerson(db, 'Quiet', 'Queue', 'quiet@example.com');
  const submission = createSubmission(db, { eventId, title: 'Queued talk', status: 'pending' });
  db.prepare(
    `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
     VALUES (?, ?, 'speaker', 1, 0)`,
  ).run(submission.id, person.id);
  decide(db, [submission.id], 'accept');

  await define(app, event, { title: 'Headshot', applies_to: 'person' });
  assert.equal(outstandingTasks(db, eventId).length, 0,
    'somebody who has not been told they are in must not be handed homework');

  // ...and picks it up on the same rule as everybody else, when told.
  notify(db, [submission.id]);
  assert.equal(outstandingTasks(db, eventId).length, 1);
});

test('assign_when=manual creates the task and gives it to nobody until you say so', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  acceptedSpeaker(app);

  const to = redirectedTo(await define(app, event, {
    title: 'Hotel and travel', applies_to: 'person', assign_when: 'manual',
  }));
  assert.match(to, /assigned=0/);
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 0);

  redirectedTo(await post(app, `/e/${event}/tasks/definitions/hotel-and-travel/assign`, {}));
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 1);

  // Assigning twice does not double anybody's to-do list.
  redirectedTo(await post(app, `/e/${event}/tasks/definitions/hotel-and-travel/assign`, {}));
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 1);
});

test('switching a manual task to on_accept hands it out then and there', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  acceptedSpeaker(app);

  await define(app, event, { title: 'Headshot', applies_to: 'person', assign_when: 'manual' });
  const to = redirectedTo(await post(app, `/e/${event}/tasks/definitions/headshot`, {
    assign_when: 'on_accept',
  }));

  assert.match(to, /assigned=1/);
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 1);
});

test('a contact task reaches every co-speaker; a submission task only the primary contact', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  const co = addPerson(app.db, 'Co', 'Speaker', 'co@example.com');
  acceptedSpeaker(app, { extra: [co] });

  await define(app, event, { title: 'Biography', applies_to: 'person' });
  await define(app, event, { title: 'Upload slides', applies_to: 'submission', requirement: 'file' });

  const byTask = {};
  for (const t of outstandingTasks(app.db, eventRow(app).id)) {
    (byTask[t.task_slug] ??= []).push(t.email);
  }

  assert.deepEqual(byTask.biography.sort(), ['ada@example.com', 'co@example.com']);
  assert.deepEqual(byTask['upload-slides'], ['ada@example.com'],
    'slides are uploaded once; giving every co-speaker a copy would overstate the work');
});

// --- refusals that name the fix ---------------------------------------------

test('an unknown applies_to names the two that exist, and what each one means', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);

  const err = await failure(define(app, event, { title: 'Something', applies_to: 'group' }));
  assert.equal(err.status, 400);
  assert.match(err.message, /'group' is not a value for applies_to/);
  assert.match(err.hint, /person \(one per speaker\)/);
  assert.match(err.hint, /submission \(one per session\)/);
});

test('an unknown requirement names the three that exist', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);

  const err = await failure(define(app, event, { title: 'Something', requirement: 'signature' }));
  assert.match(err.message, /'signature' is not a value for requirement/);
  for (const value of ['acknowledge', 'form', 'file']) assert.match(err.hint, new RegExp(value));
});

test('a form task with no form is refused rather than being impossible to finish', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  redirectedTo(await post(app, `/e/${event}/forms`, { internal_name: 'AV requirements' }));

  const err = await failure(define(app, event, { title: 'Tell us your AV needs', requirement: 'form' }));
  assert.match(err.message, /needs a form to point at/);
  assert.match(err.hint, /av-requirements/);

  const ok = redirectedTo(await define(app, event, {
    title: 'Tell us your AV needs', requirement: 'form', form: 'av-requirements',
  }));
  assert.match(ok, /tell-us-your-av-needs/);
});

test('an unreadable due date is refused with the shape that works', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);

  const err = await failure(define(app, event, { title: 'Headshot', due_at: 'next Tuesday' }));
  assert.match(err.message, /could not read 'next Tuesday' as a date/);
  assert.match(err.hint, /YYYY-MM-DD/);
});

test('changing who gets a copy, once people hold copies, is refused', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  acceptedSpeaker(app);
  await define(app, event, { title: 'Biography', applies_to: 'person' });

  const err = await failure(post(app, `/e/${event}/tasks/definitions/biography`, {
    applies_to: 'submission',
  }));
  assert.match(err.message, /already been given to 1 person/);
  assert.match(err.hint, /Retire this task and create the replacement/);

  assert.equal(app.db.prepare('SELECT applies_to FROM task_definition WHERE slug = ?')
    .get('biography').applies_to, 'person', 'the refusal must not have half-applied');
});

test('a task nobody holds can still be reshaped freely', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, { title: 'Biography', applies_to: 'person' });

  redirectedTo(await post(app, `/e/${event}/tasks/definitions/biography`, {
    applies_to: 'submission', requirement: 'file',
  }));
  const row = app.db.prepare('SELECT * FROM task_definition WHERE slug = ?').get('biography');
  assert.equal(row.applies_to, 'submission');
  assert.equal(row.requirement, 'file');
});

test('saving one field does not blank the others', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, {
    title: 'Headshot', due_at: '2027-04-30', instructions: 'At least 1000px wide.',
  });

  // A curl caller renaming a task, and nothing else.
  redirectedTo(await post(app, `/e/${event}/tasks/definitions/headshot`, { title: 'A headshot' }));

  const row = app.db.prepare('SELECT * FROM task_definition WHERE slug = ?').get('headshot');
  assert.equal(row.title, 'A headshot');
  assert.equal(row.due_at, '2027-04-30T23:59:59Z', 'the deadline must survive a partial save');
  assert.equal(row.instructions, 'At least 1000px wide.');
  assert.equal(row.required, 1);
});

test('the settings form can untick required, because it says it carries every box', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, { title: 'Headshot' });

  redirectedTo(await post(app, `/e/${event}/tasks/definitions/headshot`, {
    title: 'Headshot', task_form: '1',
  }));
  assert.equal(app.db.prepare('SELECT required FROM task_definition WHERE slug = ?')
    .get('headshot').required, 0);
});

// --- order ------------------------------------------------------------------

test('tasks can be reordered, which is what the portal lists them by', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, { title: 'First' });
  await define(app, event, { title: 'Second' });
  await define(app, event, { title: 'Third' });

  const order = () => taskDefinitions(app.db, eventRow(app).id).map((d) => d.slug);
  assert.deepEqual(order(), ['first', 'second', 'third']);

  redirectedTo(await post(app, `/e/${event}/tasks/definitions/third/move`, { direction: 'up' }));
  assert.deepEqual(order(), ['first', 'third', 'second']);

  redirectedTo(await post(app, `/e/${event}/tasks/definitions/first/move`, { direction: 'down' }));
  assert.deepEqual(order(), ['third', 'first', 'second']);

  // Off the end is a no-op rather than an error: the buttons are disabled, and
  // a caller who posts it anyway has not asked for anything harmful.
  redirectedTo(await post(app, `/e/${event}/tasks/definitions/third/move`, { direction: 'up' }));
  assert.deepEqual(order(), ['third', 'first', 'second']);
});

// --- deleting, and what it must not destroy ---------------------------------

test('a task nobody has done can be deleted, and takes its outstanding copies with it', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  acceptedSpeaker(app);
  await define(app, event, { title: 'Headshot', applies_to: 'person' });
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 1);

  const to = redirectedTo(await post(app, `/e/${event}/tasks/definitions/headshot/delete`, {}));
  assert.match(decodeURIComponent(to), /Deleted 'Headshot' and 1 outstanding copy/);

  assert.equal(taskDefinitions(app.db, eventRow(app).id).length, 0);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM task_instance').get().n, 0);
});

test('deleting a task people have finished is refused, and names retiring', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  const { person } = acceptedSpeaker(app);
  await define(app, event, { title: 'Biography', applies_to: 'person' });

  const [task] = outstandingTasks(app.db, eventRow(app).id, { personId: person.id });
  completeTask(app.db, task.id);

  const err = await failure(post(app, `/e/${event}/tasks/definitions/biography/delete`, {}));
  assert.equal(err.status, 400);
  assert.match(err.message, /1 person\(s\) have already completed 'Biography'/);
  assert.match(err.hint, /Retire it instead/);
  assert.match(err.hint, /tasks\/definitions\/biography\/retire/);

  assert.equal(app.db.prepare('SELECT count(*) AS n FROM task_instance').get().n, 1,
    'a refused delete must not have deleted anything');
});

test('the database refuses that delete too, however it arrives', async () => {
  // The handler is not the only writer: a seed script and a sqlite3 shell are
  // the two paths that produced the last two silent-destruction incidents.
  const app = newApp();
  const event = await newEventOverHttp(app);
  const { person } = acceptedSpeaker(app);
  await define(app, event, { title: 'Biography', applies_to: 'person' });

  const [task] = outstandingTasks(app.db, eventRow(app).id, { personId: person.id });
  completeTask(app.db, task.id);

  const definition = app.db.prepare('SELECT id FROM task_definition WHERE slug = ?').get('biography');
  assert.throws(
    () => app.db.prepare('DELETE FROM task_definition WHERE id = ?').run(definition.id),
    /Retire it instead/);
});

test('deleting the whole event still works, completed tasks and all', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  const { person } = acceptedSpeaker(app);
  await define(app, event, { title: 'Biography', applies_to: 'person' });

  const [task] = outstandingTasks(app.db, eventRow(app).id, { personId: person.id });
  completeTask(app.db, task.id);

  // The guard on the trigger exists so a cascade is not mistaken for somebody
  // trying to destroy a record they should keep.
  app.db.prepare('DELETE FROM event WHERE slug = ?').run(event);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM task_definition').get().n, 0);
});

// --- retiring ---------------------------------------------------------------

test('retiring keeps what people did, drops what they owe, and stops the reminders', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  const { person } = acceptedSpeaker(app);
  acceptedSpeaker(app, { first: 'Grace', last: 'Hopper', email: 'grace@example.com', title: 'Another' });
  await define(app, event, { title: 'Biography', applies_to: 'person', due_at: '2027-04-30' });

  const [task] = outstandingTasks(app.db, eventRow(app).id, { personId: person.id });
  completeTask(app.db, task.id);

  const to = redirectedTo(await post(app, `/e/${event}/tasks/definitions/biography/retire`, {}));
  assert.match(to, /dropped=1/);

  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 0,
    'nobody should still owe a task the event has stopped collecting');
  assert.equal(app.db.prepare(`SELECT count(*) AS n FROM task_instance WHERE status = 'done'`).get().n, 1,
    'the finished copy is the record the whole refusal exists to protect');

  const page = await get(app, `/e/${event}/tasks/definitions`);
  assert.match(page.body, /retired/);
});

test('a retired task is not handed to somebody accepted afterwards', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, { title: 'Biography', applies_to: 'person' });
  redirectedTo(await post(app, `/e/${event}/tasks/definitions/biography/retire`, {}));

  acceptedSpeaker(app);
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 0);

  // Bringing it back starts collecting from everybody who is already in.
  const to = redirectedTo(await post(app, `/e/${event}/tasks/definitions/biography/restore`, {}));
  assert.match(to, /assigned=1/);
  assert.equal(outstandingTasks(app.db, eventRow(app).id).length, 1);
});

test('assigning a retired task is refused rather than quietly doing nothing', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, { title: 'Biography', applies_to: 'person' });
  redirectedTo(await post(app, `/e/${event}/tasks/definitions/biography/retire`, {}));

  const err = await failure(post(app, `/e/${event}/tasks/definitions/biography/assign`, {}));
  assert.match(err.message, /is retired/);
  assert.match(err.hint, /restore/);
});

// --- not found, and not yours -----------------------------------------------

test('a task that does not exist is named, with the ones that do', async () => {
  const app = newApp();
  const event = await newEventOverHttp(app);
  await define(app, event, { title: 'Headshot' });

  const err = await failure(get(app, `/e/${event}/tasks/definitions/headshoot`));
  assert.equal(err.status, 404);
  assert.match(err.message, /no task 'headshoot' in this event/);
  assert.match(err.hint, /tasks are: headshot/);
});

test('a stranger can neither read nor write the task list', async () => {
  const owner = newApp();
  const event = await newEventOverHttp(owner);
  await define(owner, event, { title: 'Headshot' });

  const stranger = { ...owner, cookies: {} };

  for (const url of [`/e/${event}/tasks/definitions`, `/e/${event}/tasks/definitions/headshot`]) {
    const err = await failure(get(stranger, url));
    assert.equal(err.status, 403, `${url} should require an organizer`);
  }

  for (const url of [
    `/e/${event}/tasks/definitions`,
    `/e/${event}/tasks/definitions/headshot`,
    `/e/${event}/tasks/definitions/headshot/move`,
    `/e/${event}/tasks/definitions/headshot/assign`,
    `/e/${event}/tasks/definitions/headshot/retire`,
    `/e/${event}/tasks/definitions/headshot/restore`,
    `/e/${event}/tasks/definitions/headshot/delete`,
  ]) {
    const err = await failure(post(stranger, url, { title: 'Mine now', direction: 'up' }));
    assert.equal(err.status, 403, `POST ${url} should require an organizer`);
  }

  assert.equal(
    owner.db.prepare('SELECT title FROM task_definition WHERE slug = ?').get('headshot').title,
    'Headshot', 'nothing a stranger posted took effect');
});

// --- the same job from the command line -------------------------------------
//
// Every feature this repo has shipped with a screen and no command has been
// found by the eval within one run (USABILITY-LOG.md, findings 5 and 7), so the
// command line is tested rather than assumed.

function withCli(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'conf-tasks-'));
  const path = join(dir, 'test.db');
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return fn(path, lines);
  } finally {
    console.log = realLog;
    console.error = realError;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A database with one event and one accepted, notified speaker. */
function seedCliDb(path) {
  const db = openDatabase(path);
  const t = now();
  const event = db.prepare(
    `INSERT INTO event (slug, name, timezone, starts_at, ends_at, created_at, updated_at)
     VALUES ('cli-conf', 'CLI Conf', 'UTC', '2027-05-12T00:00:00Z', '2027-05-13T00:00:00Z', ?, ?)
     RETURNING *`,
  ).get(t, t);

  const person = addPerson(db, 'Ada', 'Lovelace', 'ada@example.com');
  const submission = createSubmission(db, { eventId: event.id, title: 'A talk', status: 'pending' });
  db.prepare(
    `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
     VALUES (?, ?, 'speaker', 1, 0)`,
  ).run(submission.id, person.id);
  decide(db, [submission.id], 'accept');
  notify(db, [submission.id]);
  db.close();
}

test('conf tasks --define creates a task and says who just picked it up', () => {
  withCli((path, lines) => {
    seedCliDb(path);

    const code = run(['tasks', 'cli-conf', '--db', path, '--define', 'Upload your slides',
      '--applies-to', 'submission', '--requirement', 'file', '--due', '2027-04-30']);
    assert.equal(code, 0, lines.join('\n'));

    const output = lines.join('\n');
    assert.match(output, /Now asking for 'Upload your slides'/);
    assert.match(output, /Given to 1 speaker\(s\) who are already accepted/);
    assert.match(output, /Reminders go out a week before/);

    const db = openDatabase(path);
    assert.equal(outstandingTasks(db, 1).length, 1);
    assert.equal(db.prepare('SELECT due_at FROM task_definition').get().due_at, '2027-04-30T23:59:59Z');
    db.close();
  });
});

test('conf tasks --define refuses a value it does not know, and lists the real ones', () => {
  withCli((path, lines) => {
    seedCliDb(path);
    const code = run(['tasks', 'cli-conf', '--db', path, '--define', 'Something',
      '--applies-to', 'group']);

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /'group' is not a value for --applies-to/);
    assert.match(lines.join('\n'), /--applies-to person \(one per speaker\)/);
  });
});

test('conf tasks teaches the create line whether or not anything is outstanding', () => {
  withCli((path, lines) => {
    seedCliDb(path);
    run(['tasks', 'cli-conf', '--db', path]);

    const output = lines.join('\n');
    assert.match(output, /Nothing is being asked of speakers yet/);
    assert.match(output, /conf tasks cli-conf --define/,
      'the one hint that matters must not sit behind a condition that stops holding');
  });
});

test('conf tasks --delete is refused once somebody has finished, and points at --retire', () => {
  withCli((path, lines) => {
    seedCliDb(path);
    run(['tasks', 'cli-conf', '--db', path, '--define', 'Biography', '--applies-to', 'person']);

    const db = openDatabase(path);
    const [task] = outstandingTasks(db, 1);
    completeTask(db, task.id);
    db.close();

    lines.length = 0;
    const code = run(['tasks', 'cli-conf', '--db', path, '--delete', 'biography']);
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /already completed 'Biography'/);
    assert.match(lines.join('\n'), /conf tasks cli-conf --retire biography/);

    const after = openDatabase(path);
    assert.equal(after.prepare('SELECT count(*) AS n FROM task_definition').get().n, 1);
    after.close();
  });
});

test('conf tasks --retire keeps the finished copies and drops the outstanding ones', () => {
  withCli((path, lines) => {
    seedCliDb(path);
    run(['tasks', 'cli-conf', '--db', path, '--define', 'Biography', '--applies-to', 'person']);

    lines.length = 0;
    assert.equal(run(['tasks', 'cli-conf', '--db', path, '--retire', 'biography']), 0);
    assert.match(lines.join('\n'), /1 outstanding cop\(ies\) dropped, 0 completed one\(s\) kept/);

    const db = openDatabase(path);
    assert.equal(outstandingTasks(db, 1).length, 0);
    assert.equal(db.prepare('SELECT retired_at IS NOT NULL AS gone FROM task_definition').get().gone, 1);
    db.close();
  });
});

test('conf tasks --definitions lists what is being asked for', () => {
  withCli((path, lines) => {
    seedCliDb(path);
    run(['tasks', 'cli-conf', '--db', path, '--define', 'Biography', '--applies-to', 'person']);

    lines.length = 0;
    assert.equal(run(['tasks', 'cli-conf', '--db', path, '--definitions']), 0);

    const output = lines.join('\n');
    assert.match(output, /biography/);
    assert.match(output, /each speaker/);
    assert.match(output, /1 task\./);
  });
});

test('an unknown task on the command line names the ones that exist', () => {
  withCli((path, lines) => {
    seedCliDb(path);
    run(['tasks', 'cli-conf', '--db', path, '--define', 'Biography', '--applies-to', 'person']);

    lines.length = 0;
    assert.equal(run(['tasks', 'cli-conf', '--db', path, '--retire', 'bio']), 1);
    assert.match(lines.join('\n'), /no task called 'bio'/);
    assert.match(lines.join('\n'), /tasks are: biography/);
  });
});

// --- the recipe -------------------------------------------------------------

test('llms.txt carries a worked example, because a route without one goes unused', async () => {
  const app = newApp();
  const body = (await get(app, '/llms.txt')).body;
  const full = (await get(app, '/llms.txt?all=1')).body;

  // The recipe belongs in the short form -- that is the whole point of it being
  // a recipe. The route's own entry lives in the complete list behind ?all=1.
  assert.match(body, /### Ask speakers for something/);
  assert.match(full, /POST \/e\/:event\/tasks\/definitions/);
  assert.match(body, /applies_to=submission/);
  assert.match(body, /ALREADY accepted/);
  assert.match(body, /Retire it instead/);
});
