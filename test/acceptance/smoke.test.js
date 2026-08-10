// Liveness, and the promises the route table makes.
//
// Everything in this file is read-only. It creates nothing, changes nothing,
// and is safe to point at a production deployment at any time -- which is what
// makes it the first thing to run when certifying one.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_URL, Client, expectStatus, expectBodyContains, readableBody, waitForServer,
} from './helpers.js';

const anyone = new Client('an anonymous visitor');

/**
 * A GET that signs you out is not a page, and sweeping it would end the session
 * of whoever ran the suite.
 */
const NOT_A_PAGE = new Set(['/portal/sign-out']);

describe(`liveness and the route table (${BASE_URL})`, () => {
  before(() => waitForServer(anyone));

  it('answers /healthz', async () => {
    const health = await anyone.get('/healthz');
    expectStatus(health, 200);
  });

  it('serves /llms.txt, with the recipes that make the app operable', async () => {
    const brief = await anyone.get('/llms.txt');
    expectStatus(brief, 200);
    assert.ok(brief.body.length > 1000, `llms.txt looks truncated: ${brief.body.length} bytes`);
    expectBodyContains(brief, '## Getting in',
      'the short form has to say how to authenticate, or nothing below it is reachable');
    expectBodyContains(brief, 'authorization: bearer',
      'and it has to show the header, because a caller copies the recipe, not the prose');

    // The full route table is behind ?all=1: the default is the short form,
    // because a 25KB file is one a small model spends its whole budget reading.
    // These promises are generated from the code, so they are load-bearing.
    const llms = await anyone.get('/llms.txt?all=1');
    expectStatus(llms, 200);
    assert.ok(llms.body.length > brief.body.length,
      '?all=1 should add the route list, not replace the recipes');
    for (const promise of [
      'GET /healthz',
      'POST /e/new',
      'POST /submit/:event/:form',
      'GET /portal/:event/enter',
      'POST /api/events/:event/notify',
      'GET /api/events/:event/agenda',
      'POST /e/:event/embeds',
    ]) {
      expectBodyContains(llms, promise, 'llms.txt is the only route index a remote operator has');
    }
  });

  it('lists events over the API', async () => {
    const events = await anyone.get('/api/events');
    expectStatus(events, 200);
    const { events: list } = events.json();
    assert.ok(Array.isArray(list) && list.length > 0,
      `expected at least one event; got ${readableBody(events, 300)}`);
    for (const event of list) {
      assert.ok(event.slug, `every event needs a slug: ${JSON.stringify(event)}`);
    }
  });

  it('actually serves every parameterless GET route it advertises', async () => {
    const llms = await anyone.get('/llms.txt?all=1');
    expectStatus(llms, 200);

    const paths = [...new Set(
      [...llms.body.matchAll(/^GET (\/\S*)$/gm)]
        .map((m) => m[1])
        .filter((path) => !path.includes(':') && !NOT_A_PAGE.has(path)),
    )];

    assert.ok(paths.length >= 8,
      `expected llms.txt to advertise several parameterless GET routes, found ${paths.length}`);

    // 200 and 403 are both real answers: several of these are organizer screens,
    // and whether an anonymous visitor may see them depends on how the
    // deployment is bound. A 404 means the route table advertises something
    // that is not mounted, and a 5xx means it is mounted and broken. Those are
    // the two failures worth catching, and both are posture-independent.
    const broken = [];
    for (const path of paths) {
      const result = await anyone.get(path);
      if (result.status === 404 || result.status >= 500) {
        broken.push(`  ${path} -> ${result.status}: ${readableBody(result, 200)}`);
      }
    }

    assert.equal(broken.length, 0,
      `llms.txt is generated from the route table, so everything in it should exist. `
      + `Of the ${paths.length} parameterless GET routes it advertises, these did not:\n`
      + broken.join('\n'));
  });

  it('does not leak organizer data to another origin', async () => {
    const events = await anyone.get('/api/events');
    const slug = events.json().events[0]?.slug;
    assert.ok(slug, 'need at least one event to check the CORS posture of the organizer API');

    const agenda = await anyone.get(`/api/events/${slug}/agenda`, { origin: 'https://example.org' });

    // This used to assert 200-with-no-CORS-header, which was the best it could
    // do while the route answered anybody who asked. It is now refused outright,
    // which is the stronger claim: the data carries unapproved and unannounced
    // sessions, so a stranger should not get it with or without a CORS header.
    expectStatus(agenda, 403,
      `/api/events/${slug}/agenda answered a stranger. It carries unapproved and `
      + 'unannounced sessions. The public feed is /embed/<event>/<slug>.');
    assert.equal(agenda.headers.get('access-control-allow-origin'), null,
      'and it must not invite another site to read the refusal either');
  });
});

describe(`error shape (${BASE_URL})`, () => {
  // A refusal used to cost 6,573 bytes to say two lines, because every caller
  // got the styled page. A local model made two wrong guesses at one route, read
  // both pages in full, and ran out of time: the errors were right and
  // unreadable, which for something that is not a person is the same as wrong.

  it('answers a script with the two lines that say something', async () => {
    const script = new Client('a script');
    const missing = await script.get('/no/such/route/at/all');

    expectStatus(missing, 404);
    assert.match(missing.contentType, /text\/plain/,
      'a caller that did not ask for HTML should not be sent a stylesheet');
    assert.ok(missing.body.length < 500,
      `an error should be small enough to read, got ${missing.body.length} bytes`);
    assert.match(missing.body, /llms\.txt/, 'and it should still say where to look');
  });

  it('answers a browser with the page', async () => {
    const browser = new Client('a browser');
    const missing = await browser.get('/no/such/route/at/all', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    expectStatus(missing, 404);
    assert.match(missing.contentType, /text\/html/);
  });

  it('answers an API caller with JSON', async () => {
    const script = new Client('an API caller');
    const missing = await script.get('/api/events/no-such-event');

    expectStatus(missing, 404);
    assert.match(missing.contentType, /application\/json/);
    assert.ok(missing.json().error, 'a JSON error should carry an `error`');
  });
});
