// The JSON API.
//
// The target is that somebody with no source access and no shell can run a
// conference from here: decide, tell the speakers, schedule, chase paperwork,
// email a group, hand the website team a feed. Three rules make it usable by
// something that has never seen it before:
//
//   1. Records are addressed by slug and session code, never by integer id.
//      The single exception is an outbox message, which has no other name; see
//      `listOutbox`.
//   2. Errors say what to do next. See `HttpError`.
//   3. Anything you need before you can make the next call travels with the
//      call you already made -- room slugs on the event, task slugs on the task
//      list, message ids on the outbox. Discovering an identifier by
//      deliberately failing a request is not discovery.
//
// Read routes here are organizer-gated, including the ones that look like a
// programme. The public, cross-origin feed is an embed: /embed/<event>/<slug>.

import { json, badRequest, notFound, forbidden } from '../http/router.js';
import { decide, notify, awaitingNotification, participantsOf } from '../core/submissions.js';
import { outstandingTasks, runReminders, taskDefinitions } from '../core/tasks.js';
import { findConflicts, scheduledSessions, unscheduledSessions } from '../core/schedule.js';
import { createMagicLink, canOrganize } from '../core/auth.js';
import { audienceSizes, resolveAudience, UnknownAudienceError } from '../core/audience.js';
import { searchPeople, personHistory, notesOn, tagsOn } from '../core/crm.js';
import { findEvent, findSubmission, requireOrganizer, statusCounts, STATUS_TABS, fullName } from './shared.js';

export function mountApi(router) {
  router.get('/api/events', listEvents,
    'Every event, newest first.');

  router.get('/api/events/:event', getEvent,
    'One event: what needs attention right now as sentences with the URL that shows each, '
    + 'submission counts by status, and the slugs you have to name before you can do '
    + 'anything else -- rooms to schedule into, tracks, and review rounds to route to.');

  router.get('/api/events/:event/submissions', listSubmissions,
    'Submissions. ?status=pending|accept_queue|decline_queue|accepted|declined|withdrawn|draft, '
    + '?q=text, ?track=slug. Every reply carries by_status for the whole event, so '
    + '"how many are still waiting" is a value to read rather than rows to count; `count` is '
    + 'only how many came back.');

  router.get('/api/events/:event/submissions/:code', getSubmission,
    'One submission by code, with speakers, reviews, and schedule.');

  router.post('/api/events/:event/submissions/:code/decide', decideOne,
    'Body: {"decision":"accept"|"decline"|"undecide"}. Records the decision. Sends nothing.');

  router.post('/api/events/:event/decide', decideMany,
    'Body: {"codes":["SESS-1","SESS-2"],"decision":"accept"}. Bulk version. Sends nothing.');

  router.get('/api/events/:event/notify', listNotifiable,
    'Submissions decided but not yet told: exactly what POST /notify would send.');

  router.post('/api/events/:event/notify', notifyMany,
    'Body: {"codes":["SESS-1"]}. Emails those speakers their decision and finalises it, '
    + 'irreversibly. Refuses to guess: with neither "codes" nor {"all":true} it sends '
    + 'nothing and tells you how many are waiting.');

  router.get('/api/events/:event/agenda', getAgenda,
    'ORGANIZER view of the schedule: includes unapproved and unpublished sessions, '
    + 'and sends no CORS header, so it is not usable from another site. '
    + 'For a public feed create an embed and use /embed/<event>/<slug>.');

  router.get('/api/events/:event/conflicts', getConflicts,
    'Speaker double-bookings, room clashes, and track collisions.');

  router.get('/api/events/:event/speakers', listSpeakers,
    'Accepted speakers, with what each still owes.');

  router.get('/api/events/:event/tasks', listTasks,
    'Outstanding speaker tasks. ?task=slug for one kind (e.g. task=headshot), ?person=slug for one person.');

  router.post('/api/events/:event/reminders', postReminders,
    'Queue reminder emails. Body: {"dry_run":true} to preview without sending.');

  router.get('/api/events/:event/outbox', listOutbox,
    'Messages generated for this event, newest first. Envelopes only: no bodies here. '
    + 'What a message actually said is at /api/events/<event>/outbox/<id>, using the id in each row.');

  router.get('/api/events/:event/outbox/:id', getOutboxMessage,
    'One message in full, including the body. Ids come from the outbox list.');

  router.get('/api/events/:event/audiences', listAudiences,
    'The named groups POST /e/<event>/mail can send to, with their sizes. '
    + '?audience=<key> lists exactly who is in one, which is the dry run to do before sending; '
    + '&task=<slug> narrows outstanding-tasks to people owing one particular thing.');

  router.post('/api/events/:event/portal-links', createPortalLink,
    'Body: {"person":"yusuf-karim"}. Mints a one-time sign-in link for that speaker\'s portal. '
    + 'Anyone holding the URL is signed in as them, so it goes to them and nowhere else.');

  router.get('/api/events/:event/embeds', listEmbeds,
    'The public feeds that exist, with their URLs. Read-only: create one with '
    + 'POST /e/<event>/embeds (name, feed, format). An embed records its own format, so a JSON '
    + 'feed is one made with format=json -- adding .json to an HTML embed\'s URL converts nothing.');

  router.get('/api/events/:event/files', listFiles,
    'What speakers have uploaded. ?task=<slug> for one kind. Download one at /files/<slug>, '
    + 'or all of them at /e/<event>/files.zip.');

  router.get('/api/events/:event/reviews', listReviews,
    'Per reviewer per round: submitted, still outstanding, declined. Sorted by who is furthest behind.');

  router.get('/api/people', listPeople,
    'The speaker database, across every event, not one. ?q=, ?tag=, ?company=, '
    + '?event=<slug> for people who have spoken at one, ?never_spoken=1 for people we know '
    + 'and have never put on stage.');

  router.get('/api/people/:slug', getPerson,
    'One human everywhere they appear: every event, every submission, their tags and notes. '
    + 'This is how to answer "have we had this speaker before" in one request.');
}

// --- shaping ---------------------------------------------------------------

/** Where this instance thinks it is, for URLs a caller is meant to hand to somebody. */
const baseUrl = (ctx) => ctx.origin;

/**
 * The speaker database spans events, so there is no single event to check
 * membership against. Anybody who can organize anything may read it, which is
 * the same trust boundary `/crm` already draws around the same rows.
 */
function requireAnyOrganizer(ctx) {
  const events = ctx.db.prepare('SELECT id FROM event').all();
  if (events.some((e) => canOrganize(ctx.db, e.id, ctx.person))) return;
  throw forbidden('organizer access required',
    'scripts: send `authorization: bearer <token>` (mint one at /account). '
    + 'People: sign in at /sign-in.');
}

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

  // The `docs` line is here because of Run 9, and it is the cheapest fix in this
  // file. Every attempt in that suite began with this exact call -- it is the
  // natural entry point, and it is the one route that needs no credentials. The
  // attempts that went on to read /llms.txt passed; the ones that started
  // guessing routes from here burned their budget and failed.
  //
  // We had written a machine-readable index of the whole app for precisely that
  // reader, and the only way to find it was to already know it existed. That is
  // finding 5, and 7, and 10: a capability nobody can discover is a capability
  // nobody has. It went unnoticed because everybody who had the repository also
  // had AGENTS.md telling them where to look.
  // Two complete URLs, not one URL and an instruction to modify it.
  //
  // The first version said "Add ?all=1 for every route this app serves", and
  // readers attached ?all=1 to whatever they were holding: /api/events?all=1,
  // /api/submissions?all=1. Worse, one of them wrote it unquoted into a shell,
  // zsh globbed the `?`, the request never left the machine -- so our 404, and
  // the route suggestion built for exactly that guess, never got the chance to
  // correct it, and it invented three speakers instead.
  //
  // An instruction that induces a broken command is worse than no instruction:
  // it costs the mistake AND the chance to catch it. A whole URL gets copied
  // whole.
  // Before the data, not after it. A reader going top-down meets whatever comes
  // first and starts working from it; put the pointer underneath an array and it
  // is read, if at all, after the decisions have been made. The submission list
  // already puts `by_status` above the rows for this reason and this route was
  // not given the same treatment.
  //
  // Testable rather than obvious: if the pass rate does not move, the ordering
  // idea is wrong and should be recorded as wrong.
  // ONE pointer, to the short form. Not two.
  //
  // The first version offered `docs` and `docs_all_routes` side by side, and an
  // attempt took the second: twenty-five kilobytes of route table instead of six
  // of worked examples, then ran out of room and answered with the wrong URL.
  // Two options presented as peers, one of them four times more expensive, is an
  // invitation to pick the expensive one -- and the short form already names the
  // full list in its closing lines, for the rare caller who needs it.
  //
  // The cure for "add ?all=1" was to hand over whole URLs. The cure for that
  // turned out to need a limit on how many.
  return json({
    docs: `${ctx.origin}/llms.txt`,
    docs_note: 'How to authenticate, and a worked example of each common job. '
      + 'Read this before guessing at routes.',
    events: events.map(eventShape),
  });
}

function getEvent(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  // Counts by status say how many proposals were declined, and how many
  // decisions are sitting unannounced. Neither is public.
  requireOrganizer(ctx, event);

  // Rooms and tracks ride along rather than living at their own route. You need
  // a room slug before you can schedule anything, and this is the call you have
  // already made; a separate endpoint would be one more thing to find first.
  // There are a handful of each, so nothing is being paid for by carrying them.
  const rooms = ctx.db.prepare(
    'SELECT slug, name, capacity FROM room WHERE event_id = ? ORDER BY sort_order, name',
  ).all(event.id);
  const tracks = ctx.db.prepare(
    'SELECT slug, name FROM track WHERE event_id = ? ORDER BY sort_order, name',
  ).all(event.id);

  // Review rounds ride along for the same reason rooms do: you have to name one
  // before you can point a routing rule at it, and until now the only way to
  // learn a round's slug over HTTP was to fetch /e/<event>/evaluation and read
  // it out of the HTML. An attempt did exactly that, pulled a page of forms into
  // a context that had no room for it, and ran out of time holding the answer.
  //
  // The parity audit added JSON twins for embeds, files, reviews and people and
  // did not catch this, because routing did not exist when it ran.
  const rounds = ctx.db.prepare(
    'SELECT slug, name, round FROM evaluation_plan WHERE event_id = ? ORDER BY round, id',
  ).all(event.id);

  const counts = statusCounts(ctx.db, event.id);
  const conflicts = findConflicts(ctx.db, event.id);
  const outstanding = outstandingTasks(ctx.db, event.id);
  const unscheduled = unscheduledSessions(ctx.db, event.id);
  const queued = awaitingNotification(ctx.db, event.id);

  // Sentences, not only numbers, and this is a parity fix rather than a
  // decoration. `conf status` answers "what needs attention" in the words the
  // question is asked in -- "4 awaiting a decision" -- and the HTML dashboard
  // renders the same. The API offered `submissions.pending: 4` and left the
  // caller to know that pending means awaiting-a-decision. Asked exactly that,
  // a model picked `accepted: 6` out of the same labelled map three times
  // running (Run 9).
  //
  // Each carries the URL that shows the rows, which is the pattern
  // REQUIREMENTS.md singles out as the genuinely useful part of the dashboard:
  // a count and a link to the exact filtered list.
  const api = `${ctx.origin}/api/events/${event.slug}`;
  const needsAttention = [];
  const note = (count, text, where) => {
    if (count > 0) needsAttention.push({ count, text, where });
  };

  note(counts.pending, `${counts.pending} submission(s) awaiting a decision`,
    `${api}/submissions?status=pending`);
  note(queued.length, `${queued.length} decided but not yet told`, `${api}/notify`);
  note(unscheduled.length, `${unscheduled.length} accepted session(s) with no room or time`,
    `${api}/agenda`);
  note(conflicts.filter((c) => c.severity === 'error').length,
    `${conflicts.filter((c) => c.severity === 'error').length} scheduling conflict(s)`,
    `${api}/conflicts`);
  note(outstanding.length, `${outstanding.length} outstanding speaker task(s)`, `${api}/tasks`);

  return json({
    ...eventShape(event),
    needs_attention: needsAttention,
    submissions: counts,
    conflicts: conflicts.length,
    outstanding_tasks: outstanding.length,
    rooms: rooms.map((r) => ({ slug: r.slug, name: r.name, capacity: r.capacity ?? null })),
    tracks: tracks.map((t) => ({ slug: t.slug, name: t.name })),
    review_rounds: rounds.map((r) => ({ slug: r.slug, name: r.name, round: r.round })),
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

  // `by_status` is the whole event, not the filtered rows, so that the answer to
  // "how many are still waiting" travels with the list rather than having to be
  // counted out of it.
  //
  // A model asked exactly that fetched this route unfiltered and answered 6 from
  // a list of 19 whose true pending count was 4. Nothing in the data misled it;
  // it simply counted wrong, and `count` at the top -- which is the number of
  // rows returned -- is a plausible wrong answer sitting where an answer should
  // be. This app has been here before: `conf tasks` printed twenty rows of four
  // kinds and a reader had to filter by eye, and the fix was to let them ask the
  // question instead of scanning for it (USABILITY-LOG, finding 2).
  return json({
    event: event.slug,
    count: rows.length,
    filtered: Boolean(status || track || q) || undefined,
    by_status: statusCounts(ctx.db, event.id),
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

  // Refuses to guess, for the same reason `conf notify` does. An empty body used
  // to mean "everybody", so probing this endpoint's shape with {} sent the whole
  // decision queue -- irreversibly, and to people who had not been told anything
  // yet. That is Run 4's incident with a different verb. Saying "all" is cheap;
  // discovering you meant it afterwards is not.
  const waiting = awaitingNotification(ctx.db, event.id).map((s) => s.code);
  const wantsAll = ctx.fields.bool('all');

  if (!ctx.fields.has('codes') && !wantsAll) {
    throw badRequest(
      `refusing to guess: ${waiting.length} decision(s) are waiting to be sent`,
      `pass the ones you mean as {"codes":["SESS-1"]}, or {"all":true} if you really mean all `
      + `${waiting.length}. GET /api/events/${event.slug}/notify to see them first.`);
  }

  const codes = wantsAll && !ctx.fields.has('codes') ? waiting : ctx.fields.list('codes');

  if (codes.length === 0) {
    throw badRequest('nothing to notify',
      `no submissions are waiting. GET /api/events/${event.slug}/notify to check.`);
  }

  const ids = codes.map((code) => findSubmission(ctx.db, event.id, code).id);
  const base = baseUrl(ctx);

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
  // This route's own description calls it the ORGANIZER view, and it means it:
  // it includes sessions that are scheduled but unapproved and unpublished, so
  // to a stranger it reads as a list of acceptances the speakers have not been
  // told about. Anonymously it answered 200. The public feed is /embed/...
  requireOrganizer(ctx, event);
  const sessions = scheduledSessions(ctx.db, event.id);

  return json({
    event: event.slug,
    // Said in the reply, not only in the route's documentation.
    //
    // This route returns the programme as JSON, so it looks exactly like the
    // answer to "give the website team a JSON feed" -- and it is not one. It
    // carries sessions that are scheduled but unapproved and unannounced, and it
    // sends no CORS header, so it cannot be fetched from another site at all. A
    // model asked for a feed landed here, saw JSON of the programme, and told
    // the developer to use it.
    //
    // llms.txt has always said this. The response did not, and the response is
    // where somebody is standing when they make the mistake.
    not_a_public_feed: 'Organizer view: includes unapproved and unannounced sessions, '
      + 'and sends no CORS header, so another site cannot fetch it. To give somebody a '
      + `feed, create an embed: POST ${ctx.origin}/e/${event.slug}/embeds with `
      + 'name, feed=agenda, format=json. The reply carries the public url.',
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
  // Clashes are drawn from the same unpublished schedule as the agenda above.
  requireOrganizer(ctx, event);
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

  const definitions = taskDefinitions(ctx.db, event.id);
  const taskSlug = ctx.query.get('task');
  if (taskSlug && !definitions.some((d) => d.slug === taskSlug)) {
    throw badRequest(`no task called '${taskSlug}' at this event`,
      `tasks are: ${definitions.map((d) => d.slug).join(', ')}`);
  }

  const tasks = outstandingTasks(ctx.db, event.id, { personId, taskSlug });

  // Who owes what, per kind, and the URL that asks for one kind.
  //
  // "Which speakers have not uploaded a headshot" was answered with twenty rows
  // of four kinds, and the reader filtered by eye and missed one of six. That is
  // this repo's finding 2 for the third time: `conf tasks` did it in Run 3, the
  // submission list did it this morning, and now the JSON. Each time the answer
  // was present and each time it had to be extracted carefully.
  //
  // The remedy that worked for submissions was to put the answer in the reply
  // rather than requiring a tally, and it flipped that task from failing to
  // passing in one run. Same here: counts per kind, and -- because
  // `available_tasks` was already a bare list of slugs and evidently did not say
  // what to do with them -- a whole URL per kind, ready to copy.
  const byTask = {};
  for (const d of definitions) {
    byTask[d.slug] = outstandingTasks(ctx.db, event.id, { taskSlug: d.slug }).length;
  }

  return json({
    event: event.slug,
    count: tasks.length,
    ...(taskSlug || personId ? { filtered: true } : {
      by_task: byTask,
      narrow_to_one_kind: Object.fromEntries(definitions.map((d) => [
        d.slug, `${ctx.origin}/api/events/${event.slug}/tasks?task=${d.slug}`,
      ])),
    }),
    available_tasks: definitions.map((d) => d.slug),
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
  const base = baseUrl(ctx);

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
    // The one integer id in this whole API, and it is here on purpose. Outbox
    // rows have no slug and no code -- an email is not a record anybody names --
    // so without the id there is no way to ask for one of them, which is how
    // "the bodies are not stored anywhere" became a thing people concluded.
    messages: rows.map((m) => ({
      id: m.id,
      to: m.to_email,
      subject: m.subject,
      kind: m.kind,
      submission: m.submission_code ?? null,
      created_at: m.created_at,
      delivered: Boolean(m.sent_at),
    })),
    note: `Bodies are not in this list. GET /api/events/${event.slug}/outbox/<id> for one in full.`,
  });
}

function getOutboxMessage(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  // Decision letters and portal sign-in links are in these bodies.
  requireOrganizer(ctx, event);

  const message = ctx.db.prepare(
    `SELECT o.*, s.code AS submission_code FROM outbox o
       LEFT JOIN submission s ON s.id = o.submission_id
      WHERE o.id = ? AND o.event_id = ?`,
  ).get(Number(ctx.params.id), event.id);

  if (!message) {
    throw notFound(`no message ${ctx.params.id} in this event`,
      `ids come from GET /api/events/${event.slug}/outbox`);
  }

  return json({
    id: message.id,
    to: message.to_email,
    subject: message.subject,
    body: message.body,
    kind: message.kind,
    submission: message.submission_code ?? null,
    created_at: message.created_at,
    delivered: Boolean(message.sent_at),
    // A decision email carries the calendar invite on the same row, and "what
    // did we actually send them" includes it.
    ...(message.ics_body ? { calendar: message.ics_body } : {}),
  });
}

function listAudiences(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  // Who is in 'declined-submitters' is a decision list by another name.
  requireOrganizer(ctx, event);

  const key = ctx.query.get('audience');
  const taskSlug = ctx.query.get('task') || null;

  if (!key) {
    const audiences = audienceSizes(ctx.db, event.id);
    return json({
      event: event.slug,
      count: audiences.length,
      audiences,
      note: 'Add ?audience=<key> to see exactly who is in one before sending to it. '
        + `Sending is POST /e/${event.slug}/mail with audience, subject, body.`,
    });
  }

  let recipients;
  try {
    recipients = resolveAudience(ctx.db, event.id, key, { taskSlug });
  } catch (err) {
    if (err instanceof UnknownAudienceError) throw badRequest(err.message, err.hint);
    throw err;
  }

  return json({
    event: event.slug,
    audience: key,
    task: taskSlug,
    count: recipients.length,
    recipients: recipients.map((p) => ({ slug: p.slug, name: fullName(p), email: p.email })),
    note: 'Nothing has been sent. This is the list POST /e/<event>/mail would use.',
  });
}

/**
 * Hand somebody their way in.
 *
 * The web UI never shows a live token -- it emails one -- so before this route
 * existed the only way to get a speaker signed in over HTTP was to send them a
 * message and then read the token back out of the outbox. `conf portal-link`
 * has done this in one step all along.
 */
function createPortalLink(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  // This mints a live credential for somebody else. Nothing about it is public.
  requireOrganizer(ctx, event);

  const slug = ctx.fields.require('person',
    `body: {"person":"ada-lovelace"}. Slugs are at /api/events/${event.slug}/speakers`);
  const person = ctx.db.prepare('SELECT * FROM person WHERE slug = ?').get(slug);
  if (!person) {
    throw badRequest(`no person with slug '${slug}'`,
      `list them at /api/events/${event.slug}/speakers, or /api/people across every event`);
  }

  const token = createMagicLink(ctx.db, person.id, event.id);
  // createMagicLink hands back the token and keeps only its hash, so the expiry
  // has to be read from the row it just wrote. Whoever passes this link on needs
  // to know how long it is good for; an hour surprises people.
  const link = ctx.db.prepare(
    'SELECT expires_at FROM magic_link WHERE person_id = ? ORDER BY id DESC LIMIT 1',
  ).get(person.id);

  return json({
    person: person.slug,
    url: `${baseUrl(ctx)}/portal/${event.slug}/enter?token=${token}`,
    expires_at: link.expires_at,
    note: 'One use, then it is spent. Anyone holding this URL is signed in as this person, '
      + 'so send it to them and to nobody else.',
  });
}

function listEmbeds(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const rows = ctx.db.prepare(
    `SELECT e.*, t.slug AS track_slug FROM embed e
       LEFT JOIN track t ON t.id = e.filter_track_id
      WHERE e.event_id = ? ORDER BY e.created_at`,
  ).all(event.id);

  return json({
    event: event.slug,
    count: rows.length,
    embeds: rows.map((e) => ({
      slug: e.slug,
      name: e.name,
      feed: e.feed,
      format: e.format,
      track: e.track_slug ?? null,
      enabled: Boolean(e.enabled),
      url: `${baseUrl(ctx)}/embed/${event.slug}/${e.slug}${e.format === 'html' ? '' : `.${e.format}`}`,
    })),
    note: 'Read-only. Listing the embeds that exist is not the same as making the one you '
      + `were asked for: POST /e/${event.slug}/embeds with name, feed, format.`,
  });
}

function listFiles(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const definitions = taskDefinitions(ctx.db, event.id);
  const taskSlug = ctx.query.get('task');
  if (taskSlug && !definitions.some((d) => d.slug === taskSlug)) {
    throw badRequest(`no task called '${taskSlug}' at this event`,
      definitions.length ? `tasks are: ${definitions.map((d) => d.slug).join(', ')}`
        : 'this event has no tasks');
  }

  // The same query `conf files` runs, superseded uploads excluded, so the two
  // surfaces cannot disagree about which version of a deck is the current one.
  const rows = ctx.db.prepare(
    `SELECT f.slug, f.filename, f.content_type, f.byte_size, f.created_at,
            p.slug AS person_slug, p.first_name, p.last_name,
            td.slug AS task, s.code AS submission
       FROM file f
       LEFT JOIN person p ON p.id = f.uploaded_by_person_id
       LEFT JOIN task_instance ti ON ti.file_id = f.id
       LEFT JOIN task_definition td ON td.id = ti.definition_id
       LEFT JOIN submission s ON s.id = ti.submission_id
      WHERE f.event_id = ? AND f.superseded_at IS NULL
        AND (? IS NULL OR td.slug = ?)
      ORDER BY p.last_name, f.created_at`,
  ).all(event.id, taskSlug ?? null, taskSlug ?? null);

  return json({
    event: event.slug,
    count: rows.length,
    available_tasks: definitions.map((d) => d.slug),
    files: rows.map((f) => ({
      slug: f.slug,
      filename: f.filename,
      content_type: f.content_type,
      bytes: f.byte_size,
      from: f.person_slug ?? null,
      from_name: f.person_slug ? `${f.first_name ?? ''} ${f.last_name ?? ''}`.trim() : null,
      task: f.task ?? null,
      submission: f.submission ?? null,
      created_at: f.created_at,
      url: `${baseUrl(ctx)}/files/${f.slug}`,
    })),
    note: `All of them in one archive: GET /e/${event.slug}/files.zip`,
  });
}

function listReviews(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  // `conf reviews`, unchanged: who is behind is the only reason to look.
  const rows = ctx.db.prepare(
    `SELECT p.slug AS reviewer_slug, p.first_name, p.last_name, p.email,
            ep.name AS round,
            sum(rv.status = 'submitted') AS submitted,
            sum(rv.status IN ('assigned', 'in_progress')) AS outstanding,
            sum(rv.status = 'declined') AS declined
       FROM review rv
       JOIN person p ON p.id = rv.reviewer_person_id
       JOIN evaluation_plan ep ON ep.id = rv.plan_id
      WHERE ep.event_id = ?
      GROUP BY p.id, ep.id
      ORDER BY outstanding DESC, p.last_name`,
  ).all(event.id);

  return json({
    event: event.slug,
    count: rows.length,
    reviewers: rows.map((r) => ({
      reviewer: r.reviewer_slug,
      name: fullName(r),
      email: r.email,
      round: r.round,
      submitted: r.submitted,
      outstanding: r.outstanding,
      declined: r.declined,
    })),
  });
}

function listPeople(ctx) {
  requireAnyOrganizer(ctx);

  const eventSlug = ctx.query.get('event');
  let spokeAtEventId = null;
  if (eventSlug) {
    const found = ctx.db.prepare('SELECT id FROM event WHERE slug = ?').get(eventSlug);
    if (!found) {
      const known = ctx.db.prepare('SELECT slug FROM event ORDER BY starts_at DESC').all()
        .map((e) => e.slug);
      throw badRequest(`no event with slug '${eventSlug}'`,
        known.length ? `known events: ${known.join(', ')}` : 'no events exist yet');
    }
    spokeAtEventId = found.id;
  }

  const rows = searchPeople(ctx.db, {
    query: ctx.query.get('q') ?? '',
    tag: ctx.query.get('tag') ?? '',
    company: ctx.query.get('company') ?? '',
    spokeAtEventId,
    neverSpoken: ['1', 'true', 'yes', 'on'].includes((ctx.query.get('never_spoken') ?? '').toLowerCase()),
  });

  return json({
    count: rows.length,
    people: rows.map((p) => ({
      slug: p.slug,
      name: fullName(p),
      email: p.email,
      job_title: p.job_title || null,
      company: p.company || null,
      events_spoken: p.events_spoken,
      submissions: p.submissions,
      tags: (p.tags ?? '').split(', ').filter(Boolean),
    })),
    note: 'Across every event on this instance, not one. One person in full: /api/people/<slug>.',
  });
}

function getPerson(ctx) {
  requireAnyOrganizer(ctx);

  const person = ctx.db.prepare('SELECT * FROM person WHERE slug = ?').get(ctx.params.slug);
  if (!person) {
    throw notFound(`no person with slug '${ctx.params.slug}'`,
      'search for them at /api/people?q=<name>');
  }

  const history = personHistory(ctx.db, person.id);

  return json({
    person: person.slug,
    name: fullName(person),
    email: person.email,
    job_title: person.job_title || null,
    company: person.company || null,
    tags: tagsOn(ctx.db, person.id),
    // "Spoke at" is not "submitted to". Counting submissions as appearances is
    // how somebody who was declined three times becomes a returning speaker.
    events_spoken: new Set(history.filter((h) => h.status === 'accepted').map((h) => h.event_slug)).size,
    history: history.map((h) => ({
      event: h.event_slug,
      code: h.code,
      title: h.title,
      status: h.status,
      role: h.role,
    })),
    notes: notesOn(ctx.db, person.id).map((n) => ({ created_at: n.created_at, body: n.body })),
  });
}
