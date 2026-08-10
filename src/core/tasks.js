// Speaker onboarding tasks, and the reminder engine that chases them.
//
// A `task_definition` is the organizer's template ("upload your slides, due
// October 1"). A `task_instance` is one person's copy of it. Everything the
// speaker portal shows and everything the dashboard counts reads instances.

import { now, uniqueSlug } from '../db.js';
import { queueEmail, getTemplate } from './mail.js';

// --- the vocabulary --------------------------------------------------------
//
// One list per column, exported, so the screen, the command line and every
// error message name the same values. A caller who gets one wrong is told what
// would have worked, and the answer cannot drift between the two interfaces.

/**
 * Who gets a copy of the task.
 *
 * The customer's screens call these "Contact tasks" and "Submission tasks"
 * (see docs/REQUIREMENTS.md); the column has said 'person' and 'submission'
 * since 001, so the labels carry the customer's words and the values stay.
 */
export const APPLIES_TO = [
  { value: 'person', label: 'Contact task', short: 'one per speaker',
    hint: 'One copy per accepted speaker, whatever they are giving. A biography, '
      + 'a headshot, a signed agreement.' },
  { value: 'submission', label: 'Submission task', short: 'one per session',
    hint: 'One copy per accepted session, given to its primary contact. Slides, '
      + 'an AV form. Co-speakers do not each get their own copy.' },
];

/** What finishing it takes. */
export const REQUIREMENTS = [
  { value: 'acknowledge', label: 'Confirm they have done it',
    hint: 'A button in the portal. For anything you cannot collect here -- booking a hotel.' },
  { value: 'form', label: 'Fill in a form',
    hint: 'Name the form with form=<slug>.' },
  { value: 'file', label: 'Upload a file',
    hint: 'The upload lands in Files and in `conf files --zip`, tagged with this task.' },
];

/** When people get it. */
export const ASSIGN_WHEN = [
  { value: 'on_accept', label: 'As soon as a speaker is told they are in',
    hint: 'And, when you add it later, to everybody already accepted.' },
  { value: 'manual', label: 'Only when I say so',
    hint: 'Created but given to nobody until you assign it.' },
];

// --- assignment ------------------------------------------------------------

const INSERT_INSTANCE =
  `INSERT OR IGNORE INTO task_instance (definition_id, person_id, submission_id, status, created_at)
   VALUES (?, ?, ?, 'todo', ?)`;

/**
 * Give one definition to one submission's people.
 *
 * Shared by the two ways a task is handed out -- a submission being accepted,
 * and a task being created after the fact -- so the two can never disagree
 * about who owes what. `INSERT OR IGNORE` plus the two unique indexes is what
 * makes either safe to run twice.
 */
function assignOne(db, insert, definition, submissionId, t) {
  const speakers = db.prepare(
    `SELECT p.id, sp.is_primary_contact, sp.sort_order
       FROM submission_participant sp JOIN person p ON p.id = sp.person_id
      WHERE sp.submission_id = ?
      ORDER BY sp.sort_order`,
  ).all(submissionId);
  if (speakers.length === 0) return 0;

  const primary = speakers.find((s) => s.is_primary_contact) ?? speakers[0];
  const targets = definition.applies_to === 'person'
    ? speakers.map((s) => ({ personId: s.id, submissionId: null }))
    : [{ personId: primary.id, submissionId }];

  let created = 0;
  for (const target of targets) {
    created += insert.run(definition.id, target.personId, target.submissionId, t).changes;
  }
  return created;
}

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

  // A retired task is one the event has stopped collecting, so a late
  // acceptance must not be handed it.
  const definitions = db.prepare(
    `SELECT * FROM task_definition
      WHERE event_id = ? AND assign_when = 'on_accept' AND retired_at IS NULL
      ORDER BY sort_order`,
  ).all(sub.event_id);
  if (definitions.length === 0) return 0;

  const insert = db.prepare(INSERT_INSTANCE);
  const t = now();

  let created = 0;
  for (const def of definitions) created += assignOne(db, insert, def, submissionId, t);
  return created;
}

/**
 * Give one definition to everybody who is already accepted.
 *
 * THE DECISION THIS ENCODES, because it is not obvious and it is not
 * reversible by accident:
 *
 *   A task added after people have been accepted is given to them too.
 *
 * The alternative -- assign only to future acceptances -- is what most of these
 * systems do, and it is wrong here for the same reason `published = 1` was
 * wrong: it succeeds, it does nothing visible, and nobody finds out. An
 * organizer who adds "sign the AV form" in March, six weeks after the last
 * acceptance email went out, is not asking for a task that applies to nobody;
 * they are asking their speakers for an AV form. Under the other rule the
 * dashboard reads "0 outstanding", the reminder engine has nothing to chase,
 * and the first sign of trouble is an empty inbox in April.
 *
 * It is not silent in either direction: every caller reports the count back
 * ("Assigned to 12 speaker(s) who are already accepted"), and `assign_when =
 * 'manual'` is the way to say "create it, give it to nobody yet".
 *
 * "Already accepted" means status = 'accepted': the speakers have been told.
 * Sessions sitting in `accept_queue` are decided but unannounced, and they pick
 * the task up through `assignTasksOnAccept` when the notification goes out --
 * which is the same rule, applied at the same moment, for everybody.
 */
export function assignToAlreadyAccepted(db, definition) {
  if (definition.retired_at) return 0;

  const accepted = db.prepare(
    `SELECT id FROM submission WHERE event_id = ? AND status = 'accepted' ORDER BY id`,
  ).all(definition.event_id);

  const insert = db.prepare(INSERT_INSTANCE);
  const t = now();

  let created = 0;
  for (const sub of accepted) created += assignOne(db, insert, definition, sub.id, t);
  return created;
}

/**
 * Everyone who still owes something, with what and when.
 *
 * This one query backs both the organizer dashboard ("2 accepted speakers are
 * missing a bio or headshot") and the reminder engine, so the two can never
 * disagree about who is behind.
 */
export function outstandingTasks(db, eventId, { personId = null, taskSlug = null } = {}) {
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
        AND (? IS NULL OR td.slug = ?)
      ORDER BY td.due_at IS NULL, td.due_at, td.slug, p.last_name, p.first_name`,
  ).all(eventId, personId, personId, taskSlug, taskSlug);
}

/** The task definitions for an event, for anything that offers a filter. */
export function taskDefinitions(db, eventId) {
  return db.prepare(
    `SELECT slug, title, applies_to, requirement, due_at, retired_at
       FROM task_definition WHERE event_id = ? ORDER BY sort_order, slug`,
  ).all(eventId);
}

// --- managing the definitions themselves -----------------------------------

/** Every definition with how much of it is outstanding, for the editor. */
export function taskDefinitionsWithProgress(db, eventId) {
  return db.prepare(
    `SELECT td.*,
            (SELECT count(*) FROM task_instance ti
              WHERE ti.definition_id = td.id AND ti.status = 'todo') AS todo,
            (SELECT count(*) FROM task_instance ti
              WHERE ti.definition_id = td.id AND ti.status = 'done') AS done,
            (SELECT count(*) FROM task_instance ti
              WHERE ti.definition_id = td.id AND ti.status = 'waived') AS waived,
            f.slug AS form_slug, f.internal_name AS form_name
       FROM task_definition td
       LEFT JOIN form f ON f.id = td.form_id
      WHERE td.event_id = ?
      ORDER BY td.retired_at IS NOT NULL, td.sort_order, td.slug`,
  ).all(eventId);
}

export function findTaskDefinition(db, eventId, slug) {
  return db.prepare('SELECT * FROM task_definition WHERE event_id = ? AND slug = ?')
    .get(eventId, slug) ?? null;
}

/**
 * Create a definition and hand it out.
 *
 * Validation belongs to the callers, which have their own way of saying "that
 * is not one of the values" -- `badRequest` on the web, `withHint` on the
 * command line. What lives here is the part that must not differ between them:
 * the insert, the slug, and the retroactive assignment.
 */
export function createTaskDefinition(db, eventId, {
  title, slug = null, appliesTo = 'person', requirement = 'acknowledge', formId = null,
  instructions = '', dueAt = null, required = true, assignWhen = 'on_accept',
}) {
  const finalSlug = uniqueSlug(slug || title,
    (candidate) => Boolean(db.prepare('SELECT 1 FROM task_definition WHERE event_id = ? AND slug = ?')
      .get(eventId, candidate)));

  const order = db.prepare(
    'SELECT coalesce(max(sort_order), 0) + 1 AS next FROM task_definition WHERE event_id = ?',
  ).get(eventId).next;

  const definition = db.prepare(
    `INSERT INTO task_definition (event_id, slug, title, instructions, applies_to, requirement,
                                  form_id, due_at, required, assign_when, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(eventId, finalSlug, title, instructions, appliesTo, requirement, formId, dueAt,
    required ? 1 : 0, assignWhen, order);

  const assigned = assignWhen === 'on_accept' ? assignToAlreadyAccepted(db, definition) : 0;
  return { definition, assigned };
}

/**
 * Stop collecting something, without throwing away what people already did.
 *
 * Outstanding copies go, because the point of retiring is that nobody owes it
 * any more -- and leaving them would keep the dashboard counting work nobody is
 * expected to do and the reminder engine chasing it. Finished copies stay, with
 * their files and their timestamps; they are the record the delete trigger in
 * migration 012 exists to protect.
 */
export function retireTaskDefinition(db, definition) {
  const dropped = db.prepare(
    `DELETE FROM task_instance WHERE definition_id = ? AND status = 'todo'`,
  ).run(definition.id).changes;

  db.prepare('UPDATE task_definition SET retired_at = ? WHERE id = ?').run(now(), definition.id);
  return dropped;
}

/** Bring a retired task back, and give it to everybody it now applies to. */
export function restoreTaskDefinition(db, definition) {
  db.prepare('UPDATE task_definition SET retired_at = NULL WHERE id = ?').run(definition.id);
  const live = db.prepare('SELECT * FROM task_definition WHERE id = ?').get(definition.id);
  return live.assign_when === 'on_accept' ? assignToAlreadyAccepted(db, live) : 0;
}

/** How much of a definition somebody has already acted on. */
export function taskDefinitionUsage(db, definitionId) {
  return db.prepare(
    `SELECT count(*) AS total,
            sum(status = 'todo') AS todo,
            sum(status = 'done') AS done,
            sum(status = 'waived') AS waived
       FROM task_instance WHERE definition_id = ?`,
  ).get(definitionId);
}

/**
 * Swap a definition with its neighbour.
 *
 * Order is what the speaker portal and the organizer dashboard both list by, so
 * "the agreement first, the slides last" is a real preference. Rewrites the
 * whole list rather than swapping two numbers, so definitions that arrived with
 * duplicate sort_orders sort themselves out on first use.
 */
export function moveTaskDefinition(db, eventId, definition, direction) {
  // Ordered the way the editor lists them, retired ones last, so "up" moves a
  // task past the one printed above it rather than past a row nobody can see.
  const siblings = db.prepare(
    `SELECT id FROM task_definition WHERE event_id = ?
      ORDER BY retired_at IS NOT NULL, sort_order, slug`,
  ).all(eventId);

  const index = siblings.findIndex((d) => d.id === definition.id);
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= siblings.length) return false;

  const reordered = [...siblings];
  reordered[index] = siblings[swapIndex];
  reordered[swapIndex] = siblings[index];

  const update = db.prepare('UPDATE task_definition SET sort_order = ? WHERE id = ?');
  reordered.forEach((d, i) => update.run(i + 1, d.id));
  return true;
}

/** Who owes this particular thing, and who has finished it. */
export function whoOwes(db, definitionId) {
  return db.prepare(
    `SELECT ti.id, ti.status, ti.completed_at,
            p.slug AS person_slug, p.first_name, p.last_name, p.email,
            s.code AS submission_code, s.title AS submission_title
       FROM task_instance ti
       JOIN person p ON p.id = ti.person_id
       LEFT JOIN submission s ON s.id = ti.submission_id
      WHERE ti.definition_id = ?
      ORDER BY ti.status, p.last_name, p.first_name`,
  ).all(definitionId);
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
