// The JSON API.
//
// Every organizer page has a twin here. Two rules make it usable by something
// that has never seen it before:
//
//   1. Records are addressed by slug and session code, never by integer id.
//      Integer ids are not in the responses at all, so there is nothing to
//      accidentally quote back at us.
//   2. Errors say what to do next. See `HttpError`.

import { json, badRequest } from '../http/router.js';
import { decide, notify, awaitingNotification, participantsOf } from '../core/submissions.js';
import { outstandingTasks, runReminders } from '../core/tasks.js';
import { findConflicts, scheduledSessions, unscheduledSessions } from '../core/schedule.js';
import { createMagicLink } from '../core/auth.js';
import { findEvent, findSubmission, requireOrganizer, statusCounts, STATUS_TABS, fullName } from './shared.js';

export function mountApi(router) {
  router.get('/api/events', listEvents,
    'Every event, newest first.');

  router.get('/api/events/:event', getEvent,
    'One event, with submission counts by status.');

  router.get('/api/events/:event/submissions', listSubmissions,
    'Submissions. ?status=pending|accept_queue|decline_queue|accepted|declined|withdrawn|draft, ?q=text, ?track=slug.');

  router.get('/api/events/:event/submissions/:code', getSubmission,
    'One submission by code, with speakers, reviews, and schedule.');

  router.post('/api/events/:event/submissions/:code/decide', decideOne,
    'Body: {"decision":"accept"|"decline"|"undecide"}. Records the decision. Sends nothing.');

  router.post('/api/events/:event/decide', decideMany,
    'Body: {"codes":["SESS-1","SESS-2"],"decision":"accept"}. Bulk version. Sends nothing.');

  router.get('/api/events/:event/notify', listNotifiable,
    'Submissions decided but not yet told: exactly what POST /notify would send.');

  router.post('/api/events/:event/notify', notifyMany,
    'Body: {"codes":["SESS-1"]}. Emails the speakers and finalises those statuses.');

  router.get('/api/events/:event/agenda', getAgenda,
    'Scheduled sessions, plus the accepted ones still missing a slot.');

  router.get('/api/events/:event/conflicts', getConflicts,
    'Speaker double-bookings, room clashes, and track collisions.');

  router.get('/api/events/:event/speakers', listSpeakers,
    'Accepted speakers, with what each still owes.');

  router.get('/api/events/:event/tasks', listTasks,
    'Outstanding speaker tasks. ?person=slug to narrow to one.');

  router.post('/api/events/:event/reminders', postReminders,
    'Queue reminder emails. Body: {"dry_run":true} to preview without sending.');

  router.get('/api/events/:event/outbox', listOutbox,
    'Messages generated for this event, newest first.');
}

// --- shaping ---------------------------------------------------------------

const eventShape = (e) => ({
  slug: e.slug,
  name: e.name,
  type: e.event_type,
  location: e.location,
  timezone: e.timezone,
  starts_at: e.starts_at,
  ends_at: e.ends_at,
  website_url: e.website_url || undefined,
});

const personShape = (p) => ({
  slug: p.slug,
  name: fullName(p),
  email: p.email,
  role: p.role,
  primary_contact: p.is_primary_contact ? true : undefined,
});

function submissionShape(db, s) {
  return {
    code: s.code,
    title: s.title,
    status: s.status,
    track: s.track_slug ?? null,
    format: s.format_label ?? null,
    speakers: participantsOf(db, s.id).map((p) => ({ slug: p.slug, name: fullName(p) })),
    decided_at: s.decided_at,
    notified_at: s.notified_at,
    scheduled: s.starts_at ? { room: s.room_slug ?? null, starts_at: s.starts_at, ends_at: s.ends_at } : null,
    published: Boolean(s.published),
  };
}

const SUBMISSION_SELECT = `
  SELECT s.*, t.slug AS track_slug, r.slug AS room_slug, o.label AS format_label
    FROM submission s
    LEFT JOIN track t ON t.id = s.track_id
    LEFT JOIN room r ON r.id = s.room_id
    LEFT JOIN taxonomy_option o ON o.id = s.format_option_id`;

// --- handlers --------------------------------------------------------------

function listEvents(ctx) {
  const events = ctx.db.prepare('SELECT * FROM event ORDER BY starts_at DESC').all();
  return json({ events: events.map(eventShape) });
}

function getEvent(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  return json({
    ...eventShape(event),
    submissions: statusCounts(ctx.db, event.id),
    conflicts: findConflicts(ctx.db, event.id).length,
    outstanding_tasks: outstandingTasks(ctx.db, event.id).length,
  });
}

function listSubmissions(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const where = ['s.event_id = ?'];
  const args = [event.id];

  const status = ctx.query.get('status');
  if (status) {
    if (!STATUS_TABS.includes(status)) {
      throw badRequest(`unknown status '${status}'`, `use one of: ${STATUS_TABS.join(', ')}`);
    }
    where.push('s.status = ?');
    args.push(status);
  }

  const track = ctx.query.get('track');
  if (track) { where.push('t.slug = ?'); args.push(track); }

  const q = ctx.query.get('q');
  if (q) { where.push('(s.title LIKE ? OR s.description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }

  const rows = ctx.db.prepare(`${SUBMISSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.code`)
    .all(...args);

  return json({
    event: event.slug,
    count: rows.length,
    submissions: rows.map((s) => submissionShape(ctx.db, s)),
  });
}

function getSubmission(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const found = findSubmission(ctx.db, event.id, ctx.params.code);
  const s = ctx.db.prepare(`${SUBMISSION_SELECT} WHERE s.id = ?`).get(found.id);

  const reviews = ctx.db.prepare(
    `SELECT rv.status, rv.source, rv.comment, p.slug AS reviewer,
            (SELECT round(avg(value), 2) FROM score WHERE review_id = rv.id) AS score
       FROM review rv JOIN person p ON p.id = rv.reviewer_person_id
      WHERE rv.submission_id = ?`,
  ).all(found.id);

  const answers = ctx.db.prepare(
    `SELECT ff.slug, ff.label, sa.value FROM submission_answer sa
       JOIN form_field ff ON ff.id = sa.field_id WHERE sa.submission_id = ?`,
  ).all(found.id);

  return json({
    ...submissionShape(ctx.db, s),
    description: s.description,
    speakers: participantsOf(ctx.db, found.id).map(personShape),
    answers: Object.fromEntries(answers.map((a) => [a.slug, a.value])),
    reviews,
    average_score: reviews.filter((r) => r.score != null).length
      ? Number((reviews.reduce((sum, r) => sum + (r.score ?? 0), 0)
        / reviews.filter((r) => r.score != null).length).toFixed(2))
      : null,
  });
}

function decideOne(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const submission = findSubmission(ctx.db, event.id, ctx.params.code);
  const decision = ctx.fields.choice('decision', ['accept', 'decline', 'undecide']);

  decide(ctx.db, [submission.id], decision, { actorPersonId: ctx.person?.id ?? null });
  const after = ctx.db.prepare(`${SUBMISSION_SELECT} WHERE s.id = ?`).get(submission.id);

  return json({
    ...submissionShape(ctx.db, after),
    note: 'Decision recorded. No email has been sent. '
      + `POST /api/events/${event.slug}/notify with {"codes":["${submission.code}"]} to tell the speakers.`,
  });
}

function decideMany(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const codes = ctx.fields.list('codes');
  if (codes.length === 0) throw badRequest('no codes given', 'body: {"codes":["SESS-1"],"decision":"accept"}');
  const decision = ctx.fields.choice('decision', ['accept', 'decline', 'undecide']);

  const ids = codes.map((code) => findSubmission(ctx.db, event.id, code).id);
  decide(ctx.db, ids, decision, { actorPersonId: ctx.person?.id ?? null });

  return json({
    decided: codes.length,
    decision,
    codes,
    note: 'No email has been sent. Use POST /notify to tell the speakers.',
  });
}

function listNotifiable(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const queued = awaitingNotification(ctx.db, event.id);

  return json({
    event: event.slug,
    count: queued.length,
    submissions: queued.map((s) => ({
      code: s.code,
      title: s.title,
      decision: s.status === 'accept_queue' ? 'accept' : 'decline',
      speakers: participantsOf(ctx.db, s.id).map((p) => fullName(p)),
    })),
  });
}

function notifyMany(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const codes = ctx.fields.has('codes')
    ? ctx.fields.list('codes')
    : awaitingNotification(ctx.db, event.id).map((s) => s.code);

  if (codes.length === 0) {
    throw badRequest('nothing to notify',
      `no submissions are waiting. GET /api/events/${event.slug}/notify to check.`);
  }

  const ids = codes.map((code) => findSubmission(ctx.db, event.id, code).id);
  const base = ctx.headers?.host ? `http://${ctx.headers.host}` : 'http://127.0.0.1:8080';

  const report = notify(ctx.db, ids, {
    actorPersonId: ctx.person?.id ?? null,
    portalUrlFor: (person) =>
      `${base}/portal/${event.slug}/enter?token=${createMagicLink(ctx.db, person.id, event.id)}`,
  });

  return json({
    notified: report.filter((r) => !r.skipped).length,
    skipped: report.filter((r) => r.skipped).length,
    results: report,
  });
}

function getAgenda(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const sessions = scheduledSessions(ctx.db, event.id);

  return json({
    event: event.slug,
    timezone: event.timezone,
    scheduled: sessions.map((s) => ({
      code: s.code, title: s.title, room: s.room_slug, track: s.track_slug,
      starts_at: s.starts_at, ends_at: s.ends_at, published: Boolean(s.published),
    })),
    unscheduled: unscheduledSessions(ctx.db, event.id).map((s) => ({ code: s.code, title: s.title })),
  });
}

function getConflicts(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const conflicts = findConflicts(ctx.db, event.id);
  return json({
    event: event.slug,
    count: conflicts.length,
    errors: conflicts.filter((c) => c.severity === 'error').length,
    warnings: conflicts.filter((c) => c.severity === 'warning').length,
    conflicts,
  });
}

function listSpeakers(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const rows = ctx.db.prepare(
    `SELECT p.*, group_concat(DISTINCT s.code) AS codes,
            (SELECT count(*) FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
              WHERE ti.person_id = p.id AND td.event_id = ? AND ti.status = 'todo') AS todo
       FROM person p
       JOIN submission_participant sp ON sp.person_id = p.id
       JOIN submission s ON s.id = sp.submission_id
      WHERE s.event_id = ? AND s.status IN ('accept_queue','accepted')
      GROUP BY p.id ORDER BY p.last_name, p.first_name`,
  ).all(event.id, event.id);

  return json({
    event: event.slug,
    count: rows.length,
    speakers: rows.map((p) => ({
      slug: p.slug,
      name: fullName(p),
      email: p.email,
      sessions: (p.codes ?? '').split(',').filter(Boolean),
      has_bio: Boolean(p.biography),
      has_headshot: Boolean(p.headshot_file_id),
      outstanding_tasks: p.todo,
    })),
  });
}

function listTasks(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const personSlug = ctx.query.get('person');
  let personId = null;
  if (personSlug) {
    const person = ctx.db.prepare('SELECT id FROM person WHERE slug = ?').get(personSlug);
    if (!person) throw badRequest(`no person with slug '${personSlug}'`,
      `list them at /api/events/${event.slug}/speakers`);
    personId = person.id;
  }

  const tasks = outstandingTasks(ctx.db, event.id, { personId });
  return json({
    event: event.slug,
    count: tasks.length,
    tasks: tasks.map((t) => ({
      task: t.task_slug,
      title: t.task_title,
      person: t.person_slug,
      name: `${t.first_name} ${t.last_name}`.trim(),
      email: t.email,
      submission: t.submission_code ?? null,
      due_at: t.due_at,
      required: Boolean(t.required),
    })),
  });
}

function postReminders(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const dryRun = ctx.fields.bool('dry_run');
  const base = ctx.headers?.host ? `http://${ctx.headers.host}` : 'http://127.0.0.1:8080';

  const queued = runReminders(ctx.db, event.id, {
    dryRun,
    portalUrlFor: (person) =>
      `${base}/portal/${event.slug}/enter?token=${createMagicLink(ctx.db, person.id, event.id)}`,
  });

  return json({ dry_run: dryRun, count: queued.length, reminders: queued });
}

function listOutbox(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const rows = ctx.db.prepare(
    `SELECT o.*, s.code AS submission_code FROM outbox o
       LEFT JOIN submission s ON s.id = o.submission_id
      WHERE o.event_id = ? ORDER BY o.id DESC LIMIT 200`,
  ).all(event.id);

  return json({
    event: event.slug,
    count: rows.length,
    messages: rows.map((m) => ({
      to: m.to_email,
      subject: m.subject,
      kind: m.kind,
      submission: m.submission_code ?? null,
      created_at: m.created_at,
      delivered: Boolean(m.sent_at),
    })),
  });
}
