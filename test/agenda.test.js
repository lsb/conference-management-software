// Building the agenda, and answering a machine about it.
//
// Two things are being pinned down here. First, that drag-and-drop is an input
// method laid over a working forms-based scheduler rather than a replacement for
// one: every placement the grid offers is a real form posting to the same route
// the submission page posts to, so the schedule can be built with a keyboard,
// with scripting off, or with curl. Second, that the three agenda writes now
// hand back what they computed instead of spending it on a sentence in a query
// string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { respond } from '../src/server.js';
import { newApp, get, post, redirectedTo, failure } from './http-helpers.js';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { addPerson, addSpeaker } from './helpers.js';

const EVENT = 'grid-conf-2027';

/**
 * POST a form, but ask for the answer rather than the page.
 *
 * The only difference from `post` in ./http-helpers.js is one request header,
 * which is the entire subject of half of these tests.
 */
async function postAccepting(app, url, fields = {}, accept = 'application/json') {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) body.append(key, one);
  }
  const req = Readable.from([Buffer.from(body.toString())]);
  req.headers = { 'content-type': 'application/x-www-form-urlencoded' };

  const jar = Object.entries(app.cookies ?? {})
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

  return respond(app, {
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:8080',
      // Standing in for the browser the way ./http-helpers.js does: the server
      // refuses a cookie-authenticated write that carries neither this nor an
      // Origin, and an in-process request from the app's own form is honestly
      // same-origin.
      'sec-fetch-site': 'same-origin',
      ...(jar ? { cookie: jar } : {}),
      accept,
      'content-type': 'application/x-www-form-urlencoded',
    },
    req,
  });
}

/**
 * The first form on a page that posts to `action`, with its hidden fields read
 * out of the markup. This is what a browser would send, and what somebody
 * tabbing to the button and pressing it sends.
 */
function formFor(body, action) {
  const open = body.indexOf(`<form method="post" action="${action}">`);
  if (open === -1) return null;
  const markup = body.slice(open, body.indexOf('</form>', open));

  const fields = {};
  for (const m of markup.matchAll(/<input type="hidden" name="([^"]+)"\s+value="([^"]*)"/g)) {
    fields[m[1]] = m[2];
  }
  return { action, fields, markup };
}

async function conference(app, { rooms = ['Main Stage', 'Alder Room'] } = {}) {
  redirectedTo(await post(app, '/e/new', {
    name: 'Grid Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-13',
    timezone: 'America/Los_Angeles',
  }));
  for (const name of rooms) await post(app, `/e/${EVENT}/settings/rooms`, { name });
  return app.db.prepare('SELECT * FROM event WHERE slug = ?').get(EVENT);
}

let speakers = 0;

/** An accepted session with one speaker, the way an organizer would have one. */
function acceptedSession(app, event, { title = 'A talk', told = true } = {}) {
  speakers += 1;
  const person = addPerson(app.db, {
    first: 'Ada', last: `Speaker${speakers}`, email: `ada${speakers}@example.com`,
  });
  const sub = createSubmission(app.db, { eventId: event.id, title, status: 'pending' });
  addSpeaker(app.db, sub.id, person.id, { primary: true });
  decide(app.db, [sub.id], 'accept');
  if (told) notify(app.db, [sub.id]);
  return app.db.prepare('SELECT * FROM submission WHERE id = ?').get(sub.id);
}

const approve = (app, sub) =>
  app.db.prepare(`UPDATE submission SET content_status = 'approved' WHERE id = ?`).run(sub.id);

const reload = (app, sub) =>
  app.db.prepare('SELECT * FROM submission WHERE id = ?').get(sub.id);

// --- the grid a schedule is built in ---------------------------------------

test('the grid has free slots to aim at before anything is scheduled', async () => {
  // agendaGrid alone only emits rows that already hold something, which is a
  // grid you cannot put the first session into.
  const app = newApp();
  await conference(app);

  const body = (await get(app, `/e/${EVENT}/agenda?view=week`)).body;

  assert.match(body, /data-drop="1" data-room="main-stage" data-start="2027-05-\d\dT09:00"/);
  assert.match(body, /data-drop="1" data-room="alder-room" data-start="2027-05-\d\dT09:00"/);
});

test('the grid covers the days the conference actually runs', async () => {
  // candidateSlots reads the event's dates through the timezone, which for a
  // westward event puts the first day a day early. That is fine for placing
  // things and wrong as a heading somebody reads.
  const app = newApp();
  await conference(app);

  const body = (await get(app, `/e/${EVENT}/agenda?view=week`)).body;

  assert.deepEqual([...body.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]),
    ['2027-05-12', '2027-05-13']);
});

test('a session scheduled off the hourly scaffold still gets a row of its own', async () => {
  // A session you cannot see is a session you cannot move.
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);
  await post(app, `/e/${EVENT}/submissions/${sub.code}/schedule`, {
    room: 'main-stage', starts_at: '2027-05-13T09:30', ends_at: '2027-05-13T10:00',
  });

  const body = (await get(app, `/e/${EVENT}/agenda?view=week`)).body;

  assert.match(body, /<th scope="row">09:30<\/th>/);
  assert.match(body, new RegExp(`data-code="${sub.code}" data-minutes="30"`));
});

test('a scheduled session is something you can pick up, and says where its move posts', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);
  await post(app, `/e/${EVENT}/submissions/${sub.code}/schedule`, {
    room: 'main-stage', starts_at: '2027-05-12T10:00', ends_at: '2027-05-12T10:45',
  });

  const body = (await get(app, `/e/${EVENT}/agenda?view=week`)).body;

  assert.match(body, /draggable="true"/);
  assert.match(body, new RegExp(`data-code="${sub.code}" data-minutes="45"`));
  assert.match(body, new RegExp(
    `data-schedule-action="/e/${EVENT}/submissions/${sub.code}/schedule"`));
});

test('sessions with no slot are offered alongside the grid, ready to be dragged in', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event, { title: 'Homeless talk' });

  const body = (await get(app, `/e/${EVENT}/agenda?view=week`)).body;

  assert.match(body, /Not in the grid yet/);
  assert.match(body, new RegExp(`data-code="${sub.code}" data-minutes="45"`));
});

// --- the same placement, with no mouse and no script ------------------------

test('a session is moved with a link and a button, and nothing else', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);

  // Pick it up: an ordinary link into move mode.
  const picked = await get(app, `/e/${EVENT}/agenda?view=week&move=${sub.code}`);
  assert.equal(picked.status, 200);
  assert.match(picked.body, new RegExp(`Moving <code>${sub.code}</code>`));

  // Put it down: an ordinary submit button in an ordinary form.
  const action = `/e/${EVENT}/submissions/${sub.code}/schedule`;
  const form = formFor(picked.body, action);
  assert.ok(form, 'every free slot should hold a real form while a session is being moved');
  assert.deepEqual(Object.keys(form.fields).sort(),
    ['ends_at', 'return_to', 'room', 'starts_at']);
  assert.match(form.markup, /<button type="submit"/);

  const landed = await post(app, action, form.fields);

  const to = redirectedTo(landed);
  assert.match(to, /^\/e\/grid-conf-2027\/agenda\?view=week&done=/,
    'placing from the grid should leave you looking at the grid');

  const after = reload(app, sub);
  assert.ok(after.starts_at, 'the session now has a time');
  assert.ok(after.room_id, 'and a room');
});

test('move mode offers each session its own length rather than a guess', async () => {
  const app = newApp();
  const event = await conference(app);
  const short = acceptedSession(app, event, { title: 'Lightning' });
  const long = acceptedSession(app, event, { title: 'Workshop' });
  await post(app, `/e/${EVENT}/submissions/${long.code}/schedule`, {
    room: 'main-stage', starts_at: '2027-05-12T13:00', ends_at: '2027-05-12T14:30',
  });

  const spans = async (sub) => {
    const body = (await get(app, `/e/${EVENT}/agenda?view=week&move=${sub.code}`)).body;
    const { fields } = formFor(body, `/e/${EVENT}/submissions/${sub.code}/schedule`);
    return (Date.parse(`${fields.ends_at}:00Z`) - Date.parse(`${fields.starts_at}:00Z`)) / 60_000;
  };

  assert.equal(await spans(long), 90, 'a 90 minute session stays 90 minutes wherever it lands');
  assert.equal(await spans(short), 45, 'and one that has never had a time gets the default');
});

test('the grid refuses a clash the same way the form does', async () => {
  const app = newApp();
  const event = await conference(app);
  const first = acceptedSession(app, event, { title: 'First' });
  const second = acceptedSession(app, event, { title: 'Second' });

  const slot = { room: 'main-stage', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45' };
  await post(app, `/e/${EVENT}/submissions/${first.code}/schedule`, slot);

  const err = await failure(post(app, `/e/${EVENT}/submissions/${second.code}/schedule`, {
    ...slot, return_to: `/e/${EVENT}/agenda?view=week`,
  }));

  assert.equal(err.status, 400);
  assert.match(err.message, /clashes/);
  assert.equal(reload(app, second).starts_at, null, 'a refused move changes nothing');
});

test('an unknown session to move is a 404 that names the problem', async () => {
  const app = newApp();
  await conference(app);

  const err = await failure(get(app, `/e/${EVENT}/agenda?view=week&move=SESS-404`));

  assert.equal(err.status, 404);
  assert.match(err.message, /SESS-404/);
});

// --- the drag enhancement itself -------------------------------------------

test('dragging posts the form; it does not decide anything', async () => {
  // D10: a script may change what is shown, never what is valid. So the drop
  // handler is allowed to fill in a form and submit it, and nothing else -- no
  // request of its own, and no opinion about clashes.
  const app = newApp();
  await conference(app);

  const body = (await get(app, `/e/${EVENT}/agenda?view=week`)).body;
  assert.match(body, /<form method="post" id="drop-form" hidden>/);

  const script = body.slice(body.indexOf('<script>'), body.indexOf('</script>'));
  assert.ok(script.length > 0, 'the grid view should carry the enhancement');
  assert.match(script, /form\.submit\(\)/);
  for (const decidingForItself of ['fetch(', 'XMLHttpRequest', 'clash', 'overlap']) {
    assert.ok(!script.includes(decidingForItself),
      `the browser must not ${decidingForItself} -- the server is the authority`);
  }
});

test('nothing in the grid depends on the script running', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);

  const beforeScript = (body) => body.slice(0, body.indexOf('<script>'));

  // Picking a session up is a link.
  const resting = beforeScript((await get(app, `/e/${EVENT}/agenda?view=week`)).body);
  assert.match(resting,
    new RegExp(`href="/e/${EVENT}/agenda\\?view=week&amp;move=${sub.code}"`));

  // Putting it down is a form.
  const moving = beforeScript(
    (await get(app, `/e/${EVENT}/agenda?view=week&move=${sub.code}`)).body);
  assert.ok(formFor(moving, `/e/${EVENT}/submissions/${sub.code}/schedule`),
    'the placement is a form, present in the markup the server sent');

  for (const markup of [resting, moving]) {
    assert.equal(markup.match(/\son[a-z]+="/g), null, 'no inline event handlers');
  }
});

// --- the writes answer a machine -------------------------------------------

test('placing a session answers with where it ended up', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);

  const res = await postAccepting(app, `/e/${EVENT}/submissions/${sub.code}/schedule`, {
    room: 'main-stage', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
  });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);

  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body).sort(),
    ['code', 'ends_at', 'invited', 'published', 'room', 'starts_at']);
  assert.equal(body.code, sub.code);
  assert.equal(body.room, 'main-stage');
  assert.equal(body.starts_at, '2027-05-12T16:00:00Z', 'wall clock in, instants out');
  assert.equal(body.ends_at, '2027-05-12T16:45:00Z');
  assert.equal(body.published, false);
  assert.equal(body.invited, 1, 'the speaker had been told, so their calendar was revised');
});

test('a browser placing the same session still gets its redirect', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);

  const to = redirectedTo(await post(app, `/e/${EVENT}/submissions/${sub.code}/schedule`, {
    room: 'main-stage', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
  }));

  assert.equal(to, `/e/${EVENT}/submissions/${sub.code}?invited=1`);
});

test('a return_to pointing off this event is ignored rather than followed', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);

  const to = redirectedTo(await post(app, `/e/${EVENT}/submissions/${sub.code}/schedule`, {
    room: 'main-stage', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
    return_to: 'https://evil.example/collect',
  }));

  assert.equal(to.split('?')[0], `/e/${EVENT}/submissions/${sub.code}`);
});

test('publication is reported as it ended up, not as it was asked for', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);
  approve(app, sub);

  const published = JSON.parse((await postAccepting(app,
    `/e/${EVENT}/submissions/${sub.code}/schedule`, {
      room: 'main-stage', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
      published_set: '1', published: 'on',
    })).body);
  assert.equal(published.published, true);

  // A move that says nothing about publication must not unpublish, and the
  // answer has to say so rather than echoing back the missing field.
  const moved = JSON.parse((await postAccepting(app,
    `/e/${EVENT}/submissions/${sub.code}/schedule`, {
      room: 'main-stage', starts_at: '2027-05-12T11:00', ends_at: '2027-05-12T11:45',
    })).body);
  assert.equal(moved.published, true);
  assert.equal(moved.starts_at, '2027-05-12T18:00:00Z');
});

test('autoschedule answers with what it placed and what it could not', async () => {
  const app = newApp();
  const event = await conference(app);
  const one = acceptedSession(app, event, { title: 'One' });
  const two = acceptedSession(app, event, { title: 'Two' });

  const res = await postAccepting(app, `/e/${EVENT}/agenda/autoschedule`);

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body).sort(), ['placed', 'remaining']);
  assert.equal(body.placed.length, 2);
  assert.equal(body.remaining, 0);

  assert.deepEqual([...body.placed.map((p) => p.code)].sort(), [one.code, two.code].sort());
  for (const placed of body.placed) {
    assert.ok(placed.room, 'each placement names the room it went into');
    assert.ok(placed.day && placed.time, 'and when');
  }
});

test('autoschedule with nowhere to put anything says so, and counts what is left', async () => {
  const app = newApp();
  const event = await conference(app, { rooms: [] });
  acceptedSession(app, event, { title: 'One' });
  acceptedSession(app, event, { title: 'Two' });

  const body = JSON.parse((await postAccepting(app, `/e/${EVENT}/agenda/autoschedule`)).body);

  assert.deepEqual(body.placed, []);
  assert.equal(body.remaining, 2);
});

test('autoschedule still redirects a browser with its sentence', async () => {
  const app = newApp();
  const event = await conference(app);
  acceptedSession(app, event, { title: 'One' });

  const to = redirectedTo(await post(app, `/e/${EVENT}/agenda/autoschedule`));

  assert.match(to, /^\/e\/grid-conf-2027\/agenda\?view=list&done=/);
  assert.match(decodeURIComponent(to), /Placed 1 session/);
});

test('publishing answers with what went out and what was held back, and why', async () => {
  const app = newApp();
  const event = await conference(app);

  const ready = acceptedSession(app, event, { title: 'Ready' });
  approve(app, ready);
  await post(app, `/e/${EVENT}/submissions/${ready.code}/schedule`, {
    room: 'main-stage', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
  });

  const unapproved = acceptedSession(app, event, { title: 'Unapproved' });
  await post(app, `/e/${EVENT}/submissions/${unapproved.code}/schedule`, {
    room: 'alder-room', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
  });

  const homeless = acceptedSession(app, event, { title: 'No slot' });
  approve(app, homeless);

  const res = await postAccepting(app, `/e/${EVENT}/agenda/publish`);

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, { published: 1, held_back: { unapproved: 1, unscheduled: 1 } });
  assert.equal(reload(app, ready).published, 1);
  assert.equal(reload(app, unapproved).published, 0);
});

test('publishing nothing at all is zeroes, not nulls', async () => {
  const app = newApp();
  await conference(app);

  const body = JSON.parse((await postAccepting(app, `/e/${EVENT}/agenda/publish`)).body);

  assert.deepEqual(body, { published: 0, held_back: { unapproved: 0, unscheduled: 0 } });
});

test('publishing still redirects a browser with its sentence', async () => {
  const app = newApp();
  await conference(app);

  const to = redirectedTo(await post(app, `/e/${EVENT}/agenda/publish`));

  assert.match(to, /^\/e\/grid-conf-2027\/agenda\?view=list&done=/);
});

// --- none of it is open to a stranger ---------------------------------------

test('the grid and all three writes need organizer access', async () => {
  const app = newApp();
  const event = await conference(app);
  const sub = acceptedSession(app, event);
  const stranger = { cookies: {} };

  const refusals = [
    await failure(get(app, `/e/${EVENT}/agenda?view=week`, stranger)),
    await failure(get(app, `/e/${EVENT}/agenda?view=week&move=${sub.code}`, stranger)),
    await failure(post(app, `/e/${EVENT}/submissions/${sub.code}/schedule`, {
      room: 'main-stage', starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
    }, stranger)),
    await failure(post(app, `/e/${EVENT}/agenda/autoschedule`, {}, stranger)),
    await failure(post(app, `/e/${EVENT}/agenda/publish`, {}, stranger)),
  ];

  for (const err of refusals) {
    assert.equal(err.status, 403, err.message);
    assert.match(err.hint, /sign in/);
  }
  assert.equal(reload(app, sub).starts_at, null, 'and nothing was written on the way past');
});
