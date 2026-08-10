import { Readable } from 'node:stream';
import { createApp, respond } from '../src/server.js';
import { createMagicLink, consumeMagicLink, SESSION_COOKIE } from '../src/core/auth.js';
import { now } from '../src/db.js';

/**
 * An app backed by an in-memory database, with somebody signed in.
 *
 * Requests go through the real router, the real body parsing, and the real
 * handlers -- everything except a socket. That is deliberate: the bugs worth
 * catching here are routing collisions, validation, and redirects, and none of
 * them need TCP.
 *
 * The session is real, and that matters. It is minted by calling the same two
 * exported functions the running app calls -- createMagicLink then
 * consumeMagicLink -- rather than by setting a flag that relaxes a check. There
 * is no test-only door in `src/`, and these tests exercise the same path an
 * organizer walks. Whoever is signed in becomes the owner of any event they
 * create at POST /e/new, so what is being tested is real membership.
 *
 * `newApp({ as: null })` gives an app with nobody signed in, for testing what a
 * stranger can reach.
 */
export function newApp({ as = 'test-organizer' } = {}) {
  const app = createApp({ dbPath: ':memory:' });
  app.cookies = {};

  if (as) {
    const t = now();
    const person = app.db.prepare(
      `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(as, `${as}@example.com`, 'Test', 'Organizer', t, t);

    const session = consumeMagicLink(app.db, createMagicLink(app.db, person.id, null));
    app.cookies[SESSION_COOKIE] = session.token;
    app.signedInAs = person;
  }

  return app;
}

/**
 * Passing `cookies` REPLACES the app's own session rather than adding to it, so
 * `{ cookies: {} }` is how a test asks "what does a stranger see?" and
 * `{ cookies: { conf_session: speaker.token } }` acts as that speaker rather
 * than as an organizer wearing their hat.
 */
const jarFor = (app, cookies) => cookies ?? app.cookies ?? {};

export async function get(app, url, { cookies = null, headers = {} } = {}) {
  return respond(app, { method: 'GET', url, headers: { ...headersFor(jarFor(app, cookies)), ...headers } });
}

/** POST a form, the way a browser would. */
export async function post(app, url, fields = {}, { cookies = null, headers = {} } = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) body.append(key, one);
  }
  const encoded = body.toString();

  const req = Readable.from([Buffer.from(encoded)]);
  req.headers = { 'content-type': 'application/x-www-form-urlencoded' };

  return respond(app, {
    method: 'POST',
    url,
    headers: {
      ...headersFor(jarFor(app, cookies)),
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    req,
  });
}

function headersFor(cookies) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  return {
    host: '127.0.0.1:8080',
    // A real browser adds one of these to every request and the server refuses
    // cookie-authenticated writes without them. These requests have no browser,
    // so the helper stands in for one. Sending `same-origin` is honest: that is
    // what an in-process request from the app's own forms is.
    'sec-fetch-site': 'same-origin',
    ...(jar ? { cookie: jar } : {}),
  };
}

/** Assert a response redirected, and return where to. */
export function redirectedTo(response) {
  if (response.status !== 303 && response.status !== 302) {
    throw new Error(`expected a redirect, got ${response.status}: ${String(response.body).slice(0, 300)}`);
  }
  return response.headers.location;
}

/** The error a handler threw, for asserting on the message and its hint. */
export async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to fail, but it succeeded');
}
