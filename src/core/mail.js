// Outbound mail.
//
// Nothing here talks to an SMTP server. Every message is rendered and written to
// the `outbox` table, and delivery is a separate, pluggable step. That means the
// reminder and decision logic is fully testable and fully demonstrable with no
// mail configuration at all, and "what exactly did we send that speaker, and
// when" stays answerable forever. See docs/DECISIONS.md D5.

import { now } from '../db.js';

/**
 * Substitute {{placeholders}} in a template body.
 *
 * Unknown placeholders are left untouched rather than blanked, so a typo in a
 * template shows up as a visible `{{spekaer_name}}` in the outbox preview
 * instead of silently sending a sentence with a hole in it.
 */
export function renderTemplate(body, vars = {}) {
  return String(body).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) =>
    Object.hasOwn(vars, key) && vars[key] != null ? String(vars[key]) : match,
  );
}

/** Collect the placeholder names a template uses, for the template editor. */
export function templateVariables(body) {
  return [...new Set([...String(body).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];
}

/**
 * Render a message and put it in the outbox. Returns the new outbox row id.
 *
 * `to` is a person row (or at minimum `{ id, email, first_name, last_name }`).
 */
export function queueEmail(db, {
  eventId,
  to,
  subject,
  body,
  kind,
  templateSlug = null,
  submissionId = null,
  taskInstanceId = null,
  vars = {},
  ics = null,
}) {
  const merged = {
    first_name: to.first_name ?? '',
    last_name: to.last_name ?? '',
    full_name: `${to.first_name ?? ''} ${to.last_name ?? ''}`.trim(),
    email: to.email,
    ...vars,
  };

  return db.prepare(
    `INSERT INTO outbox (event_id, to_person_id, to_email, subject, body, kind,
                         template_slug, submission_id, task_instance_id,
                         ics_uid, ics_sequence, ics_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  ).get(
    eventId,
    to.id ?? null,
    to.email,
    renderTemplate(subject, merged),
    renderTemplate(body, merged),
    kind,
    templateSlug,
    submissionId,
    taskInstanceId,
    ics?.uid ?? null,
    ics?.sequence ?? null,
    ics?.body ?? null,
    now(),
  ).id;
}

/**
 * Look up an event's template by slug, falling back to a built-in default.
 *
 * Defaults exist so a brand-new event can run a whole CFP without anyone editing
 * copy first. They are deliberately plain.
 */
export function getTemplate(db, eventId, slug) {
  const row = db.prepare(
    'SELECT subject, body FROM email_template WHERE event_id = ? AND slug = ?',
  ).get(eventId, slug);
  return row ?? DEFAULT_TEMPLATES[slug] ?? null;
}

export const DEFAULT_TEMPLATES = {
  submission_confirmation: {
    subject: 'We received your submission: {{submission_title}}',
    body: `Hi {{first_name}},

Thanks for submitting "{{submission_title}}" to {{event_name}}.

Your submission reference is {{submission_code}}. You can view and edit it in
your speaker portal:

  {{portal_url}}

We will review submissions and be in touch about next steps.

- The {{event_name}} team`,
  },

  decision_accepted: {
    subject: 'Your session was accepted for {{event_name}}',
    body: `Hi {{first_name}},

Good news - "{{submission_title}}" ({{submission_code}}) has been accepted for
{{event_name}}.

There are a few things we need from you before the event. Your speaker portal
lists them with their deadlines:

  {{portal_url}}

- The {{event_name}} team`,
  },

  decision_declined: {
    subject: 'Update on your submission to {{event_name}}',
    body: `Hi {{first_name}},

Thank you for submitting "{{submission_title}}" to {{event_name}}. We had more
strong proposals than we have room for, and we are not able to include this one
in the programme this year.

We would genuinely welcome a submission from you next time.

- The {{event_name}} team`,
  },

  task_reminder: {
    subject: 'Reminder: {{task_title}} for {{event_name}}',
    body: `Hi {{first_name}},

This is a reminder that "{{task_title}}" is due {{task_due}}.

You can complete it in your speaker portal:

  {{portal_url}}

- The {{event_name}} team`,
  },

  close_date_reminder: {
    subject: 'Submissions for {{event_name}} close {{close_at}}',
    body: `Hi {{first_name}},

You have a draft submission for {{event_name}} that has not been submitted yet.
The call for speakers closes {{close_at}}.

  {{portal_url}}

- The {{event_name}} team`,
  },
};
