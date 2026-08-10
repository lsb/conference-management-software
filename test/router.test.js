import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/http/router.js';

const noop = () => {};

function router() {
  return new Router()
    .get('/', noop)
    .get('/e/:event', noop)
    .get('/e/:event/submissions/:code', noop)
    .post('/e/:event/submissions/:code/schedule', noop)
    .get('/agenda/:event/:code.ics', noop);
}

test('literal routes match exactly', () => {
  const r = router();
  assert.ok(r.match('GET', '/'));
  assert.equal(r.match('GET', '/nope'), null);
});

test('parameters are captured by name', () => {
  const { params } = router().match('GET', '/e/conf-2026/submissions/SESS-3');
  assert.deepEqual(params, { event: 'conf-2026', code: 'SESS-3' });
});

test('a trailing slash is the same route', () => {
  assert.ok(router().match('GET', '/e/conf-2026/'));
});

test('a parameter never swallows a slash', () => {
  assert.equal(router().match('GET', '/e/conf/2026'), null);
});

test('a parameter can carry a literal file extension', () => {
  const { params } = router().match('GET', '/agenda/conf-2026/SESS-3.ics');
  assert.deepEqual(params, { event: 'conf-2026', code: 'SESS-3' },
    'the extension is not captured as part of the code');

  assert.equal(router().match('GET', '/agenda/conf-2026/SESS-3.json'), null,
    'a different extension is a different route');
});

test('HEAD is served by the GET handler', () => {
  assert.ok(router().match('HEAD', '/e/conf-2026'));
});

test('method mismatch is reported so the caller gets a 405, not a 404', () => {
  const r = router();
  assert.equal(r.match('POST', '/e/conf-2026'), null);
  assert.deepEqual(r.allowedFor('/e/conf-2026/submissions/SESS-3/schedule'), ['POST']);
});

test('a path segment with regex characters is matched literally', () => {
  const r = new Router().get('/files/a.b+c', noop);
  assert.ok(r.match('GET', '/files/a.b+c'));
  assert.equal(r.match('GET', '/files/axbxc'), null);
});

test('routes are matched in registration order', () => {
  const first = () => 'literal';
  const second = () => 'param';
  const r = new Router().get('/portal/sign-in', first).get('/portal/:event', second);

  // `/portal/sign-in` must reach the literal handler, not be read as an event
  // slug called "sign-in".
  assert.equal(r.match('GET', '/portal/sign-in').route.handler, first);
  assert.equal(r.match('GET', '/portal/conf-2026').route.handler, second);
});

// --- near misses -------------------------------------------------------------
//
// From a trace. A local model told to accept a submission tried
// POST /api/events/x/submissions/SESS-15/accept -- a reasonable guess, and
// wrong, because deciding is /decide with the decision in the body. It got a
// bare 404, went away and read llms.txt, and came back with the right call one
// round trip later. The answer was one segment away and we knew it.

test('a near-miss path suggests the route that was meant', () => {
  const r = new Router()
    .post('/api/events/:event/submissions/:code/decide', noop, 'decide')
    .post('/api/events/:event/notify', noop, 'notify')
    .get('/api/events/:event/speakers', noop, 'speakers');

  assert.deepEqual(
    r.suggestionsFor('POST', '/api/events/x/submissions/SESS-15/accept'),
    ['POST /api/events/:event/submissions/:code/decide'],
    'accept and decide are one word apart in meaning and five letters apart in text',
  );
  assert.ok(r.suggestionsFor('POST', '/api/events/x/notifiy').includes('POST /api/events/:event/notify'),
    'a typo should be caught too');
  assert.ok(r.suggestionsFor('GET', '/api/events/x/speaker').includes('GET /api/events/:event/speakers'));
});

test('an unrelated path suggests nothing at all', () => {
  // A route that is mostly parameters matches any path of the right length, so
  // without requiring a shared literal segment this offers nonsense confidently.
  const r = new Router()
    .get('/gallery/:event/:person', noop, 'gallery')
    .get('/submit/:event/:form', noop, 'submit');

  assert.deepEqual(r.suggestionsFor('GET', '/totally/unrelated/nonsense'), []);
});

test('a suggestion is never a route of a different method', () => {
  const r = new Router()
    .post('/api/events/:event/notify', noop, 'notify')
    .get('/api/events/:event/notify', noop, 'the queue');

  assert.deepEqual(r.suggestionsFor('GET', '/api/events/x/notifiy'),
    ['GET /api/events/:event/notify']);
});

test('undocumented routes are never suggested', () => {
  // llms.txt only lists documented routes, so suggesting an undocumented one
  // would point somebody at something they cannot then read about.
  const r = new Router().post('/api/events/:event/decide', noop);
  assert.deepEqual(r.suggestionsFor('POST', '/api/events/x/decidee'), []);
});
