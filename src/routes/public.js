// Everything reachable without being anybody: the call for speakers, the
// published agenda, and the embeds a conference drops into its own website.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, notFound } from '../http/router.js';
import { now, slugify, uniqueSlug } from '../db.js';
import { createSubmission, setStatus, logActivity } from '../core/submissions.js';
import { queueEmail, getTemplate } from '../core/mail.js';
import { createMagicLink, SESSION_COOKIE, consumeMagicLink } from '../core/auth.js';
import { cookieHeader } from '../http/request.js';
import { scheduledSessions, agendaByDay, localTime } from '../core/schedule.js';
import { buildIcs, uidFor, nextSequence } from '../core/ics.js';
import { findEvent, dateOnly, fullName, empty, when } from './shared.js';

export function mountPublic(router) {
  router.get('/', home, 'Index of events on this instance.');

  router.get('/submit/:event/:form', cfpForm,
    'The public call-for-speakers form. Openable by anyone; no account needed.');

  router.post('/submit/:event/:form', postCfp,
    'Submit a proposal. Creates the person if new, emails a confirmation, and returns a portal link.');

  router.get('/agenda/:event', publicAgenda,
    'The published schedule. Only sessions marked public appear.');

  router.get('/speakers/:event', speakerGallery,
    'The published speaker gallery.');

  router.get('/embed/:event/:embed', embedFeed,
    'A styled HTML fragment of the agenda or speakers, for embedding in another site.');

  router.get('/agenda/:event/:code.ics', sessionIcs,
    'A calendar entry for one published session, for attendees to add to their own calendar.');
}

/**
 * A downloadable calendar entry for a published session.
 *
 * Speakers get theirs emailed as an invite they can accept; attendees get this,
 * which is the same event at the same UID, so somebody who is both does not end
 * up with two entries.
 */
function sessionIcs(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const code = String(ctx.params.code).toUpperCase();

  const session = ctx.db.prepare(
    `SELECT s.*, r.name AS room_name FROM submission s
       LEFT JOIN room r ON r.id = s.room_id
      WHERE s.event_id = ? AND s.code = ? AND s.status = 'accepted' AND s.published = 1`,
  ).get(event.id, code);

  if (!session || !session.starts_at) {
    throw notFound(`no published session '${code}' in this event`,
      `the published schedule is at /agenda/${event.slug}`);
  }

  const body = buildIcs({
    uid: uidFor(event.slug, session.code),
    sequence: nextSequence(ctx.db, session.id),
    title: `${session.title} (${event.name})`,
    description: session.description,
    location: [session.room_name, event.location].filter(Boolean).join(', '),
    startsAt: session.starts_at,
    endsAt: session.ends_at,
    url: event.website_url,
  });

  return {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${session.code.toLowerCase()}.ics"`,
      'cache-control': 'public, max-age=300',
    },
    body,
  };
}

function home(ctx) {
  const events = ctx.db.prepare('SELECT * FROM event ORDER BY starts_at DESC').all();

  return ok(page({
    title: 'Conference management',
    body: html`
      <h1>Conference management</h1>
      <p class="sub">Running locally. <a href="/llms.txt">What this app serves</a>.</p>

      ${events.length === 0 ? empty('No events yet. Run `npm run seed` for a demo conference.') : html`
        <table>
          <thead><tr><th>Event</th><th>When</th><th>Organizer</th><th>Public</th></tr></thead>
          <tbody>
            ${events.map((e) => html`
              <tr>
                <td><strong>${e.name}</strong><br><span class="muted">${e.location}</span></td>
                <td>${dateOnly(e.starts_at, e.timezone)} &ndash; ${dateOnly(e.ends_at, e.timezone)}</td>
                <td><a href="/e/${e.slug}">Dashboard</a></td>
                <td><a href="/agenda/${e.slug}">Agenda</a> &middot;
                    <a href="/speakers/${e.slug}">Speakers</a></td>
              </tr>`)}
          </tbody>
        </table>`}
    `,
  }));
}

// --- call for speakers -----------------------------------------------------

function findForm(db, eventId, slug) {
  const form = db.prepare('SELECT * FROM form WHERE event_id = ? AND slug = ?').get(eventId, slug);
  if (!form) {
    const known = db.prepare("SELECT slug FROM form WHERE event_id = ? AND kind = 'submission'")
      .all(eventId).map((f) => f.slug);
    throw notFound(`no submission form '${slug}' for this event`,
      known.length ? `forms are: ${known.join(', ')}` : 'this event has no submission form yet');
  }
  return form;
}

function fieldsOf(db, formId, section) {
  return db.prepare(
    'SELECT * FROM form_field WHERE form_id = ? AND section = ? ORDER BY sort_order, id',
  ).all(formId, section);
}

function isClosed(form) {
  return Boolean(form.close_at && form.close_at < now());
}

/**
 * Collect answers keyed by what they map onto, e.g. `person.first_name`.
 *
 * A field's slug is the organizer's label for it and can be anything --
 * `first-name`, `your_name`, `speaker_first`. Only `maps_to` says where the
 * answer belongs, so that is what the handler reads.
 *
 * The last segment of `maps_to` is accepted as an alias, so an API client or a
 * script can post the obvious `first_name` without first fetching the form
 * definition to learn what this particular organizer called it.
 */
function mappedValues(fields, formFields) {
  const out = {};
  for (const field of formFields) {
    if (!field.maps_to) continue;
    const value = valueOf(fields, field);
    if (value !== '') out[field.maps_to] = value;
  }
  return out;
}

/** One field's answer, accepting either its slug or its `maps_to` alias. */
function valueOf(fields, field) {
  const alias = field.maps_to ? field.maps_to.split('.').pop() : null;
  return fields.get(field.slug) || (alias ? fields.get(alias) : '');
}

/** The names a caller may use for a field, for error messages. */
function acceptedNames(field) {
  const alias = field.maps_to ? field.maps_to.split('.').pop() : null;
  return alias && alias !== field.slug ? `'${field.slug}' (or '${alias}')` : `'${field.slug}'`;
}

function cfpForm(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const form = findForm(ctx.db, event.id, ctx.params.form);
  const closed = isClosed(form);

  const options = (kind) => ctx.db.prepare(
    'SELECT * FROM taxonomy_option WHERE event_id = ? AND kind = ? ORDER BY sort_order, label',
  ).all(event.id, kind);
  const tracks = ctx.db.prepare('SELECT * FROM track WHERE event_id = ? ORDER BY sort_order').all(event.id);

  const renderField = (field) => {
    const id = `f_${field.slug}`;
    const label = html`<label for="${id}">${field.label}${field.required ? raw(' <span class="req">*</span>') : ''}
      ${field.help_text ? html`<small>${field.help_text}</small>` : ''}</label>`;

    if (field.field_type === 'select') {
      const choices = field.options_kind === 'track'
        ? tracks.map((t) => ({ slug: t.slug, label: t.name }))
        : options(field.options_kind ?? '').map((o) => ({ slug: o.slug, label: o.label }));
      return html`${label}
        <select id="${id}" name="${field.slug}" ${field.required ? raw('required') : ''}>
          <option value="">- choose -</option>
          ${choices.map((c) => html`<option value="${c.slug}">${c.label}</option>`)}
        </select>`;
    }
    if (field.field_type === 'multiselect') {
      const choices = options(field.options_kind ?? '');
      return html`${label}
        <select id="${id}" name="${field.slug}" multiple size="4">
          ${choices.map((c) => html`<option value="${c.slug}">${c.label}</option>`)}
        </select>`;
    }
    if (field.field_type === 'textarea' || field.field_type === 'richtext') {
      return html`${label}<textarea id="${id}" name="${field.slug}"
        ${field.required ? raw('required') : ''}
        ${field.max_chars ? raw(`maxlength="${field.max_chars}"`) : ''}></textarea>`;
    }
    const type = { email: 'email', phone: 'tel', url: 'url', number: 'number', date: 'date' }[field.field_type] ?? 'text';
    return html`${label}<input type="${type}" id="${id}" name="${field.slug}"
      ${field.required ? raw('required') : ''}
      ${field.max_chars ? raw(`maxlength="${field.max_chars}"`) : ''}>`;
  };

  return ok(page({
    title: form.external_title || `Submit to ${event.name}`,
    body: html`
      <h1>${form.page_heading || form.external_title || 'Call for speakers'}</h1>

      <ul class="alerts">
        <li>
          ${form.close_at
            ? html`Submissions ${closed ? 'closed' : 'are accepted until'}
                   ${dateOnly(form.close_at, event.timezone)}.`
            : html`Submissions are open.`}
          ${form.submission_limit ? html` Limit: ${form.submission_limit} per person.` : ''}
        </li>
      </ul>

      ${form.welcome_message ? html`<div>${raw(form.welcome_message)}</div>` : ''}

      ${closed ? empty('This call for speakers has closed.') : html`
        <form method="post" action="/submit/${event.slug}/${form.slug}">
          <fieldset>
            <legend>Your proposal</legend>
            ${fieldsOf(ctx.db, form.id, 'abstract').map(renderField)}
          </fieldset>

          ${form.collect_participants ? html`
            <fieldset>
              <legend>About you</legend>
              ${fieldsOf(ctx.db, form.id, 'participant').map(renderField)}
            </fieldset>` : ''}

          <div class="actions"><button type="submit">Submit proposal</button></div>
          <p class="muted">You do not need an account. We will email you a link to track it.</p>
        </form>`}
    `,
  }));
}

/**
 * Accept a proposal.
 *
 * The customer marked the end of this flow "make sure this works", and it is the
 * seam the whole product turns on: a stranger fills in a form and comes out the
 * other side as a person with a submission, a confirmation email, and a portal
 * they are already signed in to. Nothing is re-keyed and nobody is asked to
 * invent a password.
 */
function postCfp(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const form = findForm(ctx.db, event.id, ctx.params.form);

  if (isClosed(form)) {
    throw badRequest('this call for speakers has closed',
      `it closed on ${dateOnly(form.close_at, event.timezone)}`);
  }

  const abstractFields = fieldsOf(ctx.db, form.id, 'abstract');
  const participantFields = fieldsOf(ctx.db, form.id, 'participant');

  for (const field of [...abstractFields, ...participantFields]) {
    const value = valueOf(ctx.fields, field);
    if (field.required && value === '') {
      throw badRequest(`missing required field: ${field.label}`,
        `send ${acceptedNames(field)} in the request body`);
    }
    if (field.max_chars && value.length > field.max_chars) {
      throw badRequest(`${field.label} is longer than ${field.max_chars} characters`,
        `it was ${value.length}`);
    }
  }

  // Read values through the form's own `maps_to` definitions rather than by
  // guessing at names. An organizer who renames a field, or whose field slug is
  // `first-name` where this code would have said `first_name`, must not silently
  // lose the answer.
  const mapped = mappedValues(ctx.fields, [...abstractFields, ...participantFields]);

  const email = mapped['person.email']
    ?? ctx.fields.require('email', 'we need an address to send your confirmation to');

  // One person row per human, matched on email, reused across every event. This
  // is what makes a returning speaker a returning speaker rather than a stranger.
  let person = ctx.db.prepare('SELECT * FROM person WHERE email = ? COLLATE NOCASE').get(email);
  const t = now();
  const first = mapped['person.first_name'] ?? '';
  const last = mapped['person.last_name'] ?? '';
  const phone = mapped['person.phone'] ?? '';
  const biography = mapped['person.biography'] ?? '';

  if (!person) {
    const slug = uniqueSlug(`${first} ${last}`.trim() || email.split('@')[0],
      (s) => ctx.db.prepare('SELECT 1 FROM person WHERE slug = ?').get(s));
    person = ctx.db.prepare(
      `INSERT INTO person (slug, email, first_name, last_name, phone, biography, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(slug, email, first, last, phone, biography, t, t);
  } else {
    // Fill in blanks from the new submission, but never overwrite what the person
    // has already curated about themselves in their portal.
    ctx.db.prepare(
      `UPDATE person SET
         first_name = CASE WHEN first_name = '' THEN ? ELSE first_name END,
         last_name  = CASE WHEN last_name  = '' THEN ? ELSE last_name  END,
         phone      = CASE WHEN phone      = '' THEN ? ELSE phone      END,
         biography  = CASE WHEN biography  = '' THEN ? ELSE biography  END,
         updated_at = ?
       WHERE id = ?`,
    ).run(first, last, phone, biography, t, person.id);
  }

  if (form.submission_limit) {
    const { n } = ctx.db.prepare(
      `SELECT count(*) AS n FROM submission
        WHERE form_id = ? AND submitted_by_person_id = ? AND status != 'withdrawn'`,
    ).get(form.id, person.id);
    if (n >= form.submission_limit) {
      throw badRequest(`you have reached this form's limit of ${form.submission_limit} submissions`,
        'withdraw one from your speaker portal if you want to replace it');
    }
  }

  const trackSlug = mapped['submission.track_id'] ?? ctx.fields.get('track');
  const track = trackSlug
    ? ctx.db.prepare('SELECT * FROM track WHERE event_id = ? AND slug = ?').get(event.id, trackSlug)
    : null;

  const submission = createSubmission(ctx.db, {
    eventId: event.id,
    formId: form.id,
    submittedByPersonId: person.id,
    title: mapped['submission.title'] ?? ctx.fields.require('title'),
    description: mapped['submission.description'] ?? ctx.fields.get('description'),
    trackId: track?.id ?? null,
    status: 'draft',
  });
  setStatus(ctx.db, submission.id, 'pending', { actorPersonId: person.id, detail: 'submitted' });

  ctx.db.prepare(
    `INSERT INTO submission_participant (submission_id, person_id, role, is_primary_contact, sort_order)
     VALUES (?, ?, 'speaker', 1, 0)`,
  ).run(submission.id, person.id);

  for (const [kind, column] of [['format', 'format_option_id'], ['level', 'level_option_id'], ['language', 'language_option_id']]) {
    const slug = mapped[`submission.${column}`] ?? ctx.fields.get(kind);
    if (!slug) continue;
    const option = ctx.db.prepare(
      'SELECT id FROM taxonomy_option WHERE event_id = ? AND kind = ? AND slug = ?',
    ).get(event.id, kind, slug);
    if (option) {
      ctx.db.prepare(`UPDATE submission SET ${column} = ? WHERE id = ?`).run(option.id, submission.id);
    }
  }

  for (const slug of ctx.fields.list('tags')) {
    const option = ctx.db.prepare(
      "SELECT id FROM taxonomy_option WHERE event_id = ? AND kind = 'tag' AND slug = ?",
    ).get(event.id, slug);
    if (option) {
      ctx.db.prepare('INSERT OR IGNORE INTO submission_tag (submission_id, option_id) VALUES (?, ?)')
        .run(submission.id, option.id);
    }
  }

  // Custom questions -- anything without a `maps_to` -- keep their answers here.
  for (const field of abstractFields) {
    if (field.maps_to) continue;
    const value = ctx.fields.get(field.slug);
    if (value === '') continue;
    ctx.db.prepare(
      'INSERT OR REPLACE INTO submission_answer (submission_id, field_id, value) VALUES (?, ?, ?)',
    ).run(submission.id, field.id, value);
  }

  const token = createMagicLink(ctx.db, person.id, event.id);
  const base = ctx.headers?.host ? `http://${ctx.headers.host}` : 'http://127.0.0.1:8080';
  const portalUrl = `${base}/portal/${event.slug}/enter?token=${token}`;

  if (form.send_confirmation_email) {
    const template = getTemplate(ctx.db, event.id, 'submission_confirmation');
    queueEmail(ctx.db, {
      eventId: event.id,
      to: person,
      subject: template.subject,
      body: form.confirmation_email_body || template.body,
      kind: 'submission_confirmation',
      templateSlug: 'submission_confirmation',
      submissionId: submission.id,
      vars: {
        event_name: event.name,
        submission_title: submission.title,
        submission_code: submission.code,
        portal_url: portalUrl,
      },
    });
  }

  logActivity(ctx.db, { eventId: event.id, actorPersonId: person.id,
    subjectType: 'submission', subjectId: submission.id, verb: 'submitted', detail: form.slug });

  // Sign them straight in. Making somebody who just typed their whole biography
  // go and find an email before they can see what they sent is the friction this
  // product exists to remove.
  const session = consumeMagicLink(ctx.db, token);

  if (form.auto_redirect_to_portal && session) {
    return redirect(`/portal/${event.slug}?submitted=${submission.code}`, {
      headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, session.token) },
    });
  }

  return ok(page({
    title: 'Thank you',
    body: html`
      <h1>Thank you</h1>
      ${form.success_message ? html`<div>${raw(form.success_message)}</div>`
        : html`<p>We have your proposal. Its reference is <code>${submission.code}</code>.</p>`}
      <p><a class="button" href="/portal/${event.slug}/enter?token=${token}">Go to your speaker portal</a></p>
    `,
  }), session ? { headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, session.token) } } : {});
}

// --- published views -------------------------------------------------------

function publishedSessions(db, eventId) {
  return scheduledSessions(db, eventId).filter((s) => s.published && s.status === 'accepted');
}

function publicAgenda(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const sessions = publishedSessions(ctx.db, event.id);
  const days = agendaByDay(ctx.db, event.id, event.timezone)
    .map(({ day, sessions: list }) => ({ day, sessions: list.filter((s) => s.published && s.status === 'accepted') }))
    .filter((d) => d.sessions.length > 0);

  return ok(page({
    title: `${event.name} - agenda`,
    body: html`
      <h1>${event.name}</h1>
      <p class="sub">${dateOnly(event.starts_at, event.timezone)} &ndash; ${dateOnly(event.ends_at, event.timezone)}
        ${event.location ? html` &middot; ${event.location}` : ''} &middot;
        <a href="/speakers/${event.slug}">Speakers</a></p>

      ${sessions.length === 0 ? empty('The schedule is not published yet.') : days.map(({ day, sessions: list }) => html`
        <h2>${day}</h2>
        <table>
          <thead><tr><th>Time</th><th>Session</th><th>Room</th><th>Track</th><th>Add</th></tr></thead>
          <tbody>
            ${list.map((s) => html`
              <tr>
                <td>${localTime(s.starts_at, event.timezone)}</td>
                <td><strong>${s.title}</strong><br><span class="muted">${speakerNames(ctx.db, s.id)}</span></td>
                <td>${s.room_name ?? ''}</td>
                <td>${s.track_name ?? ''}</td>
                <td><a href="/agenda/${event.slug}/${s.code}.ics"
                       title="Add ${s.code} to your calendar">calendar</a></td>
              </tr>`)}
          </tbody>
        </table>`)}
    `,
  }));
}

/** Everyone speaking across a set of sessions, each listed once. */
function uniqueSpeakers(db, sessions) {
  const byId = new Map();
  for (const session of sessions) {
    const people = db.prepare(
      `SELECT p.* FROM submission_participant sp JOIN person p ON p.id = sp.person_id
        WHERE sp.submission_id = ? ORDER BY sp.sort_order`,
    ).all(session.id);
    for (const person of people) {
      if (!byId.has(person.id)) byId.set(person.id, person);
    }
  }
  return [...byId.values()].sort((a, b) =>
    `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`));
}

function speakerNames(db, submissionId) {
  return db.prepare(
    `SELECT p.first_name, p.last_name FROM submission_participant sp
       JOIN person p ON p.id = sp.person_id WHERE sp.submission_id = ? ORDER BY sp.sort_order`,
  ).all(submissionId).map(fullName).join(', ');
}

function speakerGallery(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const people = ctx.db.prepare(
    `SELECT DISTINCT p.* FROM person p
       JOIN submission_participant sp ON sp.person_id = p.id
       JOIN submission s ON s.id = sp.submission_id
      WHERE s.event_id = ? AND s.status = 'accepted' AND s.published = 1
      ORDER BY p.last_name, p.first_name`,
  ).all(event.id);

  return ok(page({
    title: `${event.name} - speakers`,
    body: html`
      <h1>Speakers</h1>
      <p class="sub"><a href="/agenda/${event.slug}">Back to the agenda</a></p>
      ${people.length === 0 ? empty('No speakers announced yet.') : html`
        <div class="grid2">
          ${people.map((p) => html`
            <div class="card">
              <strong>${fullName(p)}</strong>
              ${p.biography ? html`<p>${p.biography}</p>` : ''}
              ${p.link_website ? html`<p><a href="${p.link_website}">${p.link_website}</a></p>` : ''}
            </div>`)}
        </div>`}
    `,
  }));
}

/**
 * A fragment for embedding elsewhere.
 *
 * Served as a standalone HTML document with its own styles inlined, so dropping
 * it in an `<iframe>` needs no assets and no script from us.
 */
function embedFeed(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const embed = ctx.db.prepare('SELECT * FROM embed WHERE event_id = ? AND slug = ?')
    .get(event.id, ctx.params.embed);
  if (!embed) {
    const known = ctx.db.prepare('SELECT slug FROM embed WHERE event_id = ?').all(event.id)
      .map((e) => e.slug);
    throw notFound(`no embed '${ctx.params.embed}'`,
      known.length ? `embeds are: ${known.join(', ')}` : 'this event has no embeds');
  }
  if (!embed.enabled) throw notFound('this embed is disabled');

  const sessions = publishedSessions(ctx.db, event.id)
    .filter((s) => !embed.filter_track_id || s.track_id === embed.filter_track_id);

  const showsPeople = embed.feed === 'speaker_gallery' || embed.feed === 'speaker_list';

  const body = showsPeople
    ? html`<div class="grid2">
        ${uniqueSpeakers(ctx.db, sessions).map((p) => html`
          <div class="card">
            <strong>${fullName(p)}</strong>
            ${p.biography ? html`<p>${p.biography}</p>` : ''}
          </div>`)}
      </div>`
    : html`<table>
        <tbody>
          ${sessions.map((s) => html`
            <tr>
              <td>${dateOnly(s.starts_at, event.timezone)} ${localTime(s.starts_at, event.timezone)}</td>
              <td><strong>${s.title}</strong><br><span class="muted">${speakerNames(ctx.db, s.id)}</span></td>
              <td>${s.room_name ?? ''}</td>
            </tr>`)}
        </tbody>
      </table>`;

  return ok(page({
    title: embed.name,
    body: sessions.length === 0 ? empty('Nothing published yet.') : body,
  }), { headers: { 'cache-control': 'public, max-age=60' } });
}
