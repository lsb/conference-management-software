// The JSON API's notify endpoint, which is irreversible and must not guess.
//
// `conf notify` was hardened after Run 4, where a mistyped flag mailed the whole
// decision queue. The JSON twin kept the original behaviour for months: an empty
// body meant "everybody". Probing the endpoint's shape with `{}` was enough to
// send it. These tests are here so that cannot come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp, respond } from '../src/server.js';
import { createMagicLink, consumeMagicLink, SESSION_COOKIE } from '../src/core/auth.js';
import { createSubmission, decide } from '../src/core/submissions.js';
import { newEvent, addPerson, addSpeaker, outboxFor } from './helpers.js';

/** An event with three accepted-but-unannounced submissions sitting in the queue. */
function queuedDecisions() {
  const { db, event } = newEvent();
  const owner = addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' });
  db.prepare(`INSERT INTO event_membership (event_id, person_id, role) VALUES (?, ?, 'owner')`)
    .run(event.id, owner.id);

  const codes = [];
  for (const [i, name] of [['Grace', 'Hopper'], ['Alan', 'Turing'], ['Radia', 'Perlman']].entries()) {
    const person = addPerson(db, { first: name[0], last: name[1], email: `p${i}@example.com` });
    const sub = createSubmission(db, { eventId: event.id, title: `Talk ${i}`, status: 'pending' });
    addSpeaker(db, sub.id, person.id, { primary: true });
    decide(db, [sub.id], 'accept');
    codes.push(sub.code);
  }

  return { db, event, codes, app: signedInApp(db, owner) };
}

/**
 * An app with a real organizer session, minted the way the app mints one.
 *
 * Without this these tests only pass where organizer access happens to be open,
 * which is a property of how the server was started rather than of the app. The
 * point of `notify` refusing to guess is that it refuses everywhere.
 */
function signedInApp(db, person) {
  const app = createApp({ db });
  const session = consumeMagicLink(db, createMagicLink(db, person.id, null));
  app.sessionToken = session.token;
  return app;
}

async function postJson(app, url, body) {
  const encoded = JSON.stringify(body);
  const req = Readable.from([Buffer.from(encoded)]);
  req.headers = { 'content-type': 'application/json' };
  return respond(app, {
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:8080',
      'content-type': 'application/json',
      accept: 'application/json',
      ...(app.sessionToken ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(app.sessionToken)}` } : {}),
    },
    req,
  });
}

const decisionsSent = (db) => outboxFor(db, { kind: 'decision' }).length;

/** The HttpError a handler threw, so we can assert on its status, message, and hint. */
async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to be refused, but it succeeded');
}

test('an empty body sends nothing and says how many are waiting', async () => {
  const { db, app } = queuedDecisions();

  const err = await refusal(postJson(app, '/api/events/conf-2026/notify', {}));

  assert.equal(err.status, 400);
  assert.match(err.message, /3/, 'it names the blast radius it just refused');
  assert.match(err.hint, /all/, 'and says how to mean it on purpose');
  assert.equal(decisionsSent(db), 0, 'and mails nobody');
});

test('explicit codes send only those', async () => {
  const { db, app, codes } = queuedDecisions();

  const res = await postJson(app, '/api/events/conf-2026/notify', { codes: [codes[0]] });

  assert.equal(res.status, 200);
  assert.equal(decisionsSent(db), 1);
});

test('saying all really does mean all', async () => {
  const { db, app } = queuedDecisions();

  const res = await postJson(app, '/api/events/conf-2026/notify', { all: true });

  assert.equal(res.status, 200);
  assert.equal(decisionsSent(db), 3);
});

test('with nothing queued it still refuses rather than reporting a cheerful zero', async () => {
  const { db, event } = newEvent();
  const owner = addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' });
  db.prepare(`INSERT INTO event_membership (event_id, person_id, role) VALUES (?, ?, 'owner')`)
    .run(event.id, owner.id);
  const app = signedInApp(db, owner);

  const err = await refusal(postJson(app, `/api/events/${event.slug}/notify`, {}));

  assert.equal(err.status, 400);
  assert.equal(decisionsSent(db), 0);
});
