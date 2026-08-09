import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, get, post, redirectedTo, failure } from './http-helpers.js';

const NEW_EVENT = {
  name: 'DevFlow Conf 2027',
  starts_at: '2027-05-12',
  ends_at: '2027-05-14',
  location: 'Moscone West, San Francisco, CA',
  timezone: 'America/Los_Angeles',
  with_defaults: '1',
};

async function makeEvent(app, overrides = {}) {
  const to = redirectedTo(await post(app, '/e/new', { ...NEW_EVENT, ...overrides }));
  return to.split('/')[2];
}

test('an organizer can create an event and it becomes reachable', async () => {
  const app = newApp();
  const slug = await makeEvent(app);

  assert.equal(slug, 'devflow-conf-2027');
  assert.equal((await get(app, `/e/${slug}`)).status, 200);
  assert.equal((await get(app, `/event/${slug}`)).status, 200, 'and its public page exists');
});

test('/e/new is a literal route, not an event called "new"', async () => {
  const app = newApp();
  assert.equal((await get(app, '/e/new')).status, 200);
});

test('a second event can be created, because multi-event is the point', async () => {
  const app = newApp();
  await makeEvent(app);
  const second = await makeEvent(app, { name: 'DevFlow Conf 2028', starts_at: '2028-05-10', ends_at: '2028-05-12' });

  assert.equal(second, 'devflow-conf-2028');
  const events = JSON.parse((await get(app, '/api/events')).body).events;
  assert.equal(events.length, 2);
});

test('two events with the same name get distinct slugs', async () => {
  const app = newApp();
  const first = await makeEvent(app);
  const second = await makeEvent(app);
  assert.notEqual(first, second);
  assert.equal(second, 'devflow-conf-2027-2');
});

test('an event that ends before it starts is refused, with both dates named', async () => {
  const app = newApp();
  const err = await failure(post(app, '/e/new',
    { ...NEW_EVENT, starts_at: '2027-05-14', ends_at: '2027-05-12' }));
  assert.match(err.message, /last day \(2027-05-12\) is before the first \(2027-05-14\)/);
});

test('a new event starts with usable formats and levels', async () => {
  const app = newApp();
  const slug = await makeEvent(app);
  const options = app.db.prepare(
    `SELECT kind, label FROM taxonomy_option
       WHERE event_id = (SELECT id FROM event WHERE slug = ?) ORDER BY kind, sort_order`,
  ).all(slug);

  const formats = options.filter((o) => o.kind === 'format').map((o) => o.label);
  assert.ok(formats.includes('Talk (30 min)'), 'a conference needs somewhere to start');
  assert.deepEqual(options.filter((o) => o.kind === 'level').map((o) => o.label),
    ['Beginner', 'Intermediate', 'Advanced']);
});

test('opting out of the defaults leaves the vocabulary empty', async () => {
  const app = newApp();
  const slug = await makeEvent(app, { with_defaults: '' });
  const { n } = app.db.prepare(
    'SELECT count(*) AS n FROM taxonomy_option WHERE event_id = (SELECT id FROM event WHERE slug = ?)',
  ).get(slug);
  assert.equal(n, 0);
});

test('rooms and tracks can be added and are slugged readably', async () => {
  const app = newApp();
  const slug = await makeEvent(app);

  await post(app, `/e/${slug}/settings/rooms`, { name: 'Main Stage', capacity: '600' });
  await post(app, `/e/${slug}/settings/tracks`, { name: 'AI Engineering' });

  const room = app.db.prepare('SELECT * FROM room WHERE slug = ?').get('main-stage');
  const track = app.db.prepare('SELECT * FROM track WHERE slug = ?').get('ai-engineering');
  assert.equal(room.capacity, 600);
  assert.equal(track.name, 'AI Engineering');
});

test('a room holding sessions cannot be deleted out from under them', async () => {
  const app = newApp();
  const slug = await makeEvent(app);
  await post(app, `/e/${slug}/settings/rooms`, { name: 'Main Stage' });

  const eventId = app.db.prepare('SELECT id FROM event WHERE slug = ?').get(slug).id;
  const roomId = app.db.prepare('SELECT id FROM room WHERE slug = ?').get('main-stage').id;
  app.db.prepare(
    `INSERT INTO submission (event_id, code, title, status, room_id, created_at, updated_at)
     VALUES (?, 'SESS-1', 'A talk', 'accepted', ?, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z')`,
  ).run(eventId, roomId);

  // Deleting would set those sessions' room to NULL and silently unschedule
  // them, which is worse than being told no.
  const err = await failure(post(app, `/e/${slug}/settings/rooms/main-stage/delete`));
  assert.match(err.message, /still holds 1 session/);
  assert.match(err.hint, /move them/);
  assert.ok(app.db.prepare('SELECT 1 FROM room WHERE slug = ?').get('main-stage'));
});

test('an unused room can be deleted', async () => {
  const app = newApp();
  const slug = await makeEvent(app);
  await post(app, `/e/${slug}/settings/rooms`, { name: 'Overflow Room' });
  await post(app, `/e/${slug}/settings/rooms/overflow-room/delete`);
  assert.equal(app.db.prepare('SELECT 1 FROM room WHERE slug = ?').get('overflow-room'), undefined);
});

test('vocabulary can be added and removed per kind', async () => {
  const app = newApp();
  const slug = await makeEvent(app, { with_defaults: '' });

  await post(app, `/e/${slug}/settings/options`, { kind: 'format', label: 'Fireside chat' });
  assert.ok(app.db.prepare("SELECT 1 FROM taxonomy_option WHERE kind='format' AND slug='fireside-chat'").get());

  await post(app, `/e/${slug}/settings/options/format/fireside-chat/delete`);
  assert.equal(app.db.prepare("SELECT 1 FROM taxonomy_option WHERE slug='fireside-chat'").get(), undefined);
});

test('an unknown vocabulary kind is refused and the valid ones are named', async () => {
  const app = newApp();
  const slug = await makeEvent(app);
  const err = await failure(post(app, `/e/${slug}/settings/options`, { kind: 'colour', label: 'Blue' }));
  assert.match(err.message, /must be one of: format, level, language, tag/);
});

test('editing event details persists them', async () => {
  const app = newApp();
  const slug = await makeEvent(app);

  await post(app, `/e/${slug}/settings`, {
    name: 'DevFlow Conf 2027', event_type: 'Summit', location: 'Oakland',
    timezone: 'America/New_York', starts_at: '2027-05-12', ends_at: '2027-05-15',
    description: 'Now four days.',
  });

  const event = app.db.prepare('SELECT * FROM event WHERE slug = ?').get(slug);
  assert.equal(event.event_type, 'Summit');
  assert.equal(event.location, 'Oakland');
  assert.equal(event.timezone, 'America/New_York');
  assert.match(event.ends_at, /^2027-05-15/);
});
