// Setting up review: rounds, scorecards, reviewer pools, and assignments.
//
// A round is the unit everything hangs off. It owns its dates, its scorecard,
// its pool of reviewers, and whether it is blind — because those genuinely
// differ between rounds. The first pass over two hundred abstracts is usually
// anonymous and scored on two axes by a wide pool; the final pass is a small
// group deciding, with names visible, whether this particular person can carry
// a keynote.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, notFound } from '../http/router.js';
import { now, slugify, uniqueSlug } from '../db.js';
import { queueEmail } from '../core/mail.js';
import { createMagicLink } from '../core/auth.js';
import {
  findEvent, requireOrganizer, organizerNav, tabs, empty, statusPill, fullName, dateOnly,
} from './shared.js';

export function mountEvaluation(router) {
  router.get('/e/:event/evaluation', planList,
    'Review rounds: their dates, scorecards, pools, and progress.');
  router.post('/e/:event/evaluation', createPlan,
    'Create a review round. Body: name, opens_at, closes_at, anonymize, max_per_reviewer.');

  router.get('/e/:event/evaluation/:plan', planDetail,
    'One review round: edit its scorecard, pool, and assignments.');
  router.post('/e/:event/evaluation/:plan/settings', updatePlan,
    'Rename a round, move its dates, toggle blind review, set a per-reviewer cap.');
  router.post('/e/:event/evaluation/:plan/criteria', addCriterion,
    'Add a scorecard field. Body: label, field_type=number|select|text, scale_min, scale_max, weight, choices.');
  router.post('/e/:event/evaluation/:plan/criteria/:criterion/delete', deleteCriterion,
    'Remove a scorecard field.');
  router.post('/e/:event/evaluation/:plan/reviewers', addReviewer,
    'Put somebody in this round\'s reviewer pool. Body: email, and optionally first_name/last_name.');
  router.post('/e/:event/evaluation/:plan/assign', assign,
    'Assign submissions to a reviewer, honouring the per-reviewer cap. Supports auto-distribution.');
  router.post('/e/:event/evaluation/:plan/remind', remindReviewers,
    'Email every reviewer in this round who still has work outstanding.');

  router.get('/e/:event/evaluation/:plan/scores.csv', scoresCsv,
    'Every submitted score in this round, as CSV.');
}

// --- reading ---------------------------------------------------------------

function findPlan(ctx, event, slug) {
  const plan = ctx.db.prepare('SELECT * FROM evaluation_plan WHERE event_id = ? AND slug = ?')
    .get(event.id, slug);
  if (!plan) {
    const known = ctx.db.prepare('SELECT slug FROM evaluation_plan WHERE event_id = ?')
      .all(event.id).map((p) => p.slug);
    throw notFound(`no review round '${slug}'`,
      known.length ? `rounds are: ${known.join(', ')}` : 'this event has no review rounds yet');
  }
  return plan;
}

function criteriaOf(db, planId) {
  return db.prepare('SELECT * FROM criterion WHERE plan_id = ? ORDER BY sort_order, id').all(planId);
}

function poolOf(db, planId) {
  return db.prepare(
    `SELECT p.*, pr.added_at,
            (SELECT count(*) FROM review r WHERE r.plan_id = ? AND r.reviewer_person_id = p.id) AS assigned,
            (SELECT count(*) FROM review r WHERE r.plan_id = ? AND r.reviewer_person_id = p.id
              AND r.status = 'submitted') AS done
       FROM plan_reviewer pr JOIN person p ON p.id = pr.person_id
      WHERE pr.plan_id = ? ORDER BY p.last_name, p.first_name`,
  ).all(planId, planId, planId);
}

/**
 * Aggregate score per submission for a round.
 *
 * Only numeric criteria count. Averaging "Accept" with a 4 would be arithmetic
 * on a word, so a dropdown recommendation is reported separately rather than
 * folded into the number.
 *
 * The average is weighted: a criterion set to count double counts double. An
 * unweighted mean of 4 and 2 is 3.0; weighting the first by 2 gives 3.33, and
 * committees notice the difference.
 */
function rankings(db, planId, { direction = 'desc' } = {}) {
  const rows = db.prepare(
    `SELECT s.id, s.code, s.title, s.status,
            sum(sc.value * c.weight) AS weighted_total,
            sum(c.weight) AS weight_total,
            avg(sc.value) AS plain_average,
            count(DISTINCT r.id) AS reviews
       FROM submission s
       JOIN review r ON r.submission_id = s.id AND r.plan_id = ? AND r.status = 'submitted'
       JOIN score sc ON sc.review_id = r.id
       JOIN criterion c ON c.id = sc.criterion_id AND c.field_type = 'number'
      GROUP BY s.id`,
  ).all(planId);

  const scored = rows.map((r) => ({
    ...r,
    weighted_average: r.weight_total ? Number((r.weighted_total / r.weight_total).toFixed(2)) : null,
    plain_average: r.plain_average == null ? null : Number(r.plain_average.toFixed(2)),
  }));

  scored.sort((a, b) => (direction === 'asc'
    ? (a.weighted_average ?? 0) - (b.weighted_average ?? 0)
    : (b.weighted_average ?? 0) - (a.weighted_average ?? 0)));
  return scored;
}

// --- screens ---------------------------------------------------------------

function planList(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const plans = ctx.db.prepare(
    `SELECT ep.*,
            (SELECT count(*) FROM plan_reviewer WHERE plan_id = ep.id) AS pool,
            (SELECT count(*) FROM review WHERE plan_id = ep.id) AS assigned,
            (SELECT count(*) FROM review WHERE plan_id = ep.id AND status = 'submitted') AS done,
            (SELECT count(*) FROM criterion WHERE plan_id = ep.id) AS criteria
       FROM evaluation_plan ep WHERE ep.event_id = ? ORDER BY ep.round, ep.created_at`,
  ).all(event.id);

  return ok(page({
    title: `Review rounds - ${event.name}`,
    nav: organizerNav(event, 'Review'),
    wide: true,
    body: html`
      <h1>Review rounds</h1>
      <p class="sub">Each round has its own dates, scorecard, and reviewer pool.
        <a href="/e/${event.slug}/review">See progress and scores</a>.</p>

      ${plans.length === 0 ? empty('No rounds yet. Create the first one below.') : html`
        <table>
          <thead><tr><th>Round</th><th>Name</th><th>Open</th><th>Closes</th>
            <th>Blind</th><th class="num">Criteria</th><th class="num">Pool</th>
            <th class="num">Reviews</th></tr></thead>
          <tbody>
            ${plans.map((p) => html`
              <tr>
                <td>${p.round}</td>
                <td><a href="/e/${event.slug}/evaluation/${p.slug}"><strong>${p.name}</strong></a></td>
                <td>${p.opens_at ? dateOnly(p.opens_at, event.timezone) : html`<span class="muted">-</span>`}</td>
                <td>${p.closes_at ? dateOnly(p.closes_at, event.timezone) : html`<span class="muted">-</span>`}</td>
                <td>${p.anonymize ? 'yes' : html`<span class="muted">no</span>`}</td>
                <td class="num">${p.criteria}</td>
                <td class="num">${p.pool}</td>
                <td class="num">${p.done} / ${p.assigned}</td>
              </tr>`)}
          </tbody>
        </table>`}

      <h2>New round</h2>
      <form method="post" action="/e/${event.slug}/evaluation">
        <div class="row">
          <div><label for="name">Name</label>
            <input type="text" id="name" name="name" required placeholder="Initial Review"></div>
          <div><label for="round">Round number</label>
            <input type="number" id="round" name="round" value="${plans.length + 1}" min="1"></div>
        </div>
        <div class="row">
          <div><label for="opens_at">Opens</label>
            <input type="date" id="opens_at" name="opens_at"></div>
          <div><label for="closes_at">Closes</label>
            <input type="date" id="closes_at" name="closes_at"></div>
          <div><label for="max_per_reviewer">Max per reviewer <small>optional</small></label>
            <input type="number" id="max_per_reviewer" name="max_per_reviewer" min="1"></div>
        </div>
        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="anonymize" value="1">
          Blind review: hide submitter identity from reviewers in this round
        </label>
        <div class="actions"><button type="submit">Create round</button></div>
      </form>
    `,
  }));
}

function createPlan(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const name = ctx.fields.require('name', 'for example: Initial Review');
  const slug = uniqueSlug(name,
    (s) => ctx.db.prepare('SELECT 1 FROM evaluation_plan WHERE event_id = ? AND slug = ?').get(event.id, s));

  const plan = ctx.db.prepare(
    `INSERT INTO evaluation_plan (event_id, slug, name, round, opens_at, closes_at,
                                  anonymize, max_per_reviewer, description, is_open, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?) RETURNING *`,
  ).get(event.id, slug, name, ctx.fields.int('round', 1),
    asDate(ctx.fields.get('opens_at')), asDate(ctx.fields.get('closes_at')),
    ctx.fields.bool('anonymize') ? 1 : 0, ctx.fields.int('max_per_reviewer', null), now());

  // A round with no scorecard cannot be reviewed against, so give it the shape
  // most committees start from. Every part of it is editable.
  const defaults = [
    { label: 'Relevance', field_type: 'number', scale_min: 1, scale_max: 5, weight: 1 },
    { label: 'Originality', field_type: 'number', scale_min: 1, scale_max: 5, weight: 1 },
    { label: 'Recommendation', field_type: 'select', choices: 'Accept,Maybe,Reject', weight: 1 },
    { label: 'Comments', field_type: 'text', weight: 1 },
  ];
  defaults.forEach((c, i) => insertCriterion(ctx.db, plan.id, { ...c, sort_order: i + 1 }));

  return redirect(`/e/${event.slug}/evaluation/${plan.slug}`);
}

function planDetail(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  const criteria = criteriaOf(ctx.db, plan.id);
  const pool = poolOf(ctx.db, plan.id);
  const tracks = ctx.db.prepare('SELECT * FROM track WHERE event_id = ? ORDER BY sort_order').all(event.id);

  const assignable = ctx.db.prepare(
    `SELECT s.code, s.title, s.status, t.name AS track_name,
            (SELECT count(*) FROM review r WHERE r.plan_id = ? AND r.submission_id = s.id) AS reviewers
       FROM submission s LEFT JOIN track t ON t.id = s.track_id
      WHERE s.event_id = ? AND s.status IN ('pending', 'accept_queue', 'decline_queue')
      ORDER BY s.code`,
  ).all(plan.id, event.id);

  const flash = ctx.query.get('done');

  return ok(page({
    title: `${plan.name} - ${event.name}`,
    nav: organizerNav(event, 'Review'),
    wide: true,
    body: html`
      <p class="sub"><a href="/e/${event.slug}/evaluation">&larr; All rounds</a></p>
      <h1>${plan.name}</h1>
      <p class="sub">Round ${plan.round}
        ${plan.anonymize ? html` &middot; <strong>blind</strong>` : ''}
        ${plan.max_per_reviewer ? html` &middot; max ${plan.max_per_reviewer} per reviewer` : ''}</p>
      ${flash ? html`<p class="flash">${flash}</p>` : ''}

      <h2>Settings</h2>
      <form method="post" action="/e/${event.slug}/evaluation/${plan.slug}/settings">
        <div class="row">
          <div><label for="name">Name</label>
            <input type="text" id="name" name="name" value="${plan.name}" required></div>
          <div><label for="opens_at">Opens</label>
            <input type="date" id="opens_at" name="opens_at" value="${(plan.opens_at ?? '').slice(0, 10)}"></div>
          <div><label for="closes_at">Closes</label>
            <input type="date" id="closes_at" name="closes_at" value="${(plan.closes_at ?? '').slice(0, 10)}"></div>
          <div><label for="max_per_reviewer">Max per reviewer</label>
            <input type="number" id="max_per_reviewer" name="max_per_reviewer" min="1"
                   value="${plan.max_per_reviewer ?? ''}"></div>
        </div>
        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="anonymize" value="1" ${plan.anonymize ? raw('checked') : ''}>
          Blind review: hide submitter identity from reviewers in this round
        </label>
        <div class="actions"><button type="submit">Save settings</button></div>
      </form>

      <h2>Scorecard</h2>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Range or choices</th>
          <th class="num">Weight</th><th></th></tr></thead>
        <tbody>
          ${criteria.map((c) => html`
            <tr>
              <td><strong>${c.label}</strong></td>
              <td><code>${c.field_type}</code></td>
              <td>${c.field_type === 'number' ? html`${c.scale_min} to ${c.scale_max}`
                : c.field_type === 'select' ? c.choices : html`<span class="muted">free text</span>`}</td>
              <td class="num">${c.weight}</td>
              <td>
                <form method="post" class="inline"
                      action="/e/${event.slug}/evaluation/${plan.slug}/criteria/${c.slug}/delete">
                  <button type="submit" class="secondary">Remove</button>
                </form>
              </td>
            </tr>`)}
        </tbody>
      </table>

      <form method="post" action="/e/${event.slug}/evaluation/${plan.slug}/criteria">
        <div class="row">
          <div><label for="label">New field</label>
            <input type="text" id="label" name="label" required placeholder="Speaker experience"></div>
          <div><label for="field_type">Type</label>
            <select id="field_type" name="field_type">
              <option value="number">Number</option>
              <option value="select">Dropdown</option>
              <option value="text">Free text</option>
            </select></div>
          <div><label for="scale_min">Min</label>
            <input type="number" id="scale_min" name="scale_min" value="1"></div>
          <div><label for="scale_max">Max</label>
            <input type="number" id="scale_max" name="scale_max" value="5"></div>
          <div><label for="weight">Weight</label>
            <input type="number" id="weight" name="weight" value="1" step="0.5" min="0"></div>
        </div>
        <label for="choices">Dropdown choices <small>comma separated, for a dropdown</small></label>
        <input type="text" id="choices" name="choices" placeholder="Accept,Maybe,Reject">
        <div class="actions"><button type="submit">Add field</button></div>
      </form>

      <h2>Reviewer pool</h2>
      ${pool.length === 0 ? empty('Nobody is in this round yet.') : html`
        <table>
          <thead><tr><th>Reviewer</th><th>Email</th><th class="num">Assigned</th>
            <th class="num">Done</th><th class="num">Outstanding</th></tr></thead>
          <tbody>
            ${pool.map((r) => html`
              <tr>
                <td>${fullName(r)}</td>
                <td class="muted">${r.email}</td>
                <td class="num">${r.assigned}</td>
                <td class="num">${r.done}</td>
                <td class="num">${r.assigned - r.done > 0
                  ? html`<strong>${r.assigned - r.done}</strong>` : '0'}</td>
              </tr>`)}
          </tbody>
        </table>
        <form method="post" action="/e/${event.slug}/evaluation/${plan.slug}/remind">
          <div class="actions">
            <button type="submit" class="secondary">Remind everyone with outstanding reviews</button>
          </div>
        </form>`}

      <form method="post" action="/e/${event.slug}/evaluation/${plan.slug}/reviewers">
        <div class="row">
          <div><label for="email">Add a reviewer by email</label>
            <input type="email" id="email" name="email" required></div>
          <div><label for="first_name">First name</label>
            <input type="text" id="first_name" name="first_name"></div>
          <div><label for="last_name">Last name</label>
            <input type="text" id="last_name" name="last_name"></div>
          <div style="flex:0 0 auto"><button type="submit">Add to pool</button></div>
        </div>
        <p class="muted">If they are new, we create the account and show you a sign-in
          link on the next screen, so you are never waiting on an email to arrive.</p>
      </form>

      <h2>Assign</h2>
      <form method="post" action="/e/${event.slug}/evaluation/${plan.slug}/assign">
        <div class="row">
          <div>
            <label for="reviewer">Reviewer</label>
            <select id="reviewer" name="reviewer">
              <option value="">- distribute across the whole pool -</option>
              ${pool.map((r) => html`<option value="${r.slug}">${fullName(r)}</option>`)}
            </select>
          </div>
          <div>
            <label for="track">Only this track <small>optional</small></label>
            <select id="track" name="track">
              <option value="">All tracks</option>
              ${tracks.map((t) => html`<option value="${t.slug}">${t.name}</option>`)}
            </select>
          </div>
          <div>
            <label for="per_submission">Reviewers per submission <small>when distributing</small></label>
            <input type="number" id="per_submission" name="per_submission" value="2" min="1">
          </div>
        </div>

        <div class="scroll" style="max-height:22rem;overflow-y:auto">
        <table>
          <thead><tr><th></th><th>Code</th><th>Title</th><th>Track</th>
            <th class="num">Reviewers</th></tr></thead>
          <tbody>
            ${assignable.map((s) => html`
              <tr>
                <td><input type="checkbox" name="codes" value="${s.code}" aria-label="Select ${s.code}"></td>
                <td><code>${s.code}</code></td>
                <td>${s.title}</td>
                <td>${s.track_name ?? ''}</td>
                <td class="num">${s.reviewers}</td>
              </tr>`)}
          </tbody>
        </table>
        </div>

        <div class="actions">
          <button type="submit" name="mode" value="selected">Assign selected</button>
          <button type="submit" name="mode" value="auto" class="secondary">
            Auto-distribute everything unassigned
          </button>
        </div>
        <p class="muted">Auto-distribution gives each submission the requested number of
          reviewers, spreading the load evenly and respecting the per-reviewer cap.</p>
      </form>

      <h2>Export</h2>
      <p><a class="button secondary" href="/e/${event.slug}/evaluation/${plan.slug}/scores.csv">
        Download scores as CSV</a></p>
    `,
  }));
}

// --- writing ---------------------------------------------------------------

function asDate(value) {
  return value ? `${value}T00:00:00Z` : null;
}

function insertCriterion(db, planId, c) {
  const slug = uniqueSlug(c.label,
    (s) => db.prepare('SELECT 1 FROM criterion WHERE plan_id = ? AND slug = ?').get(planId, s));
  return db.prepare(
    `INSERT INTO criterion (plan_id, slug, label, help_text, scale_min, scale_max,
                            weight, sort_order, field_type, choices)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(planId, slug, c.label, c.scale_min ?? 1, c.scale_max ?? 5, c.weight ?? 1,
    c.sort_order ?? 99, c.field_type ?? 'number', c.choices ?? '');
}

function updatePlan(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  ctx.db.prepare(
    `UPDATE evaluation_plan SET name = ?, opens_at = ?, closes_at = ?,
                                anonymize = ?, max_per_reviewer = ? WHERE id = ?`,
  ).run(ctx.fields.require('name'), asDate(ctx.fields.get('opens_at')),
    asDate(ctx.fields.get('closes_at')), ctx.fields.bool('anonymize') ? 1 : 0,
    ctx.fields.int('max_per_reviewer', null), plan.id);

  return redirect(`/e/${event.slug}/evaluation/${plan.slug}?done=Settings+saved`);
}

function addCriterion(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  const fieldType = ctx.fields.choice('field_type', ['number', 'select', 'text'], 'number');
  const choices = ctx.fields.get('choices');
  if (fieldType === 'select' && choices === '') {
    throw badRequest('a dropdown needs some choices',
      'give them comma separated, for example: Accept,Maybe,Reject');
  }

  const scaleMin = ctx.fields.int('scale_min', 1);
  const scaleMax = ctx.fields.int('scale_max', 5);
  if (fieldType === 'number' && scaleMin >= scaleMax) {
    throw badRequest(`a scale of ${scaleMin} to ${scaleMax} has nothing in it`,
      'the maximum has to be higher than the minimum');
  }

  const count = ctx.db.prepare('SELECT count(*) AS n FROM criterion WHERE plan_id = ?').get(plan.id).n;
  insertCriterion(ctx.db, plan.id, {
    label: ctx.fields.require('label'),
    field_type: fieldType,
    choices,
    scale_min: scaleMin,
    scale_max: scaleMax,
    weight: Number(ctx.fields.get('weight', '1')),
    sort_order: count + 1,
  });

  return redirect(`/e/${event.slug}/evaluation/${plan.slug}?done=Scorecard+field+added`);
}

function deleteCriterion(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  const criterion = ctx.db.prepare('SELECT * FROM criterion WHERE plan_id = ? AND slug = ?')
    .get(plan.id, ctx.params.criterion);
  if (!criterion) throw notFound(`no scorecard field '${ctx.params.criterion}' in this round`);

  ctx.db.prepare('DELETE FROM criterion WHERE id = ?').run(criterion.id);
  return redirect(`/e/${event.slug}/evaluation/${plan.slug}?done=Field+removed`);
}

function addReviewer(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  const email = ctx.fields.require('email');
  let person = ctx.db.prepare('SELECT * FROM person WHERE email = ? COLLATE NOCASE').get(email);
  const t = now();

  if (!person) {
    const first = ctx.fields.get('first_name');
    const last = ctx.fields.get('last_name');
    const slug = uniqueSlug(`${first} ${last}`.trim() || email.split('@')[0],
      (s) => ctx.db.prepare('SELECT 1 FROM person WHERE slug = ?').get(s));
    person = ctx.db.prepare(
      `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(slug, email, first, last, t, t);
  }

  ctx.db.prepare('INSERT OR IGNORE INTO plan_reviewer (plan_id, person_id, added_at) VALUES (?, ?, ?)')
    .run(plan.id, person.id, t);
  ctx.db.prepare(
    `INSERT OR IGNORE INTO event_membership (event_id, person_id, role) VALUES (?, ?, 'reviewer')`,
  ).run(event.id, person.id);

  // Show the sign-in link rather than only emailing it. An organizer setting up
  // a committee on a Sunday should not be blocked waiting for an inbox.
  const token = createMagicLink(ctx.db, person.id, event.id);
  const base = ctx.headers?.host ? `http://${ctx.headers.host}` : 'http://127.0.0.1:8080';
  const link = `${base}/portal/${event.slug}/enter?token=${token}`;

  queueEmail(ctx.db, {
    eventId: event.id,
    to: person,
    subject: `You have been asked to review for ${event.name}`,
    body: `Hi {{first_name}},\n\nYou have been added to the "${plan.name}" review round for `
      + `${event.name}.\n\nYour queue is here:\n\n  ${link}\n\n- The ${event.name} team`,
    kind: 'bulk',
    vars: { event_name: event.name },
  });

  return redirect(`/e/${event.slug}/evaluation/${plan.slug}`
    + `?done=${encodeURIComponent(`Added ${fullName(person)}. Their sign-in link: ${link}`)}`);
}

/**
 * Assign submissions to reviewers.
 *
 * Two modes. "Selected" gives the ticked submissions to one named reviewer.
 * "Auto" spreads everything that is short of reviewers across the pool, always
 * handing the next submission to whoever currently has the least work — which is
 * what keeps a volunteer committee from having one person carry it.
 *
 * Both respect the round's per-reviewer cap, and neither ever assigns somebody
 * their own submission.
 */
function assign(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  const pool = poolOf(ctx.db, plan.id);
  if (pool.length === 0) {
    throw badRequest('this round has no reviewers yet', 'add somebody to the pool first');
  }

  const mode = ctx.fields.choice('mode', ['selected', 'auto'], 'selected');
  const trackSlug = ctx.fields.get('track');
  const cap = plan.max_per_reviewer ?? Infinity;

  const load = new Map(pool.map((r) => [r.id, r.assigned]));
  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO review (plan_id, submission_id, reviewer_person_id, status, assigned_at)
     VALUES (?, ?, ?, 'assigned', ?)`,
  );
  const isAuthor = ctx.db.prepare(
    'SELECT 1 FROM submission_participant WHERE submission_id = ? AND person_id = ?',
  );

  let created = 0;
  const t = now();

  const candidates = (submissionId) => pool
    .filter((r) => load.get(r.id) < cap && !isAuthor.get(submissionId, r.id))
    .sort((a, b) => load.get(a.id) - load.get(b.id));

  if (mode === 'selected') {
    const reviewerSlug = ctx.fields.get('reviewer');
    if (!reviewerSlug) {
      throw badRequest('choose a reviewer, or use auto-distribute',
        'the reviewer dropdown is above the submission list');
    }
    const reviewer = pool.find((r) => r.slug === reviewerSlug);
    if (!reviewer) throw badRequest(`'${reviewerSlug}' is not in this round's pool`);

    const codes = ctx.fields.list('codes');
    if (codes.length === 0) throw badRequest('no submissions selected', 'tick at least one row');

    for (const code of codes) {
      const submission = ctx.db.prepare('SELECT id FROM submission WHERE event_id = ? AND code = ?')
        .get(event.id, code.toUpperCase());
      if (!submission) continue;
      if (load.get(reviewer.id) >= cap) {
        throw badRequest(
          `${fullName(reviewer)} is at this round's cap of ${plan.max_per_reviewer}`,
          'raise the cap in Settings, or give these to somebody else');
      }
      if (isAuthor.get(submission.id, reviewer.id)) {
        throw badRequest(`${fullName(reviewer)} is a speaker on ${code}`,
          'nobody reviews their own submission');
      }
      created += insert.run(plan.id, submission.id, reviewer.id, t).changes;
      load.set(reviewer.id, load.get(reviewer.id) + 1);
    }
  } else {
    const wanted = ctx.fields.int('per_submission', 2);
    const rows = ctx.db.prepare(
      `SELECT s.id, s.code,
              (SELECT count(*) FROM review r WHERE r.plan_id = ? AND r.submission_id = s.id) AS have
         FROM submission s LEFT JOIN track t ON t.id = s.track_id
        WHERE s.event_id = ? AND s.status IN ('pending', 'accept_queue', 'decline_queue')
          AND (? = '' OR t.slug = ?)
        ORDER BY s.code`,
    ).all(plan.id, event.id, trackSlug, trackSlug);

    for (const row of rows) {
      for (let n = row.have; n < wanted; n++) {
        const [next] = candidates(row.id);
        if (!next) break;   // everybody is capped or conflicted; stop quietly
        created += insert.run(plan.id, row.id, next.id, t).changes;
        load.set(next.id, load.get(next.id) + 1);
      }
    }
  }

  return redirect(`/e/${event.slug}/evaluation/${plan.slug}`
    + `?done=${encodeURIComponent(`${created} assignment(s) created`)}`);
}

function remindReviewers(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  const behind = poolOf(ctx.db, plan.id).filter((r) => r.assigned > r.done);
  const base = ctx.headers?.host ? `http://${ctx.headers.host}` : 'http://127.0.0.1:8080';

  for (const reviewer of behind) {
    const link = `${base}/portal/${event.slug}/enter?token=${createMagicLink(ctx.db, reviewer.id, event.id)}`;
    queueEmail(ctx.db, {
      eventId: event.id,
      to: reviewer,
      subject: `${reviewer.assigned - reviewer.done} review(s) still to do for ${event.name}`,
      body: `Hi {{first_name}},\n\nYou have ${reviewer.assigned - reviewer.done} of `
        + `${reviewer.assigned} reviews left in the "${plan.name}" round`
        + `${plan.closes_at ? `, which closes on ${plan.closes_at.slice(0, 10)}` : ''}.\n\n`
        + `Your queue:\n\n  ${link}\n\n- The ${event.name} team`,
      kind: 'bulk',
      vars: { event_name: event.name },
    });
  }

  return redirect(`/e/${event.slug}/evaluation/${plan.slug}`
    + `?done=${encodeURIComponent(`Reminded ${behind.length} reviewer(s)`)}`);
}

function scoresCsv(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const plan = findPlan(ctx, event, ctx.params.plan);

  const rows = ctx.db.prepare(
    `SELECT s.code, s.title, s.status,
            p.first_name || ' ' || p.last_name AS reviewer, r.source, r.status AS review_status,
            c.label AS criterion, c.field_type, sc.value, sc.text_value, r.comment
       FROM review r
       JOIN submission s ON s.id = r.submission_id
       JOIN person p ON p.id = r.reviewer_person_id
       LEFT JOIN score sc ON sc.review_id = r.id
       LEFT JOIN criterion c ON c.id = sc.criterion_id
      WHERE r.plan_id = ? ORDER BY s.code, p.last_name, c.sort_order`,
  ).all(plan.id);

  const header = ['code', 'title', 'submission_status', 'reviewer', 'source',
    'review_status', 'criterion', 'value', 'comment'];
  const lines = [header.join(',')];

  for (const r of rows) {
    lines.push([
      r.code, r.title, r.status, r.reviewer, r.source, r.review_status,
      r.criterion ?? '',
      r.field_type === 'number' ? (r.value ?? '') : (r.text_value || r.value || ''),
      r.comment ?? '',
    ].map(csvCell).join(','));
  }

  return {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${event.slug}-${plan.slug}-scores.csv"`,
    },
    body: `${lines.join('\n')}\n`,
  };
}

/** Quote a CSV cell, doubling any quotes inside it. */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export { rankings, criteriaOf, poolOf };
