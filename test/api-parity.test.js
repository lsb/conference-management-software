// The HTTP surface, tested as the thing somebody with no shell actually has.
//
// A parity audit mapped every `conf` verb to its route and found holes: minting
// a speaker's sign-in link was CLI-only, the audience keys could be learned only
// by failing a request on purpose, the outbox list omitted message bodies and
// did not say so, and a room slug -- which you must have before you can schedule
// anything -- appeared nowhere in JSON. Each gap below is one of those.
//
// Every route here is organizer-only. That is asserted rather than assumed: see
// `asAStranger`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { respond } from '../src/server.js';
import { now } from '../src/db.js';
import { SESSION_COOKIE } from '../src/core/auth.js';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { newApp, get, post, redirectedTo, failure } from './http-helpers.js';
import { addPerson, addSpeaker, addTaskDefinition } from './helpers.js';

// --- fixtures ---------------------------------------------------------------

/**
 * An event whose owner is the signed-in person, built over HTTP.
 *
 * Created through `POST /e/new` rather than by inserting a row, because that is
 * what grants the membership. An event conjured straight into the database has
 * no owner, so every assertion below would pass on loopback and 403 everywhere
 * else -- which is precisely the class of bug this file exists to catch.
 */
async function organizerApp() {
  const app = newApp();
  redirectedTo(await post(app, '/e/new', {
    name: 'Parity Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-14',
    timezone: 'America/Los_Angeles', with_defaults: '1',
  }));
  const slug = 'parity-conf-2027';

  await post(app, `/e/${slug}/settings/rooms`, { name: 'Main Stage', capacity: '400' });
  await post(app, `/e/${slug}/settings/rooms`, { name: 'Workshop Room' });
  await post(app, `/e/${slug}/settings/tracks`, { name: 'AI Engineering' });

  const event = app.db.prepare('SELECT * FROM event WHERE slug = ?').get(slug);
  return { app, slug, event };
}

/** One accepted, announced speaker, so there is a person and a message to find. */
function announcedSpeaker(app, event, { first = 'Yusuf', last = 'Karim' } = {}) {
  const person = addPerson(app.db, { first, last, email: `${first}.${last}@example.com`.toLowerCase() });
  const submission = createSubmission(app.db, {
    eventId: event.id, title: `${first}'s talk`, status: 'pending',
  });
  addSpeaker(app.db, submission.id, person.id, { primary: true });
  decide(app.db, [submission.id], 'accept');
  notify(app.db, [submission.id], { portalUrlFor: () => 'http://127.0.0.1:8080/portal/x' });
  return { person, submission };
}

/**
 * A file already sent in against a task, without going through multipart.
 *
 * The bytes are irrelevant here -- what is being tested is that the JSON list
 * joins an upload to the person and the task it answers, which is the only
 * reason to look at it.
 */
function uploadAgainst(db, eventId, personId, taskSlug, filename) {
  const t = now();
  const file = db.prepare(
    `INSERT INTO file (slug, event_id, uploaded_by_person_id, filename, content_type,
                       byte_size, sha256, storage_path, created_at)
     VALUES (?, ?, ?, ?, 'application/pdf', 2048, 'x', ?, ?) RETURNING *`,
  ).get(`file-${filename}`, eventId, personId, filename, `x/${filename}`, t);

  const instance = db.prepare(
    `SELECT ti.id FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
      WHERE td.event_id = ? AND td.slug = ? AND ti.person_id = ?`,
  ).get(eventId, taskSlug, personId);
  assert.ok(instance, `nobody owes '${taskSlug}', so there is nothing to attach a file to`);

  db.prepare(`UPDATE task_instance SET file_id = ?, status = 'done' WHERE id = ?`)
    .run(file.id, instance.id);
  return file;
}

// --- plumbing ---------------------------------------------------------------

async function getJson(app, url, options) {
  const res = await get(app, url, options);
  assert.equal(res.status, 200, `GET ${url} answered ${res.status}`);
  assert.match(res.headers['content-type'], /application\/json/, `GET ${url} did not return JSON`);
  return JSON.parse(res.body);
}

/** POST a JSON body, the way a caller holding only `curl` and llms.txt would. */
async function postJson(app, url, body, { cookies = null } = {}) {
  const encoded = JSON.stringify(body);
  const req = Readable.from([Buffer.from(encoded)]);
  req.headers = { 'content-type': 'application/json' };

  const jar = cookies ?? app.cookies ?? {};
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

  return respond(app, {
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:8080',
      'content-type': 'application/json',
      accept: 'application/json',
      // Same stand-in for a browser that `post()` in http-helpers makes: a
      // cookie-authenticated write with neither Origin nor Sec-Fetch-Site is
      // refused, because that is what a cross-site form post looks like.
      'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : {}),
    },
    req,
  });
}

/**
 * Assert that nobody signed in is refused, with a message they can act on.
 *
 * These read identically under `npm test` and `HOST=0.0.0.0 npm test`, and that
 * is the point. Authorization used to short-circuit to true whenever the process
 * thought it was bound to loopback, which made every gate here a 200 locally and
 * a 403 in a deployment -- two products, only one of them ever exercised. It is
 * a database fact now, so if one of these ever starts depending on how the
 * process was started, something has regressed.
 */
async function refusesStrangers(app, request) {
  const err = await failure(request());
  assert.equal(err.status, 403, `expected 403, got ${err.status}: ${err.message}`);
  assert.match(err.message, /organizer access required/);
  assert.ok(err.hint, 'a 403 with no hint tells nobody how to fix it');
  return err;
}

const anonymously = { cookies: {} };

// --- 1. portal links --------------------------------------------------------

test('a speaker sign-in link can be minted over HTTP, with its expiry', async () => {
  const { app, slug, event } = await organizerApp();
  const { person } = announcedSpeaker(app, event);

  const res = await postJson(app, `/api/events/${slug}/portal-links`, { person: person.slug });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);

  assert.equal(body.person, person.slug);
  assert.match(body.url, new RegExp(`/portal/${slug}/enter\\?token=`));
  assert.ok(body.expires_at, 'a link with no stated expiry is a link somebody sends too late');
  assert.ok(body.expires_at > new Date().toISOString(), 'it should not arrive already expired');
});

test('the minted link actually signs that person in, once', async () => {
  // The point of the route is a working credential, not a plausible string.
  const { app, slug, event } = await organizerApp();
  const { person } = announcedSpeaker(app, event);

  const body = JSON.parse((await postJson(app, `/api/events/${slug}/portal-links`,
    { person: person.slug })).body);
  const token = new URL(body.url).searchParams.get('token');

  const entered = await get(app, `/portal/${slug}/enter?token=${encodeURIComponent(token)}`, anonymously);
  const setCookie = String(entered.headers['set-cookie'] ?? '');
  assert.match(setCookie, new RegExp(SESSION_COOKIE), 'entering with the token should start a session');

  const reused = await get(app, `/portal/${slug}/enter?token=${encodeURIComponent(token)}`, anonymously);
  assert.doesNotMatch(String(reused.headers['set-cookie'] ?? ''), new RegExp(`${SESSION_COOKIE}=[^;]`),
    'a one-time link that works twice is not one-time');
});

test('an unknown person is named in the refusal, not swallowed', async () => {
  const { app, slug } = await organizerApp();

  const err = await failure(postJson(app, `/api/events/${slug}/portal-links`, { person: 'nobody-here' }));
  assert.equal(err.status, 400);
  assert.match(err.message, /nobody-here/);
  assert.match(err.hint, /speakers|\/api\/people/);
});

test('portal-links refuses a stranger', async () => {
  const { app, slug, event } = await organizerApp();
  const { person } = announcedSpeaker(app, event);

  await refusesStrangers(app, () => postJson(app, `/api/events/${slug}/portal-links`,
    { person: person.slug }, { cookies: {} }));
});

// --- 2. audiences -----------------------------------------------------------

test('the audience keys are readable without failing a request on purpose', async () => {
  const { app, slug, event } = await organizerApp();
  announcedSpeaker(app, event);

  const body = await getJson(app, `/api/events/${slug}/audiences`);

  assert.equal(body.count, body.audiences.length);
  const accepted = body.audiences.find((a) => a.key === 'accepted-speakers');
  assert.ok(accepted, 'accepted-speakers should be listed');
  for (const field of ['key', 'label', 'description', 'count']) {
    assert.ok(field in accepted, `an audience without '${field}' cannot be chosen from`);
  }
  assert.equal(accepted.count, 1);
});

test('an audience previews its recipients as JSON, and sends nothing', async () => {
  const { app, slug, event } = await organizerApp();
  const { person } = announcedSpeaker(app, event);
  const before = app.db.prepare('SELECT count(*) AS n FROM outbox').get().n;

  const body = await getJson(app, `/api/events/${slug}/audiences?audience=accepted-speakers`);

  assert.equal(body.count, 1);
  assert.deepEqual(body.recipients, [{
    slug: person.slug, name: 'Yusuf Karim', email: person.email,
  }]);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM outbox').get().n, before,
    'a preview that sends something is not a preview');
});

test('the task filter narrows outstanding-tasks to one thing owed', async () => {
  const { app, slug, event } = await organizerApp();
  addTaskDefinition(app.db, event.id, { slug: 'headshot', title: 'Send a headshot', requirement: 'file' });
  addTaskDefinition(app.db, event.id, { slug: 'upload-slides', title: 'Upload slides', requirement: 'file' });
  announcedSpeaker(app, event);

  const all = await getJson(app, `/api/events/${slug}/audiences?audience=outstanding-tasks`);
  const headshots = await getJson(app,
    `/api/events/${slug}/audiences?audience=outstanding-tasks&task=headshot`);

  assert.ok(all.count >= headshots.count);
  assert.equal(headshots.task, 'headshot');
});

test('an unknown audience is told what the real ones are', async () => {
  const { app, slug } = await organizerApp();

  const err = await failure(get(app, `/api/events/${slug}/audiences?audience=everyone`));
  assert.equal(err.status, 400);
  assert.match(err.hint, /accepted-speakers/);
});

test('audiences refuses a stranger', async () => {
  const { app, slug } = await organizerApp();
  await refusesStrangers(app, () => get(app, `/api/events/${slug}/audiences`, anonymously));
});

// --- 3. outbox bodies -------------------------------------------------------

test('the outbox list carries the id you need to read one, and says bodies are elsewhere', async () => {
  const { app, slug, event } = await organizerApp();
  announcedSpeaker(app, event);

  const body = await getJson(app, `/api/events/${slug}/outbox`);

  assert.ok(body.count > 0, 'notifying a speaker should have written a message');
  const [message] = body.messages;
  assert.ok(Number.isInteger(message.id), 'without an id there is no way to ask for one message');
  assert.ok(!('body' in message), 'the list is envelopes only');
  assert.match(body.note, /outbox\/<id>/,
    'a list that silently omits bodies teaches people that bodies are not stored');
});

test('one message comes back in full, body included', async () => {
  const { app, slug, event } = await organizerApp();
  announcedSpeaker(app, event);

  const list = await getJson(app, `/api/events/${slug}/outbox`);
  const { id } = list.messages[0];
  const message = await getJson(app, `/api/events/${slug}/outbox/${id}`);

  for (const field of ['to', 'subject', 'body', 'kind', 'submission', 'created_at', 'delivered']) {
    assert.ok(field in message, `the detail route should carry '${field}'`);
  }
  assert.ok(message.body.length > 0, 'the body is the entire reason for this route');
  assert.equal(message.kind, 'decision');
  assert.equal(typeof message.delivered, 'boolean');
});

test('a message from another event is not readable through this one', async () => {
  const { app, slug, event } = await organizerApp();
  announcedSpeaker(app, event);
  redirectedTo(await post(app, '/e/new', {
    name: 'Other Conf 2027', starts_at: '2027-09-01', ends_at: '2027-09-02', timezone: 'UTC',
  }));
  const { id } = (await getJson(app, `/api/events/${slug}/outbox`)).messages[0];

  const err = await failure(get(app, `/api/events/other-conf-2027/outbox/${id}`));
  assert.equal(err.status, 404);
  assert.match(err.hint, /outbox/);
});

test('an outbox body refuses a stranger', async () => {
  const { app, slug, event } = await organizerApp();
  announcedSpeaker(app, event);
  const { id } = (await getJson(app, `/api/events/${slug}/outbox`)).messages[0];

  await refusesStrangers(app, () => get(app, `/api/events/${slug}/outbox/${id}`, anonymously));
});

// --- 4. rooms and tracks ----------------------------------------------------

test('the event carries its room and track slugs, so scheduling needs no guessing', async () => {
  const { app, slug } = await organizerApp();

  const body = await getJson(app, `/api/events/${slug}`);

  assert.deepEqual(body.rooms.map((r) => r.slug), ['main-stage', 'workshop-room']);
  assert.equal(body.rooms[0].capacity, 400);
  assert.equal(body.rooms[1].capacity, null, 'a room with no capacity should say so, not vanish');
  assert.deepEqual(body.tracks.map((t) => t.slug), ['ai-engineering']);
});

test('a room slug from the API is the one the schedule form accepts', async () => {
  // The whole point of publishing the slug is that it is usable verbatim.
  const { app, slug, event } = await organizerApp();
  const { submission } = announcedSpeaker(app, event);
  const room = (await getJson(app, `/api/events/${slug}`)).rooms[0].slug;

  const res = await post(app, `/e/${slug}/submissions/${submission.code}/schedule`, {
    room, starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:30',
  });
  assert.equal(res.status, 303, `scheduling into '${room}' should have worked`);

  const agenda = await getJson(app, `/api/events/${slug}/agenda`);
  assert.equal(agenda.scheduled[0].room, room);
});

// --- 5. read-only twins -----------------------------------------------------

test('embeds have a JSON twin that names the format each one records', async () => {
  const { app, slug } = await organizerApp();
  await post(app, `/e/${slug}/embeds`, { name: 'Programme', feed: 'agenda', format: 'json' });

  const body = await getJson(app, `/api/events/${slug}/embeds`);

  assert.equal(body.count, 1);
  const [embed] = body.embeds;
  assert.equal(embed.format, 'json');
  assert.equal(embed.enabled, true);
  assert.match(embed.url, /\/embed\/parity-conf-2027\/programme\.json$/);
  assert.match(body.note, /POST/, 'listing embeds is not making one; the route should say so');
});

test('files have a JSON twin: who sent what, and where to download it', async () => {
  const { app, slug, event } = await organizerApp();
  addTaskDefinition(app.db, event.id, { slug: 'upload-slides', title: 'Upload your slides' });
  addTaskDefinition(app.db, event.id, { slug: 'headshot', title: 'Send a headshot' });
  const { person } = announcedSpeaker(app, event);
  uploadAgainst(app.db, event.id, person.id, 'upload-slides', 'deck.pdf');

  const body = await getJson(app, `/api/events/${slug}/files`);

  assert.equal(body.count, 1);
  const [file] = body.files;
  assert.equal(file.filename, 'deck.pdf');
  assert.equal(file.from, person.slug);
  assert.equal(file.task, 'upload-slides');
  assert.match(file.url, new RegExp(`/files/${file.slug}$`), 'a file row you cannot fetch is a dead end');
  assert.deepEqual([...body.available_tasks].sort(), ['headshot', 'upload-slides'],
    'the ?task= filter is unusable unless the list says which slugs it accepts');
});

test('the file list filters by task, and names the tasks when you get one wrong', async () => {
  const { app, slug, event } = await organizerApp();
  addTaskDefinition(app.db, event.id, { slug: 'upload-slides', title: 'Upload your slides' });
  addTaskDefinition(app.db, event.id, { slug: 'headshot', title: 'Send a headshot' });
  const { person } = announcedSpeaker(app, event);
  uploadAgainst(app.db, event.id, person.id, 'upload-slides', 'deck.pdf');

  assert.equal((await getJson(app, `/api/events/${slug}/files?task=upload-slides`)).count, 1);
  assert.equal((await getJson(app, `/api/events/${slug}/files?task=headshot`)).count, 0);

  const err = await failure(get(app, `/api/events/${slug}/files?task=nonsense`));
  assert.equal(err.status, 400);
  assert.match(err.hint, /headshot/);
});

test('reviews have a JSON twin: submitted and outstanding, per reviewer', async () => {
  const { app, slug } = await organizerApp();

  const body = await getJson(app, `/api/events/${slug}/reviews`);

  assert.equal(body.count, 0, 'a fresh event has nobody assigned');
  assert.deepEqual(body.reviewers, []);
});

test('the speaker database is readable over HTTP, across events', async () => {
  const { app, event } = await organizerApp();
  announcedSpeaker(app, event);
  announcedSpeaker(app, event, { first: 'Ada', last: 'Lovelace' });

  const body = await getJson(app, '/api/people');

  const names = body.people.map((p) => p.name);
  assert.ok(names.includes('Yusuf Karim'), `expected Yusuf in ${JSON.stringify(names)}`);
  assert.equal(body.count, body.people.length);

  const searched = await getJson(app, '/api/people?q=Lovelace');
  assert.deepEqual(searched.people.map((p) => p.name), ['Ada Lovelace']);
});

test('never_spoken finds people we know and have never put on stage', async () => {
  const { app, event } = await organizerApp();
  announcedSpeaker(app, event);
  addPerson(app.db, { first: 'Grace', last: 'Hopper', email: 'grace@example.com' });

  const body = await getJson(app, '/api/people?never_spoken=1');
  const names = body.people.map((p) => p.name);

  assert.ok(names.includes('Grace Hopper'), `expected Grace in ${JSON.stringify(names)}`);
  assert.ok(!names.includes('Yusuf Karim'), 'somebody who has spoken is not never-spoken');
});

test('one person comes back with every event they appear in', async () => {
  const { app, event } = await organizerApp();
  const { person, submission } = announcedSpeaker(app, event);

  const body = await getJson(app, `/api/people/${person.slug}`);

  assert.equal(body.person, person.slug);
  assert.equal(body.events_spoken, 1);
  assert.deepEqual(body.history.map((h) => h.code), [submission.code]);
  assert.equal(body.history[0].event, 'parity-conf-2027');
  assert.equal(body.history[0].status, 'accepted');
});

test('an unknown person slug says how to find the right one', async () => {
  const { app } = await organizerApp();

  const err = await failure(get(app, '/api/people/who-even'));
  assert.equal(err.status, 404);
  assert.match(err.hint, /\/api\/people\?q=/);
});

test('every new read-only twin refuses a stranger', async () => {
  const { app, slug, event } = await organizerApp();
  const { person } = announcedSpeaker(app, event);

  for (const url of [
    `/api/events/${slug}`,
    `/api/events/${slug}/embeds`,
    `/api/events/${slug}/files`,
    `/api/events/${slug}/reviews`,
    '/api/people',
    `/api/people/${person.slug}`,
  ]) {
    await refusesStrangers(app, () => get(app, url, anonymously));
  }
});

test('the speaker database stays shut on an instance with no events at all', async () => {
  // The CRM had this exact hole: with no event to check membership against, the
  // check returned early and handed every name and email to anybody asking.
  const app = newApp({ as: null });

  await refusesStrangers(app, () => get(app, '/api/people', anonymously));
});

// --- discoverability --------------------------------------------------------

test('every new route appears in llms.txt, because that is the only front door', async () => {
  const { app } = await organizerApp();

  // ?all=1, because the default is now the short form: recipes only. The
  // complete route table is what this test is about, and it is one flag away.
  const llms = (await get(app, '/llms.txt?all=1')).body;

  for (const pattern of [
    '/api/events/:event/portal-links',
    '/api/events/:event/audiences',
    '/api/events/:event/outbox/:id',
    '/api/events/:event/embeds',
    '/api/events/:event/files',
    '/api/events/:event/reviews',
    '/api/people',
    '/api/people/:slug',
  ]) {
    assert.ok(llms.includes(pattern), `${pattern} is missing from llms.txt`);
  }
});

test('no route is registered without a doc string', async () => {
  // A route with no doc is invisible in llms.txt, which for a caller with no
  // source access is the same as a route that does not exist.
  const { app } = await organizerApp();

  const undocumented = app.router.routes.filter((r) => !r.doc).map((r) => `${r.method} ${r.pattern}`);
  assert.deepEqual(undocumented, []);
});

// --- counting without counting ------------------------------------------------

test('the submission list carries the counts, so nobody has to tally rows', async () => {
  // A model asked "how many are waiting for a decision" fetched this route
  // unfiltered and answered 6, from a list of 19 whose true pending count was 4.
  // Nothing in the data misled it -- it counted wrong -- and `count`, which is
  // how many rows came back, sits at the top as a plausible wrong answer.
  const { app, slug: event } = await organizerApp();

  const before = await get(app, `/api/events/${event}/submissions`);
  assert.equal(before.status, 200);
  assert.ok(JSON.parse(before.body).by_status, 'the reply should carry by_status');

  await post(app, `/e/${event}/forms`, { internal_name: 'CFP', with_defaults: '1' });
  const form = (await get(app, `/e/${event}/forms`)).body.match(/\/forms\/([a-z0-9-]+)"/)[1];
  for (const title of ['One', 'Two', 'Three']) {
    await post(app, `/submit/${event}/${form}`, {
      title, description: 'x', format: 'talk-30-min', track: 'ai-engineering',
      'first-name': 'A', 'last-name': title, email: `${title.toLowerCase()}@example.com`,
      biography: 'Engineer.',
    });
  }

  const all = await get(app, `/api/events/${event}/submissions`);
  const body = JSON.parse(all.body);

  assert.equal(body.by_status.pending, 3,
    'by_status should answer the question the rows would otherwise have to be counted for');
  assert.equal(body.count, body.submissions.length,
    'count is how many came back, and should say so by matching');
});

test('by_status describes the event, not the filter', async () => {
  // Otherwise a filtered call answers its own question tautologically -- ask for
  // the pending ones and be told how many pending ones you were sent -- and the
  // denominator, which is the useful part, disappears exactly when you narrow.
  const { app, slug: event } = await organizerApp();
  await post(app, `/e/${event}/forms`, { internal_name: 'CFP', with_defaults: '1' });
  const form = (await get(app, `/e/${event}/forms`)).body.match(/\/forms\/([a-z0-9-]+)"/)[1];
  await post(app, `/submit/${event}/${form}`, {
    title: 'One', description: 'x', format: 'talk-30-min', track: 'ai-engineering',
    'first-name': 'A', 'last-name': 'B', email: 'a@example.com', biography: 'Engineer.',
  });

  const filtered = await get(app, `/api/events/${event}/submissions?status=accepted`);
  const body = JSON.parse(filtered.body);

  assert.equal(body.count, 0, 'nothing is accepted yet');
  assert.equal(body.by_status.pending, 1, 'but the event still has one pending, and should say so');
  assert.equal(body.filtered, true, 'and should say that what came back was narrowed');
});

// --- findability --------------------------------------------------------------

test('the entry point says where the documentation is', async () => {
  // Run 9: every attempt in the blank-directory suite began with GET
  // /api/events, and the ones that went on to read /llms.txt passed while the
  // ones that started guessing routes failed. We had written a machine-readable
  // index for exactly that reader and the only way to find it was to know.
  const app = newApp({ as: null });

  const entry = await get(app, '/api/events', { cookies: {} });

  assert.equal(entry.status, 200, 'the entry point must answer without credentials');
  const body = JSON.parse(entry.body);
  assert.match(body.docs, /\/llms\.txt$/, 'and it must say where the instructions are');
  assert.match(body.docs_all_routes, /\/llms\.txt\?all=1$/,
    'the full route list must be a URL to copy, not an instruction to build one: '
    + 'a reader told to "add ?all=1" appends it to whatever it is holding, and one '
    + 'wrote it unquoted into a shell where zsh globbed the ? and ate the request');
});

test('what needs attention comes back as sentences with somewhere to go', async () => {
  // `conf status` and the dashboard both answer this in the words the question
  // uses. The API offered `submissions.pending: 4` and left the caller to know
  // that pending means awaiting-a-decision; asked exactly that, a model picked
  // `accepted: 6` out of the same map three times running.
  const { app, slug } = await organizerApp();
  await post(app, `/e/${slug}/forms`, { internal_name: 'CFP', with_defaults: '1' });
  const form = (await get(app, `/e/${slug}/forms`)).body.match(/\/forms\/([a-z0-9-]+)"/)[1];
  await post(app, `/submit/${slug}/${form}`, {
    title: 'One', description: 'x', format: 'talk-30-min', track: 'ai-engineering',
    'first-name': 'A', 'last-name': 'B', email: 'a@example.com', biography: 'Engineer.',
  });

  const body = JSON.parse((await get(app, `/api/events/${slug}`)).body);
  const waiting = body.needs_attention.find((n) => /awaiting a decision/.test(n.text));

  assert.ok(waiting, `expected a sentence about awaiting a decision, got ${
    JSON.stringify(body.needs_attention)}`);
  assert.equal(waiting.count, 1);
  assert.match(waiting.where, /status=pending/,
    'a count without the link to its rows is half an answer');
});

test('nothing needing attention says nothing, rather than saying zero', async () => {
  const { app, slug } = await organizerApp();
  const body = JSON.parse((await get(app, `/api/events/${slug}`)).body);
  assert.deepEqual(body.needs_attention, [],
    'a fresh event has nothing to chase, and a list of zeroes is noise');
});

test('the task list says how it can be narrowed, with whole URLs', async () => {
  // "Which speakers have not uploaded a headshot" was answered with twenty rows
  // of four kinds; the reader filtered by eye and missed one of six. Finding 2,
  // third occurrence. `available_tasks` was already there and is a bare list of
  // slugs -- it does not say what to do with them.
  const { app, slug } = await organizerApp();
  await post(app, `/e/${slug}/tasks/definitions`, {
    title: 'Upload a headshot', applies_to: 'person', requirement: 'file',
  });

  const body = JSON.parse((await get(app, `/api/events/${slug}/tasks`)).body);

  assert.ok(body.by_task, 'an unfiltered list should say how many owe each kind');
  const slugs = Object.keys(body.narrow_to_one_kind);
  assert.ok(slugs.length > 0, 'and should hand over the URL for each kind');
  assert.match(body.narrow_to_one_kind[slugs[0]], /\/tasks\?task=/,
    'a whole URL, because a reader told to build one appends it to whatever it is holding');
});

test('a narrowed task list does not repeat the whole menu back', async () => {
  const { app, slug } = await organizerApp();
  await post(app, `/e/${slug}/tasks/definitions`, {
    title: 'Upload a headshot', applies_to: 'person', requirement: 'file',
  });

  const body = JSON.parse((await get(app,
    `/api/events/${slug}/tasks?task=upload-a-headshot`)).body);

  assert.equal(body.filtered, true, 'it should say the rows were narrowed');
  assert.equal(body.by_task, undefined,
    'and not offer the menu again to somebody who has already ordered');
});
