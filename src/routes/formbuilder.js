// Building a submission form.
//
// An organizer's form is the only part of this app a stranger ever fills in, so
// the builder's job is to make the consequences of each choice visible while
// they are making it: which fields are required, which are locked because the
// rest of the app depends on them, and what the public page will actually look
// like.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, notFound } from '../http/router.js';
import { now, uniqueSlug } from '../db.js';
import { fieldsOf, isClosed, optionResolver } from './formfields.js';
import { OPERATORS, needsValue, operatorLabel, rulesFor, recentRouting } from '../core/routing.js';
import { findEvent, requireOrganizer, organizerNav, empty, dateOnly, when } from './shared.js';

/**
 * Field types an organizer can add, and what each is for.
 *
 * Deliberately a short list. Every extra type is another thing to render,
 * validate, export, and explain, and a conference form is mostly prose,
 * choices, and a couple of numbers.
 */
const FIELD_TYPES = [
  { value: 'text', label: 'Short text', hint: 'One line. A title, a job title, a URL.' },
  { value: 'textarea', label: 'Long text', hint: 'A paragraph or several. Abstracts and biographies.' },
  { value: 'select', label: 'Dropdown', hint: 'One choice from a list you control.' },
  { value: 'multiselect', label: 'Multiple choice', hint: 'Any number from a list.' },
  { value: 'checkbox', label: 'Yes or no', hint: 'A single box to tick.' },
  { value: 'email', label: 'Email address', hint: 'Validated as an address.' },
  { value: 'phone', label: 'Phone number', hint: '' },
  { value: 'url', label: 'Link', hint: '' },
  { value: 'number', label: 'Number', hint: '' },
  { value: 'date', label: 'Date', hint: '' },
];

/** Places an answer can land. A field with no mapping is a custom question. */
const MAPPINGS = [
  { value: '', label: 'Just store the answer (custom question)' },
  { value: 'submission.title', label: 'Session title' },
  { value: 'submission.description', label: 'Session description' },
  { value: 'submission.track_id', label: 'Track' },
  { value: 'submission.format_option_id', label: 'Format' },
  { value: 'submission.level_option_id', label: 'Level' },
  { value: 'submission.language_option_id', label: 'Language' },
  { value: 'person.first_name', label: 'Speaker first name' },
  { value: 'person.last_name', label: 'Speaker last name' },
  { value: 'person.email', label: 'Speaker email' },
  { value: 'person.phone', label: 'Speaker phone' },
  { value: 'person.biography', label: 'Speaker biography' },
  { value: 'person.job_title', label: 'Speaker job title' },
  { value: 'person.company', label: 'Speaker company' },
];

/**
 * How a routing outcome reads on screen.
 *
 * "Nothing matched" and "partly applied" are not errors, but they are not
 * successes either, and colouring them the same as a clean route is how a form
 * with a broken rule looks fine for a month.
 */
const OUTCOME_LABEL = {
  routed: 'Routed', partial: 'Partly applied', no_match: 'No rule matched', failed: 'Failed',
};
const OUTCOME_PILL = {
  routed: 'accepted', partial: 'pending', no_match: 'draft', failed: 'declined',
};

export function mountFormBuilder(router) {
  router.get('/e/:event/forms', formList, 'Submission forms for this event.');
  router.post('/e/:event/forms', createForm, 'Create a submission form. Body: internal_name.');

  router.get('/e/:event/forms/:form', formDetail, 'Edit one form: its settings and its questions.');
  router.post('/e/:event/forms/:form/settings', updateForm,
    'Save a form\'s wording, deadline, limit, and confirmation settings.');
  router.post('/e/:event/forms/:form/fields', addField,
    'Add a question. Body: label, field_type, section, required, maps_to, options_kind, max_chars.');
  router.post('/e/:event/forms/:form/fields/:field/delete', deleteField, 'Remove a question.');
  router.post('/e/:event/forms/:form/fields/:field/move', moveField,
    'Reorder a question. Body: direction=up|down.');
  router.post('/e/:event/forms/:form/conditions', addCondition,
    'Show a question only when another is answered a certain way.');
  router.post('/e/:event/forms/:form/conditions/:id/delete', deleteCondition, 'Remove a rule.');

  router.post('/e/:event/forms/:form/routing', addRoutingRule,
    'Route arriving proposals by their answer to a category question. '
    + 'Body: field (a question about the session), operator=equals|not_equals|includes|is_present|is_blank, '
    + 'value, and at least one action: plan (a review round slug), track (a track slug), '
    + 'reviewers (how many to assign, default 2). The first matching rule wins.');
  router.post('/e/:event/forms/:form/routing/:id/delete', deleteRoutingRule,
    'Remove a routing rule. What it already did stays recorded on those submissions.');
  router.post('/e/:event/forms/:form/routing/:id/move', moveRoutingRule,
    'Change which routing rule is tried first. Body: direction=up|down.');
}

function findForm(ctx, event, slug) {
  const form = ctx.db.prepare('SELECT * FROM form WHERE event_id = ? AND slug = ?').get(event.id, slug);
  if (!form) {
    const known = ctx.db.prepare('SELECT slug FROM form WHERE event_id = ?').all(event.id)
      .map((f) => f.slug);
    throw notFound(`no form '${slug}'`,
      known.length ? `forms are: ${known.join(', ')}` : 'this event has no forms yet');
  }
  return form;
}

// --- list ------------------------------------------------------------------

function formList(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const forms = ctx.db.prepare(
    `SELECT f.*, (SELECT count(*) FROM submission s WHERE s.form_id = f.id) AS submissions,
            (SELECT count(*) FROM submission s WHERE s.form_id = f.id AND s.status = 'draft') AS drafts,
            (SELECT count(*) FROM form_field ff WHERE ff.form_id = f.id) AS questions
       FROM form f WHERE f.event_id = ? ORDER BY f.created_at DESC`,
  ).all(event.id);

  return ok(page({
    title: `Forms - ${event.name}`,
    nav: organizerNav(event, 'Forms'),
    wide: true,
    body: html`
      <h1>Submission forms</h1>
      <p class="sub">What a speaker fills in. You can run more than one &mdash; a main
        call and a late lightning-talk round, say &mdash; each with its own deadline.</p>

      ${forms.length === 0 ? empty('No forms yet. Create one below and it is immediately public.') : html`
        <table>
          <thead><tr><th>Form</th><th>Public link</th><th>Status</th><th>Closes</th>
            <th class="num">Questions</th><th class="num">Submissions</th></tr></thead>
          <tbody>
            ${forms.map((f) => html`
              <tr>
                <td><a href="/e/${event.slug}/forms/${f.slug}"><strong>${f.internal_name}</strong></a>
                  <br><span class="muted">${f.external_title}</span></td>
                <td><a href="/submit/${event.slug}/${f.slug}"><code>/submit/${event.slug}/${f.slug}</code></a></td>
                <td>${isClosed(f)
                  ? html`<span class="pill declined">Closed</span>`
                  : html`<span class="pill accepted">Open</span>`}</td>
                <td>${f.close_at ? dateOnly(f.close_at, event.timezone) : html`<span class="muted">no deadline</span>`}</td>
                <td class="num">${f.questions}</td>
                <td class="num">${f.submissions}${f.drafts > 0 ? html` <span class="muted">(${f.drafts} draft)</span>` : ''}</td>
              </tr>`)}
          </tbody>
        </table>`}

      <h2>New form</h2>
      <form method="post" action="/e/${event.slug}/forms">
        <div class="row">
          <div><label for="internal_name">Name it for yourself <span class="req">*</span>
            <small>Only organizers see this.</small></label>
            <input type="text" id="internal_name" name="internal_name" required
                   placeholder="CFP 2027 (main round)"></div>
          <div><label for="external_title">And for submitters
            <small>The heading on the public page.</small></label>
            <input type="text" id="external_title" name="external_title"
                   placeholder="Call for Speakers"></div>
        </div>
        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="with_defaults" value="1" checked>
          Start with the usual questions (title, description, track, format, and who you are)
        </label>
        <div class="actions"><button type="submit">Create form</button></div>
      </form>
    `,
  }));
}

function createForm(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const internalName = ctx.fields.require('internal_name', 'for example: CFP 2027 (main round)');
  const slug = uniqueSlug(internalName,
    (s) => ctx.db.prepare('SELECT 1 FROM form WHERE event_id = ? AND slug = ?').get(event.id, s));
  const t = now();

  const form = ctx.db.prepare(
    `INSERT INTO form (event_id, slug, kind, internal_name, external_title, page_heading,
                       welcome_message, collect_participants, auto_redirect_to_portal,
                       success_message, send_confirmation_email, confirmation_email_body,
                       created_at, updated_at)
     VALUES (?, ?, 'submission', ?, ?, ?, '', 1, 1, ?, 1, '', ?, ?) RETURNING *`,
  ).get(event.id, slug, internalName,
    ctx.fields.get('external_title', 'Call for Speakers'),
    ctx.fields.get('external_title', 'Tell us what you would talk about'),
    'Thank you. We have your proposal and will be in touch.', t, t);

  // A form with no questions is a dead link. These are the ones every
  // conference asks for, and every one of them is editable or removable.
  if (ctx.fields.bool('with_defaults')) {
    const defaults = [
      ['abstract', 'Title', 'text', 'submission.title', 1, 1, 255],
      ['abstract', 'Description', 'textarea', 'submission.description', 1, 0, 5000],
      ['abstract', 'Track', 'select', 'submission.track_id', 1, 0, null],
      ['abstract', 'Format', 'select', 'submission.format_option_id', 1, 0, null],
      ['abstract', 'Level', 'select', 'submission.level_option_id', 0, 0, null],
      ['participant', 'First name', 'text', 'person.first_name', 1, 1, 255],
      ['participant', 'Last name', 'text', 'person.last_name', 1, 1, 255],
      ['participant', 'Email', 'email', 'person.email', 1, 1, null],
      ['participant', 'Job title', 'text', 'person.job_title', 0, 0, 255],
      ['participant', 'Company', 'text', 'person.company', 0, 0, 255],
      ['participant', 'Biography', 'textarea', 'person.biography', 1, 0, 1200],
    ];
    defaults.forEach(([section, label, type, mapsTo, required, locked, maxChars], i) => {
      insertField(ctx.db, form.id, {
        section, label, field_type: type, maps_to: mapsTo,
        required, locked, max_chars: maxChars, sort_order: i + 1,
      });
    });
  }

  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

function insertField(db, formId, f) {
  const slug = uniqueSlug(f.label,
    (s) => db.prepare('SELECT 1 FROM form_field WHERE form_id = ? AND slug = ?').get(formId, s));
  return db.prepare(
    `INSERT INTO form_field (form_id, section, slug, label, help_text, field_type,
                             options_kind, maps_to, required, locked, max_chars, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(formId, f.section, slug, f.label, f.help_text ?? '', f.field_type,
    f.options_kind ?? null, f.maps_to || null, f.required ? 1 : 0, f.locked ? 1 : 0,
    f.max_chars ?? null, f.sort_order ?? 99);
}

// --- one form --------------------------------------------------------------

function formDetail(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);

  const sections = {
    abstract: fieldsOf(ctx.db, form.id, 'abstract'),
    participant: fieldsOf(ctx.db, form.id, 'participant'),
  };
  const all = [...sections.abstract, ...sections.participant];

  const conditions = ctx.db.prepare(
    `SELECT c.*, w.label AS when_label, t.label AS field_label
       FROM form_field_condition c
       JOIN form_field w ON w.id = c.when_field_id
       JOIN form_field t ON t.id = c.field_id
      WHERE t.form_id = ?`,
  ).all(form.id);

  // Routing reads an answer off the submission, so the questions it can read
  // are the ones about the session. A question about the speaker is stored on
  // the person, and a rule on it would compare against nothing forever.
  const routable = sections.abstract.filter((f) => !String(f.maps_to ?? '').startsWith('person.'));
  const rules = rulesFor(ctx.db, form.id);
  const decisions = recentRouting(ctx.db, form.id);
  const options = optionResolver(ctx.db, event.id);
  const plans = ctx.db.prepare(
    `SELECT ep.*, (SELECT count(*) FROM plan_reviewer WHERE plan_id = ep.id) AS pool
       FROM evaluation_plan ep WHERE ep.event_id = ? ORDER BY ep.round, ep.created_at`,
  ).all(event.id);
  const tracks = ctx.db.prepare(
    'SELECT * FROM track WHERE event_id = ? ORDER BY sort_order, name').all(event.id);

  // The comparison value is a slug, and a typo in one is a rule that never
  // fires and never says so. Listing the answers each dropdown can actually
  // produce is what makes that avoidable at the point of writing the rule --
  // the add form re-checks it, and so does anything posting here with curl.
  const answerable = routable
    .map((f) => ({ field: f, choices: options(f) }))
    .filter((entry) => entry.choices.length > 0);

  const fieldRows = (section) => html`
    ${sections[section].length === 0 ? empty('No questions in this section yet.') : html`
      <table>
        <thead><tr><th>Question</th><th>Type</th><th>Goes to</th><th>Required</th><th>Order</th><th></th></tr></thead>
        <tbody>
          ${sections[section].map((f, i) => html`
            <tr>
              <td><strong>${f.label}</strong>
                ${f.locked ? html` <span class="pill draft">locked</span>` : ''}
                <br><code class="muted">${f.slug}</code>
                ${f.help_text ? html`<br><span class="muted">${f.help_text}</span>` : ''}</td>
              <td>${FIELD_TYPES.find((t) => t.value === f.field_type)?.label ?? f.field_type}
                ${f.max_chars ? html`<br><span class="muted">max ${f.max_chars}</span>` : ''}</td>
              <td>${f.maps_to
                ? html`<code>${f.maps_to}</code>`
                : html`<span class="muted">stored as an answer</span>`}</td>
              <td>${f.required ? 'yes' : html`<span class="muted">optional</span>`}</td>
              <td>
                <form method="post" class="inline"
                      action="/e/${event.slug}/forms/${form.slug}/fields/${f.slug}/move">
                  <input type="hidden" name="direction" value="up">
                  <button type="submit" class="secondary" ${i === 0 ? raw('disabled') : ''}
                          aria-label="Move ${f.label} up">Up</button>
                </form>
                <form method="post" class="inline"
                      action="/e/${event.slug}/forms/${form.slug}/fields/${f.slug}/move">
                  <input type="hidden" name="direction" value="down">
                  <button type="submit" class="secondary"
                          ${i === sections[section].length - 1 ? raw('disabled') : ''}
                          aria-label="Move ${f.label} down">Down</button>
                </form>
              </td>
              <td>${f.locked ? html`<span class="muted">required by the app</span>` : html`
                <form method="post" class="inline"
                      action="/e/${event.slug}/forms/${form.slug}/fields/${f.slug}/delete">
                  <button type="submit" class="secondary">Remove</button>
                </form>`}</td>
            </tr>`)}
        </tbody>
      </table>`}`;

  return ok(page({
    title: `${form.internal_name} - ${event.name}`,
    nav: organizerNav(event, 'Forms'),
    wide: true,
    body: html`
      <p class="sub"><a href="/e/${event.slug}/forms">&larr; All forms</a></p>
      <h1>${form.internal_name}</h1>
      <p class="sub">
        Public at <a href="/submit/${event.slug}/${form.slug}"><code>/submit/${event.slug}/${form.slug}</code></a>
        &middot; ${isClosed(form) ? 'closed' : 'open'}
        ${form.close_at ? html` until ${dateOnly(form.close_at, event.timezone)}` : ''}
      </p>
      <p><a class="button secondary" href="/submit/${event.slug}/${form.slug}">View the public form</a></p>

      <h2>Questions about the session</h2>
      ${fieldRows('abstract')}

      <h2>Questions about the speaker</h2>
      ${fieldRows('participant')}

      <h2>Add a question</h2>
      <form method="post" action="/e/${event.slug}/forms/${form.slug}/fields">
        <div class="row">
          <div><label for="label">Question <span class="req">*</span></label>
            <input type="text" id="label" name="label" required placeholder="Key takeaway"></div>
          <div><label for="section">Section</label>
            <select id="section" name="section">
              <option value="abstract">About the session</option>
              <option value="participant">About the speaker</option>
            </select></div>
          <div><label for="field_type">Type</label>
            <select id="field_type" name="field_type">
              ${FIELD_TYPES.map((t) => html`<option value="${t.value}">${t.label}</option>`)}
            </select></div>
        </div>
        <div class="row">
          <div><label for="maps_to">Where the answer goes</label>
            <select id="maps_to" name="maps_to">
              ${MAPPINGS.map((m) => html`<option value="${m.value}">${m.label}</option>`)}
            </select></div>
          <div><label for="options_kind">Choices come from <small>for a dropdown</small></label>
            <select id="options_kind" name="options_kind">
              <option value="">- not a dropdown -</option>
              <option value="format">Formats</option>
              <option value="level">Levels</option>
              <option value="language">Languages</option>
              <option value="tag">Tags</option>
            </select></div>
          <div><label for="max_chars">Character limit <small>optional</small></label>
            <input type="number" id="max_chars" name="max_chars" min="1"></div>
        </div>
        <label for="help_text">Help text <small>Shown under the question.</small></label>
        <input type="text" id="help_text" name="help_text">
        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="required" value="1"> Required
        </label>
        <div class="actions"><button type="submit">Add question</button></div>
      </form>

      <h2>Conditional questions</h2>
      <p class="sub">Ask something only when an earlier answer calls for it &mdash;
        workshop prerequisites, say, but only for workshops.</p>
      ${conditions.length === 0 ? empty('No rules yet. Every question is always asked.') : html`
        <table>
          <thead><tr><th>Ask</th><th>Only when</th><th></th></tr></thead>
          <tbody>
            ${conditions.map((c) => html`
              <tr>
                <td><strong>${c.field_label}</strong></td>
                <td>${c.when_label} ${c.operator.replace('_', ' ')}
                  ${c.value ? html`<code>${c.value}</code>` : ''}</td>
                <td><form method="post" class="inline"
                      action="/e/${event.slug}/forms/${form.slug}/conditions/${c.id}/delete">
                  <button type="submit" class="secondary">Remove</button></form></td>
              </tr>`)}
          </tbody>
        </table>`}

      ${all.length < 2 ? '' : html`
        <form method="post" action="/e/${event.slug}/forms/${form.slug}/conditions" class="row">
          <div><label for="field_id">Ask this</label>
            <select id="field_id" name="field_id">
              ${all.map((f) => html`<option value="${f.slug}">${f.label}</option>`)}
            </select></div>
          <div><label for="when_field_id">Only when</label>
            <select id="when_field_id" name="when_field_id">
              ${all.map((f) => html`<option value="${f.slug}">${f.label}</option>`)}
            </select></div>
          <div><label for="operator">is</label>
            <select id="operator" name="operator">
              <option value="equals">equal to</option>
              <option value="not_equals">not equal to</option>
              <option value="includes">one of</option>
              <option value="is_present">answered at all</option>
              <option value="is_blank">left blank</option>
            </select></div>
          <div><label for="value">this value</label>
            <input type="text" id="value" name="value" placeholder="workshop"></div>
          <div style="flex:0 0 auto"><button type="submit">Add rule</button></div>
        </form>`}

      <h2>Routing</h2>
      <p class="sub">Where a proposal goes, decided by what it says. A rule reads one
        answer and, when it matches, hands the submission to a review round and/or sets
        its track &mdash; so nobody re-keys anything after it arrives.
        Rules are tried top to bottom and <strong>the first one that matches wins</strong>,
        so put the most specific first.</p>

      ${rules.length === 0 ? empty('No routing rules. Every proposal arrives in the pile and waits to be sorted by hand.') : html`
        <table>
          <thead><tr><th>Order</th><th>When</th><th>Then</th><th></th></tr></thead>
          <tbody>
            ${rules.map((r, i) => html`
              <tr>
                <td>
                  <form method="post" class="inline"
                        action="/e/${event.slug}/forms/${form.slug}/routing/${r.id}/move">
                    <input type="hidden" name="direction" value="up">
                    <button type="submit" class="secondary" ${i === 0 ? raw('disabled') : ''}
                            aria-label="Try this rule earlier">Up</button>
                  </form>
                  <form method="post" class="inline"
                        action="/e/${event.slug}/forms/${form.slug}/routing/${r.id}/move">
                    <input type="hidden" name="direction" value="down">
                    <button type="submit" class="secondary" ${i === rules.length - 1 ? raw('disabled') : ''}
                            aria-label="Try this rule later">Down</button>
                  </form>
                </td>
                <td><strong>${r.field_label}</strong> ${operatorLabel(r.operator)}
                  ${needsValue(r.operator) ? html`<code>${r.value}</code>` : ''}</td>
                <td>
                  ${r.plan_id ? html`Review round
                    <a href="/e/${event.slug}/evaluation/${r.plan_slug}">${r.plan_name}</a>,
                    ${r.reviewers} reviewer(s)${r.track_id ? html`<br>` : ''}` : ''}
                  ${r.track_id ? html`Track <strong>${r.track_name}</strong>` : ''}
                  ${r.plan_id && r.plan_pool === 0 ? html`<br><span class="pill pending">nobody in that pool</span>
                    <span class="muted">proposals routed here will sit unreviewed until somebody is
                      <a href="/e/${event.slug}/evaluation/${r.plan_slug}">added to the round</a>.</span>` : ''}
                </td>
                <td><form method="post" class="inline"
                      action="/e/${event.slug}/forms/${form.slug}/routing/${r.id}/delete">
                  <button type="submit" class="secondary">Remove</button></form></td>
              </tr>`)}
          </tbody>
        </table>`}

      ${routable.length === 0 ? empty('Add a question about the session first: a rule needs an answer to read.')
        : plans.length === 0 && tracks.length === 0
          ? empty(`Nowhere to route to yet. Create a review round under Review, or a track under Settings.`)
          : html`
        <form method="post" action="/e/${event.slug}/forms/${form.slug}/routing">
          <div class="row">
            <div><label for="routing_field">When the answer to</label>
              <select id="routing_field" name="field">
                ${routable.map((f) => html`<option value="${f.slug}">${f.label}</option>`)}
              </select></div>
            <div><label for="routing_operator">is</label>
              <select id="routing_operator" name="operator">
                ${OPERATORS.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
              </select></div>
            <div><label for="routing_value">this answer</label>
              <input type="text" id="routing_value" name="value" placeholder="retrieval"></div>
          </div>
          <div class="row">
            <div><label for="routing_plan">Send it to this review round</label>
              <select id="routing_plan" name="plan">
                <option value="">- no review round -</option>
                ${plans.map((p) => html`<option value="${p.slug}">${p.name}${p.pool === 0 ? ' (empty pool)' : ''}</option>`)}
              </select></div>
            <div><label for="routing_reviewers">Reviewers <small>from that round's pool</small></label>
              <input type="number" id="routing_reviewers" name="reviewers" value="2" min="1"></div>
            <div><label for="routing_track">And set its track to</label>
              <select id="routing_track" name="track">
                <option value="">- leave the track alone -</option>
                ${tracks.map((t) => html`<option value="${t.slug}">${t.name}</option>`)}
              </select></div>
            <div style="flex:0 0 auto"><button type="submit">Add routing rule</button></div>
          </div>
          ${answerable.length === 0 ? '' : html`
            <p class="muted">Answers to compare against &mdash; a rule matches the slug, not the label:
              ${answerable.map((entry) => html`<br><strong>${entry.field.label}</strong>
                ${entry.choices.map((c) => html`<code>${c.slug}</code> `)}`)}</p>`}
        </form>`}

      ${decisions.length === 0 ? '' : html`
        <h3>What routing has done</h3>
        <p class="sub">The last ${decisions.length} proposal(s) through this form. Each
          one also carries this in its own history.</p>
        <table>
          <thead><tr><th>Submission</th><th>Outcome</th><th>What happened</th><th>When</th></tr></thead>
          <tbody>
            ${decisions.map((d) => html`
              <tr>
                <td><a href="/e/${event.slug}/submissions/${d.code}"><code>${d.code}</code></a>
                  <br><span class="muted">${d.title}</span></td>
                <td><span class="pill ${OUTCOME_PILL[d.outcome]}">${OUTCOME_LABEL[d.outcome]}</span></td>
                <td>${d.detail}</td>
                <td>${when(d.created_at, event.timezone)}</td>
              </tr>`)}
          </tbody>
        </table>`}

      <h2>Settings</h2>
      <form method="post" action="/e/${event.slug}/forms/${form.slug}/settings">
        <div class="row">
          <div><label for="internal_name">Internal name</label>
            <input type="text" id="internal_name" name="internal_name" value="${form.internal_name}" required></div>
          <div><label for="external_title">Public title</label>
            <input type="text" id="external_title" name="external_title" value="${form.external_title}"></div>
        </div>
        <div class="row">
          <div><label for="page_heading">Page heading</label>
            <input type="text" id="page_heading" name="page_heading" value="${form.page_heading}"></div>
          <div><label for="close_at">Closes <small>after this, no new or edited submissions</small></label>
            <input type="date" id="close_at" name="close_at" value="${(form.close_at ?? '').slice(0, 10)}"></div>
          <div><label for="submission_limit">Limit per person <small>optional</small></label>
            <input type="number" id="submission_limit" name="submission_limit" min="1"
                   value="${form.submission_limit ?? ''}"></div>
        </div>

        <label for="welcome_message">Welcome message</label>
        <textarea id="welcome_message" name="welcome_message">${form.welcome_message}</textarea>

        <label for="success_message">Thank-you message</label>
        <textarea id="success_message" name="success_message">${form.success_message}</textarea>

        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="send_confirmation_email" value="1"
                 ${form.send_confirmation_email ? raw('checked') : ''}>
          Email submitters a confirmation with a link to their portal
        </label>
        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="auto_redirect_to_portal" value="1"
                 ${form.auto_redirect_to_portal ? raw('checked') : ''}>
          Send them straight into their portal after submitting
        </label>
        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="collect_participants" value="1"
                 ${form.collect_participants ? raw('checked') : ''}>
          Ask who the speaker is
        </label>

        <div class="actions"><button type="submit">Save settings</button></div>
      </form>
    `,
  }));
}

function updateForm(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);

  const closeOn = ctx.fields.get('close_at');
  ctx.db.prepare(
    `UPDATE form SET internal_name = ?, external_title = ?, page_heading = ?,
                     welcome_message = ?, success_message = ?, close_at = ?,
                     submission_limit = ?, send_confirmation_email = ?,
                     auto_redirect_to_portal = ?, collect_participants = ?, updated_at = ?
      WHERE id = ?`,
  ).run(ctx.fields.require('internal_name'), ctx.fields.get('external_title'),
    ctx.fields.get('page_heading'), ctx.fields.get('welcome_message'),
    ctx.fields.get('success_message'),
    // End of day, so "closes on the 30th" means the 30th is still usable.
    closeOn ? `${closeOn}T23:59:59Z` : null,
    ctx.fields.int('submission_limit', null),
    ctx.fields.bool('send_confirmation_email') ? 1 : 0,
    ctx.fields.bool('auto_redirect_to_portal') ? 1 : 0,
    ctx.fields.bool('collect_participants') ? 1 : 0,
    now(), form.id);

  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

function addField(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);

  const section = ctx.fields.choice('section', ['abstract', 'participant'], 'abstract');
  const fieldType = ctx.fields.choice('field_type', FIELD_TYPES.map((t) => t.value), 'text');
  const mapsTo = ctx.fields.get('maps_to');
  const optionsKind = ctx.fields.get('options_kind');

  if (mapsTo && !MAPPINGS.some((m) => m.value === mapsTo)) {
    throw badRequest(`'${mapsTo}' is not somewhere an answer can go`,
      `choose one of: ${MAPPINGS.filter((m) => m.value).map((m) => m.value).join(', ')}`);
  }

  // A dropdown with nothing to choose from is the bug we already shipped once:
  // a required field nobody could answer. Refuse it at the door.
  const isDropdown = fieldType === 'select' || fieldType === 'multiselect';
  const resolvesFromTracks = mapsTo === 'submission.track_id';
  const resolvesFromTaxonomy = ['submission.format_option_id', 'submission.level_option_id',
    'submission.language_option_id'].includes(mapsTo);

  if (isDropdown && !optionsKind && !resolvesFromTracks && !resolvesFromTaxonomy) {
    throw badRequest('a dropdown needs somewhere to get its choices from',
      'pick a vocabulary under "Choices come from", or map the answer to Track, Format, Level, or Language');
  }

  const count = ctx.db.prepare(
    'SELECT count(*) AS n FROM form_field WHERE form_id = ? AND section = ?').get(form.id, section).n;

  insertField(ctx.db, form.id, {
    section,
    label: ctx.fields.require('label'),
    help_text: ctx.fields.get('help_text'),
    field_type: fieldType,
    options_kind: optionsKind || null,
    maps_to: mapsTo,
    required: ctx.fields.bool('required'),
    locked: 0,
    max_chars: ctx.fields.int('max_chars', null),
    sort_order: count + 1,
  });

  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

function findField(ctx, form, slug) {
  const field = ctx.db.prepare('SELECT * FROM form_field WHERE form_id = ? AND slug = ?')
    .get(form.id, slug);
  if (!field) throw notFound(`no question '${slug}' on this form`);
  return field;
}

/**
 * Remove a question.
 *
 * Locked fields cannot go: the rest of the app reads a submission's title and a
 * speaker's email, and a form that does not collect them produces records
 * nothing else can display.
 */
function deleteField(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);
  const field = findField(ctx, form, ctx.params.field);

  if (field.locked) {
    throw badRequest(`'${field.label}' cannot be removed`,
      'the rest of the app reads this answer; you can rename it, but not drop it');
  }

  ctx.db.prepare('DELETE FROM form_field WHERE id = ?').run(field.id);
  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

/** Swap a question with its neighbour, so order is editable without dragging. */
function moveField(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);
  const field = findField(ctx, form, ctx.params.field);

  const direction = ctx.fields.choice('direction', ['up', 'down']);
  const siblings = fieldsOf(ctx.db, form.id, field.section);
  const index = siblings.findIndex((f) => f.id === field.id);
  const swapWith = siblings[direction === 'up' ? index - 1 : index + 1];

  if (swapWith) {
    // Rewrite the whole section's order rather than swapping two numbers, so a
    // section seeded with duplicate sort_orders sorts itself out on first use.
    const reordered = [...siblings];
    reordered[index] = swapWith;
    reordered[direction === 'up' ? index - 1 : index + 1] = field;
    const update = ctx.db.prepare('UPDATE form_field SET sort_order = ? WHERE id = ?');
    reordered.forEach((f, i) => update.run(i + 1, f.id));
  }

  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

function addCondition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);

  const field = findField(ctx, form, ctx.fields.require('field_id'));
  const whenField = findField(ctx, form, ctx.fields.require('when_field_id'));

  if (field.id === whenField.id) {
    throw badRequest('a question cannot depend on itself',
      'pick a different question for the condition');
  }
  if (field.locked) {
    throw badRequest(`'${field.label}' is always asked`,
      'the rest of the app depends on it, so it cannot be made conditional');
  }

  ctx.db.prepare(
    `INSERT INTO form_field_condition (field_id, when_field_id, operator, value)
     VALUES (?, ?, ?, ?)`,
  ).run(field.id, whenField.id,
    ctx.fields.choice('operator', ['equals', 'not_equals', 'includes', 'is_blank', 'is_present']),
    ctx.fields.get('value'));

  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

function deleteCondition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);

  const condition = ctx.db.prepare(
    `SELECT c.* FROM form_field_condition c JOIN form_field f ON f.id = c.field_id
      WHERE c.id = ? AND f.form_id = ?`,
  ).get(Number(ctx.params.id), form.id);
  if (!condition) throw notFound('no such rule on this form');

  ctx.db.prepare('DELETE FROM form_field_condition WHERE id = ?').run(condition.id);
  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

// --- routing ---------------------------------------------------------------
//
// Configuration-time checks are the whole game here. A routing rule runs months
// after it is written, on somebody else's proposal, with nobody watching; every
// mistake that can be caught while the organizer is still looking at the screen
// has to be caught there, and every refusal has to say what would have worked.

function findRoutingRule(ctx, form) {
  const rule = ctx.db.prepare('SELECT * FROM form_routing_rule WHERE id = ? AND form_id = ?')
    .get(Number(ctx.params.id), form.id);
  if (!rule) {
    throw notFound('no such routing rule on this form',
      'the rules and their ids are under Routing on the form page');
  }
  return rule;
}

function addRoutingRule(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);

  const field = findField(ctx, form,
    ctx.fields.require('field', 'the slug of a question about the session, for example: track'));

  if (field.section !== 'abstract' || String(field.maps_to ?? '').startsWith('person.')) {
    throw badRequest(`'${field.label}' is a question about the speaker, not about the session`,
      'routing reads an answer stored on the proposal; pick one of the questions under '
      + '"Questions about the session", such as Track or Format');
  }

  const operator = ctx.fields.choice('operator', OPERATORS.map((o) => o.value), 'equals');
  // is_present and is_blank ask whether there is an answer at all, so a value
  // alongside them would be stored and never read.
  const value = needsValue(operator) ? ctx.fields.get('value') : '';

  if (needsValue(operator) && value === '') {
    throw badRequest(`a rule on '${field.label}' needs something to compare the answer to`,
      "send value=<the answer>, or operator=is_present to match any answer at all");
  }

  // A comparison against something nobody can answer is a rule that never fires
  // and never complains. Where the question has a known set of answers, the
  // value has to be one of them.
  const choices = optionResolver(ctx.db, event.id)(field);
  if (value !== '' && choices.length > 0 && !choices.some((c) => c.slug === value)) {
    throw badRequest(`'${value}' is not one of the answers to '${field.label}'`,
      `a rule comparing against it could never match. The answers are: `
      + choices.map((c) => c.slug).join(', '));
  }

  const planSlug = ctx.fields.get('plan');
  const trackSlug = ctx.fields.get('track');
  if (!planSlug && !trackSlug) {
    throw badRequest('a routing rule has to do something',
      `send plan=<review round slug>, track=<track slug>, or both. `
      + `Rounds are listed at /e/${event.slug}/evaluation and tracks at /e/${event.slug}/settings`);
  }

  const plan = planSlug ? requirePlan(ctx, event, planSlug) : null;
  const track = trackSlug ? requireTrack(ctx, event, trackSlug) : null;

  const reviewers = ctx.fields.int('reviewers', 2);
  if (reviewers < 1) {
    throw badRequest(`a rule asking for ${reviewers} reviewer(s) would hand the proposal to nobody`,
      'send reviewers=1 or more, or leave it out and it asks for 2');
  }

  // The first match wins, so a rule identical to an earlier one is dead code:
  // it would sit in the list looking like it does something.
  const duplicate = rulesFor(ctx.db, form.id).find(
    (r) => r.field_id === field.id && r.operator === operator && r.value === value);
  if (duplicate) {
    throw badRequest(
      `there is already a rule for when '${field.label}' ${operatorLabel(operator)} ${value}`.trim(),
      'the first matching rule wins, so this one could never fire. Change that rule instead, '
      + 'or remove it first');
  }

  const count = ctx.db.prepare('SELECT count(*) AS n FROM form_routing_rule WHERE form_id = ?')
    .get(form.id).n;

  ctx.db.prepare(
    `INSERT INTO form_routing_rule (form_id, field_id, operator, value, plan_id, track_id,
                                    reviewers, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(form.id, field.id, operator, value, plan?.id ?? null, track?.id ?? null,
    reviewers, count + 1, now());

  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

function requirePlan(ctx, event, slug) {
  const plan = ctx.db.prepare('SELECT * FROM evaluation_plan WHERE event_id = ? AND slug = ?')
    .get(event.id, slug);
  if (plan) return plan;

  const known = ctx.db.prepare(
    'SELECT slug FROM evaluation_plan WHERE event_id = ? ORDER BY round, created_at')
    .all(event.id).map((p) => p.slug);
  throw badRequest(`no review round '${slug}' in this event`,
    known.length
      ? `rounds are: ${known.join(', ')}`
      : `this event has no review rounds yet; create one at /e/${event.slug}/evaluation`);
}

function requireTrack(ctx, event, slug) {
  const track = ctx.db.prepare('SELECT * FROM track WHERE event_id = ? AND slug = ?')
    .get(event.id, slug);
  if (track) return track;

  // Listed in the order the organizer sees them on screen, so the hint reads as
  // the same list they are looking at.
  const known = ctx.db.prepare(
    'SELECT slug FROM track WHERE event_id = ? ORDER BY sort_order, name')
    .all(event.id).map((t) => t.slug);
  throw badRequest(`no track '${slug}' in this event`,
    known.length
      ? `tracks are: ${known.join(', ')}`
      : `this event has no tracks yet; add one at /e/${event.slug}/settings`);
}

/**
 * Remove a rule.
 *
 * What it already did stays in `submission_routing`, which is why that table
 * records a sentence rather than a set of ids: "why is SESS-9 in the ML round"
 * has to stay answerable after the rule that put it there is gone.
 */
function deleteRoutingRule(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);
  const rule = findRoutingRule(ctx, form);

  ctx.db.prepare('DELETE FROM form_routing_rule WHERE id = ?').run(rule.id);
  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}

/** Change which rule is tried first. Precedence is the whole semantics, so it is editable. */
function moveRoutingRule(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const form = findForm(ctx, event, ctx.params.form);
  const rule = findRoutingRule(ctx, form);

  const direction = ctx.fields.choice('direction', ['up', 'down']);
  const siblings = rulesFor(ctx.db, form.id);
  const index = siblings.findIndex((r) => r.id === rule.id);
  const swapWith = siblings[direction === 'up' ? index - 1 : index + 1];

  if (swapWith) {
    // Rewrite the whole list rather than swapping two numbers, so rules that
    // arrived with duplicate sort_orders sort themselves out on first use.
    const reordered = [...siblings];
    reordered[index] = swapWith;
    reordered[direction === 'up' ? index - 1 : index + 1] = rule;
    const update = ctx.db.prepare('UPDATE form_routing_rule SET sort_order = ? WHERE id = ?');
    reordered.forEach((r, i) => update.run(i + 1, r.id));
  }

  return redirect(`/e/${event.slug}/forms/${form.slug}`);
}
