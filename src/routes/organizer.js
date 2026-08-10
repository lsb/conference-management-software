// The organizer's screens.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest } from '../http/router.js';
import { decide, notify, awaitingNotification, participantsOf, setStatus } from '../core/submissions.js';
import { outstandingTasks, runReminders } from '../core/tasks.js';
import {
  findConflicts, unscheduledSessions, scheduledSessions, conflictsForSlot, placeSession,
  agendaByDay, agendaByRoom, agendaByTrack, agendaGrid, autoSchedule, localTime,
} from '../core/schedule.js';
import { createMagicLink } from '../core/auth.js';
import { contentPanel } from './content.js';
import { now } from '../db.js';
import {
  findEvent, findSubmission, requireOrganizer, organizerNav, statusPill, statusCounts,
  STATUS_TABS, STATUS_LABELS, tabs, empty, when, dateOnly, fullName,
  toLocalInput, fromLocalInput,
} from './shared.js';

export function mountOrganizer(router) {
  router.get('/e/:event', dashboard,
    'Organizer dashboard: counts, and the specific things that need attention.');

  router.get('/e/:event/submissions', submissionList,
    'All submissions. Filter with ?status=pending|accept_queue|decline_queue|accepted|declined|withdrawn|draft, or ?q=search.');

  router.get('/e/:event/submissions/:code', submissionDetail,
    'One submission: its abstract, speakers, reviews, schedule, and history.');

  router.post('/e/:event/submissions/decide', postDecide,
    'Record accept/decline/undecide on one or more submissions. Sends no email.');

  router.get('/e/:event/notify', notifyQueue,
    'Submissions that have been decided but not yet told. This is the send screen.');

  router.post('/e/:event/notify', postNotify,
    'Send decision emails for the selected submissions and finalise their status.');

  router.post('/e/:event/submissions/:code/schedule', postSchedule,
    'Put a session in a room at a time, refusing the move if it would clash.');

  router.get('/e/:event/agenda', agenda,
    'The schedule. ?view=list|day|week|track|room|conflicts.');

  router.post('/e/:event/agenda/autoschedule', postAutoSchedule,
    'Place every unscheduled session in the first slot that does not clash. A draft, not a timetable.');

  router.post('/e/:event/agenda/publish', postPublish,
    'Put every approved, scheduled session on the public agenda.');

  router.get('/e/:event/speakers', speakers,
    'Everyone speaking, with what they still owe.');

  router.get('/e/:event/tasks', taskDashboard,
    'Who still owes what, and the reminder queue.');

  router.post('/e/:event/tasks/remind', postRemind,
    'Queue reminder emails for overdue tasks. Add dry_run=1 to preview.');

  router.get('/e/:event/review', reviewProgress,
    'Evaluation progress: scores per submission and per reviewer.');

  router.get('/e/:event/outbox', outbox,
    'Every message this app has generated, whether or not it was delivered.');

  router.get('/e/:event/outbox/:id', outboxItem,
    'One message, in full.');
}

// --- dashboard -------------------------------------------------------------

function dashboard(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const counts = statusCounts(ctx.db, event.id);
  const conflicts = findConflicts(ctx.db, event.id);
  const unscheduled = unscheduledSessions(ctx.db, event.id);
  const queued = awaitingNotification(ctx.db, event.id);
  const outstanding = outstandingTasks(ctx.db, event.id);

  const missingProfile = ctx.db.prepare(
    `SELECT DISTINCT p.slug, p.first_name, p.last_name,
            (p.biography = '') AS no_bio, (p.headshot_file_id IS NULL) AS no_headshot
       FROM submission_participant sp
       JOIN submission s ON s.id = sp.submission_id
       JOIN person p ON p.id = sp.person_id
      WHERE s.event_id = ? AND s.status = 'accepted'
        AND (p.biography = '' OR p.headshot_file_id IS NULL)`,
  ).all(event.id);

  // Sentences with a count and a link beat a wall of charts. Each one is a thing
  // somebody has to go and do.
  const alerts = [];
  if (counts.pending > 0) {
    alerts.push({ level: 'warn', text: `${counts.pending} submission${counts.pending === 1 ? '' : 's'} awaiting a decision`,
      href: `/e/${event.slug}/submissions?status=pending`, action: 'Review them' });
  }
  if (queued.length > 0) {
    alerts.push({ level: 'warn', text: `${queued.length} decided but not yet told`,
      href: `/e/${event.slug}/notify`, action: 'Send decisions' });
  }
  if (unscheduled.length > 0) {
    // Counts sessions still in the accept queue as well as announced ones,
    // because organizers build the grid before they send the acceptances.
    alerts.push({ level: '', text: `${unscheduled.length} session${unscheduled.length === 1 ? '' : 's'} still need a time slot`,
      href: `/e/${event.slug}/agenda?view=list`, action: 'Schedule them' });
  }
  // Publishing and approving are separate on purpose, which means it is
  // possible to tick "show this publicly" on a session whose content nobody has
  // approved and have precisely nothing happen. Say so, rather than letting an
  // organizer discover it from an empty website.
  const invisible = ctx.db.prepare(
    `SELECT count(*) AS n FROM submission
      WHERE event_id = ? AND status = 'accepted' AND published = 1 AND content_status != 'approved'`,
  ).get(event.id).n;
  if (invisible > 0) {
    alerts.push({ level: 'stop',
      text: `${invisible} session${invisible === 1 ? ' is' : 's are'} marked public but not approved, `
        + `so ${invisible === 1 ? 'it does' : 'they do'} not appear on the agenda`,
      href: `/e/${event.slug}/submissions?status=accepted`, action: 'Approve them' });
  }

  const errors = conflicts.filter((c) => c.severity === 'error');
  if (errors.length > 0) {
    alerts.push({ level: 'stop', text: `${errors.length} scheduling conflict${errors.length === 1 ? '' : 's'}`,
      href: `/e/${event.slug}/agenda?view=conflicts`, action: 'Resolve' });
  }
  if (missingProfile.length > 0) {
    const bios = missingProfile.filter((p) => p.no_bio).length;
    const shots = missingProfile.filter((p) => p.no_headshot).length;
    alerts.push({ level: '', text: `${missingProfile.length} accepted speaker${missingProfile.length === 1 ? '' : 's'} `
      + `missing a bio or headshot (${bios} bio${bios === 1 ? '' : 's'}, ${shots} headshot${shots === 1 ? '' : 's'})`,
      href: `/e/${event.slug}/speakers`, action: 'See who' });
  }
  if (outstanding.length > 0) {
    alerts.push({ level: '', text: `${outstanding.length} outstanding speaker task${outstanding.length === 1 ? '' : 's'}`,
      href: `/e/${event.slug}/tasks`, action: 'Chase them' });
  }

  const acceptedSpeakers = ctx.db.prepare(
    `SELECT count(DISTINCT sp.person_id) AS n
       FROM submission_participant sp JOIN submission s ON s.id = sp.submission_id
      WHERE s.event_id = ? AND s.status = 'accepted'`,
  ).get(event.id).n;

  return ok(page({
    title: `${event.name} - dashboard`,
    nav: organizerNav(event, 'Dashboard'),
    wide: true,
    body: html`
      <h1>${event.name}</h1>
      <p class="sub">
        ${dateOnly(event.starts_at, event.timezone)} to ${dateOnly(event.ends_at, event.timezone)}
        ${event.location ? html` &middot; ${event.location}` : ''}
        &middot; ${event.timezone}
      </p>

      <div class="cards">
        <div class="card"><div class="n">${counts.all}</div><div class="label">Submissions</div></div>
        <div class="card"><div class="n">${acceptedSpeakers}</div><div class="label">Accepted speakers</div></div>
        <div class="card"><div class="n">${counts.accepted}</div><div class="label">Accepted sessions</div></div>
        <div class="card"><div class="n">${counts.pending}</div><div class="label">Awaiting decision</div></div>
      </div>

      <h2>Needs attention</h2>
      ${alerts.length === 0 ? empty('Nothing is waiting on you.') : html`
        <ul class="alerts">
          ${alerts.map((a) => html`
            <li class="${a.level}">${a.text} &mdash; <a href="${a.href}">${a.action}</a></li>
          `)}
        </ul>
      `}

      <h2>Submissions by status</h2>
      <div class="cards">
        ${STATUS_TABS.map((status) => html`
          <div class="card">
            <div class="n">${counts[status]}</div>
            <div class="label"><a href="/e/${event.slug}/submissions?status=${status}">${STATUS_LABELS[status]}</a></div>
          </div>
        `)}
      </div>
    `,
  }));
}

// --- submissions -----------------------------------------------------------

function submissionList(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const status = ctx.query.get('status');
  const search = (ctx.query.get('q') ?? '').trim();
  const counts = statusCounts(ctx.db, event.id);

  const where = ['s.event_id = ?'];
  const args = [event.id];
  if (status) {
    if (!STATUS_TABS.includes(status)) {
      throw badRequest(`unknown status '${status}'`, `use one of: ${STATUS_TABS.join(', ')}`);
    }
    where.push('s.status = ?');
    args.push(status);
  }
  if (search) {
    where.push('(s.title LIKE ? OR s.code LIKE ? OR s.description LIKE ?)');
    args.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const rows = ctx.db.prepare(
    `SELECT s.*, t.name AS track_name, r.name AS room_name,
            (SELECT group_concat(p.first_name || ' ' || p.last_name, ', ')
               FROM submission_participant sp JOIN person p ON p.id = sp.person_id
              WHERE sp.submission_id = s.id) AS speakers,
            (SELECT round(avg(sc.value), 2) FROM review rv JOIN score sc ON sc.review_id = rv.id
              WHERE rv.submission_id = s.id AND rv.status = 'submitted') AS avg_score
       FROM submission s
       LEFT JOIN track t ON t.id = s.track_id
       LEFT JOIN room r ON r.id = s.room_id
      WHERE ${raw(where.join(' AND '))}
      ORDER BY s.code`,
  ).all(...args);

  return ok(page({
    title: `Submissions - ${event.name}`,
    nav: organizerNav(event, 'Submissions'),
    wide: true,
    body: html`
      <h1>Submissions</h1>
      <p class="sub">Record a decision here; nothing is sent until you go to
        <a href="/e/${event.slug}/notify">Notify</a>.</p>

      ${tabs([
        { href: `/e/${event.slug}/submissions`, label: 'All', count: counts.all, current: !status },
        ...STATUS_TABS.map((s) => ({
          href: `/e/${event.slug}/submissions?status=${s}`,
          label: STATUS_LABELS[s], count: counts[s], current: status === s,
        })),
      ])}

      <form method="get" class="row" style="margin-bottom:1rem">
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        <div><label for="q">Search</label>
          <input type="text" id="q" name="q" value="${search}" placeholder="title, code, or abstract text"></div>
        <div style="flex:0 0 auto"><button type="submit">Search</button></div>
      </form>

      ${rows.length === 0 ? empty('No submissions match.') : html`
      <form method="post" action="/e/${event.slug}/submissions/decide">
        <div class="scroll">
        <table>
          <thead><tr>
            <th></th><th>Code</th><th>Status</th><th>Title</th><th>Speakers</th>
            <th>Track</th><th class="num">Score</th><th>Scheduled</th>
          </tr></thead>
          <tbody>
            ${rows.map((s) => html`
              <tr>
                <td><input type="checkbox" name="codes" value="${s.code}" aria-label="Select ${s.code}"></td>
                <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
                <td>${statusPill(s.status)}</td>
                <td>${s.title}</td>
                <td>${s.speakers ?? html`<span class="muted">-</span>`}</td>
                <td>${s.track_name ?? html`<span class="muted">-</span>`}</td>
                <td class="num">${s.avg_score ?? html`<span class="muted">-</span>`}</td>
                <td>${s.starts_at ? when(s.starts_at, event.timezone) : html`<span class="muted">-</span>`}</td>
              </tr>
            `)}
          </tbody>
        </table>
        </div>
        <div class="actions">
          <button type="submit" name="decision" value="accept">Accept selected</button>
          <button type="submit" name="decision" value="decline" class="secondary">Decline selected</button>
          <button type="submit" name="decision" value="undecide" class="secondary">Move back to pending</button>
        </div>
        <p class="muted">Decisions are recorded, not sent. ${rows.length} shown.</p>
      </form>
      `}
    `,
  }));
}

function submissionDetail(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const submission = findSubmission(ctx.db, event.id, ctx.params.code);

  const people = participantsOf(ctx.db, submission.id);
  const rooms = ctx.db.prepare('SELECT * FROM room WHERE event_id = ? ORDER BY sort_order, name').all(event.id);
  const track = submission.track_id
    ? ctx.db.prepare('SELECT name FROM track WHERE id = ?').get(submission.track_id) : null;

  const reviews = ctx.db.prepare(
    `SELECT rv.*, p.first_name, p.last_name,
            (SELECT round(avg(value), 2) FROM score WHERE review_id = rv.id) AS avg_score
       FROM review rv JOIN person p ON p.id = rv.reviewer_person_id
      WHERE rv.submission_id = ? ORDER BY rv.status, p.last_name`,
  ).all(submission.id);

  const answers = ctx.db.prepare(
    `SELECT ff.label, sa.value FROM submission_answer sa
       JOIN form_field ff ON ff.id = sa.field_id
      WHERE sa.submission_id = ? ORDER BY ff.sort_order`,
  ).all(submission.id);

  const history = ctx.db.prepare(
    `SELECT a.*, p.first_name, p.last_name FROM activity a
       LEFT JOIN person p ON p.id = a.actor_person_id
      WHERE a.subject_type = 'submission' AND a.subject_id = ? ORDER BY a.id DESC`,
  ).all(submission.id);

  const slotProblems = submission.starts_at && submission.ends_at
    ? conflictsForSlot(ctx.db, event.id, {
        submissionId: submission.id, roomId: submission.room_id,
        startsAt: submission.starts_at, endsAt: submission.ends_at,
      })
    : [];

  return ok(page({
    title: `${submission.code} - ${submission.title}`,
    nav: organizerNav(event, 'Submissions'),
    body: html`
      <p class="sub"><a href="/e/${event.slug}/submissions">&larr; All submissions</a></p>
      <h1>${submission.title}</h1>
      <p class="sub"><code>${submission.code}</code> &middot; ${statusPill(submission.status)}
        ${track ? html` &middot; ${track.name}` : ''}
        ${submission.notified_at ? html` &middot; speaker told ${dateOnly(submission.notified_at, event.timezone)}`
          : html` &middot; <span class="muted">speaker not yet told</span>`}</p>

      ${ctx.query.get('done') ? html`<p class="flash">${ctx.query.get('done')}</p>` : ''}
      ${ctx.query.get('invited') ? html`<p class="flash">Calendar invite sent to
        ${ctx.query.get('invited')} speaker(s). A reschedule updates the entry already in
        their calendar rather than adding a second one.</p>` : ''}

      ${slotProblems.length > 0 ? html`
        <ul class="alerts">
          ${slotProblems.map((p) => html`<li class="stop">${p.detail}</li>`)}
        </ul>` : ''}

      <h2>Abstract</h2>
      <p>${submission.description || html`<span class="muted">No description given.</span>`}</p>

      ${answers.length > 0 ? html`
        <h2>Other answers</h2>
        <div class="grid2">
          ${answers.map((a) => html`<div><strong>${a.label}</strong><br>${a.value}</div>`)}
        </div>` : ''}

      <h2>Speakers</h2>
      ${people.length === 0 ? empty('Nobody is attached to this submission.') : html`
        <table><tbody>
          ${people.map((p) => html`
            <tr>
              <td><a href="/e/${event.slug}/speakers#${p.slug}">${fullName(p)}</a>
                ${p.is_primary_contact ? html` <span class="pill draft">primary</span>` : ''}</td>
              <td class="muted">${p.email}</td>
              <td class="muted">${p.role}</td>
            </tr>`)}
        </tbody></table>`}

      <h2>Decision</h2>
      <form method="post" action="/e/${event.slug}/submissions/decide">
        <input type="hidden" name="codes" value="${submission.code}">
        <input type="hidden" name="return_to" value="/e/${event.slug}/submissions/${submission.code}">
        <div class="actions">
          <button type="submit" name="decision" value="accept">Accept</button>
          <button type="submit" name="decision" value="decline" class="secondary">Decline</button>
          <button type="submit" name="decision" value="undecide" class="secondary">Back to pending</button>
        </div>
        <p class="muted">Recorded only. Send from <a href="/e/${event.slug}/notify">Notify</a>.</p>
      </form>

      <h2>Schedule</h2>
      <form method="post" action="/e/${event.slug}/submissions/${submission.code}/schedule">
        <div class="row">
          <div>
            <label for="room">Room</label>
            <select id="room" name="room">
              <option value="">- unassigned -</option>
              ${rooms.map((r) => html`
                <option value="${r.slug}" ${r.id === submission.room_id ? raw('selected') : ''}>
                  ${r.name}${r.capacity ? ` (${r.capacity})` : ''}
                </option>`)}
            </select>
          </div>
          <div>
            <label for="starts_at">Starts <small>${event.timezone}</small></label>
            <input type="datetime-local" id="starts_at" name="starts_at"
                   value="${toLocalInput(submission.starts_at, event.timezone)}">
          </div>
          <div>
            <label for="ends_at">Ends</label>
            <input type="datetime-local" id="ends_at" name="ends_at"
                   value="${toLocalInput(submission.ends_at, event.timezone)}">
          </div>
        </div>
        <div class="actions">
          <button type="submit">Save schedule</button>
          <!-- An unchecked checkbox posts nothing, so absence cannot mean "unpublish":
               a curl caller who simply did not mention publication would silently take
               the session off the public agenda. This hidden field is how the form says
               "I have an opinion about publication", leaving absence to mean "leave it". -->
          <input type="hidden" name="published_set" value="1">
          <label style="display:flex;gap:.4rem;align-items:center;font-weight:400;margin:0">
            <input type="checkbox" name="published" ${submission.published ? raw('checked') : ''}>
            Show on the public agenda
          </label>
        </div>
      </form>

      ${contentPanel(ctx, event, submission)}

      <h2>Reviews</h2>
      ${reviews.length === 0 ? empty('No reviews assigned.') : html`
        <table>
          <thead><tr><th>Reviewer</th><th>Status</th><th class="num">Score</th><th>Comment</th></tr></thead>
          <tbody>
            ${reviews.map((r) => html`
              <tr>
                <td>${r.first_name} ${r.last_name}${r.source === 'ai' ? html` <span class="pill draft">AI</span>` : ''}</td>
                <td>${r.status}</td>
                <td class="num">${r.avg_score ?? html`<span class="muted">-</span>`}</td>
                <td>${r.comment}</td>
              </tr>`)}
          </tbody>
        </table>`}

      <h2>History</h2>
      <table><tbody>
        ${history.map((h) => html`
          <tr>
            <td class="muted">${h.created_at}</td>
            <td>${h.verb.replace(/_/g, ' ')}</td>
            <td class="muted">${h.detail}</td>
            <td class="muted">${h.first_name ? `${h.first_name} ${h.last_name}` : ''}</td>
          </tr>`)}
      </tbody></table>
    `,
  }));
}

function postDecide(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const codes = ctx.fields.list('codes');
  if (codes.length === 0) {
    throw badRequest('no submissions selected',
      'tick at least one row, or POST codes=SESS-1&codes=SESS-2');
  }
  const decision = ctx.fields.choice('decision', ['accept', 'decline', 'undecide']);
  const ids = codes.map((code) => findSubmission(ctx.db, event.id, code).id);

  decide(ctx.db, ids, decision, { actorPersonId: ctx.person?.id ?? null });

  const back = ctx.fields.get('return_to') || `/e/${event.slug}/submissions`;
  return redirect(`${back}${back.includes('?') ? '&' : '?'}decided=${codes.length}`);
}

// --- notify ----------------------------------------------------------------

function notifyQueue(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const queued = awaitingNotification(ctx.db, event.id);
  const sent = ctx.query.get('sent');

  return ok(page({
    title: `Notify - ${event.name}`,
    nav: organizerNav(event, 'Submissions'),
    body: html`
      <h1>Send decisions</h1>
      <p class="sub">These have been decided but the speakers have not been told.
        Sending also finalises each status and, for acceptances, assigns onboarding tasks.</p>

      ${sent ? html`<p class="flash">Sent ${sent} decision${sent === '1' ? '' : 's'}.</p>` : ''}

      ${queued.length === 0 ? empty('Nothing is waiting to be sent.') : html`
        <form method="post" action="/e/${event.slug}/notify">
          <table>
            <thead><tr><th></th><th>Code</th><th>Decision</th><th>Title</th></tr></thead>
            <tbody>
              ${queued.map((s) => html`
                <tr>
                  <td><input type="checkbox" name="codes" value="${s.code}" checked aria-label="Select ${s.code}"></td>
                  <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
                  <td>${statusPill(s.status)}</td>
                  <td>${s.title}</td>
                </tr>`)}
            </tbody>
          </table>
          <div class="actions">
            <button type="submit">Send ${queued.length} decision${queued.length === 1 ? '' : 's'}</button>
          </div>
          <p class="muted">Mail is written to the <a href="/e/${event.slug}/outbox">outbox</a>.
            Nothing leaves this machine unless a delivery sink is configured.</p>
        </form>`}
    `,
  }));
}

function postNotify(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const codes = ctx.fields.list('codes');
  if (codes.length === 0) {
    throw badRequest('no submissions selected', 'tick at least one row before sending');
  }
  const ids = codes.map((code) => findSubmission(ctx.db, event.id, code).id);

  const report = notify(ctx.db, ids, {
    actorPersonId: ctx.person?.id ?? null,
    portalUrlFor: (person) => portalUrl(ctx, event, person),
  });

  const sent = report.filter((r) => !r.skipped).length;
  return redirect(`/e/${event.slug}/notify?sent=${sent}`);
}

/** A signed-in link straight into the speaker's portal, so they never see a login form. */
function portalUrl(ctx, event, person) {
  const token = createMagicLink(ctx.db, person.id, event.id);
  const base = ctx.headers?.host ? `http://${ctx.headers.host}` : 'http://127.0.0.1:8080';
  return `${base}/portal/${event.slug}/enter?token=${token}`;
}

// --- agenda ----------------------------------------------------------------

const VIEW_LABELS = {
  list: 'List',
  day: 'By day',
  week: 'Grid',
  track: 'By track',
  room: 'By room',
  conflicts: 'Conflicts',
};

function agenda(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const view = ctx.query.get('view') ?? 'list';

  const conflicts = findConflicts(ctx.db, event.id);
  const unscheduled = unscheduledSessions(ctx.db, event.id);
  const sessions = scheduledSessions(ctx.db, event.id);

  const allRooms = ctx.db.prepare('SELECT * FROM room WHERE event_id = ? ORDER BY sort_order, name')
    .all(event.id);

  // Pre-fill with the event's first morning, so placing a session is two clicks
  // rather than typing a date somebody has to go and look up.
  const firstDay = (event.starts_at ?? '').slice(0, 10);
  const defaultSlot = {
    start: firstDay ? `${firstDay}T09:00` : '',
    end: firstDay ? `${firstDay}T09:45` : '',
  };

  const views = ['list', 'day', 'week', 'track', 'room', 'conflicts'];
  if (!views.includes(view)) {
    throw badRequest(`unknown view '${view}'`, `use one of: ${views.join(', ')}`);
  }

  let content;
  if (view === 'conflicts') {
    content = conflicts.length === 0
      ? empty('No conflicts. Every scheduled session has its own room, and nobody is in two places at once.')
      : html`
        <table>
          <thead><tr><th>Severity</th><th>Kind</th><th>Sessions</th><th>What is wrong</th></tr></thead>
          <tbody>
            ${conflicts.map((c) => html`
              <tr>
                <td><span class="pill ${c.severity === 'error' ? 'declined' : 'pending'}">${c.severity}</span></td>
                <td><code>${c.kind}</code></td>
                <td>${c.sessions.map((code) => html`
                  <a href="/e/${event.slug}/submissions/${code}"><code>${code}</code></a> `)}</td>
                <td>${c.detail}</td>
              </tr>`)}
          </tbody>
        </table>`;
  } else if (view === 'day') {
    const days = agendaByDay(ctx.db, event.id, event.timezone);
    content = days.length === 0 ? empty('Nothing is scheduled yet.') : html`
      ${days.map(({ day, sessions: daySessions }) => html`
        <h3>${day}</h3>
        <table>
          <thead><tr><th>Time</th><th>Room</th><th>Code</th><th>Title</th><th>Track</th></tr></thead>
          <tbody>
            ${daySessions.map((s) => html`
              <tr>
                <td>${localTime(s.starts_at, event.timezone)}-${localTime(s.ends_at, event.timezone)}</td>
                <td>${s.room_name ?? html`<span class="muted">-</span>`}</td>
                <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
                <td>${s.title}</td>
                <td>${s.track_name ?? ''}</td>
              </tr>`)}
          </tbody>
        </table>`)}`;
  } else if (view === 'week') {
    const grid = agendaGrid(ctx.db, event.id, event.timezone);
    content = grid.length === 0 ? empty('Nothing is scheduled yet.') : html`
      ${grid.map(({ day, rooms: gridRooms, rows }) => html`
        <h3>${day}</h3>
        <div class="scroll">
        <table>
          <thead><tr><th>Time</th>${gridRooms.map((r) => html`<th>${r.name}</th>`)}</tr></thead>
          <tbody>
            ${rows.map((row) => html`
              <tr>
                <td><strong>${row.time}</strong></td>
                ${row.cells.map((cell) => html`
                  <td>${cell
                    ? html`<a href="/e/${event.slug}/submissions/${cell.code}">${cell.title}</a>
                           <br><span class="muted">${cell.code}</span>`
                    : html`<span class="muted">-</span>`}</td>`)}
              </tr>`)}
          </tbody>
        </table>
        </div>`)}`;
  } else if (view === 'track') {
    const byTrack = agendaByTrack(ctx.db, event.id);
    content = html`${byTrack.map(({ track, sessions: trackSessions }) => html`
      <h3>${track.name}</h3>
      ${trackSessions.length === 0 ? empty('Nothing scheduled on this track yet.') : html`
        <table>
          <thead><tr><th>When</th><th>Room</th><th>Code</th><th>Title</th></tr></thead>
          <tbody>
            ${trackSessions.map((s) => html`
              <tr>
                <td>${when(s.starts_at, event.timezone)}</td>
                <td>${s.room_name ?? html`<span class="muted">-</span>`}</td>
                <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
                <td>${s.title}</td>
              </tr>`)}
          </tbody>
        </table>`}`)}`;
  } else if (view === 'room') {
    const byRoom = agendaByRoom(ctx.db, event.id);
    content = html`${byRoom.map(({ room, sessions: roomSessions }) => html`
      <h3>${room.name} ${room.capacity ? html`<span class="muted">(${room.capacity} seats)</span>` : ''}</h3>
      ${roomSessions.length === 0 ? empty('Nothing scheduled in this room.') : html`
        <table>
          <thead><tr><th>Start</th><th>End</th><th>Code</th><th>Title</th></tr></thead>
          <tbody>
            ${roomSessions.map((s) => html`
              <tr>
                <td>${when(s.starts_at, event.timezone)}</td>
                <td>${localTime(s.ends_at, event.timezone)}</td>
                <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
                <td>${s.title}</td>
              </tr>`)}
          </tbody>
        </table>`}`)}`;
  } else {
    content = sessions.length === 0 ? empty('Nothing is scheduled yet.') : html`
      <div class="scroll">
      <table>
        <thead><tr><th>Code</th><th>Title</th><th>Room</th><th>Starts</th><th>Ends</th><th>Track</th><th>Public</th></tr></thead>
        <tbody>
          ${sessions.map((s) => html`
            <tr>
              <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
              <td>${s.title}</td>
              <td>${s.room_name ?? html`<span class="muted">-</span>`}</td>
              <td>${when(s.starts_at, event.timezone)}</td>
              <td>${localTime(s.ends_at, event.timezone)}</td>
              <td>${s.track_name ?? ''}</td>
              <td>${s.published ? 'yes' : html`<span class="muted">no</span>`}</td>
            </tr>`)}
        </tbody>
      </table>
      </div>`;
  }

  const errorCount = conflicts.filter((c) => c.severity === 'error').length;

  return ok(page({
    title: `Agenda - ${event.name}`,
    nav: organizerNav(event, 'Agenda'),
    wide: true,
    body: html`
      <h1>Agenda</h1>
      <p class="sub">${sessions.length} scheduled, ${unscheduled.length} still without a slot.</p>
      ${ctx.query.get('done') ? html`<p class="flash">${ctx.query.get('done')}</p>` : ''}

      ${tabs(views.map((v) => ({
        href: `/e/${event.slug}/agenda?view=${v}`,
        label: VIEW_LABELS[v],
        count: v === 'conflicts' ? conflicts.length : undefined,
        current: view === v,
      })))}

      ${errorCount > 0 && view !== 'conflicts' ? html`
        <ul class="alerts"><li class="stop">${errorCount} conflict${errorCount === 1 ? '' : 's'} need resolving &mdash;
          <a href="/e/${event.slug}/agenda?view=conflicts">show them</a></li></ul>` : ''}

      ${content}

      ${view === 'list' ? html`
        <h2>Publish</h2>
        <p class="sub">Puts every accepted, approved, scheduled session on the public
          agenda. Anything unapproved or without a time is held back and counted.</p>
        <form method="post" action="/e/${event.slug}/agenda/publish">
          <button type="submit">Publish the agenda</button>
        </form>` : ''}

      ${unscheduled.length > 0 && view === 'list' ? html`
        <h2>Accepted, but not scheduled</h2>
        <p class="sub">Give each a room and a time. A clash is refused, not accepted
          and complained about afterwards.</p>

        <form method="post" action="/e/${event.slug}/agenda/autoschedule">
          <div class="actions">
            <button type="submit" class="secondary">
              Place all ${unscheduled.length} automatically
            </button>
          </div>
          <p class="muted">A greedy first pass: each session gets the first slot that
            does not clash. It is a draft to argue with, and nothing is published.</p>
        </form>

        <div class="scroll">
        <table>
          <thead><tr><th>Code</th><th>Title</th><th>Room</th><th>Starts</th><th>Ends</th><th></th></tr></thead>
          <tbody>
            ${unscheduled.map((s) => html`
              <tr>
                <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
                <td>${s.title}<br>${statusPill(s.status)}</td>
                <td colspan="4">
                  <form method="post" action="/e/${event.slug}/submissions/${s.code}/schedule" class="row">
                    <div>
                      <label for="room_${s.code}">Room</label>
                      <select id="room_${s.code}" name="room">
                        <option value="">- choose -</option>
                        ${allRooms.map((r) => html`<option value="${r.slug}">${r.name}</option>`)}
                      </select>
                    </div>
                    <div>
                      <label for="from_${s.code}">Starts</label>
                      <input type="datetime-local" id="from_${s.code}" name="starts_at"
                             value="${defaultSlot.start}">
                    </div>
                    <div>
                      <label for="to_${s.code}">Ends</label>
                      <input type="datetime-local" id="to_${s.code}" name="ends_at"
                             value="${defaultSlot.end}">
                    </div>
                    <div style="flex:0 0 auto"><button type="submit">Place it</button></div>
                  </form>
                </td>
              </tr>`)}
          </tbody>
        </table>
        </div>` : ''}
    `,
  }));
}

function postAutoSchedule(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const placed = autoSchedule(ctx.db, event.id, {
    toInstant: (localValue) => fromLocalInput(localValue, event.timezone),
  });

  const remaining = unscheduledSessions(ctx.db, event.id).length;
  const note = placed.length === 0
    ? 'Nothing could be placed automatically. Add rooms, or move something by hand.'
    : `Placed ${placed.length} session(s). ${remaining > 0 ? `${remaining} still need a slot. ` : ''}`
      + 'Nothing has been published; check it before you do.';

  return redirect(`/e/${event.slug}/agenda?view=list&done=${encodeURIComponent(note)}`);
}

/**
 * Publish the agenda.
 *
 * Only sessions that are accepted, approved, and actually scheduled. Publishing
 * a session with no time on it puts a hole in somebody's programme, and
 * publishing unapproved content is the thing approval exists to prevent, so
 * both are counted and reported rather than silently skipped.
 */
function postPublish(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const ready = ctx.db.prepare(
    `SELECT count(*) AS n FROM submission
      WHERE event_id = ? AND status = 'accepted' AND content_status = 'approved'
        AND starts_at IS NOT NULL AND room_id IS NOT NULL AND published = 0`,
  ).get(event.id).n;

  const heldBack = ctx.db.prepare(
    `SELECT
       sum(content_status != 'approved') AS unapproved,
       sum(starts_at IS NULL OR room_id IS NULL) AS unscheduled
     FROM submission
      WHERE event_id = ? AND status = 'accepted' AND published = 0`,
  ).get(event.id);

  ctx.db.prepare(
    `UPDATE submission SET published = 1, updated_at = ?
      WHERE event_id = ? AND status = 'accepted' AND content_status = 'approved'
        AND starts_at IS NOT NULL AND room_id IS NOT NULL`,
  ).run(now(), event.id);

  const parts = [`Published ${ready} session(s).`];
  if (heldBack.unapproved > 0) parts.push(`${heldBack.unapproved} held back: content not approved.`);
  if (heldBack.unscheduled > 0) parts.push(`${heldBack.unscheduled} held back: no time slot.`);

  return redirect(`/e/${event.slug}/agenda?view=list&done=${encodeURIComponent(parts.join(' '))}`);
}

function postSchedule(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const submission = findSubmission(ctx.db, event.id, ctx.params.code);

  const roomSlug = ctx.fields.get('room');
  const room = roomSlug
    ? ctx.db.prepare('SELECT * FROM room WHERE event_id = ? AND slug = ?').get(event.id, roomSlug)
    : null;
  if (roomSlug && !room) {
    const known = ctx.db.prepare('SELECT slug FROM room WHERE event_id = ?').all(event.id)
      .map((r) => r.slug);
    throw badRequest(`no room '${roomSlug}' in this event`, `rooms are: ${known.join(', ')}`);
  }

  const startsAt = fromLocalInput(ctx.fields.get('starts_at'), event.timezone);
  const endsAt = fromLocalInput(ctx.fields.get('ends_at'), event.timezone);

  // Publication is only being changed if the caller said so. The form always
  // says so, via a hidden field next to the checkbox; a curl caller moving a
  // talk to a new time says nothing and keeps whatever was already true.
  const setsPublished = ctx.fields.has('published_set') || ctx.fields.has('published');
  const published = setsPublished ? ctx.fields.bool('published') : undefined;

  // The database refuses this too, but a form should answer for itself rather
  // than letting a trigger do the talking.
  if (published && submission.content_status !== 'approved') {
    throw badRequest('this session cannot go on the public agenda yet: its content is not approved',
      'approve it in the Content section below, then publish');
  }

  // Refuses the move rather than accepting it and complaining afterwards. An
  // organizer who has been told "no" still has the old, working schedule. This
  // is the same call `conf schedule` makes, which is what keeps the calendar
  // invite from depending on which interface you happened to use.
  const { clashes, invited } = placeSession(ctx.db, event.id, submission.id, {
    roomId: room?.id ?? null, startsAt, endsAt, published,
  });

  if (clashes.length > 0) {
    throw badRequest(`that slot clashes: ${clashes.map((p) => p.detail).join('; ')}`,
      'pick a different room or time, or move the other session first');
  }

  return redirect(`/e/${event.slug}/submissions/${submission.code}`
    + (invited ? `?invited=${invited.messages}` : ''));
}

// --- speakers, tasks, review, outbox ---------------------------------------

function speakers(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const rows = ctx.db.prepare(
    `SELECT p.*,
            group_concat(DISTINCT s.code) AS codes,
            (SELECT count(*) FROM task_instance ti
               JOIN task_definition td ON td.id = ti.definition_id
              WHERE ti.person_id = p.id AND td.event_id = ? AND ti.status = 'todo') AS todo,
            (SELECT count(*) FROM submission_participant sp2
               JOIN submission s2 ON s2.id = sp2.submission_id
              WHERE sp2.person_id = p.id AND s2.event_id != ?) AS other_events
       FROM person p
       JOIN submission_participant sp ON sp.person_id = p.id
       JOIN submission s ON s.id = sp.submission_id
      WHERE s.event_id = ? AND s.status IN ('accept_queue', 'accepted')
      GROUP BY p.id
      ORDER BY p.last_name, p.first_name`,
  ).all(event.id, event.id, event.id);

  return ok(page({
    title: `Speakers - ${event.name}`,
    nav: organizerNav(event, 'Speakers'),
    wide: true,
    body: html`
      <h1>Speakers</h1>
      <p class="sub">${rows.length} accepted. "Elsewhere" counts sessions at your other events &mdash;
        a speaker you have had before.</p>

      ${rows.length === 0 ? empty('Nobody has been accepted yet.') : html`
        <div class="scroll">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Sessions</th><th>Bio</th><th>Headshot</th>
            <th class="num">Owes</th><th class="num">Elsewhere</th></tr></thead>
          <tbody>
            ${rows.map((p) => html`
              <tr id="${p.slug}">
                <td>${fullName(p)}</td>
                <td class="muted">${p.email}</td>
                <td>${(p.codes ?? '').split(',').filter(Boolean).map((code) => html`
                  <a href="/e/${event.slug}/submissions/${code}"><code>${code}</code></a> `)}</td>
                <td>${p.biography ? 'yes' : html`<span class="pill pending">missing</span>`}</td>
                <td>${p.headshot_file_id ? 'yes' : html`<span class="pill pending">missing</span>`}</td>
                <td class="num">${p.todo > 0 ? html`<strong>${p.todo}</strong>` : '0'}</td>
                <td class="num">${p.other_events > 0 ? p.other_events : html`<span class="muted">-</span>`}</td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}
    `,
  }));
}

function taskDashboard(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const outstanding = outstandingTasks(ctx.db, event.id);
  const preview = runReminders(ctx.db, event.id, { dryRun: true });
  const queued = ctx.query.get('queued');

  const byDefinition = ctx.db.prepare(
    `SELECT td.title, td.due_at, td.applies_to, td.requirement,
            sum(ti.status = 'todo') AS todo, sum(ti.status = 'done') AS done
       FROM task_definition td LEFT JOIN task_instance ti ON ti.definition_id = td.id
      WHERE td.event_id = ? GROUP BY td.id ORDER BY td.sort_order, td.due_at`,
  ).all(event.id);

  return ok(page({
    title: `Tasks - ${event.name}`,
    nav: organizerNav(event, 'Tasks'),
    wide: true,
    body: html`
      <h1>Speaker tasks</h1>
      <p class="sub">Who still owes what.</p>
      ${queued ? html`<p class="flash">Queued ${queued} reminder${queued === '1' ? '' : 's'}.</p>` : ''}

      <h2>By task</h2>
      <table>
        <thead><tr><th>Task</th><th>Due</th><th>Applies to</th><th class="num">Outstanding</th><th class="num">Done</th></tr></thead>
        <tbody>
          ${byDefinition.map((t) => html`
            <tr>
              <td>${t.title}</td>
              <td>${t.due_at ? dateOnly(t.due_at, event.timezone) : html`<span class="muted">no deadline</span>`}</td>
              <td class="muted">${t.applies_to}</td>
              <td class="num">${t.todo ?? 0}</td>
              <td class="num">${t.done ?? 0}</td>
            </tr>`)}
        </tbody>
      </table>

      <h2>Outstanding, by person</h2>
      ${outstanding.length === 0 ? empty('Everybody is up to date.') : html`
        <div class="scroll">
        <table>
          <thead><tr><th>Person</th><th>Task</th><th>For</th><th>Due</th></tr></thead>
          <tbody>
            ${outstanding.map((t) => html`
              <tr>
                <td>${t.first_name} ${t.last_name}<br><span class="muted">${t.email}</span></td>
                <td>${t.task_title}</td>
                <td>${t.submission_code
                  ? html`<a href="/e/${event.slug}/submissions/${t.submission_code}"><code>${t.submission_code}</code></a>`
                  : html`<span class="muted">them personally</span>`}</td>
                <td>${t.due_at ? dateOnly(t.due_at, event.timezone) : html`<span class="muted">-</span>`}</td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}

      <h2>Reminders</h2>
      <p class="sub">Speakers are reminded a week before, the day before, and the day after a deadline.
        Then they are left alone.</p>
      ${preview.length === 0
        ? empty('No reminders are due right now.')
        : html`
          <ul class="alerts">
            ${preview.map((p) => html`<li>${p.email} &mdash; ${p.task} <span class="muted">(${p.rule})</span></li>`)}
          </ul>
          <form method="post" action="/e/${event.slug}/tasks/remind">
            <button type="submit">Queue ${preview.length} reminder${preview.length === 1 ? '' : 's'}</button>
          </form>`}
    `,
  }));
}

function postRemind(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const queued = runReminders(ctx.db, event.id, {
    dryRun: ctx.fields.bool('dry_run'),
    portalUrlFor: (person) => portalUrl(ctx, event, person),
  });
  return redirect(`/e/${event.slug}/tasks?queued=${queued.length}`);
}

function reviewProgress(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const plans = ctx.db.prepare(
    'SELECT * FROM evaluation_plan WHERE event_id = ? ORDER BY round, name',
  ).all(event.id);

  const reviewers = ctx.db.prepare(
    `SELECT p.first_name, p.last_name, p.slug,
            sum(rv.status = 'submitted') AS done,
            sum(rv.status != 'submitted') AS remaining
       FROM review rv
       JOIN person p ON p.id = rv.reviewer_person_id
       JOIN evaluation_plan ep ON ep.id = rv.plan_id
      WHERE ep.event_id = ? GROUP BY p.id ORDER BY remaining DESC, p.last_name`,
  ).all(event.id);

  const ranked = ctx.db.prepare(
    `SELECT s.code, s.title, s.status,
            round(avg(sc.value), 2) AS avg_score, count(DISTINCT rv.id) AS reviews
       FROM submission s
       JOIN review rv ON rv.submission_id = s.id AND rv.status = 'submitted'
       JOIN score sc ON sc.review_id = rv.id
      WHERE s.event_id = ? GROUP BY s.id ORDER BY avg_score DESC, s.code`,
  ).all(event.id);

  return ok(page({
    title: `Review - ${event.name}`,
    nav: organizerNav(event, 'Review'),
    wide: true,
    body: html`
      <h1>Review progress</h1>
      <p class="sub">${plans.map((p) => `${p.name} (round ${p.round})`).join(', ') || 'No evaluation plan yet.'}</p>

      <h2>Reviewers</h2>
      ${reviewers.length === 0 ? empty('Nothing assigned yet.') : html`
        <table>
          <thead><tr><th>Reviewer</th><th class="num">Submitted</th><th class="num">Still to do</th></tr></thead>
          <tbody>
            ${reviewers.map((r) => html`
              <tr><td>${r.first_name} ${r.last_name}</td>
                <td class="num">${r.done}</td>
                <td class="num">${r.remaining > 0 ? html`<strong>${r.remaining}</strong>` : '0'}</td></tr>`)}
          </tbody>
        </table>`}

      <h2>Ranked by score</h2>
      ${ranked.length === 0 ? empty('No scores submitted yet.') : html`
        <table>
          <thead><tr><th>Code</th><th>Title</th><th>Status</th><th class="num">Average</th><th class="num">Reviews</th></tr></thead>
          <tbody>
            ${ranked.map((s) => html`
              <tr>
                <td><a href="/e/${event.slug}/submissions/${s.code}"><code>${s.code}</code></a></td>
                <td>${s.title}</td>
                <td>${statusPill(s.status)}</td>
                <td class="num"><strong>${s.avg_score}</strong></td>
                <td class="num">${s.reviews}</td>
              </tr>`)}
          </tbody>
        </table>`}
    `,
  }));
}

function outbox(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const rows = ctx.db.prepare(
    `SELECT o.*, s.code AS submission_code FROM outbox o
       LEFT JOIN submission s ON s.id = o.submission_id
      WHERE o.event_id = ? ORDER BY o.id DESC LIMIT 200`,
  ).all(event.id);

  return ok(page({
    title: `Outbox - ${event.name}`,
    nav: organizerNav(event, 'Outbox'),
    wide: true,
    body: html`
      <h1>Outbox</h1>
      <p class="sub">Every message this app has generated. Nothing is delivered until a
        sink is configured, so this is also the record of what a speaker was told and when.</p>

      ${rows.length === 0 ? empty('No messages yet.') : html`
        <div class="scroll">
        <table>
          <thead><tr><th>When</th><th>To</th><th>Kind</th><th>Subject</th><th>About</th><th>Delivered</th></tr></thead>
          <tbody>
            ${rows.map((m) => html`
              <tr>
                <td class="muted">${m.created_at}</td>
                <td>${m.to_email}</td>
                <td><code>${m.kind}</code></td>
                <td><a href="/e/${event.slug}/outbox/${m.id}">${m.subject}</a></td>
                <td>${m.submission_code ? html`<code>${m.submission_code}</code>` : ''}</td>
                <td>${m.sent_at ? m.sent_at : html`<span class="muted">not sent</span>`}</td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}
    `,
  }));
}

function outboxItem(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const message = ctx.db.prepare('SELECT * FROM outbox WHERE id = ? AND event_id = ?')
    .get(Number(ctx.params.id), event.id);
  if (!message) throw badRequest(`no message ${ctx.params.id} in this event`);

  return ok(page({
    title: message.subject,
    nav: organizerNav(event, 'Outbox'),
    body: html`
      <p class="sub"><a href="/e/${event.slug}/outbox">&larr; Outbox</a></p>
      <h1>${message.subject}</h1>
      <p class="sub">To ${message.to_email} &middot; <code>${message.kind}</code> &middot; ${message.created_at}
        ${message.sent_at ? html` &middot; delivered ${message.sent_at}` : html` &middot; not delivered`}</p>
      <pre style="white-space:pre-wrap;background:var(--panel);padding:1rem;border-radius:8px">${message.body}</pre>
      ${message.ics_body ? html`
        <h2>Calendar invite</h2>
        <pre style="white-space:pre-wrap;background:var(--panel);padding:1rem;border-radius:8px">${message.ics_body}</pre>` : ''}
    `,
  }));
}
