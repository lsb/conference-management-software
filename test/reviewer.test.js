// A reviewer scoring a submission.
//
// Reviewing is half of feature 2 and had no test naming any of its four routes.
// What that hid: this route's own documentation, the text /llms.txt publishes,
// named a parameter the handler does not read. A script following it got a 303
// to `?saved=1` -- which reads exactly like success -- and left the review in
// `in_progress`. The reviewer believed they had submitted; the organizer's
// outstanding count still had them on it.
//
// Only over curl, because a browser presses the button and the button has the
// right name. That is the fifth time this shape has come up here, and it is the
// argument for testing routes rather than the core functions behind them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, post, failure } from './http-helpers.js';
import { SESSION_COOKIE, createMagicLink, consumeMagicLink } from '../src/core/auth.js';
import { createSubmission } from '../src/core/submissions.js';
import { now } from '../src/db.js';

/** One reviewer, assigned one submission, scored on two criteria. */
function reviewerWithAnAssignment(app) {
  const db = app.db;
  const t = now();
  const event = db.prepare(
    `INSERT INTO event (slug, name, timezone, starts_at, ends_at, created_at, updated_at)
     VALUES ('rv-2027', 'RV', 'UTC', '2027-05-12T00:00:00Z', '2027-05-13T00:00:00Z', ?, ?)
     RETURNING *`).get(t, t);

  const person = (slug, email) => db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, 'Rev', 'Iewer', ?, ?) RETURNING *`).get(slug, email, t, t);

  const reviewer = person('rev-iewer', 'rev@example.com');
  const other = person('other-reviewer', 'other@example.com');

  const submission = createSubmission(db, { eventId: event.id, title: 'A talk', status: 'pending' });
  const plan = db.prepare(
    `INSERT INTO evaluation_plan (event_id, slug, name, created_at)
     VALUES (?, 'round-1', 'Round 1', ?) RETURNING *`).get(event.id, t);

  for (const p of [reviewer, other]) {
    db.prepare('INSERT INTO plan_reviewer (plan_id, person_id, added_at) VALUES (?, ?, ?)')
      .run(plan.id, p.id, t);
    db.prepare("INSERT INTO event_membership (event_id, person_id, role) VALUES (?, ?, 'reviewer')")
      .run(event.id, p.id);
  }

  db.prepare(`INSERT INTO criterion (plan_id, slug, label, scale_min, scale_max, sort_order)
              VALUES (?, 'relevance', 'Relevance', 1, 5, 0)`).run(plan.id);
  db.prepare(`INSERT INTO criterion (plan_id, slug, label, scale_min, scale_max, sort_order)
              VALUES (?, 'clarity', 'Clarity', 1, 5, 1)`).run(plan.id);

  db.prepare(`INSERT INTO review (plan_id, submission_id, reviewer_person_id, assigned_at)
              VALUES (?, ?, ?, ?)`).run(plan.id, submission.id, reviewer.id, t);

  const signIn = (p) => ({
    [SESSION_COOKIE]: consumeMagicLink(db, createMagicLink(db, p.id, event.id)).token,
  });

  return {
    db,
    event: 'rv-2027',
    code: submission.code,
    cookies: signIn(reviewer),
    otherCookies: signIn(other),
  };
}

const reviewStatus = (db) => db.prepare('SELECT status FROM review').get().status;
const FULL = { relevance: '4', clarity: '5', comment: 'Worth having.' };

test('submit_review=1 finishes the review', async () => {
  const app = newApp();
  const { db, event, code, cookies } = reviewerWithAnAssignment(app);

  await post(app, `/review/${event}/${code}`, { ...FULL, submit_review: '1' }, { cookies });

  assert.equal(reviewStatus(db), 'submitted');
});

test('submit=1 finishes it too, because that is what the docs said for months', async () => {
  const app = newApp();
  const { db, event, code, cookies } = reviewerWithAnAssignment(app);

  await post(app, `/review/${event}/${code}`, { ...FULL, submit: '1' }, { cookies });

  assert.equal(reviewStatus(db), 'submitted',
    'a script following the published contract got a 303 and an unsubmitted review');
});

test('saving without asking to finish keeps the review open', async () => {
  const app = newApp();
  const { db, event, code, cookies } = reviewerWithAnAssignment(app);

  await post(app, `/review/${event}/${code}`, { relevance: '4' }, { cookies });

  assert.equal(reviewStatus(db), 'in_progress', 'a partial review is a feature, not a submission');
  assert.equal(db.prepare('SELECT submitted_at FROM review').get().submitted_at, null);
});

test('a review cannot be finished with a criterion unscored, and it says which', async () => {
  const app = newApp();
  const { db, event, code, cookies } = reviewerWithAnAssignment(app);

  const err = await failure(post(app, `/review/${event}/${code}`,
    { relevance: '4', submit_review: '1' }, { cookies }));

  assert.equal(err.status, 400);
  assert.match(err.message, /Clarity/,
    'naming the missing one is the difference between a fix and a guess');
  assert.notEqual(reviewStatus(db), 'submitted');
});

test('a score outside the scale is refused rather than stored', async () => {
  const app = newApp();
  const { db, event, code, cookies } = reviewerWithAnAssignment(app);

  const err = await failure(post(app, `/review/${event}/${code}`,
    { relevance: '11', clarity: '5' }, { cookies }));

  assert.equal(err.status, 400);
  assert.match(err.message, /between 1 and 5/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM score').get().n, 0,
    'and nothing from that request was kept');
});

test('a submitted review is not silently overwritten', async () => {
  const app = newApp();
  const { db, event, code, cookies } = reviewerWithAnAssignment(app);
  await post(app, `/review/${event}/${code}`, { ...FULL, submit_review: '1' }, { cookies });

  const err = await failure(post(app, `/review/${event}/${code}`,
    { relevance: '1', clarity: '1', comment: 'Changed my mind.' }, { cookies }));

  assert.equal(err.status, 400);
  assert.equal(db.prepare('SELECT comment FROM review').get().comment, 'Worth having.');
});

test('a reviewer cannot score a submission that was not assigned to them', async () => {
  const app = newApp();
  const { db, event, code, otherCookies } = reviewerWithAnAssignment(app);

  const err = await failure(post(app, `/review/${event}/${code}`,
    { ...FULL, submit_review: '1' }, { cookies: otherCookies }));

  assert.equal(err.status, 404, 'being a reviewer on the plan is not being this submission\'s reviewer');
  assert.equal(reviewStatus(db), 'assigned');
});

test('a stranger cannot score anything', async () => {
  const app = newApp();
  const { db, event, code } = reviewerWithAnAssignment(app);

  const err = await failure(post(app, `/review/${event}/${code}`,
    { ...FULL, submit_review: '1' }, { cookies: {} }));

  assert.equal(err.status, 403);
  assert.equal(reviewStatus(db), 'assigned');
});
