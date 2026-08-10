// The demo sign-in personas must correspond to people who exist.
//
// This lives in the acceptance suite rather than the unit suite on purpose. The
// question is not "is the PERSONAS array well formed" -- that can be checked
// without a server and proves nothing. The question is "does clicking Organizer
// on the deployment you are pointing at actually sign you in", and the only way
// to know is to click it against a real instance holding real seeded data.
//
// It matters more than it looks. An independent evaluator drives a headless
// browser, is handed one URL, and has no shell and no repository. /login is the
// only door it can use. Every persona pointed at an `sbek-...@example.com`
// address that no seed has ever created, so every button failed -- and nobody
// noticed for months, because organizer access is open on loopback and local
// development never needs to sign in at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, BASE_URL } from './helpers.js';

const PERSONA_KEYS = ['organizer', 'speaker', 'speaker2', 'reviewer'];

test(`the demo sign-in page works against ${BASE_URL}`, async (t) => {
  const page = await new Client('a visitor').get('/login');

  if (page.status === 404 || page.status === 403) {
    t.skip('demo sign-in is disabled on this deployment (DEMO_LOGIN is off)');
    return;
  }

  assert.equal(page.status, 200, 'GET /login should render the sign-in page');

  for (const persona of PERSONA_KEYS) {
    const client = new Client(`the ${persona} persona`);
    const result = await client.postForm('/login', { persona });

    assert.equal(result.status, 303,
      `POST /login persona=${persona} should sign in and redirect, got ${result.status}. `
      + 'A persona naming somebody the seed does not create fails exactly this way, '
      + 'and it is the only way a browser-driven evaluator can get in.');
  }
});

test('the organizer persona can actually reach an organizer screen', async (t) => {
  // Signing in is not the point; being able to organize afterwards is. A persona
  // that resolves to a real person with no membership would pass the test above
  // and still be useless.
  const organizer = new Client('the organizer persona');
  const signIn = await organizer.postForm('/login', { persona: 'organizer' });

  if (signIn.status !== 303) {
    t.skip('demo sign-in is disabled or unavailable on this deployment');
    return;
  }

  const events = await organizer.get('/api/events');
  assert.equal(events.status, 200, 'the event list should be readable');

  const [first] = JSON.parse(events.body).events ?? [];
  if (!first) {
    t.skip('this deployment has no events to check organizer access against');
    return;
  }

  const dashboard = await organizer.get(`/e/${first.slug}`);
  assert.equal(dashboard.status, 200,
    `the organizer persona signed in but got ${dashboard.status} on /e/${first.slug}. `
    + 'The persona resolves to somebody with no organizer membership on this event.');
});
