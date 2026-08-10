// Category-based routing: where a proposal goes, decided by what it says.
//
// A rule is (form, source field, comparison, action). When a submission arrives
// through a form, the rules on that form are tried in order and the FIRST match
// wins -- see the long note in src/migrations/010_form_routing.sql for why that
// rather than applying every match.
//
// Two actions, deliberately no more:
//
//   plan   put the submission in front of a review round's reviewer pool, by
//          creating `review` rows exactly as the Assign screen does. Routing
//          feeds the evaluation machinery that already exists; it does not have
//          its own idea of who reviews what.
//   track  set the submission's track.
//
// Everything routing does is written down. A submission that matched nothing,
// or matched a rule whose action could not be carried out, leaves a row in
// `submission_routing` saying so, because the failure mode that costs a
// conference real money is the one nobody notices until a reviewer opens an
// empty queue.

import { now } from '../db.js';
import { logActivity } from './submissions.js';

/**
 * How a rule compares an answer.
 *
 * `needsValue` is false for the two operators that ask about the presence of an
 * answer rather than its content; asking for a comparison value there would be
 * a box with nothing to put in it.
 */
export const OPERATORS = [
  { value: 'equals', label: 'is', needsValue: true },
  { value: 'not_equals', label: 'is not', needsValue: true },
  { value: 'includes', label: 'includes', needsValue: true },
  { value: 'is_present', label: 'is answered at all', needsValue: false },
  { value: 'is_blank', label: 'is left blank', needsValue: false },
];

export function operatorLabel(operator) {
  return OPERATORS.find((o) => o.value === operator)?.label ?? operator;
}

export function needsValue(operator) {
  return OPERATORS.find((o) => o.value === operator)?.needsValue ?? true;
}

/**
 * Does an answer satisfy a comparison?
 *
 * The one implementation, used both by conditional logic (which decides whether
 * a question is asked) and by routing (which decides where the answer goes).
 * They are the same question asked on opposite sides of the submit button, and
 * an organizer who learns what `includes` means in one place is entitled to be
 * right about it in the other.
 *
 * `includes` splits on commas because that is how a multiselect answer arrives.
 */
export function matches(operator, actual, want) {
  const value = String(actual ?? '');
  switch (operator) {
    case 'equals': return value === want;
    case 'not_equals': return value !== want;
    case 'includes': return value.split(',').map((v) => v.trim()).includes(want);
    case 'is_blank': return value === '';
    case 'is_present': return value !== '';
    default: return false;
  }
}

// --- reading ---------------------------------------------------------------

/** A form's rules, in the order they are tried, with everything needed to describe one. */
export function rulesFor(db, formId) {
  return db.prepare(
    `SELECT r.*,
            f.slug AS field_slug, f.label AS field_label, f.maps_to AS field_maps_to,
            f.field_type AS field_type, f.options_kind AS field_options_kind,
            p.slug AS plan_slug, p.name AS plan_name,
            t.slug AS track_slug, t.name AS track_name,
            (SELECT count(*) FROM plan_reviewer pr WHERE pr.plan_id = r.plan_id) AS plan_pool
       FROM form_routing_rule r
       JOIN form_field f ON f.id = r.field_id
       LEFT JOIN evaluation_plan p ON p.id = r.plan_id
       LEFT JOIN track t ON t.id = r.track_id
      WHERE r.form_id = ?
      ORDER BY r.sort_order, r.id`,
  ).all(formId);
}

/** What routing did to one submission, newest first. */
export function routingFor(db, submissionId) {
  return db.prepare(
    'SELECT * FROM submission_routing WHERE submission_id = ? ORDER BY id DESC',
  ).all(submissionId);
}

/** What routing has been doing on one form lately, newest first. */
export function recentRouting(db, formId, { limit = 10 } = {}) {
  return db.prepare(
    `SELECT sr.*, s.code, s.title
       FROM submission_routing sr
       JOIN submission s ON s.id = sr.submission_id
      WHERE sr.form_id = ? ORDER BY sr.id DESC LIMIT ?`,
  ).all(formId, limit);
}

/**
 * The answer a rule reads, taken from the saved submission rather than from the
 * request that created it.
 *
 * Reading storage is what lets anything call `routeSubmission` -- the public
 * form, a draft being submitted later from the portal, an organizer re-running
 * it -- and get the same answer. It is the same mapping `answersFor()` in
 * src/routes/formfields.js uses to fill in an editor, narrowed to one field.
 */
function answerOfRule(db, submission, rule) {
  switch (rule.field_maps_to) {
    case 'submission.title': return submission.title ?? '';
    case 'submission.description': return submission.description ?? '';
    case 'submission.track_id':
      return slugOf(db, 'track', submission.track_id);
    case 'submission.format_option_id':
      return slugOf(db, 'taxonomy_option', submission.format_option_id);
    case 'submission.level_option_id':
      return slugOf(db, 'taxonomy_option', submission.level_option_id);
    case 'submission.language_option_id':
      return slugOf(db, 'taxonomy_option', submission.language_option_id);
    default:
      return db.prepare(
        'SELECT value FROM submission_answer WHERE submission_id = ? AND field_id = ?',
      ).get(submission.id, rule.field_id)?.value ?? '';
  }
}

function slugOf(db, table, id) {
  if (!id) return '';
  return db.prepare(`SELECT slug FROM ${table} WHERE id = ?`).get(id)?.slug ?? '';
}

/** "Track is retrieval", for the audit line and the screen. */
export function describeRule(rule) {
  const comparison = needsValue(rule.operator)
    ? `${operatorLabel(rule.operator)} ${rule.value}`
    : operatorLabel(rule.operator);
  return `${rule.field_label} ${comparison}`;
}

// --- writing ---------------------------------------------------------------

/**
 * Put one submission in front of a review round's pool.
 *
 * Same rules as the Assign screen's auto-distribution, because it is the same
 * job: hand the next one to whoever currently has the least, never to somebody
 * speaking on it, never past the round's per-reviewer cap.
 *
 * Returns what it managed rather than throwing when it cannot finish. A pool
 * that is empty or wholly capped is an organizer problem, not a submitter one,
 * and the caller records it where an organizer will see it.
 */
export function assignToPlan(db, plan, submissionId, { wanted = 2 } = {}) {
  const pool = db.prepare(
    `SELECT p.id, p.first_name, p.last_name,
            (SELECT count(*) FROM review r WHERE r.plan_id = ? AND r.reviewer_person_id = p.id) AS assigned
       FROM plan_reviewer pr JOIN person p ON p.id = pr.person_id
      WHERE pr.plan_id = ?`,
  ).all(plan.id, plan.id);

  if (pool.length === 0) {
    return { created: 0, short: 'nobody is in its reviewer pool yet, so nothing was assigned' };
  }

  const cap = plan.max_per_reviewer ?? Infinity;
  const isAuthor = db.prepare(
    'SELECT 1 FROM submission_participant WHERE submission_id = ? AND person_id = ?');
  const already = new Set(db.prepare(
    'SELECT reviewer_person_id AS id FROM review WHERE plan_id = ? AND submission_id = ?',
  ).all(plan.id, submissionId).map((r) => r.id));

  const insert = db.prepare(
    `INSERT OR IGNORE INTO review (plan_id, submission_id, reviewer_person_id, status, assigned_at)
     VALUES (?, ?, ?, 'assigned', ?)`,
  );

  const t = now();
  let created = 0;

  while (already.size < wanted) {
    // Least-loaded first, so a volunteer committee does not end up with one
    // person carrying it. `assigned` is kept up to date in the loop, otherwise
    // every submission in a batch would go to the same least-loaded reviewer.
    const [next] = pool
      .filter((r) => !already.has(r.id) && r.assigned < cap && !isAuthor.get(submissionId, r.id))
      .sort((a, b) => a.assigned - b.assigned);
    if (!next) break;

    created += insert.run(plan.id, submissionId, next.id, t).changes;
    already.add(next.id);
    next.assigned += 1;
  }

  const short = already.size < wanted
    ? `only ${already.size} of ${wanted} reviewer(s) could be assigned; its pool has `
      + `${pool.length}, not counting anyone at the round's cap or speaking on this submission`
    : null;
  return { created, short };
}

/**
 * Route a submission: find the first rule that matches, do what it says, and
 * write down what happened.
 *
 * Never throws. A stranger's proposal must not be refused because an
 * organizer's rule points somewhere broken, so a failure is recorded against
 * the submission and the submission stands. Returns the record, or null when
 * routing did not apply at all (no form, or a form with no rules) -- which is
 * not an event worth logging, it is just a form nobody has configured.
 */
export function routeSubmission(db, submissionId, { actorPersonId = null } = {}) {
  const submission = db.prepare('SELECT * FROM submission WHERE id = ?').get(submissionId);
  if (!submission) throw new Error(`no submission with id ${submissionId}`);
  if (!submission.form_id) return null;

  const rules = rulesFor(db, submission.form_id);
  if (rules.length === 0) return null;

  try {
    const rule = rules.find((r) => matches(r.operator, answerOfRule(db, submission, r), r.value));
    if (!rule) {
      return record(db, submission, null, 'no_match',
        `no routing rule matched; ${rules.length} rule(s) were tried`, actorPersonId);
    }

    const done = [];
    const problems = [];

    if (rule.track_id) {
      db.prepare('UPDATE submission SET track_id = ?, updated_at = ? WHERE id = ?')
        .run(rule.track_id, now(), submission.id);
      done.push(`track "${rule.track_name}"`);
    }

    if (rule.plan_id) {
      const plan = db.prepare('SELECT * FROM evaluation_plan WHERE id = ?').get(rule.plan_id);
      const { created, short } = assignToPlan(db, plan, submission.id, { wanted: rule.reviewers });
      if (created > 0) done.push(`review round "${plan.name}" (${created} reviewer(s))`);
      if (short) problems.push(`Review round "${plan.name}": ${short}`);
    }

    const detail = `${describeRule(rule)} -> ${done.join(', ') || 'nothing was applied'}`
      + (problems.length ? `. ${problems.join('. ')}` : '');

    return record(db, submission, rule.id, problems.length ? 'partial' : 'routed',
      detail, actorPersonId);
  } catch (err) {
    // Recorded, not rethrown: see the note above. The submission is already
    // saved, and an organizer who reads this row knows exactly what to fix.
    return record(db, submission, null, 'failed',
      `routing raised an error and stopped: ${err.message}`, actorPersonId);
  }
}

function record(db, submission, ruleId, outcome, detail, actorPersonId) {
  const row = db.prepare(
    `INSERT INTO submission_routing (submission_id, rule_id, form_id, outcome, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(submission.id, ruleId, submission.form_id, outcome, detail, now());

  // Only a real routing decision goes in the submission's own history, which an
  // organizer reads to answer "why is this here". "Nothing matched" belongs on
  // the form, next to the rules that failed to match, and it is there.
  if (outcome !== 'no_match') {
    logActivity(db, {
      eventId: submission.event_id,
      actorPersonId,
      subjectType: 'submission',
      subjectId: submission.id,
      verb: 'routed',
      detail,
    });
  }
  return row;
}
