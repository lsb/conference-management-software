// Claiming an instance, signing in, and letting other people in.
//
// None of this was covered when it was written, and it shipped with a bug that
// bricked a fresh instance: the claim deleted the operator's only copy of the
// setup token, then failed on a constraint further down, leaving nothing that
// could ever claim it again. Found by standing up a fresh instance by hand,
// which is the sort of thing a test should not need a person for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, get, post, redirectedTo, failure } from './http-helpers.js';
import {
  recordSetupToken, hasAdmin, createApiToken, SESSION_COOKIE,
} from '../src/core/auth.js';

const TOKEN = 'a-setup-token-that-is-long-enough-to-be-allowed';
const PASSWORD = 'correct-horse-battery-staple';

/** An unclaimed instance: nobody signed in, and a known setup token. */
function unclaimed() {
  const app = newApp({ as: null });
  recordSetupToken(app.db, TOKEN);
  return app;
}

const adminCount = (db) => db.prepare('SELECT count(*) AS n FROM person WHERE is_admin = 1').get().n;

test('a fresh instance has nobody who can administer it', () => {
  const app = unclaimed();
  assert.equal(hasAdmin(app.db), false);
});

test('the setup token turns the first caller into an administrator', async () => {
  const app = unclaimed();

  const claimed = await post(app, '/setup/claim',
    { token: TOKEN, email: 'chair@example.com', password: PASSWORD });

  assert.equal(redirectedTo(claimed), '/');
  assert.equal(hasAdmin(app.db), true);
  assert.match(String(claimed.headers['set-cookie']), new RegExp(SESSION_COOKIE),
    'claiming should sign you in, not send you to a login form');
});

test('a claim signs you in as somebody who can actually do things', async () => {
  const app = unclaimed();
  const claimed = await post(app, '/setup/claim',
    { token: TOKEN, email: 'chair@example.com', password: PASSWORD });
  const cookie = /conf_session=([^;]+)/.exec(String(claimed.headers['set-cookie']))[1];

  const made = await post(app, '/e/new',
    { name: 'First Conf', starts_at: '2027-01-01', ends_at: '2027-01-02' },
    { cookies: { [SESSION_COOKIE]: decodeURIComponent(cookie) } });

  assert.match(redirectedTo(made), /^\/e\/first-conf/);
});

test('the wrong setup token claims nothing', async () => {
  const app = unclaimed();

  const err = await failure(post(app, '/setup/claim',
    { token: 'not-the-token-but-still-long-enough-to-try', email: 'x@y.com', password: PASSWORD }));

  assert.equal(err.status, 403);
  assert.equal(adminCount(app.db), 0);
});

test('a refused claim leaves the instance claimable', async () => {
  // The bug this exists for. A claim that fails part-way through must leave
  // every door it found open: the token still valid, and nobody promoted.
  const app = unclaimed();

  await failure(post(app, '/setup/claim', { token: TOKEN, email: 'x@y.com', password: 'short' }));
  assert.equal(adminCount(app.db), 0, 'a rejected password must not promote anybody');

  const second = await post(app, '/setup/claim',
    { token: TOKEN, email: 'chair@example.com', password: PASSWORD });

  assert.equal(redirectedTo(second), '/', 'the token must still work after a failed attempt');
  assert.equal(hasAdmin(app.db), true);
});

test('a short password is refused, and says why', async () => {
  const app = unclaimed();
  const err = await failure(post(app, '/setup/claim',
    { token: TOKEN, email: 'x@y.com', password: 'short' }));

  assert.equal(err.status, 400);
  assert.match(err.message, /12 characters/);
});

// --- signing in --------------------------------------------------------------

async function claimedApp() {
  const app = unclaimed();
  const claimed = await post(app, '/setup/claim',
    { token: TOKEN, email: 'chair@example.com', password: PASSWORD });
  // Carry the session the claim handed back, the way a browser would. Without
  // this every later call in the test is anonymous, and assertions about what an
  // organizer can do quietly become assertions about what a stranger can do.
  const cookie = /conf_session=([^;]+)/.exec(String(claimed.headers['set-cookie']));
  app.cookies[SESSION_COOKIE] = decodeURIComponent(cookie[1]);
  return app;
}

test('the password set at claim time signs that person back in', async () => {
  const app = await claimedApp();

  const back = await post(app, '/sign-in', { email: 'chair@example.com', password: PASSWORD },
    { cookies: {} });

  assert.equal(redirectedTo(back), '/');
  assert.match(String(back.headers['set-cookie']), new RegExp(SESSION_COOKIE));
});

test('a wrong password and an unknown address fail the same way', async () => {
  // Telling a stranger whether an address is known leaks the speaker list of
  // every conference on this instance.
  const app = await claimedApp();

  const wrongPassword = await post(app, '/sign-in',
    { email: 'chair@example.com', password: 'not-the-password' }, { cookies: {} });
  const unknownPerson = await post(app, '/sign-in',
    { email: 'nobody@example.com', password: PASSWORD }, { cookies: {} });

  assert.equal(redirectedTo(wrongPassword), redirectedTo(unknownPerson));
});

test('signing in is case-insensitive about the address', async () => {
  const app = await claimedApp();
  const back = await post(app, '/sign-in',
    { email: 'CHAIR@Example.COM', password: PASSWORD }, { cookies: {} });
  assert.equal(redirectedTo(back), '/');
});

// --- tokens ------------------------------------------------------------------

test('a bearer token carries exactly its owner\'s access', async () => {
  const app = await claimedApp();
  const admin = app.db.prepare('SELECT * FROM person WHERE is_admin = 1').get();
  const token = createApiToken(app.db, admin.id, 'a test');

  // A gated route, deliberately: /api/events answers anybody, so asserting on it
  // would pass with no credentials at all and prove nothing.
  await post(app, '/e/new', { name: 'First Conf', starts_at: '2027-01-01', ends_at: '2027-01-02' });

  const refused = await failure(get(app, '/api/events/first-conf/agenda', { cookies: {} }));
  assert.equal(refused.status, 403, 'the route must actually be gated for this test to mean anything');

  const allowed = await get(app, '/api/events/first-conf/agenda',
    { cookies: {}, headers: { authorization: `bearer ${token}` } });
  assert.equal(allowed.status, 200);
});

test('a revoked token stops working', async () => {
  const app = await claimedApp();
  const admin = app.db.prepare('SELECT * FROM person WHERE is_admin = 1').get();
  const token = createApiToken(app.db, admin.id, 'a test');
  app.db.prepare('UPDATE api_token SET revoked_at = ? WHERE person_id = ?')
    .run('2020-01-01T00:00:00Z', admin.id);

  await post(app, '/e/new', { name: 'First Conf', starts_at: '2027-01-01', ends_at: '2027-01-02' });

  const err = await failure(get(app, '/api/events/first-conf/agenda',
    { cookies: {}, headers: { authorization: `bearer ${token}` } }));

  assert.equal(err.status, 403, 'a revoked token must not authenticate');
});

// --- letting other people in --------------------------------------------------

test('an organizer can add somebody and is handed a link to give them', async () => {
  const app = await claimedApp();
  await post(app, '/e/new', { name: 'First Conf', starts_at: '2027-01-01', ends_at: '2027-01-02' });

  const added = await post(app, '/e/first-conf/people',
    { email: 'reviewer@example.com', role: 'reviewer' });

  const to = redirectedTo(added);
  assert.match(to, /link=/, 'the reply must carry a one-time link, because nothing is emailed');
  assert.match(decodeURIComponent(to), /\/portal\/first-conf\/enter\?token=/);

  const roles = app.db.prepare(
    `SELECT role FROM event_membership m JOIN person p ON p.id = m.person_id
      WHERE p.email = 'reviewer@example.com'`).all().map((r) => r.role);
  assert.deepEqual(roles, ['reviewer']);
});

test('a stranger cannot add themselves to an event', async () => {
  const app = await claimedApp();
  await post(app, '/e/new', { name: 'First Conf', starts_at: '2027-01-01', ends_at: '2027-01-02' });

  const err = await failure(post(app, '/e/first-conf/people',
    { email: 'me@example.com', role: 'owner' }, { cookies: {} }));

  assert.equal(err.status, 403);
});
