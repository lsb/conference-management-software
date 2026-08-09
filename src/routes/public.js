// Everything reachable without being anybody: the call for speakers, the
// published agenda, and the embeds a conference drops into its own website.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, notFound } from '../http/router.js';
import { now, slugify, uniqueSlug } from '../db.js';
import { createSubmission, setStatus, logActivity } from '../core/submissions.js';
import { queueEmail, getTemplate } from '../core/mail.js';
import { createMagicLink, SESSION_COOKIE, consumeMagicLink } from '../core/auth.js';
import { cookieHeader } from '../http/request.js';
import { scheduledSessions } from '../core/schedule.js';
import { buildIcs, uidFor, nextSequence } from '../core/ics.js';
import { readStoredFile, isImage } from '../core/files.js';
import { renderFeed } from '../core/feeds.js';
import {
  fieldsOf, isClosed, mappedValues, valueOf, acceptedNames,
  optionResolver, conditionsFor, renderField, CONDITIONAL_FIELD_SCRIPT, validateAnswers,
} from './formfields.js';
import { resolvePersonByEmail } from './demo-auth.js';
import { findEvent, dateOnly, fullName, empty, when } from './shared.js';

export function mountPublic(router) {
  router.get('/', home, 'Index of events on this instance.');

  router.get('/submit/:event/:form', cfpForm,
    'The public call-for-speakers form. Openable by anyone; no account needed.');

  router.post('/submit/:event/:form', postCfp,
    'Submit a proposal. Creates the person if new, emails a confirmation, and returns a portal link.');

  // The extension-bearing routes are registered FIRST. A bare `:embed` matches
  // greedily, so `/embed/x/agenda.json` would otherwise be read as an embed
  // named "agenda.json" and 404.
  for (const format of ['json', 'xml', 'ics']) {
    router.get(`/embed/:event/:embed.${format}`, embedFeed,
      `An embed feed. The extension is cosmetic: the embed's own format setting `
      + `decides what comes back, so for ${format.toUpperCase()} set that embed's `
      + `format to ${format} at /e/<event>/embeds.`);
  }
  router.get('/embed/:event/:embed', embedFeed,
    'An embed feed as styled HTML. Add .json, .xml, or .ics for the same data in another shape.');

  router.get('/agenda/:event/:code.ics', sessionIcs,
    'A calendar entry for one published session, for attendees to add to their own calendar.');

  router.get('/files/:slug', serveFile,
    'A stored file: a headshot, a slide deck, a signed agreement.');
}

/**
 * Serve a stored file.
 *
 * Served with the content-type we recorded at upload, not the one the browser
 * claimed, and always with `X-Content-Type-Options: nosniff` and a
 * `Content-Security-Policy` that forbids scripts. A speaker uploading an
 * "image" full of HTML gets it back as an inert download, not as a page running
 * on our origin.
 */
function serveFile(ctx) {
  const stored = readStoredFile(ctx.db, ctx.params.slug);
  if (!stored) throw notFound(`no file '${ctx.params.slug}'`);

  const { file, data } = stored;
  return {
    status: 200,
    headers: {
      'content-type': file.content_type,
      'content-length': String(data.length),
      'content-disposition':
        `${isImage(file) ? 'inline' : 'attachment'}; filename="${file.filename}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      // Content-addressed, so the bytes behind a slug never change.
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: data,
  };
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
      <p class="sub">Running locally.
        <a href="/crm">Speaker database</a> &middot;
        <a href="/llms.txt">What this app serves</a>.</p>

      ${events.length === 0 ? empty('No events yet. Run `npm run seed` for a demo conference.') : html`
        <table>
          <thead><tr><th>Event</th><th>When</th><th>Organizer</th><th>Public</th></tr></thead>
          <tbody>
            ${events.map((e) => html`
              <tr>
                <td><strong>${e.name}</strong><br><span class="muted">${e.location}</span></td>
                <td>${dateOnly(e.starts_at, e.timezone)} &ndash; ${dateOnly(e.ends_at, e.timezone)}</td>
                <td><a href="/e/${e.slug}">Dashboard</a></td>
                <td><a href="/event/${e.slug}">Public pages</a></td>
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






function cfpForm(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const form = findForm(ctx.db, event.id, ctx.params.form);
  const closed = isClosed(form);

  // Field rendering is shared with the portal's editor (src/routes/formfields.js)
  // so a question looks and behaves the same whether it is being answered for
  // the first time or corrected a week later. It also fixes a dropdown that used
  // to render empty: tracks live in their own table, not in taxonomy_option, so
  // the resolver keys on `maps_to` rather than on a taxonomy kind that a track
  // field can never have.
  const options = optionResolver(ctx.db, event.id);
  const conditions = conditionsFor(ctx.db, form.id);
  const renderOne = (field) => renderField(field, { options, conditions });

  return ok(page({
    title: form.external_title || `Submit to ${event.name}`,
    script: conditions.length > 0 ? CONDITIONAL_FIELD_SCRIPT : null,
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
            ${fieldsOf(ctx.db, form.id, 'abstract').map(renderOne)}
          </fieldset>

          ${form.collect_participants ? html`
            <fieldset>
              <legend>About you</legend>
              ${fieldsOf(ctx.db, form.id, 'participant').map(renderOne)}
            </fieldset>` : ''}

          <div class="actions">
            <button type="submit">Submit proposal</button>
            <button type="submit" name="save_draft" value="1" class="secondary">Save as draft</button>
          </div>
          <p class="muted">A draft needs only a title. We will keep it for you and
            you can finish it any time before the call closes.</p>
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

  // A draft is a promise to come back, not a finished proposal, so only the
  // title is insisted on. Everything else can arrive on Sunday night.
  const asDraft = ctx.fields.bool('save_draft');
  const allFields = [...abstractFields, ...participantFields];

  validateAnswers(ctx.fields, allFields, {
    requireRequired: !asDraft,
    conditions: conditionsFor(ctx.db, form.id),
  });

  // Read values through the form's own `maps_to` definitions rather than by
  // guessing at names. An organizer who renames a field, or whose field slug is
  // `first-name` where this code would have said `first_name`, must not silently
  // lose the answer.
  const mapped = mappedValues(ctx.fields, [...abstractFields, ...participantFields]);

  const email = mapped['person.email']
    ?? ctx.fields.require('email', 'we need an address to send your confirmation to');

  // One person row per human, reused across every event. This is what makes a
  // returning speaker a returning speaker rather than a stranger.
  //
  // Resolution goes through the same alias-tolerant lookup the sign-in page
  // uses, so somebody who submitted once as ada@work.example and again as
  // a.lovelace@work.example does not fork into two speakers with half a
  // biography each. It never creates a row -- that stays below, and explicit.
  let person = resolvePersonByEmail(ctx.db, email);
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
  if (!asDraft) {
    setStatus(ctx.db, submission.id, 'pending', { actorPersonId: person.id, detail: 'submitted' });
  }

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

  // A draft has not been submitted, so there is nothing to confirm. Sending
  // "we have your proposal" for something the organizers cannot see would be a
  // lie the speaker acts on.
  if (form.send_confirmation_email && !asDraft) {
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

  logActivity(ctx.db, { eventId: event.id, actorPersonId: person.id, subjectType: 'submission',
    subjectId: submission.id, verb: asDraft ? 'drafted' : 'submitted', detail: form.slug });

  // Sign them straight in. Making somebody who just typed their whole biography
  // go and find an email before they can see what they sent is the friction this
  // product exists to remove.
  const session = consumeMagicLink(ctx.db, token);

  // A draft goes straight back to its own editor: the next thing its author
  // wants is to keep writing, not a receipt.
  if (asDraft && session) {
    return redirect(`/portal/${event.slug}/submissions/${submission.code}/edit?draft=1`, {
      headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, session.token) },
    });
  }

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


/** A person's headshot slug, for building its URL. Null when they have none. */
function headshotSlugFor(db, person) {
  if (!person.headshot_file_id) return null;
  return db.prepare('SELECT slug FROM file WHERE id = ?').get(person.headshot_file_id)?.slug ?? null;
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


/**
 * A fragment for embedding elsewhere.
 *
 * Served as a standalone HTML document with its own styles inlined, so dropping
 * it in an `<iframe>` needs no assets and no script from us.
 */
/**
 * An embed, in whichever shape it was configured for.
 *
 * The extension in the URL is cosmetic: the embed itself records its format, so
 * a URL already pasted into somebody's website keeps working when they switch
 * it from HTML to JSON. The route accepts the extension so the URL looks like
 * what it returns.
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
  if (!embed.enabled) {
    throw notFound('this embed is turned off',
      'an organizer can re-enable it in the event\'s Embeds screen');
  }

  const base = ctx.headers?.host ? `http://${ctx.headers.host}` : '';
  const { contentType, body } = renderFeed(ctx.db, event, embed, { baseUrl: base });

  return {
    status: 200,
    headers: {
      'content-type': contentType,
      // Embeds are read by other people's websites, so they have to be
      // fetchable cross-origin, and a minute of caching keeps a busy homepage
      // from hammering this.
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60',
    },
    body,
  };
}

