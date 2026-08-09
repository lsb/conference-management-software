// The speaker portal.
//
// Everything a speaker needs and nothing they do not: what they proposed, what
// happened to it, what they owe us, and their own details to correct.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, forbidden, notFound } from '../http/router.js';
import { now } from '../db.js';
import { createMagicLink, consumeMagicLink, signOut, SESSION_COOKIE, organizerAccessIsOpen } from '../core/auth.js';
import { cookieHeader, clearCookieHeader } from '../http/request.js';
import { outstandingTasks, completeTask } from '../core/tasks.js';
import { queueEmail } from '../core/mail.js';
import { storeUpload, IMAGE_TYPES } from '../core/files.js';
import { findEvent, statusPill, empty, dateOnly, when, fullName } from './shared.js';

export function mountPortal(router) {
  // Registered before `/portal/:event` so these literals win the match.
  router.get('/portal/sign-in', signInForm, 'Ask for a sign-in link by email.');
  router.post('/portal/sign-in', postSignIn, 'Email a one-time sign-in link.');
  router.get('/portal/sign-out', doSignOut, 'End the session.');

  router.get('/portal/:event/enter', enter,
    'Exchange a one-time token for a session. This is the link in every email we send.');

  router.get('/portal/:event', portalHome,
    'Speaker home: submissions, profile summary, and outstanding tasks.');
  router.get('/portal/:event/submissions', portalSubmissions, 'The speaker\'s own proposals.');
  router.get('/portal/:event/profile', profileForm, 'The speaker\'s own details, editable by them.');
  router.post('/portal/:event/profile', postProfile, 'Save the speaker\'s own details.');
  router.get('/portal/:event/tasks', portalTasks, 'What this speaker still owes.');
  router.post('/portal/:event/tasks/:id/complete', postCompleteTask, 'Mark one task done.');
  router.get('/portal/:event/resources', resourceIndex,
    'Reference pages for speakers: AV guidance, travel, the agreement.');
  router.get('/portal/:event/resources/:slug', resourcePage, 'One reference page.');
}

function requirePerson(ctx, event) {
  if (!ctx.person) {
    throw forbidden('you are not signed in',
      `open the link we emailed you, or request another at /portal/sign-in`);
  }
  return ctx.person;
}

// --- getting in ------------------------------------------------------------

function signInForm(ctx) {
  const sent = ctx.query.get('sent');
  const events = ctx.db.prepare('SELECT * FROM event ORDER BY starts_at DESC').all();

  return ok(page({
    title: 'Speaker sign-in',
    body: html`
      <h1>Speaker sign-in</h1>
      ${sent ? html`<p class="flash">If we know that address, a sign-in link is on its way.</p>` : ''}
      <p class="sub">No password. We email you a link that signs you in.</p>
      <form method="post" action="/portal/sign-in">
        <label for="email">Your email address</label>
        <input type="email" id="email" name="email" required autocomplete="email">
        <label for="event">Event</label>
        <select id="event" name="event">
          ${events.map((e) => html`<option value="${e.slug}">${e.name}</option>`)}
        </select>
        <div class="actions"><button type="submit">Email me a link</button></div>
      </form>
    `,
  }));
}

function postSignIn(ctx) {
  const email = ctx.fields.require('email');
  const eventSlug = ctx.fields.get('event');
  const event = eventSlug
    ? ctx.db.prepare('SELECT * FROM event WHERE slug = ?').get(eventSlug)
    : ctx.db.prepare('SELECT * FROM event ORDER BY starts_at DESC LIMIT 1').get();

  const person = ctx.db.prepare('SELECT * FROM person WHERE email = ? COLLATE NOCASE').get(email);

  // Always answer the same way. Telling a stranger whether an address is known
  // leaks the speaker list of every conference on this instance.
  if (person && event) {
    const token = createMagicLink(ctx.db, person.id, event.id);
    const base = ctx.headers?.host ? `http://${ctx.headers.host}` : 'http://127.0.0.1:8080';
    queueEmail(ctx.db, {
      eventId: event.id,
      to: person,
      subject: `Your sign-in link for ${event.name}`,
      body: `Hi {{first_name}},\n\nHere is your sign-in link. It works once, and expires in an hour.\n\n`
        + `  ${base}/portal/${event.slug}/enter?token=${token}\n\n- The ${event.name} team`,
      kind: 'bulk',
      vars: { event_name: event.name },
    });
  }

  return redirect('/portal/sign-in?sent=1');
}

function enter(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const session = consumeMagicLink(ctx.db, ctx.query.get('token'));

  if (!session) {
    return ok(page({
      title: 'That link has expired',
      body: html`
        <h1>That link no longer works</h1>
        <p>Sign-in links work once and expire after an hour.</p>
        <p><a class="button" href="/portal/sign-in">Send me a new one</a></p>`,
    }), { status: 410 });
  }

  return redirect(`/portal/${event.slug}`, {
    headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, session.token) },
  });
}

function doSignOut(ctx) {
  signOut(ctx.db, ctx.cookies);
  return redirect('/portal/sign-in', { headers: { 'set-cookie': clearCookieHeader(SESSION_COOKIE) } });
}

// --- the portal ------------------------------------------------------------

function nav(event, current, person) {
  const items = [['', 'Home'], ['/submissions', 'Submissions'], ['/profile', 'Profile'],
    ['/tasks', 'Tasks'], ['/resources', 'Resources']];
  return html`
    <header class="bar">
      <div class="inner">
        <strong>${event.name}</strong>
        <nav>
          ${items.map(([path, label]) => html`
            <a href="/portal/${event.slug}${path}" ${current === label ? raw('aria-current="page"') : ''}>${label}</a>`)}
        </nav>
        <span class="spacer"></span>
        <span class="who">${fullName(person)} &middot; <a href="/portal/sign-out">Sign out</a></span>
      </div>
    </header>`;
}

function submissionsOf(db, eventId, personId) {
  return db.prepare(
    `SELECT DISTINCT s.*, f.slug AS form_slug, o.label AS format_label
       FROM submission s
       JOIN submission_participant sp ON sp.submission_id = s.id
       LEFT JOIN form f ON f.id = s.form_id
       LEFT JOIN taxonomy_option o ON o.id = s.format_option_id
      WHERE s.event_id = ? AND sp.person_id = ?
      ORDER BY s.code`,
  ).all(eventId, personId);
}

/**
 * What the speaker is told about their own submission.
 *
 * Deliberately not the internal status. A speaker must never see `accept_queue`
 * -- that is a decision we have made but not yet stood behind, and showing it
 * would be telling them by accident, which is the exact thing the two-step
 * decision flow exists to prevent.
 */
function speakerFacingStatus(submission) {
  switch (submission.status) {
    case 'accepted': return { key: 'accepted', label: 'Accepted' };
    case 'declined': return { key: 'declined', label: 'Not accepted' };
    case 'withdrawn': return { key: 'withdrawn', label: 'Withdrawn' };
    case 'draft': return { key: 'draft', label: 'Draft' };
    default: return { key: 'pending', label: 'Under review' };
  }
}

function portalHome(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);

  const submissions = submissionsOf(ctx.db, event.id, person.id);
  const tasks = outstandingTasks(ctx.db, event.id, { personId: person.id });
  const submitted = ctx.query.get('submitted');

  return ok(page({
    title: `${event.name} - speaker portal`,
    nav: nav(event, 'Home', person),
    body: html`
      <h1>Welcome, ${person.first_name || fullName(person)}</h1>

      ${submitted ? html`<p class="flash">Thank you. Your proposal <code>${submitted}</code>
        has been received, and you can edit it here until the call closes.</p>` : ''}

      ${tasks.length > 0 ? html`
        <ul class="alerts">
          <li class="warn">You have ${tasks.length} thing${tasks.length === 1 ? '' : 's'} to do &mdash;
            <a href="/portal/${event.slug}/tasks">see what</a></li>
        </ul>` : ''}

      <h2>Your submissions</h2>
      ${submissions.length === 0 ? empty('You have not submitted anything to this event.') : html`
        <table>
          <tbody>
            ${submissions.map((s) => {
              const view = speakerFacingStatus(s);
              return html`
                <tr>
                  <td><code>${s.code}</code></td>
                  <td><strong>${s.title}</strong>${s.format_label ? html`<br><span class="muted">${s.format_label}</span>` : ''}</td>
                  <td><span class="pill ${view.key}">${view.label}</span></td>
                  <td>${s.starts_at ? when(s.starts_at, event.timezone) : ''}</td>
                </tr>`;
            })}
          </tbody>
        </table>`}

      <h2>Your profile</h2>
      <p>${person.biography || html`<span class="muted">You have not written a biography yet.</span>`}</p>
      <p><a class="button secondary" href="/portal/${event.slug}/profile">Edit your details</a></p>
    `,
  }));
}

function portalSubmissions(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);
  const submissions = submissionsOf(ctx.db, event.id, person.id);

  return ok(page({
    title: `Your submissions - ${event.name}`,
    nav: nav(event, 'Submissions', person),
    body: html`
      <h1>Your submissions</h1>
      ${submissions.length === 0 ? empty('Nothing yet.') : submissions.map((s) => {
        const view = speakerFacingStatus(s);
        return html`
          <fieldset>
            <legend><code>${s.code}</code> <span class="pill ${view.key}">${view.label}</span></legend>
            <h3 style="margin-top:0">${s.title}</h3>
            <p>${s.description}</p>
            ${s.starts_at ? html`<p class="muted">Scheduled ${when(s.starts_at, event.timezone)}</p>` : ''}
          </fieldset>`;
      })}
    `,
  }));
}

function profileForm(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);
  const saved = ctx.query.get('saved');

  const field = (name, label, value, type = 'text') => html`
    <div>
      <label for="${name}">${label}</label>
      <input type="${type}" id="${name}" name="${name}" value="${value ?? ''}">
    </div>`;

  return ok(page({
    title: `Your details - ${event.name}`,
    nav: nav(event, 'Profile', person),
    body: html`
      <h1>Your details</h1>
      <p class="sub">This is what appears in the programme and on the website. You control it.</p>
      ${saved ? html`<p class="flash">Saved.</p>` : ''}

      <form method="post" action="/portal/${event.slug}/profile" enctype="multipart/form-data">
        <fieldset>
          <legend>Your headshot</legend>
          ${person.headshot_file_id ? html`
            <p><img src="/files/${headshotSlug(ctx.db, person)}" alt="Your current headshot"
                    style="max-width:9rem;border-radius:8px"></p>` : html`
            <p class="muted">You have not uploaded one yet. It goes on the website and in
              the printed programme.</p>`}
          <label for="headshot">Upload ${person.headshot_file_id ? 'a replacement' : 'one'}
            <small>JPEG, PNG or WebP. Square works best.</small></label>
          <input type="file" id="headshot" name="headshot" accept="image/*">
        </fieldset>

        <fieldset>
          <legend>About you</legend>
          <div class="row">
            ${field('first_name', 'First name', person.first_name)}
            ${field('last_name', 'Last name', person.last_name)}
          </div>
          <div class="row">
            ${field('pronouns', 'Pronouns', person.pronouns)}
            ${field('honorific', 'Honorific', person.honorific)}
            ${field('phone', 'Phone', person.phone, 'tel')}
          </div>
          <label for="biography">Biography</label>
          <textarea id="biography" name="biography" maxlength="5000">${person.biography}</textarea>
        </fieldset>

        <fieldset>
          <legend>Links</legend>
          <div class="row">
            ${field('link_website', 'Website', person.link_website, 'url')}
            ${field('link_linkedin', 'LinkedIn', person.link_linkedin, 'url')}
          </div>
          <div class="row">
            ${field('link_x', 'X', person.link_x, 'url')}
            ${field('link_facebook', 'Facebook', person.link_facebook, 'url')}
          </div>
        </fieldset>

        <div class="actions"><button type="submit">Save</button></div>
        <p class="muted">Your email address (${person.email}) identifies you across events.
          Ask an organizer if it needs changing.</p>
      </form>
    `,
  }));
}

/** The slug of a person's headshot, for building its URL. */
function headshotSlug(db, person) {
  if (!person.headshot_file_id) return null;
  return db.prepare('SELECT slug FROM file WHERE id = ?').get(person.headshot_file_id)?.slug ?? null;
}

function postProfile(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);

  const upload = ctx.fields.file('headshot');
  if (upload) {
    const stored = storeUpload(ctx.db, {
      eventId: event.id, personId: person.id, upload, accept: IMAGE_TYPES,
    });
    ctx.db.prepare('UPDATE person SET headshot_file_id = ? WHERE id = ?')
      .run(stored.id, person.id);
  }

  ctx.db.prepare(
    `UPDATE person SET first_name = ?, last_name = ?, pronouns = ?, honorific = ?, phone = ?,
                       biography = ?, link_website = ?, link_linkedin = ?, link_x = ?,
                       link_facebook = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    ctx.fields.get('first_name', person.first_name),
    ctx.fields.get('last_name', person.last_name),
    ctx.fields.get('pronouns'), ctx.fields.get('honorific'), ctx.fields.get('phone'),
    ctx.fields.get('biography'), ctx.fields.get('link_website'), ctx.fields.get('link_linkedin'),
    ctx.fields.get('link_x'), ctx.fields.get('link_facebook'), now(), person.id,
  );

  return redirect(`/portal/${event.slug}/profile?saved=1`);
}

function portalTasks(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);

  const open = outstandingTasks(ctx.db, event.id, { personId: person.id });
  const done = ctx.db.prepare(
    `SELECT ti.id, td.title, ti.completed_at, s.code AS submission_code
       FROM task_instance ti
       JOIN task_definition td ON td.id = ti.definition_id
       LEFT JOIN submission s ON s.id = ti.submission_id
      WHERE td.event_id = ? AND ti.person_id = ? AND ti.status = 'done'
      ORDER BY ti.completed_at DESC`,
  ).all(event.id, person.id);

  return ok(page({
    title: `Your tasks - ${event.name}`,
    nav: nav(event, 'Tasks', person),
    body: html`
      <h1>Your tasks</h1>

      ${open.length === 0 ? empty('Nothing outstanding. Thank you.') : html`
        ${open.map((t) => html`
          <fieldset>
            <legend>${t.task_title}${t.required ? html` <span class="req">*</span>` : ''}</legend>
            ${t.submission_code ? html`<p class="muted">For <code>${t.submission_code}</code> &mdash; ${t.submission_title}</p>` : ''}
            <p>${t.due_at ? html`Due ${dateOnly(t.due_at, event.timezone)}` : html`<span class="muted">No deadline</span>`}</p>
            <form method="post" action="/portal/${event.slug}/tasks/${t.id}/complete"
                  enctype="multipart/form-data">
              ${t.requirement === 'file' ? html`
                <label for="file_${t.id}">Upload your file</label>
                <input type="file" id="file_${t.id}" name="upload" required>` : ''}
              <div class="actions">
                <button type="submit">${t.requirement === 'acknowledge' ? 'I have done this' : 'Mark done'}</button>
              </div>
            </form>
          </fieldset>`)}`}

      ${done.length > 0 ? html`
        <h2>Done</h2>
        <table><tbody>
          ${done.map((t) => html`
            <tr><td>${t.title}</td>
              <td>${t.submission_code ? html`<code>${t.submission_code}</code>` : ''}</td>
              <td class="muted">${dateOnly(t.completed_at, event.timezone)}</td></tr>`)}
        </tbody></table>` : ''}
    `,
  }));
}

function resourceIndex(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);

  const pages = ctx.db.prepare(
    `SELECT slug, title FROM resource_page WHERE event_id = ? AND published = 1
      ORDER BY sort_order, title`,
  ).all(event.id);

  return ok(page({
    title: `Resources - ${event.name}`,
    nav: nav(event, 'Resources', person),
    body: html`
      <h1>Resources</h1>
      <p class="sub">Everything we would otherwise have emailed you twice.</p>
      ${pages.length === 0 ? empty('Nothing here yet.') : html`
        <div class="stack">
          ${pages.map((p) => html`
            <div class="card">
              <a href="/portal/${event.slug}/resources/${p.slug}"><strong>${p.title}</strong></a>
            </div>`)}
        </div>`}
    `,
  }));
}

function resourcePage(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);

  const resource = ctx.db.prepare(
    'SELECT * FROM resource_page WHERE event_id = ? AND slug = ? AND published = 1',
  ).get(event.id, ctx.params.slug);

  if (!resource) {
    const known = ctx.db.prepare(
      'SELECT slug FROM resource_page WHERE event_id = ? AND published = 1',
    ).all(event.id).map((r) => r.slug);
    throw notFound(`no resource page '${ctx.params.slug}'`,
      known.length ? `pages are: ${known.join(', ')}` : 'this event has no resource pages');
  }

  return ok(page({
    title: `${resource.title} - ${event.name}`,
    nav: nav(event, 'Resources', person),
    body: html`
      <p class="sub"><a href="/portal/${event.slug}/resources">&larr; Resources</a></p>
      <h1>${resource.title}</h1>
      ${/* Organizer-authored content, including embed markup, which is the point
            of the feature: an existing AV guide can be pasted in whole. Speakers
            cannot write here -- only event staff can, so the trust boundary is
            the same one that already lets staff email them. */ ''}
      <div>${raw(resource.body)}</div>
    `,
  }));
}

function postCompleteTask(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  const person = requirePerson(ctx, event);
  const id = Number(ctx.params.id);

  const instance = ctx.db.prepare(
    `SELECT ti.*, td.event_id, td.requirement FROM task_instance ti
       JOIN task_definition td ON td.id = ti.definition_id WHERE ti.id = ?`,
  ).get(id);

  if (!instance || instance.event_id !== event.id) throw notFound(`no task ${id} in this event`);
  if (instance.person_id !== person.id) {
    throw forbidden('that task belongs to somebody else');
  }

  let fileId = null;
  if (instance.requirement === 'file') {
    const upload = ctx.fields.requireFile('upload', 'this task is completed by uploading a file');
    fileId = storeUpload(ctx.db, { eventId: event.id, personId: person.id, upload }).id;
  }

  completeTask(ctx.db, id, { fileId });
  return redirect(`/portal/${event.slug}/tasks`);
}
