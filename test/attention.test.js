// "What needs attention" -- one list, two interfaces.
//
// Two things are tested here and only one of them is the feature.
//
// The feature: a speaker who withdraws from a slot they were scheduled into
// leaves a hole in the programme, and until this existed nothing said so. The
// session drops off the public agenda by itself, because every published query
// filters on status, so the app looked fine from outside while `conf status`
// reported that nothing needed attention and there was an empty room at 9am.
//
// The other thing, which matters more over time: `conf status` and
// GET /api/events/<event> used to be two independent copies of the same five
// queries. They agreed by coincidence. The parity test at the bottom fails if
// somebody adds a sixth item to core and gives only one interface a way to act
// on it -- which is exactly how the copies would have drifted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newApp, get, post, redirectedTo } from './http-helpers.js';
import { SESSION_COOKIE } from '../src/core/auth.js';
import { needsAttention } from '../src/core/attention.js';
import { withdrawnFromSlots } from '../src/core/schedule.js';
import { openDatabase, now } from '../src/db.js';
import { createSubmission, setStatus, decide, notify } from '../src/core/submissions.js';
import { addPerson } from './helpers.js';
import { run } from '../src/cli.js';

/** An event with one speaker accepted, told, and scheduled into a room. */
async function scheduledSpeaker(app) {
  redirectedTo(await post(app, '/e/new', {
    name: 'Withdraw Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-14',
    timezone: 'America/Los_Angeles', with_defaults: '1',
  }));
  const event = 'withdraw-conf-2027';
  await post(app, `/e/${event}/settings/tracks`, { name: 'Retrieval' });
  await post(app, `/e/${event}/settings/rooms`, { name: 'Main Stage' });
  const form = redirectedTo(await post(app, `/e/${event}/forms`,
    { internal_name: 'CFP', with_defaults: '1' })).split('/').pop();

  const submitted = await post(app, `/submit/${event}/${form}`, {
    title: 'Keynote', description: 'D', format: 'talk-30-min', track: 'retrieval',
    'first-name': 'Priya', 'last-name': 'Raman', email: 'p@example.com', biography: 'E.',
  }, { cookies: {} });

  const cookies = {
    [SESSION_COOKIE]: String(submitted.headers['set-cookie']).match(/conf_session=([^;]+)/)[1],
  };
  const code = app.db.prepare('SELECT code FROM submission ORDER BY id DESC').get().code;

  await post(app, `/e/${event}/submissions/decide`, { codes: code, decision: 'accept' });
  await post(app, `/e/${event}/notify`, { codes: code, confirm: '1' });
  const room = app.db.prepare(
    'SELECT slug FROM room WHERE event_id = (SELECT id FROM event WHERE slug = ?)').get(event);
  await post(app, `/e/${event}/submissions/${code}/schedule`,
    { room: room.slug, starts_at: '2027-05-12T09:00' });

  return { event, code, cookies };
}

const attentionOf = async (app, event) => JSON.parse(
  (await get(app, `/api/events/${event}`, { headers: { accept: 'application/json' } })).body,
).needs_attention;

test('a speaker withdrawing from a scheduled slot is reported as needing attention', async () => {
  const app = newApp();
  const { event, code, cookies } = await scheduledSpeaker(app);

  assert.equal((await attentionOf(app, event)).find((i) => /withdrew/.test(i.text)), undefined,
    'nobody has withdrawn yet');

  await post(app, `/portal/${event}/submissions/${code}/withdraw`, {}, { cookies });

  const items = await attentionOf(app, event);
  const hole = items.find((i) => /withdrew/.test(i.text));
  assert.ok(hole, `nothing reported the withdrawal, got ${JSON.stringify(items)}`);
  assert.equal(hole.count, 1);
  assert.deepEqual(hole.codes, [code], 'and it names which session, so it can be filled');
  assert.ok(hole.where, 'with somewhere to look');
});

test('the withdrawn session leaves the public agenda, which is why nothing noticed', async () => {
  const app = newApp();
  const { event, code, cookies } = await scheduledSpeaker(app);
  await post(app, `/portal/${event}/submissions/${code}/withdraw`, {}, { cookies });

  const agenda = JSON.parse(
    (await get(app, `/api/events/${event}/agenda`, { headers: { accept: 'application/json' } })).body);
  const still = JSON.stringify(agenda).includes(code);
  assert.equal(still, false, 'a withdrawn session must not stay on the agenda');
});

test('withdrawing before anyone scheduled you is not called a hole in the programme', () => {
  const app = newApp();
  const db = app.db;
  const t = now();
  const event = db.prepare(
    `INSERT INTO event (slug, name, timezone, starts_at, ends_at, created_at, updated_at)
     VALUES ('q-2027', 'Q', 'UTC', '2027-05-12T00:00:00Z', '2027-05-13T00:00:00Z', ?, ?)
     RETURNING *`).get(t, t);

  const pending = createSubmission(db, { eventId: event.id, title: 'Never accepted', status: 'pending' });
  setStatus(db, pending.id, 'withdrawn');

  assert.deepEqual(withdrawnFromSlots(db, event.id), [],
    'a proposal that never had a slot cannot have vacated one');
});

test('conf status and the API check the same set of things', async () => {
  const app = newApp();
  const { event, code, cookies } = await scheduledSpeaker(app);
  await post(app, `/portal/${event}/submissions/${code}/withdraw`, {}, { cookies });

  const eventId = app.db.prepare('SELECT id FROM event WHERE slug = ?').get(event).id;
  const core = needsAttention(app.db, eventId);

  // Everything core reports, with a count, must give the API somewhere to look.
  // A new item wired into core and not into the route arrives here as a
  // `where: undefined`, which is how the two used to drift apart.
  for (const item of await attentionOf(app, event)) {
    assert.ok(item.where, `"${item.text}" has no URL to look at`);
  }

  // And the command line must offer a next command for each of them.
  const dir = mkdtempSync(join(tmpdir(), 'conf-attention-'));
  const path = join(dir, 'test.db');
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const db = openDatabase(path);
    const t = now();
    const ev = db.prepare(
      `INSERT INTO event (slug, name, timezone, starts_at, ends_at, created_at, updated_at)
       VALUES ('cli-conf', 'CLI Conf', 'UTC', '2027-05-12T00:00:00Z', '2027-05-13T00:00:00Z', ?, ?)
       RETURNING *`).get(t, t);
    const room = db.prepare(
      `INSERT INTO room (event_id, slug, name, sort_order)
       VALUES (?, 'main', 'Main', 0) RETURNING *`).get(ev.id);
    const person = addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' });
    const sub = createSubmission(db, { eventId: ev.id, title: 'A talk', status: 'pending' });
    db.prepare(
      `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
       VALUES (?, ?, 'speaker', 1, 0)`).run(sub.id, person.id);
    decide(db, [sub.id], 'accept');
    notify(db, [sub.id]);
    db.prepare('UPDATE submission SET room_id = ?, starts_at = ?, ends_at = ? WHERE id = ?')
      .run(room.id, '2027-05-12T16:00:00Z', '2027-05-12T16:30:00Z', sub.id);
    setStatus(db, sub.id, 'withdrawn');
    db.close();

    run(['status', 'cli-conf', '--db', path]);
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }

  const printed = lines.join('\n');
  assert.match(printed, /1 withdrew from a slot in the programme/,
    `conf status did not mention the withdrawal:\n${printed}`);
  assert.match(printed, /conf submissions cli-conf --status withdrawn/,
    'and it has to name the command that shows which one');

  // Every core item appears in the printed output, so the CLI cannot silently
  // drop one that the API still reports.
  for (const item of core) {
    assert.ok(printed.includes(item.text),
      `conf status never mentioned "${item.text}"`);
  }

  // An item core knows about and the CLI has no command for renders as
  // "->  undefined", which is the same drift the URL check catches on the
  // other side. It has to be an assertion, because it still looks like output.
  assert.equal(printed.includes('undefined'), false,
    `conf status printed an item it has no next command for:\n${printed}`);
});
