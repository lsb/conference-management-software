// Speaker onboarding tasks, and the reminder engine that chases them.
//
// A `task_definition` is the organizer's template ("upload your slides, due
// October 1"). A `task_instance` is one person's copy of it. Everything the
// speaker portal shows and everything the dashboard counts reads instances.

import { now } from '../db.js';
import { queueEmail, getTemplate } from './mail.js';

/**
 * Create task instances for a submission that has just been accepted.
 *
 * Returns how many instances were created. Safe to call twice, and safe to call
 * for a second session by the same speaker: two unique indexes cover the two
 * shapes of task, so a retried notification never doubles anyone's to-do list
 * and a speaker with three accepted talks still owes exactly one headshot.
 * (The person-level case needs its own partial index -- see migration 003 --
 * because a NULL submission_id does not compare equal to another NULL.)
 *
 * Two shapes of task, assigned differently:
 *
 *   applies_to = 'person'     one per accepted speaker. Things a human owes
 *                             regardless of how many talks they are giving:
 *                             a bio, a headshot, a signed agreement.
 *
 *   applies_to = 'submission' one per session, assigned to the primary contact
 *                             only. Slides get uploaded once; giving every
 *                             co-speaker their own copy of the task would make
 *                             the "who still owes what" dashboard lie about how
 *                             much work is actually outstanding.
 */
export function assignTasksOnAccept(db, submissionId) {
  const sub = db.prepare('SELECT * FROM submission WHERE id = ?').get(submissionId);
  if (!sub) throw new Error(`no submission with id ${submissionId}`);

  const definitions = db.prepare(
    `SELECT * FROM task_definition WHERE event_id = ? AND assign_when = 'on_accept' ORDER BY sort_order`,
  ).all(sub.event_id);
  if (definitions.length === 0) return 0;

  const speakers = db.prepare(
    `SELECT p.id, sp.is_primary_contact, sp.sort_order
       FROM submission_participant sp JOIN person p ON p.id = sp.person_id
      WHERE sp.submission_id = ?
      ORDER BY sp.sort_order`,
  ).all(submissionId);
  if (speakers.length === 0) return 0;

  const primary = speakers.find((s) => s.is_primary_contact) ?? speakers[0];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO task_instance (definition_id, person_id, submission_id, status, created_at)
     VALUES (?, ?, ?, 'todo', ?)`,
  );

  let created = 0;
  const t = now();
  for (const def of definitions) {
    const targets = def.applies_to === 'person'
      ? speakers.map((s) => ({ personId: s.id, submissionId: null }))
      : [{ personId: primary.id, submissionId }];

    for (const target of targets) {
      created += insert.run(def.id, target.personId, target.submissionId, t).changes;
    }
  }
  return created;
}

/**
 * Everyone who still owes something, with what and when.
 *
 * This one query backs both the organizer dashboard ("2 accepted speakers are
 * missing a bio or headshot") and the reminder engine, so the two can never
 * disagree about who is behind.
 */
export function outstandingTasks(db, eventId, { personId = null } = {}) {
  return db.prepare(
    `SELECT ti.id, ti.status, ti.submission_id, ti.person_id,
            td.slug AS task_slug, td.title AS task_title, td.due_at, td.required,
            td.applies_to, td.requirement,
            p.slug AS person_slug, p.email, p.first_name, p.last_name,
            s.code AS submission_code, s.title AS submission_title
       FROM task_instance ti
       JOIN task_definition td ON td.id = ti.definition_id
       JOIN person p ON p.id = ti.person_id
       LEFT JOIN submission s ON s.id = ti.submission_id
      WHERE td.event_id = ? AND ti.status = 'todo'
        AND (? IS NULL OR ti.person_id = ?)
      ORDER BY td.due_at IS NULL, td.due_at, p.last_name, p.first_name`,
  ).all(eventId, personId, personId);
}

/** Mark a task done. `fileId` is required when the task is a file upload. */
export function completeTask(db, taskInstanceId, { fileId = null } = {}) {
  const instance = db.prepare(
    `SELECT ti.*, td.requirement, td.title
       FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
      WHERE ti.id = ?`,
  ).get(taskInstanceId);
  if (!instance) throw new Error(`no task instance with id ${taskInstanceId}`);

  if (instance.requirement === 'file' && !fileId) {
    throw new Error(`task '${instance.title}' requires a file upload before it can be completed`);
  }

  return db.prepare(
    `UPDATE task_instance SET status = 'done', completed_at = ?, file_id = COALESCE(?, file_id)
      WHERE id = ? RETURNING *`,
  ).get(now(), fileId, taskInstanceId);
}

// --- the reminder engine ---------------------------------------------------

/**
 * When to nag, relative to a task's due date.
 *
 * Deliberately short. The complaint that makes organizers buy software like this
 * is chasing people by hand; the complaint that makes speakers hate it is being
 * nagged daily. Three touches and then silence.
 */
export const REMINDER_RULES = [
  { rule: 'due_in_7_days', offsetDays: -7 },
  { rule: 'due_in_1_day',  offsetDays: -1 },
  { rule: 'overdue_by_1_day', offsetDays: 1 },
];

/**
 * Queue reminders for every outstanding task that has crossed a rule's
 * threshold and has not already been reminded under that rule.
 *
 * Sends to exactly the people who have not finished -- the entire point of the
 * feature. Idempotent via `reminder_log`, so running it hourly, or twice by
 * accident, mails nobody twice.
 *
 * `asOf` is injectable so tests can travel in time instead of sleeping.
 */
export function runReminders(db, eventId, { asOf = now(), portalUrlFor, dryRun = false } = {}) {
  const event = db.prepare('SELECT * FROM event WHERE id = ?').get(eventId);
  if (!event) throw new Error(`no event with id ${eventId}`);

  const template = getTemplate(db, eventId, 'task_reminder');
  const asOfMs = Date.parse(asOf);
  const queued = [];

  const alreadySent = db.prepare(
    'SELECT 1 FROM reminder_log WHERE task_instance_id = ? AND rule = ?',
  );
  const recordSent = db.prepare(
    'INSERT INTO reminder_log (task_instance_id, rule, sent_at) VALUES (?, ?, ?)',
  );

  for (const task of outstandingTasks(db, eventId)) {
    if (!task.due_at || !task.required) continue;
    const dueMs = Date.parse(task.due_at);
    if (Number.isNaN(dueMs)) continue;

    for (const { rule, offsetDays } of REMINDER_RULES) {
      const threshold = dueMs + offsetDays * 86_400_000;
      if (asOfMs < threshold) continue;
      if (alreadySent.get(task.id, rule)) continue;

      if (!dryRun) {
        queueEmail(db, {
          eventId,
          to: { id: task.person_id, email: task.email,
            first_name: task.first_name, last_name: task.last_name },
          subject: template.subject,
          body: template.body,
          kind: 'task_reminder',
          templateSlug: 'task_reminder',
          submissionId: task.submission_id,
          taskInstanceId: task.id,
          vars: {
            event_name: event.name,
            task_title: task.task_title,
            task_due: task.due_at,
            submission_code: task.submission_code ?? '',
            submission_title: task.submission_title ?? '',
            portal_url: portalUrlFor ? portalUrlFor({ id: task.person_id, slug: task.person_slug }, event) : '',
          },
        });
        recordSent.run(task.id, rule, asOf);
      }

      queued.push({ taskInstanceId: task.id, rule, email: task.email, task: task.task_title });
      break; // at most one reminder per task per run
    }
  }

  return queued;
}
