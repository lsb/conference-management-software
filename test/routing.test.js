// Category-based routing: a proposal's answer decides where it goes.
//
// These drive the real HTTP handlers with plain form posts, which is the only
// way this feature is ever used -- there is no JavaScript on either the form
// editor or the public form, so what curl can do is what exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, get, post, redirectedTo, failure } from './http-helpers.js';

/** An event with two tracks and a default submission form. */
async function conference(app) {
  redirectedTo(await post(app, '/e/new', {
    name: 'DevFlow Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-14',
    timezone: 'America/Los_Angeles', with_defaults: '1',
  }));
  const event = 'devflow-conf-2027';

  await post(app, `/e/${event}/settings/tracks`, { name: 'Retrieval' });
  await post(app, `/e/${event}/settings/tracks`, { name: 'Platform and Infra' });

  const form = redirectedTo(await post(app, `/e/${event}/forms`, {
    internal_name: 'CFP 2027 (main round)', with_defaults: '1',
  })).split('/').pop();

  return { event, form };
}

/** A review round, optionally with people in its pool. */
async function reviewRound(app, event, {
  name = 'First Round (ML)', reviewers = [], maxPerReviewer = '',
} = {}) {
  const plan = redirectedTo(await post(app, `/e/${event}/evaluation`, {
    name, max_per_reviewer: maxPerReviewer,
  })).split('/').pop();

  for (const email of reviewers) {
    await post(app, `/e/${event}/evaluation/${plan}/reviewers`,
      { email, first_name: email.split('@')[0], last_name: 'Reviewer' });
  }
  return plan;
}

const PROPOSAL = {
  title: 'Retrieval that actually retrieves', description: 'On chunking.',
  format: 'talk-30-min', 'first-name': 'Priya', 'last-name': 'Raman',
  email: 'priya@example.com', biography: 'Engineer.',
};

const submissionOf = (app, title = PROPOSAL.title) =>
  app.db.prepare('SELECT * FROM submission WHERE title = ?').get(title);

const routingOf = (app, submissionId) => app.db.prepare(
  'SELECT * FROM submission_routing WHERE submission_id = ? ORDER BY id DESC').get(submissionId);

const reviewsOf = (app, submissionId) => app.db.prepare(
  'SELECT * FROM review WHERE submission_id = ?').all(submissionId);

// --- the headline case -----------------------------------------------------

test('a proposal is handed to a review round and a track by its category answer', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event,
    { reviewers: ['ann@example.com', 'bo@example.com'] });

  await post(app, `/e/${event}/forms/${form}/routing`, {
    field: 'track', operator: 'equals', value: 'retrieval',
    plan, track: 'retrieval', reviewers: '2',
  });

  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  const track = app.db.prepare('SELECT slug FROM track WHERE id = ?').get(submission.track_id);
  assert.equal(track.slug, 'retrieval');
  assert.equal(reviewsOf(app, submission.id).length, 2,
    'both reviewers in the round should have been given it');

  const routed = routingOf(app, submission.id);
  assert.equal(routed.outcome, 'routed');
  assert.match(routed.detail, /Track is retrieval/);
  assert.match(routed.detail, /First Round \(ML\)/);
});

test('routing feeds the review round that already exists, not a pool of its own', async () => {
  // The reviews it creates are the same rows the Assign screen creates, so the
  // round's own progress counts include them.
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event, { reviewers: ['ann@example.com'] });

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', plan, reviewers: '1' });
  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const page = (await get(app, `/e/${event}/evaluation/${plan}`)).body;
  assert.match(page, /ann@example\.com/);
  const assigned = app.db.prepare(
    `SELECT count(*) AS n FROM review r JOIN evaluation_plan p ON p.id = r.plan_id
      WHERE p.slug = ?`).get(plan).n;
  assert.equal(assigned, 1);
});

test('a rule overrides the track the submitter picked', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  await post(app, `/e/${event}/forms/${form}/routing`, {
    field: 'format', operator: 'equals', value: 'workshop-120-min', track: 'retrieval',
  });

  await post(app, `/submit/${event}/${form}`,
    { ...PROPOSAL, track: 'platform-and-infra', format: 'workshop-120-min' });

  const submission = submissionOf(app);
  assert.equal(
    app.db.prepare('SELECT slug FROM track WHERE id = ?').get(submission.track_id).slug,
    'retrieval');
});

test('a rule can read the answer to a question of your own', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/e/${event}/forms/${form}/fields`,
    { label: 'Which team', field_type: 'text', section: 'abstract' });

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'which-team', operator: 'is_present', track: 'retrieval' });

  await post(app, `/submit/${event}/${form}`,
    { ...PROPOSAL, track: 'platform-and-infra', 'which-team': 'Search' });

  const submission = submissionOf(app);
  assert.equal(
    app.db.prepare('SELECT slug FROM track WHERE id = ?').get(submission.track_id).slug,
    'retrieval');
  assert.match(routingOf(app, submission.id).detail, /Which team is answered at all/);
});

// --- which rule wins -------------------------------------------------------

test('the first matching rule wins, and it is the one recorded', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'retrieval' });
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'format', operator: 'equals', value: 'talk-30-min', track: 'platform-and-infra' });

  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  assert.equal(
    app.db.prepare('SELECT slug FROM track WHERE id = ?').get(submission.track_id).slug,
    'retrieval', 'the second rule matched too, and must not have been applied');

  const first = app.db.prepare(
    'SELECT id FROM form_routing_rule ORDER BY sort_order, id').get().id;
  assert.equal(routingOf(app, submission.id).rule_id, first);
});

test('reordering the rules changes which one wins', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'retrieval' });
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'format', operator: 'equals', value: 'talk-30-min', track: 'platform-and-infra' });

  const second = app.db.prepare(
    'SELECT id FROM form_routing_rule ORDER BY sort_order, id').all()[1].id;
  await post(app, `/e/${event}/forms/${form}/routing/${second}/move`, { direction: 'up' });

  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  assert.equal(
    app.db.prepare('SELECT slug FROM track WHERE id = ?').get(submission.track_id).slug,
    'platform-and-infra');
});

test('moving the first rule up is a no-op rather than an error', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'retrieval' });

  const only = app.db.prepare('SELECT id FROM form_routing_rule').get().id;
  const response = await post(app, `/e/${event}/forms/${form}/routing/${only}/move`,
    { direction: 'up' });
  assert.equal(response.status, 303);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM form_routing_rule').get().n, 1);
});

// --- nothing disappears quietly --------------------------------------------

test('a proposal that matches no rule is recorded as such, not silently ignored', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'retrieval' });

  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'platform-and-infra' });

  const submission = submissionOf(app);
  const routed = routingOf(app, submission.id);
  assert.equal(routed.outcome, 'no_match');
  assert.match(routed.detail, /no routing rule matched/);
  assert.equal(
    app.db.prepare('SELECT slug FROM track WHERE id = ?').get(submission.track_id).slug,
    'platform-and-infra', 'the submitter\'s own answer is left alone');
});

test('a form with no rules records nothing at all', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  assert.equal(app.db.prepare('SELECT count(*) AS n FROM submission_routing').get().n, 0,
    'routing that nobody configured is not an event worth logging');
});

test('routing into an empty reviewer pool is visible, and the proposal still lands', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event, { reviewers: [] });

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', plan });
  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  assert.ok(submission, 'the submission is never refused over an organizer misconfiguration');

  const routed = routingOf(app, submission.id);
  assert.equal(routed.outcome, 'partial');
  assert.match(routed.detail, /nobody is in its reviewer pool/);

  const page = (await get(app, `/e/${event}/forms/${form}`)).body;
  assert.match(page, /Partly applied/);
});

test('a rule pointing at an empty pool is flagged before anything is submitted', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event, { reviewers: [] });

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', plan });

  const page = (await get(app, `/e/${event}/forms/${form}`)).body;
  assert.match(page, /nobody in that pool/);
  assert.match(page, /sit unreviewed/);
});

test('the shortfall is recorded when the round\'s cap runs out', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event,
    { reviewers: ['ann@example.com'], maxPerReviewer: '1' });

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', plan, reviewers: '3' });
  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  assert.equal(reviewsOf(app, submission.id).length, 1);
  const routed = routingOf(app, submission.id);
  assert.equal(routed.outcome, 'partial');
  assert.match(routed.detail, /only 1 of 3 reviewer\(s\)/);
});

test('nobody is routed a submission they are speaking on', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event,
    { reviewers: [PROPOSAL.email, 'bo@example.com'] });

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', plan, reviewers: '2' });
  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  const reviewers = app.db.prepare(
    `SELECT p.email FROM review r JOIN person p ON p.id = r.reviewer_person_id
      WHERE r.submission_id = ?`).all(submission.id).map((r) => r.email);
  assert.deepEqual(reviewers, ['bo@example.com']);
  assert.equal(routingOf(app, submission.id).outcome, 'partial',
    'asking for two and getting one is reported, not rounded down in silence');
});

test('a draft is not routed, because half an idea is not for reviewers', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event, { reviewers: ['ann@example.com'] });

  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'is_present', plan });

  await post(app, `/submit/${event}/${form}`,
    { title: 'Half an idea', email: 'later@example.com', track: 'retrieval', save_draft: '1' });

  const submission = submissionOf(app, 'Half an idea');
  assert.equal(submission.status, 'draft');
  assert.equal(reviewsOf(app, submission.id).length, 0);
  assert.equal(routingOf(app, submission.id), undefined);
});

// --- saying why ------------------------------------------------------------

test('the submission\'s own history says why it landed where it did', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event, { reviewers: ['ann@example.com'] });

  await post(app, `/e/${event}/forms/${form}/routing`, {
    field: 'track', operator: 'equals', value: 'retrieval', plan, track: 'retrieval',
  });
  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  const page = (await get(app, `/e/${event}/submissions/${submission.code}`)).body;
  assert.match(page, /routed/);
  assert.match(page, /First Round \(ML\)/);
});

test('removing a rule keeps the record of what it already did', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'retrieval' });
  await post(app, `/submit/${event}/${form}`, { ...PROPOSAL, track: 'retrieval' });

  const submission = submissionOf(app);
  const rule = app.db.prepare('SELECT id FROM form_routing_rule').get().id;
  await post(app, `/e/${event}/forms/${form}/routing/${rule}/delete`);

  const routed = routingOf(app, submission.id);
  assert.equal(routed.rule_id, null, 'the rule is gone');
  assert.match(routed.detail, /Track is retrieval/, 'what it did is not');
});

// --- refusing a rule that could not work -----------------------------------

test('a rule with no action is refused', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval' }));
  assert.match(err.message, /has to do something/);
  assert.match(err.hint, /plan=<review round slug>, track=<track slug>/);
});

test('an unknown review round is refused, naming the rounds that exist', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await reviewRound(app, event);

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', plan: 'round-one' }));
  assert.match(err.message, /no review round 'round-one'/);
  assert.match(err.hint, /first-round-ml/);
});

test('an unknown track is refused, naming the tracks that exist', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'rag' }));
  assert.match(err.message, /no track 'rag'/);
  assert.match(err.hint, /retrieval, platform-and-infra/);
});

test('a value nobody could ever answer is refused, listing the answers', async () => {
  // A typo in a slug is a rule that never fires and never says so, which is the
  // exact failure this repo keeps paying for.
  const app = newApp();
  const { event, form } = await conference(app);

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'Retrieval', track: 'retrieval' }));
  assert.match(err.message, /'Retrieval' is not one of the answers to 'Track'/);
  assert.match(err.hint, /retrieval, platform-and-infra/);
});

test('a comparison with nothing to compare against is refused', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', track: 'retrieval' }));
  assert.match(err.message, /needs something to compare the answer to/);
  assert.match(err.hint, /is_present/);
});

test('a question about the speaker cannot be routed on', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'biography', operator: 'is_present', track: 'retrieval' }));
  assert.match(err.message, /about the speaker, not about the session/);
  assert.match(err.hint, /Questions about the session/);
});

test('a rule that could never fire because an earlier one shadows it is refused', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'retrieval' });

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', track: 'platform-and-infra' }));
  assert.match(err.message, /there is already a rule/);
  assert.match(err.hint, /first matching rule wins/);
});

test('an unknown question names the form it is not on', async () => {
  const app = newApp();
  const { event, form } = await conference(app);

  const err = await failure(post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'topic', operator: 'is_present', track: 'retrieval' }));
  assert.match(err.message, /no question 'topic' on this form/);
});

// --- deleting what a rule depends on ---------------------------------------

test('removing a track a rule assigns to is refused, and says what to do', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'format', operator: 'equals', value: 'talk-30-min', track: 'retrieval' });

  const err = await failure(post(app, `/e/${event}/settings/tracks/retrieval/delete`));
  assert.match(err.message, /routing rule assigns to/);
  assert.match(err.message, /Remove the rule first/);
  assert.ok(app.db.prepare("SELECT 1 FROM track WHERE slug = 'retrieval'").get(),
    'nothing was changed');
});

test('removing the track works once the rule is gone', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'format', operator: 'equals', value: 'talk-30-min', track: 'retrieval' });

  const rule = app.db.prepare('SELECT id FROM form_routing_rule').get().id;
  await post(app, `/e/${event}/forms/${form}/routing/${rule}/delete`);
  await post(app, `/e/${event}/settings/tracks/retrieval/delete`);

  assert.equal(app.db.prepare("SELECT 1 FROM track WHERE slug = 'retrieval'").get(), undefined);
});

test('deleting a whole event still works when its forms have routing rules', async () => {
  // The protection above is about an organizer removing one track, not about
  // tearing down a conference -- which arrives as a cascade and must not trip.
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event, { reviewers: ['ann@example.com'] });
  await post(app, `/e/${event}/forms/${form}/routing`,
    { field: 'track', operator: 'equals', value: 'retrieval', plan, track: 'retrieval' });

  assert.doesNotThrow(() => app.db.prepare('DELETE FROM event WHERE slug = ?').run(event));
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM form_routing_rule').get().n, 0);
});

test('a rule cannot be written with no action, even straight into the database', async () => {
  const app = newApp();
  const { event, form } = await conference(app);
  const formId = app.db.prepare('SELECT id FROM form WHERE slug = ?').get(form).id;
  const fieldId = app.db.prepare(
    'SELECT id FROM form_field WHERE form_id = ? AND slug = ?').get(formId, 'track').id;

  assert.throws(() => app.db.prepare(
    `INSERT INTO form_routing_rule (form_id, field_id, operator, value, sort_order, created_at)
     VALUES (?, ?, 'equals', 'retrieval', 1, '2027-01-01T00:00:00Z')`,
  ).run(formId, fieldId), /CHECK constraint/i);
});

// --- the two rule kinds agree ----------------------------------------------

test('a conditional question and a routing rule compare an answer the same way', async () => {
  // One comparison implementation, so `includes` cannot come to mean two things.
  const { matches } = await import('../src/core/routing.js');
  const { conditionHolds } = await import('../src/routes/formfields.js');

  const answers = { track: 'retrieval,platform-and-infra' };
  const answerOf = (slug) => answers[slug] ?? '';

  for (const operator of ['equals', 'not_equals', 'includes', 'is_blank', 'is_present']) {
    assert.equal(
      conditionHolds({ when_slug: 'track', operator, value: 'retrieval' }, answerOf),
      matches(operator, answers.track, 'retrieval'),
      `${operator} should mean the same thing in both places`);
  }
});

// --- the wipe -----------------------------------------------------------------

test('a routing rule does not stop the database being reset', async () => {
  // `npm run seed` empties every table before rebuilding. Turning foreign keys
  // off does not turn triggers off, and the trigger protecting a review round
  // from deletion while a rule assigns to it aborted the wipe half-way. The
  // demo could not be reset, and eval attempts silently ran on the previous
  // attempt's state.
  //
  // Whether it fired at all came down to spelling: the wipe went in alphabetical
  // order, `evaluation_plan` sorts before `event`, so rounds were removed while
  // events still existed and the trigger's "unless the whole event is going"
  // guard still held.
  const app = newApp();
  const { event, form } = await conference(app);
  const plan = await reviewRound(app, event, { reviewers: ['ann@example.com'] });
  await post(app, `/e/${event}/forms/${form}/routing`, {
    field: 'track', operator: 'equals', value: 'retrieval', plan, track: 'retrieval',
  });
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM form_routing_rule').get().n, 1);

  // What wipe() does: events first, so every guard is false, then everything.
  const tables = app.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migration' ORDER BY name`,
  ).all().map((r) => r.name);

  app.db.exec('PRAGMA foreign_keys = OFF');
  app.db.exec('DELETE FROM event');
  for (const name of tables) app.db.exec(`DELETE FROM ${name}`);
  app.db.exec('PRAGMA foreign_keys = ON');

  assert.equal(app.db.prepare('SELECT count(*) AS n FROM form_routing_rule').get().n, 0);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM event').get().n, 0);
});
