// Submissions: the spine of the product.
//
// A submission and a session are the same row at different points in its life.
// Nothing in here copies a record; acceptance advances a status and unlocks the
// scheduling columns.
//
// The two operations organizers care most about are deliberately separate:
//
//   decide()  records accept/decline. Sends nothing. Reversible, cheap, safe to
//             do in bulk while arguing about it in a meeting.
//   notify()  tells the speakers, and only then moves the queue states to their
//             final ones. Irreversible in the way that matters -- you cannot
//             unsend mail -- so it is never a side effect of anything else.
//
// See docs/DECISIONS.md D2 and D3.

import { now } from '../db.js';
import { queueEmail, getTemplate } from './mail.js';
import { assignTasksOnAccept } from './tasks.js';

export const STATUSES = [
  'draft', 'pending', 'accept_queue', 'decline_queue',
  'accepted', 'declined', 'withdrawn',
];

/** Statuses whose decision has been made but not yet communicated. */
export const QUEUED_STATUSES = ['accept_queue', 'decline_queue'];

/** Statuses that put a session on the agenda. */
export const SCHEDULABLE_STATUSES = ['accept_queue', 'accepted'];

const QUEUE_RESOLUTION = { accept_queue: 'accepted', decline_queue: 'declined' };

/**
 * Legal transitions.
 *
 * `accepted` can still fall back to `decline_queue` (and vice versa) because
 * speakers do drop out and organizers do change their minds; those paths exist
 * so the app never forces someone to edit the database by hand. What is *not*
 * here is a direct pending -> accepted edge: reaching a final state goes through
 * a queue, which is what guarantees the speaker was told.
 */
export const TRANSITIONS = {
  draft:         ['pending', 'withdrawn'],
  pending:       ['accept_queue', 'decline_queue', 'draft', 'withdrawn'],
  accept_queue:  ['accepted', 'decline_queue', 'pending', 'withdrawn'],
  decline_queue: ['declined', 'accept_queue', 'pending', 'withdrawn'],
  accepted:      ['decline_queue', 'withdrawn'],
  declined:      ['accept_queue', 'withdrawn'],
  withdrawn:     ['pending'],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export class TransitionError extends Error {
  constructor(from, to) {
    super(
      `cannot move a submission from '${from}' to '${to}'. ` +
      `Legal next statuses from '${from}': ${(TRANSITIONS[from] ?? []).join(', ') || 'none'}`,
    );
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
  }
}

// --- reading ---------------------------------------------------------------

export function getSubmission(db, eventId, code) {
  return db.prepare('SELECT * FROM submission WHERE event_id = ? AND code = ?')
    .get(eventId, code) ?? null;
}

/**
 * Claim the next session code for an event: SESS-1, SESS-2, ...
 *
 * Short and speakable, so it survives being read aloud in a programme meeting
 * and retyped into a search box.
 *
 * Backed by a counter on `event` rather than by the highest code in the table,
 * so a deleted code is retired rather than handed to the next submission. Codes
 * appear in sent email and printed programmes; reusing one points a speaker at
 * somebody else's session.
 */
export function allocateCode(db, eventId, prefix = 'SESS') {
  const { code_counter } = db.prepare(
    'UPDATE event SET code_counter = code_counter + 1 WHERE id = ? RETURNING code_counter',
  ).get(eventId);
  return `${prefix}-${code_counter}`;
}

/** What `allocateCode` would return, without claiming it. For previews. */
export function peekNextCode(db, eventId, prefix = 'SESS') {
  const row = db.prepare('SELECT code_counter FROM event WHERE id = ?').get(eventId);
  if (!row) throw new Error(`no event with id ${eventId}`);
  return `${prefix}-${row.code_counter + 1}`;
}

/**
 * Move the counter past a code that was assigned by hand.
 *
 * An import, or a migration from another system, arrives with codes already on
 * it. Without this the counter still reads zero, and the next submission
 * created through the app is handed SESS-1 again -- which either collides
 * outright or, worse, quietly reuses a code that is already in somebody's inbox.
 */
export function reserveCode(db, eventId, code, prefix = 'SESS') {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(code));
  if (!match) return;

  db.prepare('UPDATE event SET code_counter = max(code_counter, ?) WHERE id = ?')
    .run(Number(match[1]), eventId);
}

export function participantsOf(db, submissionId) {
  return db.prepare(
    `SELECT p.*, sp.role, sp.is_primary_contact
       FROM submission_participant sp JOIN person p ON p.id = sp.person_id
      WHERE sp.submission_id = ?
      ORDER BY sp.sort_order, p.last_name, p.first_name`,
  ).all(submissionId);
}

// --- writing ---------------------------------------------------------------

export function createSubmission(db, {
  eventId, title, description = '', formId = null, submittedByPersonId = null,
  trackId = null, status = 'draft', code = null,
}) {
  const t = now();

  // A hand-supplied code has to move the counter with it, or the next
  // submission created through the app is handed the same one.
  if (code) reserveCode(db, eventId, code);

  const row = db.prepare(
    `INSERT INTO submission (event_id, code, form_id, submitted_by_person_id,
                             title, description, track_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, code ?? allocateCode(db, eventId), formId, submittedByPersonId,
    title, description, trackId, status, t, t);

  logActivity(db, { eventId, actorPersonId: submittedByPersonId,
    subjectType: 'submission', subjectId: row.id, verb: 'created', detail: title });
  return row;
}

/**
 * Move a submission to a new status, refusing illegal moves.
 *
 * This is the only function that writes `submission.status`, so the state
 * machine cannot be bypassed by accident.
 */
export function setStatus(db, submissionId, to, { actorPersonId = null, detail = '' } = {}) {
  const row = db.prepare('SELECT * FROM submission WHERE id = ?').get(submissionId);
  if (!row) throw new Error(`no submission with id ${submissionId}`);
  if (row.status === to) return row;
  if (!canTransition(row.status, to)) throw new TransitionError(row.status, to);

  const t = now();
  const isDecision = to === 'accept_queue' || to === 'decline_queue';

  const updated = db.prepare(
    `UPDATE submission
        SET status = ?, updated_at = ?,
            decided_at = CASE WHEN ? THEN ? ELSE decided_at END,
            decided_by_person_id = CASE WHEN ? THEN ? ELSE decided_by_person_id END
      WHERE id = ? RETURNING *`,
  ).get(to, t, isDecision ? 1 : 0, t, isDecision ? 1 : 0, actorPersonId, submissionId);

  logActivity(db, {
    eventId: row.event_id, actorPersonId, subjectType: 'submission', subjectId: submissionId,
    verb: 'status_changed', detail: detail || `${row.status} -> ${to}`,
  });
  return updated;
}

/**
 * Record a decision without telling anybody.
 *
 * `decision` is 'accept', 'decline', or 'undecide'. Bulk-safe and reversible;
 * this is what a programme committee clicks through dozens of times.
 */
export function decide(db, submissionIds, decision, { actorPersonId = null } = {}) {
  const target = { accept: 'accept_queue', decline: 'decline_queue', undecide: 'pending' }[decision];
  if (!target) {
    throw new Error(`unknown decision '${decision}'. Use one of: accept, decline, undecide`);
  }

  const results = [];
  for (const id of submissionIds) {
    results.push(setStatus(db, id, target, { actorPersonId }));
  }
  return results;
}

/**
 * Tell the speakers, then finalise the decision.
 *
 * Only touches submissions sitting in a queue state, and that single guard is
 * what prevents double-sending: a successful notify leaves the row in a final
 * status, so calling notify again finds nothing to do.
 *
 * It deliberately does *not* also refuse rows with a `notified_at`. An organizer
 * who moves an accepted session back to `decline_queue` -- because a speaker
 * dropped out, or the committee reversed itself -- has to be able to tell them
 * about the change. `notified_at` records when we last wrote to them, not
 * whether we are permitted to write again.
 *
 * Returns a per-submission report so the caller can show "24 notified, 2
 * skipped, and here is which" instead of a bare success.
 */
export function notify(db, submissionIds, { actorPersonId = null, portalUrlFor } = {}) {
  const report = [];

  for (const id of submissionIds) {
    const sub = db.prepare('SELECT * FROM submission WHERE id = ?').get(id);
    if (!sub) { report.push({ id, skipped: 'no such submission' }); continue; }

    const finalStatus = QUEUE_RESOLUTION[sub.status];
    if (!finalStatus) {
      report.push({ id, code: sub.code, skipped: `status is '${sub.status}', not a decision queue` });
      continue;
    }
    const event = db.prepare('SELECT * FROM event WHERE id = ?').get(sub.event_id);
    const people = participantsOf(db, id);
    const template = getTemplate(db, sub.event_id,
      finalStatus === 'accepted' ? 'decision_accepted' : 'decision_declined');

    for (const person of people) {
      queueEmail(db, {
        eventId: sub.event_id,
        to: person,
        subject: template.subject,
        body: template.body,
        kind: 'decision',
        templateSlug: finalStatus === 'accepted' ? 'decision_accepted' : 'decision_declined',
        submissionId: id,
        vars: {
          event_name: event.name,
          submission_title: sub.title,
          submission_code: sub.code,
          portal_url: portalUrlFor ? portalUrlFor(person, event) : '',
        },
      });
    }

    setStatus(db, id, finalStatus, { actorPersonId, detail: 'notified' });
    db.prepare('UPDATE submission SET notified_at = ? WHERE id = ?').run(now(), id);

    // The handoff the customer marked "make sure this works": the moment a
    // speaker is told they are in, the work they owe is already waiting for
    // them in the portal. Nothing is re-keyed and nobody has to remember.
    const assigned = finalStatus === 'accepted' ? assignTasksOnAccept(db, id) : 0;

    logActivity(db, { eventId: sub.event_id, actorPersonId, subjectType: 'submission',
      subjectId: id, verb: 'notified', detail: finalStatus });

    report.push({ id, code: sub.code, notified: people.length, status: finalStatus, tasksAssigned: assigned });
  }

  return report;
}

/**
 * Tell a submitter we have their proposal.
 *
 * This belongs to the transition, not to the door somebody came in through. A
 * proposal stops being a draft in two places -- a form filled in one sitting
 * (routes/public.js) and a draft finished later in the portal
 * (routes/portal.js) -- and for a long time only the first of them sent
 * anything. Save a draft on Friday, submit it on Sunday, and you received no
 * receipt at all: no reference code, no portal link, no evidence we had it.
 * The customer annotated this requirement "must have".
 *
 * Nothing about it is decided by the caller. The form's own
 * `send_confirmation_email` flag and custom body are read here, and the
 * recipient is the person the submission is filed under, so the two paths
 * cannot drift apart again the way they already did once.
 *
 * `portalUrlFor` matches notify(): core does not mint magic links or know the
 * origin, so the route hands in a way to build the URL. Omit it and the mail
 * still goes, without a link.
 */
export function confirmSubmission(db, submissionId, { portalUrlFor } = {}) {
  const sub = db.prepare('SELECT * FROM submission WHERE id = ?').get(submissionId);
  if (!sub) return null;

  const form = db.prepare('SELECT * FROM form WHERE id = ?').get(sub.form_id);
  if (form && !form.send_confirmation_email) return null;

  const event = db.prepare('SELECT * FROM event WHERE id = ?').get(sub.event_id);
  const person = db.prepare('SELECT * FROM person WHERE id = ?').get(sub.submitted_by_person_id);
  if (!person) return null;

  const template = getTemplate(db, sub.event_id, 'submission_confirmation');

  return queueEmail(db, {
    eventId: sub.event_id,
    to: person,
    subject: template.subject,
    body: form?.confirmation_email_body || template.body,
    kind: 'submission_confirmation',
    templateSlug: 'submission_confirmation',
    submissionId: sub.id,
    vars: {
      event_name: event.name,
      submission_title: sub.title,
      submission_code: sub.code,
      portal_url: portalUrlFor ? portalUrlFor(person, event) : '',
    },
  });
}

/** Everything still waiting on a human decision. */
export function pendingDecisions(db, eventId) {
  return db.prepare(
    `SELECT * FROM submission WHERE event_id = ? AND status = 'pending' ORDER BY created_at`,
  ).all(eventId);
}

/** Decided but not yet told -- the batch the notify screen operates on. */
export function awaitingNotification(db, eventId) {
  return db.prepare(
    `SELECT * FROM submission
      WHERE event_id = ? AND status IN ('accept_queue', 'decline_queue') AND notified_at IS NULL
      ORDER BY status, code`,
  ).all(eventId);
}

export function logActivity(db, { eventId, actorPersonId = null, subjectType, subjectId, verb, detail = '' }) {
  db.prepare(
    `INSERT INTO activity (event_id, actor_person_id, subject_type, subject_id, verb, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, actorPersonId, subjectType, subjectId, verb, detail, now());
}
