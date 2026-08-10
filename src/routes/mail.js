// Bulk email.
//
// The shape here is deliberate: you cannot reach the send button without having
// been shown the recipient list first. Bulk mail to speakers is the highest
// consequence action in the product after acceptance decisions, and the failure
// mode is always the same one — sending to a list you assumed rather than read.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest } from '../http/router.js';
import { AUDIENCES, audienceSizes, resolveAudience, UnknownAudienceError } from '../core/audience.js';
import { queueEmail, renderTemplate, templateVariables } from '../core/mail.js';
import { taskDefinitions } from '../core/tasks.js';
import { createMagicLink } from '../core/auth.js';
import { findEvent, requireOrganizer, organizerNav, empty, fullName } from './shared.js';

export function mountMail(router) {
  router.get('/e/:event/mail', composer,
    'Compose a bulk message. ?audience=<key> previews exactly who would receive it. '
    + 'The audience keys, and the same preview as JSON, are at /api/events/<event>/audiences.');

  router.post('/e/:event/mail', send,
    'Queue a bulk message to an audience. Body: audience, subject, body. '
    + 'This is what to use for a deadline change or a paperwork nag; notify announces decisions. '
    + 'Add preview=1 to render the first message without sending anything.');
}

function templatesFor(db, eventId) {
  return db.prepare('SELECT slug, name, subject, body FROM email_template WHERE event_id = ? ORDER BY name')
    .all(eventId);
}

function composer(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const audiences = audienceSizes(ctx.db, event.id);
  const templates = templatesFor(ctx.db, event.id);
  const tasks = taskDefinitions(ctx.db, event.id);

  const selectedKey = ctx.query.get('audience');
  const taskSlug = ctx.query.get('task') || null;
  const sent = ctx.query.get('sent');

  let recipients = [];
  if (selectedKey) {
    try {
      recipients = resolveAudience(ctx.db, event.id, selectedKey, { taskSlug });
    } catch (err) {
      if (err instanceof UnknownAudienceError) throw badRequest(err.message, err.hint);
      throw err;
    }
  }

  const chosenTemplate = templates.find((t) => t.slug === ctx.query.get('template'));

  return ok(page({
    title: `Bulk email - ${event.name}`,
    nav: organizerNav(event, 'Outbox'),
    wide: true,
    body: html`
      <h1>Send a message</h1>
      <p class="sub">Pick who it goes to, read the list, then write it.
        Messages are written to the <a href="/e/${event.slug}/outbox">outbox</a>.</p>

      ${sent ? html`<p class="flash">Queued ${sent} message${sent === '1' ? '' : 's'}.</p>` : ''}

      <h2>1. Who</h2>
      <form method="get" class="row">
        <div>
          <label for="audience">Audience</label>
          <select id="audience" name="audience">
            <option value="">- choose -</option>
            ${audiences.map((a) => html`
              <option value="${a.key}" ${a.key === selectedKey ? raw('selected') : ''}>
                ${a.label} (${a.count})
              </option>`)}
          </select>
        </div>
        <div>
          <label for="task">Only those owing <small>optional, narrows the task audience</small></label>
          <select id="task" name="task">
            <option value="">- any task -</option>
            ${tasks.map((t) => html`
              <option value="${t.slug}" ${t.slug === taskSlug ? raw('selected') : ''}>${t.title}</option>`)}
          </select>
        </div>
        <div style="flex:0 0 auto"><button type="submit">Show me who</button></div>
      </form>

      ${selectedKey ? html`
        <p class="sub">${AUDIENCES.find((a) => a.key === selectedKey)?.description ?? ''}</p>
        ${recipients.length === 0 ? empty('Nobody matches. Nothing would be sent.') : html`
          <div class="scroll">
          <table>
            <thead><tr><th>Name</th><th>Email</th></tr></thead>
            <tbody>
              ${recipients.map((p) => html`<tr><td>${fullName(p)}</td><td class="muted">${p.email}</td></tr>`)}
            </tbody>
          </table>
          </div>`}
      ` : empty('Choose an audience to see who would receive this.')}

      ${selectedKey && recipients.length > 0 ? html`
        <h2>2. What</h2>

        ${templates.length > 0 ? html`
          <form method="get" class="row">
            <input type="hidden" name="audience" value="${selectedKey}">
            ${taskSlug ? html`<input type="hidden" name="task" value="${taskSlug}">` : ''}
            <div>
              <label for="template">Start from a saved template</label>
              <select id="template" name="template">
                <option value="">- write it fresh -</option>
                ${templates.map((t) => html`
                  <option value="${t.slug}" ${t.slug === chosenTemplate?.slug ? raw('selected') : ''}>${t.name}</option>`)}
              </select>
            </div>
            <div style="flex:0 0 auto"><button type="submit" class="secondary">Load</button></div>
          </form>` : ''}

        <form method="post" action="/e/${event.slug}/mail">
          <input type="hidden" name="audience" value="${selectedKey}">
          ${taskSlug ? html`<input type="hidden" name="task" value="${taskSlug}">` : ''}
          ${chosenTemplate ? html`<input type="hidden" name="template" value="${chosenTemplate.slug}">` : ''}

          <label for="subject">Subject</label>
          <input type="text" id="subject" name="subject" required
                 value="${chosenTemplate?.subject ?? ''}">

          <label for="body">Message
            <small>{{first_name}}, {{full_name}}, {{email}}, {{event_name}} and {{portal_url}} are filled in per person.</small>
          </label>
          <textarea id="body" name="body" required rows="14">${chosenTemplate?.body ?? ''}</textarea>

          <div class="actions">
            <button type="submit" name="preview" value="1" class="secondary">Preview the first one</button>
            <button type="submit">Send to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}</button>
          </div>
        </form>` : ''}
    `,
  }));
}

function send(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const audienceKey = ctx.fields.require('audience',
    `one of: ${AUDIENCES.map((a) => a.key).join(', ')}`);
  const taskSlug = ctx.fields.get('task') || null;

  let recipients;
  try {
    recipients = resolveAudience(ctx.db, event.id, audienceKey, { taskSlug });
  } catch (err) {
    if (err instanceof UnknownAudienceError) throw badRequest(err.message, err.hint);
    throw err;
  }

  if (recipients.length === 0) {
    throw badRequest('that audience is empty, so nothing would be sent',
      `check who matches at /e/${event.slug}/mail?audience=${audienceKey}`);
  }

  const subject = ctx.fields.require('subject');
  const body = ctx.fields.require('body');
  const base = ctx.origin;

  const varsFor = (person) => ({
    event_name: event.name,
    portal_url: `${base}/portal/${event.slug}/enter?token=${createMagicLink(ctx.db, person.id, event.id)}`,
  });

  // Rendering the first message against a real person catches the mistake that
  // matters -- a placeholder nobody will fill in -- before it goes to everyone.
  if (ctx.fields.bool('preview')) {
    const [first] = recipients;
    const merged = {
      first_name: first.first_name, last_name: first.last_name,
      full_name: fullName(first), email: first.email, ...varsFor(first),
    };
    const rendered = renderTemplate(body, merged);
    const unresolved = templateVariables(rendered);

    return ok(page({
      title: `Preview - ${event.name}`,
      nav: organizerNav(event, 'Outbox'),
      body: html`
        <p class="sub"><a href="/e/${event.slug}/mail?audience=${audienceKey}">&larr; Back to the composer</a></p>
        <h1>Preview</h1>
        <p class="sub">As ${fullName(first)} &lt;${first.email}&gt; would see it.
          ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} in total.</p>

        ${unresolved.length > 0 ? html`
          <ul class="alerts">
            <li class="stop">These placeholders have no value and would be sent literally:
              ${unresolved.map((v) => html`<code>{{${v}}}</code> `)}</li>
          </ul>` : ''}

        <p><strong>${renderTemplate(subject, merged)}</strong></p>
        <pre style="white-space:pre-wrap;background:var(--panel);padding:1rem;border-radius:8px">${rendered}</pre>

        <form method="post" action="/e/${event.slug}/mail">
          <input type="hidden" name="audience" value="${audienceKey}">
          ${taskSlug ? html`<input type="hidden" name="task" value="${taskSlug}">` : ''}
          <input type="hidden" name="subject" value="${subject}">
          <textarea name="body" hidden>${body}</textarea>
          <div class="actions">
            <button type="submit">Send to ${recipients.length}</button>
            <a class="button secondary" href="/e/${event.slug}/mail?audience=${audienceKey}">Keep editing</a>
          </div>
        </form>`,
    }));
  }

  for (const person of recipients) {
    queueEmail(ctx.db, {
      eventId: event.id,
      to: person,
      subject,
      body,
      kind: 'bulk',
      templateSlug: ctx.fields.get('template') || null,
      vars: varsFor(person),
    });
  }

  return redirect(`/e/${event.slug}/mail?sent=${recipients.length}`);
}
