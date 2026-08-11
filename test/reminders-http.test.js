// Chasing paperwork over HTTP.
//
// `POST /api/events/<event>/reminders` had no test naming it. The core engine
// was well covered; the route that calls it was not, and the gap between those
// two is where the confirmation-email bug lived as well -- core correct, one
// caller not reaching it.
//
// The contract worth pinning is the preview. `notify` earned its refusal to
// guess after Run 4, where a mistyped flag mailed a whole decision queue. This
// endpoint sends real mail to real speakers, and a dry run that turns out to
// send is the same incident wearing a different hat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, post, redirectedTo, failure } from './http-helpers.js';
import { addTaskDefinition } from './helpers.js';

/** An event with one accepted, notified speaker owing one overdue task. */
async function speakerOwingSomething(app) {
  redirectedTo(await post(app, '/e/new', {
    name: 'Remind Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-14',
    timezone: 'UTC', with_defaults: '1',
  }));
  const event = 'remind-conf-2027';
  await post(app, `/e/${event}/settings/tracks`, { name: 'Retrieval' });
  const form = redirectedTo(await post(app, `/e/${event}/forms`,
    { internal_name: 'CFP', with_defaults: '1' })).split('/').pop();

  const eventId = app.db.prepare('SELECT id FROM event WHERE slug = ?').get(event).id;
  addTaskDefinition(app.db, eventId, { dueAt: '2020-01-01T00:00:00Z' });

  await post(app, `/submit/${event}/${form}`, {
    title: 'A talk', description: 'D', format: 'talk-30-min', track: 'retrieval',
    'first-name': 'Priya', 'last-name': 'Raman', email: 'p@example.com', biography: 'E.',
  }, { cookies: {} });

  const code = app.db.prepare('SELECT code FROM submission ORDER BY id DESC').get().code;
  await post(app, `/e/${event}/submissions/decide`, { codes: code, decision: 'accept' });
  await post(app, `/e/${event}/notify`, { codes: code, confirm: '1' });
  return { event, eventId };
}

const remindersSent = (app) => app.db.prepare(
  "SELECT count(*) AS n FROM outbox WHERE kind = 'task_reminder'").get().n;

const callReminders = (app, event, fields) => post(app,
  `/api/events/${event}/reminders`, fields, { headers: { accept: 'application/json' } });

test('a dry run says what it would send and sends none of it', async () => {
  const app = newApp();
  const { event } = await speakerOwingSomething(app);

  const preview = JSON.parse((await callReminders(app, event, { dry_run: 'true' })).body);

  assert.equal(preview.dry_run, true);
  assert.equal(preview.count, 1, 'a preview that reports nothing is not a preview');
  assert.equal(remindersSent(app), 0, 'and it must not have sent it');
});

test('without a dry run it sends, and running it again does not send again', async () => {
  const app = newApp();
  const { event } = await speakerOwingSomething(app);

  assert.equal(JSON.parse((await callReminders(app, event, {})).body).count, 1);
  assert.equal(remindersSent(app), 1);

  // The engine is meant to be safe to run on a timer. It is also, in practice,
  // run twice by a person who was not sure the first one worked.
  await callReminders(app, event, {});
  await callReminders(app, event, {});
  assert.equal(remindersSent(app), 1,
    'a speaker already chased does not get chased again for the same thing');
});

test('a preview does not use up the reminder it was previewing', async () => {
  const app = newApp();
  const { event } = await speakerOwingSomething(app);

  await callReminders(app, event, { dry_run: 'true' });
  await callReminders(app, event, {});

  assert.equal(remindersSent(app), 1,
    'previewing must not mark the rung as sent, or the preview eats the reminder');
});

test('a stranger cannot make this app send mail', async () => {
  const app = newApp();
  const { event } = await speakerOwingSomething(app);

  const err = await failure(post(app, `/api/events/${event}/reminders`, {},
    { cookies: {}, headers: { accept: 'application/json' } }));

  assert.equal(err.status, 403);
  assert.equal(remindersSent(app), 0);
});
