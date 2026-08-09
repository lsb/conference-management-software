// The reviewer's screens.
//
// Separate from the organizer's Review page, which is about progress in
// aggregate. This is the working surface: the queue of things assigned to me,
// and the form for scoring one of them.
//
// Reviewers are volunteers doing this in the evenings. The queue is therefore
// ordered by what is most useful to do next, the form fits on one screen, and
// nothing asks them to navigate anywhere to find the next item.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, forbidden, notFound } from '../http/router.js';
import { now } from '../db.js';
import { rolesFor, organizerAccessIsOpen } from '../core/auth.js';
import { findEvent, empty, statusPill, fullName } from './shared.js';

export function mountReviewer(router) {
  router.get('/review/:event', queue,
    'A reviewer\'s own queue: submissions assigned to them, unscored first.');

  router.get('/review/:event/:code', scoreForm,
    'The scoring form for one submission.');

  router.post('/review/:event/:code', postScore,
    'Save scores and a comment. Add submit=1 to mark the review finished.');

  router.post('/review/:event/:code/conflict', postConflict,
    'Declare a conflict of interest and hand the submission back.');
}

/**
 * Which person is reviewing.
 *
 * On loopback with nobody signed in, fall back to any reviewer on the event so
 * the screens are explorable in a local demo. Off loopback this requires a real
 * signed-in reviewer.
 */
function reviewerFor(ctx, event) {
  if (ctx.person && rolesFor(ctx.db, event.id, ctx.person.id).length > 0) return ctx.person;

  if (organizerAccessIsOpen()) {
    const anyReviewer = ctx.db.prepare(
      `SELECT p.* FROM event_membership m JOIN person p ON p.id = m.person_id
        WHERE m.event_id = ? AND m.role = 'reviewer' LIMIT 1`,
    ).get(event.id);
    if (anyReviewer) return anyReviewer;
  }

  throw forbidden('reviewer access required',
    'sign in at /portal/sign-in with an account that reviews for this event');
}

function findReview(ctx, event, reviewer, code) {
  const review = ctx.db.prepare(
    `SELECT rv.*, s.code, s.title, s.description, s.status AS submission_status, s.id AS submission_id,
            ep.name AS plan_name, ep.round, ep.slug AS plan_slug, ep.anonymize
       FROM review rv
       JOIN submission s ON s.id = rv.submission_id
       JOIN evaluation_plan ep ON ep.id = rv.plan_id
      WHERE s.event_id = ? AND s.code = ? AND rv.reviewer_person_id = ?`,
  ).get(event.id, code.toUpperCase(), reviewer.id);

  if (!review) {
    throw notFound(`${code} is not assigned to you for review`,
      `your queue is at /review/${event.slug}`);
  }
  return review;
}

function criteriaFor(db, planId) {
  return db.prepare('SELECT * FROM criterion WHERE plan_id = ? ORDER BY sort_order, id').all(planId);
}

/**
 * One scorecard field.
 *
 * A committee's scorecard is not all numbers. The dropdown ("accept / maybe /
 * reject") is the field they argue about, and the free-text box is where the
 * argument gets made. Only the numeric ones feed the aggregate.
 */
function renderCriterion(criterion, current, locked) {
  const id = `c_${criterion.slug}`;
  const disabled = locked ? raw('disabled') : '';
  const weightNote = criterion.field_type === 'number' && criterion.weight !== 1
    ? html` <small>counts x${criterion.weight} toward the average</small>` : '';

  if (criterion.field_type === 'select') {
    const choices = String(criterion.choices).split(',').map((c) => c.trim()).filter(Boolean);
    return html`
      <label for="${id}">Choose one</label>
      <select id="${id}" name="${criterion.slug}" ${disabled}>
        <option value="">- no answer -</option>
        ${choices.map((c) => html`
          <option value="${c}" ${c === current ? raw('selected') : ''}>${c}</option>`)}
      </select>`;
  }

  if (criterion.field_type === 'text') {
    return html`
      <label for="${id}">Your notes</label>
      <textarea id="${id}" name="${criterion.slug}" ${disabled}>${current ?? ''}</textarea>`;
  }

  return html`
    <label for="${id}">${criterion.scale_min} to ${criterion.scale_max}${weightNote}</label>
    <input type="number" id="${id}" name="${criterion.slug}"
           min="${criterion.scale_min}" max="${criterion.scale_max}" step="1"
           value="${current ?? ''}" ${disabled}>`;
}

function nav(event, person) {
  return html`
    <header class="bar">
      <div class="inner">
        <strong>${event.name}</strong>
        <nav><a href="/review/${event.slug}" aria-current="page">My review queue</a></nav>
        <span class="spacer"></span>
        <span class="who">${fullName(person)}</span>
      </div>
    </header>`;
}

function queue(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const reviewer = reviewerFor(ctx, event);

  const rows = ctx.db.prepare(
    `SELECT rv.status, rv.submitted_at, rv.conflict_of_interest,
            s.code, s.title, ep.name AS plan_name, ep.round,
            -- Numeric criteria only. A dropdown and a comment box are stored
            -- with a zero, and folding those into the mean would drag every
            -- reviewer's average toward nothing.
            (SELECT round(avg(sc.value), 2) FROM score sc
               JOIN criterion c ON c.id = sc.criterion_id
              WHERE sc.review_id = rv.id AND c.field_type = 'number') AS my_score
       FROM review rv
       JOIN submission s ON s.id = rv.submission_id
       JOIN evaluation_plan ep ON ep.id = rv.plan_id
      WHERE s.event_id = ? AND rv.reviewer_person_id = ?
      ORDER BY rv.status = 'submitted', rv.status = 'declined', ep.round, s.code`,
  ).all(event.id, reviewer.id);

  const todo = rows.filter((r) => r.status !== 'submitted' && r.status !== 'declined');
  const done = rows.filter((r) => r.status === 'submitted');

  return ok(page({
    title: `Review queue - ${event.name}`,
    nav: nav(event, reviewer),
    body: html`
      <h1>Your review queue</h1>
      <p class="sub">${todo.length} to score, ${done.length} done.
        Scores are private to the programme committee; submitters never see them.</p>

      ${todo.length === 0 ? empty('Nothing waiting. Thank you.') : html`
        <table>
          <thead><tr><th>Code</th><th>Title</th><th>Round</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${todo.map((r) => html`
              <tr>
                <td><code>${r.code}</code></td>
                <td>${r.title}</td>
                <td class="muted">${r.plan_name}</td>
                <td>${r.status.replace('_', ' ')}</td>
                <td><a class="button" href="/review/${event.slug}/${r.code}">
                  ${r.status === 'in_progress' ? 'Continue' : 'Score it'}</a></td>
              </tr>`)}
          </tbody>
        </table>`}

      ${done.length > 0 ? html`
        <h2>Done</h2>
        <table>
          <thead><tr><th>Code</th><th>Title</th><th class="num">Your score</th><th>Submitted</th></tr></thead>
          <tbody>
            ${done.map((r) => html`
              <tr>
                <td><a href="/review/${event.slug}/${r.code}"><code>${r.code}</code></a></td>
                <td>${r.title}</td>
                <td class="num">${r.my_score ?? html`<span class="muted">-</span>`}</td>
                <td class="muted">${r.submitted_at?.slice(0, 10) ?? ''}</td>
              </tr>`)}
          </tbody>
        </table>` : ''}
    `,
  }));
}

function scoreForm(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const reviewer = reviewerFor(ctx, event);
  const review = findReview(ctx, event, reviewer, ctx.params.code);
  const criteria = criteriaFor(ctx.db, review.plan_id);

  const existing = Object.fromEntries(
    ctx.db.prepare(
      `SELECT sc.criterion_id, sc.value, sc.text_value, c.field_type
         FROM score sc JOIN criterion c ON c.id = sc.criterion_id
        WHERE sc.review_id = ?`,
    ).all(review.id).map((s) => [s.criterion_id, s.field_type === 'number' ? s.value : s.text_value]),
  );

  const answers = ctx.db.prepare(
    `SELECT ff.label, sa.value FROM submission_answer sa
       JOIN form_field ff ON ff.id = sa.field_id
      WHERE sa.submission_id = ? ORDER BY ff.sort_order`,
  ).all(review.submission_id);

  // Only looked up when the round is not blind. Fetching them and then relying
  // on the template not to print them is one edit away from a leak.
  const authors = review.anonymize ? [] : ctx.db.prepare(
    `SELECT p.first_name, p.last_name, p.company FROM submission_participant sp
       JOIN person p ON p.id = sp.person_id
      WHERE sp.submission_id = ? ORDER BY sp.sort_order`,
  ).all(review.submission_id);

  const saved = ctx.query.get('saved');
  const locked = review.status === 'submitted';

  return ok(page({
    title: `${review.code} - review`,
    nav: nav(event, reviewer),
    body: html`
      <p class="sub"><a href="/review/${event.slug}">&larr; Your queue</a></p>
      <h1>${review.title}</h1>
      <p class="sub"><code>${review.code}</code> &middot; ${review.plan_name} (round ${review.round})
        ${locked ? html` &middot; <span class="pill accepted">submitted</span>` : ''}</p>

      ${saved ? html`<p class="flash">Saved.</p>` : ''}

      <h2>The proposal</h2>
      <p>${review.description || html`<span class="muted">No description given.</span>`}</p>

      ${answers.length > 0 ? html`
        <div class="grid2">
          ${answers.map((a) => html`<div><strong>${a.label}</strong><br>${a.value}</div>`)}
        </div>` : ''}

      ${review.anonymize
        ? html`<p class="muted">This round is <strong>blind</strong>: the submitter's
            name, their co-authors, and their employer are deliberately not shown.
            Score the proposal, not the person.</p>`
        : html`
          <h3>Submitted by</h3>
          <p>${authors.map((p) => html`
            ${fullName(p)}${p.company ? html` &mdash; ${p.company}` : ''}<br>`)}</p>`}

      <h2>Your scores</h2>
      <form method="post" action="/review/${event.slug}/${review.code}">
        ${criteria.map((c) => html`
          <fieldset>
            <legend>${c.label}</legend>
            ${c.help_text ? html`<p class="muted">${c.help_text}</p>` : ''}
            ${renderCriterion(c, existing[c.id], locked)}
          </fieldset>`)}

        <label for="comment">Comment for the committee</label>
        <textarea id="comment" name="comment" ${locked ? raw('disabled') : ''}>${review.comment}</textarea>

        ${locked ? html`<p class="muted">This review has been submitted. Ask an organizer to reopen it.</p>` : html`
          <div class="actions">
            <button type="submit" name="submit_review" value="1">Submit review</button>
            <button type="submit" class="secondary">Save and come back later</button>
          </div>`}
      </form>

      ${locked ? '' : html`
        <h2>Not the right reviewer?</h2>
        <form method="post" action="/review/${event.slug}/${review.code}/conflict">
          <p class="muted">If you work with the submitter, or have any other reason this
            should not be your call, hand it back. Nobody needs to know why.</p>
          <button type="submit" class="secondary">I have a conflict of interest</button>
        </form>`}
    `,
  }));
}

function postScore(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const reviewer = reviewerFor(ctx, event);
  const review = findReview(ctx, event, reviewer, ctx.params.code);

  if (review.status === 'submitted') {
    throw badRequest('this review has already been submitted',
      'ask an organizer to reopen it if it needs changing');
  }

  const criteria = criteriaFor(ctx.db, review.plan_id);
  const finishing = ctx.fields.bool('submit_review');
  const upsert = ctx.db.prepare(
    'INSERT OR REPLACE INTO score (review_id, criterion_id, value, text_value) VALUES (?, ?, ?, ?)',
  );

  let scored = 0;
  for (const criterion of criteria) {
    const answer = ctx.fields.get(criterion.slug);
    if (answer === '') continue;

    if (criterion.field_type === 'number') {
      const value = Number(answer);
      if (!Number.isFinite(value) || value < criterion.scale_min || value > criterion.scale_max) {
        throw badRequest(
          `'${criterion.label}' must be between ${criterion.scale_min} and ${criterion.scale_max}`,
          `got '${answer}'`);
      }
      upsert.run(review.id, criterion.id, value, '');
    } else if (criterion.field_type === 'select') {
      const choices = String(criterion.choices).split(',').map((c) => c.trim()).filter(Boolean);
      if (!choices.includes(answer)) {
        throw badRequest(`'${criterion.label}' must be one of: ${choices.join(', ')}`,
          `got '${answer}'`);
      }
      // Stored as text and deliberately not as a number: averaging "Accept"
      // with a 4 would be arithmetic on a word.
      upsert.run(review.id, criterion.id, 0, answer);
    } else {
      upsert.run(review.id, criterion.id, 0, answer);
    }
    scored++;
  }

  // Submitting with criteria missing produces an average that silently means
  // something different from everyone else's. Refuse, and say which are missing.
  if (finishing && scored < criteria.length) {
    const missing = criteria
      .filter((c) => ctx.fields.get(c.slug) === '')
      .map((c) => c.label);
    throw badRequest(`score every criterion before submitting: ${missing.join(', ')} missing`,
      'or use "Save and come back later" to keep a partial review');
  }

  ctx.db.prepare(
    `UPDATE review SET comment = ?, status = ?, submitted_at = ? WHERE id = ?`,
  ).run(
    ctx.fields.get('comment'),
    finishing ? 'submitted' : 'in_progress',
    finishing ? now() : null,
    review.id,
  );

  return finishing
    ? redirect(`/review/${event.slug}`)
    : redirect(`/review/${event.slug}/${review.code}?saved=1`);
}

function postConflict(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const reviewer = reviewerFor(ctx, event);
  const review = findReview(ctx, event, reviewer, ctx.params.code);

  // Any scores already entered go with it. A declared conflict means the
  // opinion should not count, not that it should count quietly.
  ctx.db.prepare('DELETE FROM score WHERE review_id = ?').run(review.id);
  ctx.db.prepare(
    `UPDATE review SET status = 'declined', conflict_of_interest = 1, submitted_at = ? WHERE id = ?`,
  ).run(now(), review.id);

  return redirect(`/review/${event.slug}`);
}
