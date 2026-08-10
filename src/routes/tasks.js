// Deciding what speakers owe.
//
// `task_definition` is the template -- "upload your slides, due 1 April" -- and
// `task_instance` is one person's copy of it. Every downstream feature reads
// instances: the speaker portal, the "who still owes what" dashboard, the
// reminder engine, and the file collector behind `conf files --zip`. None of
// them can show anything until a definition exists, which is why this screen
// exists: until it did, an event built entirely over HTTP could never assign
// anybody anything, and four features looked broken when they were merely
// empty.
//
// Shaped after routes/formbuilder.js, which does the same job for form fields:
// a list with reorder buttons, an add form, and a detail page that owns the
// destructive actions.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, notFound } from '../http/router.js';
import {
  APPLIES_TO, REQUIREMENTS, ASSIGN_WHEN,
  taskDefinitionsWithProgress, findTaskDefinition, createTaskDefinition,
  assignToAlreadyAccepted, retireTaskDefinition, restoreTaskDefinition,
  moveTaskDefinition, taskDefinitionUsage, whoOwes,
} from '../core/tasks.js';
import { findEvent, requireOrganizer, organizerNav, empty, dateOnly, fullName } from './shared.js';

export function mountTasks(router) {
  router.get('/e/:event/tasks/definitions', definitionList,
    'What speakers are asked to do: bios, headshots, slides, agreements. '
    + 'Nothing appears under Tasks, in reminders, or in Files until one of these exists.');

  router.post('/e/:event/tasks/definitions', createDefinition,
    'Create a task. Body: title, applies_to=person|submission, '
    + 'requirement=acknowledge|form|file, due_at=YYYY-MM-DD, '
    + 'assign_when=on_accept|manual, required=1, instructions, form=<form slug>. '
    + 'An on_accept task is given to everybody already accepted, not just to future '
    + 'acceptances; the reply says how many.');

  router.get('/e/:event/tasks/definitions/:task', definitionDetail,
    'One task: its settings, and who owes it.');

  router.post('/e/:event/tasks/definitions/:task', updateDefinition,
    'Save a task\'s wording, deadline, requirement, and when it is assigned.');

  router.post('/e/:event/tasks/definitions/:task/move', moveDefinition,
    'Reorder a task. Body: direction=up|down.');

  router.post('/e/:event/tasks/definitions/:task/assign', assignDefinition,
    'Give this task to everybody already accepted, now. Safe to repeat.');

  router.post('/e/:event/tasks/definitions/:task/retire', retireDefinition,
    'Stop collecting this. Nobody is assigned or chased for it again, and what '
    + 'people have already done is kept.');

  router.post('/e/:event/tasks/definitions/:task/restore', restoreDefinition,
    'Start collecting a retired task again.');

  router.post('/e/:event/tasks/definitions/:task/delete', deleteDefinition,
    'Remove a task. Refused once anybody has completed it -- retire it instead.');
}

// --- plumbing ---------------------------------------------------------------

function requireDefinition(ctx, event, slug) {
  const definition = findTaskDefinition(ctx.db, event.id, slug);
  if (definition) return definition;

  const known = ctx.db.prepare(
    'SELECT slug FROM task_definition WHERE event_id = ? ORDER BY sort_order, slug',
  ).all(event.id).map((d) => d.slug);

  throw notFound(`no task '${slug}' in this event`,
    known.length
      ? `tasks are: ${known.join(', ')}`
      : `this event has no tasks yet; create one at POST /e/${event.slug}/tasks/definitions`);
}

/**
 * One of a known set, refused by name with what each value means.
 *
 * `Fields.choice` already names the legal values; this adds what choosing each
 * one does, because "applies_to must be one of: person, submission" does not
 * tell somebody which of the two gives every co-speaker their own copy.
 */
function pick(ctx, name, options, fallback) {
  const value = ctx.fields.get(name);
  if (value === '' && fallback !== undefined) return fallback;

  if (!options.some((o) => o.value === value)) {
    throw badRequest(
      value ? `'${value}' is not a value for ${name}` : `${name} is missing`,
      `use ${options.map((o) => `${o.value} (${o.short ?? o.label.toLowerCase()})`).join(', or ')}`);
  }
  return value;
}

/**
 * A deadline the way the rest of the app stores one.
 *
 * End of day, so "due on the 30th" means the 30th is still usable -- the same
 * reading a form's close date gets.
 */
function dueFrom(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T23:59:59Z`;
  if (Number.isNaN(Date.parse(value))) {
    throw badRequest(`could not read '${value}' as a date`, 'use YYYY-MM-DD, for example 2027-04-30');
  }
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The form a form-task points at.
 *
 * A "fill in a form" task with no form is the same bug as a dropdown with no
 * choices: something the speaker is asked for and cannot supply. Refused at the
 * door, with the forms that exist named.
 */
function formIdFor(ctx, event, requirement) {
  const slug = ctx.fields.get('form');
  const known = () => ctx.db.prepare('SELECT slug FROM form WHERE event_id = ? ORDER BY internal_name')
    .all(event.id).map((f) => f.slug);

  if (!slug) {
    if (requirement !== 'form') return null;
    const forms = known();
    throw badRequest('a "fill in a form" task needs a form to point at',
      forms.length
        ? `send form=<slug>; the forms here are: ${forms.join(', ')}`
        : `this event has no forms yet; make one at /e/${event.slug}/forms, or choose `
          + 'requirement=acknowledge or requirement=file');
  }

  const form = ctx.db.prepare('SELECT id FROM form WHERE event_id = ? AND slug = ?')
    .get(event.id, slug);
  if (form) return form.id;

  const forms = known();
  throw badRequest(`no form '${slug}' in this event`,
    forms.length ? `forms are: ${forms.join(', ')}` : `this event has no forms yet; make one at /e/${event.slug}/forms`);
}

const appliesLabel = (value) => APPLIES_TO.find((a) => a.value === value)?.label ?? value;
const requirementLabel = (value) => REQUIREMENTS.find((r) => r.value === value)?.label ?? value;

// --- the list ---------------------------------------------------------------

function definitionList(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const definitions = taskDefinitionsWithProgress(ctx.db, event.id);
  const live = definitions.filter((d) => !d.retired_at);
  const forms = ctx.db.prepare('SELECT slug, internal_name FROM form WHERE event_id = ? ORDER BY internal_name')
    .all(event.id);

  const accepted = ctx.db.prepare(
    `SELECT count(*) AS n FROM submission WHERE event_id = ? AND status = 'accepted'`,
  ).get(event.id).n;

  const assigned = ctx.query.get('assigned');
  const flash = ctx.query.get('done');

  return ok(page({
    title: `Task setup - ${event.name}`,
    nav: organizerNav(event, 'Task setup'),
    wide: true,
    body: html`
      <h1>What speakers are asked to do</h1>
      <p class="sub">A task here is a template. Each accepted speaker gets their own copy,
        and that copy is what the <a href="/e/${event.slug}/tasks">Tasks dashboard</a>,
        the reminders, and <a href="/e/${event.slug}/files">Files</a> all count.
        Until something is listed here, all three are empty for a reason.</p>

      ${flash ? html`<p class="flash">${flash}</p>` : ''}
      ${assigned ? html`<p class="flash">Given to ${assigned} speaker${assigned === '1' ? '' : 's'}.</p>` : ''}

      ${definitions.length === 0
        ? empty('No tasks yet. Add the first one below; it is assigned immediately to anyone already accepted.')
        : html`
        <div class="scroll">
        <table>
          <thead><tr><th>Task</th><th>Who gets it</th><th>To finish it</th><th>Due</th>
            <th>Assigned</th><th class="num">Outstanding</th><th class="num">Done</th><th>Order</th></tr></thead>
          <tbody>
            ${definitions.map((d, i) => html`
              <tr>
                <td><a href="/e/${event.slug}/tasks/definitions/${d.slug}"><strong>${d.title}</strong></a>
                  ${d.required ? '' : html` <span class="pill draft">optional</span>`}
                  ${d.retired_at ? html` <span class="pill withdrawn">retired</span>` : ''}
                  <br><code class="muted">${d.slug}</code></td>
                <td>${appliesLabel(d.applies_to)}
                  <br><span class="muted">${APPLIES_TO.find((a) => a.value === d.applies_to)?.short ?? ''}</span></td>
                <td>${requirementLabel(d.requirement)}
                  ${d.form_slug ? html`<br><span class="muted">${d.form_name}</span>` : ''}</td>
                <td>${d.due_at ? dateOnly(d.due_at, event.timezone) : html`<span class="muted">no deadline</span>`}</td>
                <td>${d.retired_at
                  ? html`<span class="muted">no longer</span>`
                  : d.assign_when === 'on_accept' ? 'on acceptance' : html`<span class="muted">by hand</span>`}</td>
                <td class="num">${d.todo}</td>
                <td class="num">${d.done}${d.waived > 0 ? html` <span class="muted">+${d.waived} waived</span>` : ''}</td>
                <td>
                  <form method="post" class="inline"
                        action="/e/${event.slug}/tasks/definitions/${d.slug}/move">
                    <input type="hidden" name="direction" value="up">
                    <button type="submit" class="secondary" ${i === 0 ? raw('disabled') : ''}
                            aria-label="Move ${d.title} up">Up</button>
                  </form>
                  <form method="post" class="inline"
                        action="/e/${event.slug}/tasks/definitions/${d.slug}/move">
                    <input type="hidden" name="direction" value="down">
                    <button type="submit" class="secondary"
                            ${i === definitions.length - 1 ? raw('disabled') : ''}
                            aria-label="Move ${d.title} down">Down</button>
                  </form>
                </td>
              </tr>`)}
          </tbody>
        </table>
        </div>
        <p class="muted">${live.length} task${live.length === 1 ? '' : 's'} being collected.</p>`}

      <h2>Add a task</h2>
      <p class="sub">${accepted === 0
        ? 'Nobody has been accepted yet, so this will start applying as soon as somebody is.'
        : html`<strong>${accepted}</strong> speaker${accepted === 1 ? ' is' : 's are'} already accepted.
            A task assigned on acceptance is given to them too, straight away &mdash; not only to
            future acceptances. Choose "only when I say so" if you do not want that yet.`}</p>

      <form method="post" action="/e/${event.slug}/tasks/definitions">
        <input type="hidden" name="task_form" value="1">
        <div class="row">
          <div><label for="title">What are you asking for? <span class="req">*</span></label>
            <input type="text" id="title" name="title" required placeholder="Upload your slides"></div>
          <div><label for="due_at">Due <small>optional; reminders hang off this</small></label>
            <input type="date" id="due_at" name="due_at"></div>
        </div>

        <div class="row">
          <div><label for="applies_to">Who gets a copy</label>
            <select id="applies_to" name="applies_to">
              ${APPLIES_TO.map((a) => html`<option value="${a.value}">${a.label} &mdash; ${a.short}</option>`)}
            </select></div>
          <div><label for="requirement">How they finish it</label>
            <select id="requirement" name="requirement">
              ${REQUIREMENTS.map((r) => html`<option value="${r.value}">${r.label}</option>`)}
            </select></div>
          <div><label for="assign_when">Assigned</label>
            <select id="assign_when" name="assign_when">
              ${ASSIGN_WHEN.map((a) => html`<option value="${a.value}">${a.label}</option>`)}
            </select></div>
          ${forms.length === 0 ? '' : html`
            <div><label for="form">Form to fill in <small>for a form task</small></label>
              <select id="form" name="form">
                <option value="">- none -</option>
                ${forms.map((f) => html`<option value="${f.slug}">${f.internal_name}</option>`)}
              </select></div>`}
        </div>

        <label for="instructions">Instructions <small>for your own reference and the reminder text</small></label>
        <textarea id="instructions" name="instructions"></textarea>

        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="required" value="1" checked>
          Required &mdash; only required tasks with a deadline are chased by the reminder engine
        </label>

        <div class="actions"><button type="submit">Add task</button></div>

        <p class="muted">
          ${APPLIES_TO.map((a) => html`<strong>${a.label}</strong>: ${a.hint}<br>`)}
          ${REQUIREMENTS.map((r) => html`<strong>${r.label}</strong>: ${r.hint}<br>`)}
        </p>
      </form>
    `,
  }));
}

function createDefinition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const requirement = pick(ctx, 'requirement', REQUIREMENTS, 'acknowledge');

  const { definition, assigned } = createTaskDefinition(ctx.db, event.id, {
    title: ctx.fields.require('title', 'for example: Upload your slides'),
    slug: ctx.fields.get('slug') || null,
    appliesTo: pick(ctx, 'applies_to', APPLIES_TO, 'person'),
    requirement,
    formId: formIdFor(ctx, event, requirement),
    instructions: ctx.fields.get('instructions'),
    dueAt: dueFrom(ctx.fields.get('due_at')),
    // A checkbox posts nothing when unticked, so absence has to mean "off" for
    // anything arriving from the form. `task_form` is how the form says so;
    // a caller who never mentions it gets the sensible default instead.
    required: ctx.fields.has('task_form') || ctx.fields.has('required')
      ? ctx.fields.bool('required')
      : true,
    assignWhen: pick(ctx, 'assign_when', ASSIGN_WHEN, 'on_accept'),
  });

  return redirect(`/e/${event.slug}/tasks/definitions/${definition.slug}?assigned=${assigned}`);
}

// --- one task ---------------------------------------------------------------

function definitionDetail(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const definition = requireDefinition(ctx, event, ctx.params.task);

  const usage = taskDefinitionUsage(ctx.db, definition.id);
  const people = whoOwes(ctx.db, definition.id);
  const forms = ctx.db.prepare('SELECT slug, internal_name FROM form WHERE event_id = ? ORDER BY internal_name')
    .all(event.id);
  const assigned = ctx.query.get('assigned');
  const dropped = ctx.query.get('dropped');

  const finished = (usage.done ?? 0) + (usage.waived ?? 0);
  const currentForm = definition.form_id
    ? ctx.db.prepare('SELECT slug FROM form WHERE id = ?').get(definition.form_id)?.slug ?? ''
    : '';

  return ok(page({
    title: `${definition.title} - ${event.name}`,
    nav: organizerNav(event, 'Task setup'),
    wide: true,
    body: html`
      <p class="sub"><a href="/e/${event.slug}/tasks/definitions">&larr; All tasks</a></p>
      <h1>${definition.title}</h1>
      <p class="sub"><code>${definition.slug}</code> &middot; ${appliesLabel(definition.applies_to)}
        &middot; ${requirementLabel(definition.requirement)}
        ${definition.retired_at ? html` &middot; <span class="pill withdrawn">retired</span>` : ''}</p>

      ${assigned ? html`<p class="flash">Given to ${assigned} speaker${assigned === '1' ? '' : 's'}.
        ${assigned === '0' ? 'Nobody is accepted yet, or everybody already had it.' : ''}</p>` : ''}
      ${dropped ? html`<p class="flash">Retired. ${dropped} outstanding cop${dropped === '1' ? 'y' : 'ies'}
        dropped; ${finished} finished one${finished === 1 ? '' : 's'} kept.</p>` : ''}

      ${definition.retired_at ? html`
        <p class="flash">This task is no longer collected. Nobody new is assigned it and nobody
          is chased for it. What ${finished} person(s) already did is kept below.</p>
        <form method="post" action="/e/${event.slug}/tasks/definitions/${definition.slug}/restore">
          <button type="submit">Collect this again</button>
        </form>` : ''}

      <h2>Settings</h2>
      <form method="post" action="/e/${event.slug}/tasks/definitions/${definition.slug}">
        <!-- Says "this post carries every checkbox", so a box left out was
             unticked rather than simply not mentioned. Without it a curl caller
             renaming a task could never make it optional. -->
        <input type="hidden" name="task_form" value="1">
        <div class="row">
          <div><label for="title">Title</label>
            <input type="text" id="title" name="title" value="${definition.title}" required></div>
          <div><label for="due_at">Due</label>
            <input type="date" id="due_at" name="due_at" value="${(definition.due_at ?? '').slice(0, 10)}"></div>
        </div>

        <div class="row">
          <div><label for="applies_to">Who gets a copy</label>
            <select id="applies_to" name="applies_to" ${usage.total > 0 ? raw('disabled') : ''}>
              ${APPLIES_TO.map((a) => html`
                <option value="${a.value}" ${a.value === definition.applies_to ? raw('selected') : ''}>
                  ${a.label} &mdash; ${a.short}</option>`)}
            </select>
            ${usage.total > 0 ? html`<small class="muted">Fixed: it has already been given out
              ${usage.total} time(s) in this shape.</small>` : ''}</div>
          <div><label for="requirement">How they finish it</label>
            <select id="requirement" name="requirement" ${finished > 0 ? raw('disabled') : ''}>
              ${REQUIREMENTS.map((r) => html`
                <option value="${r.value}" ${r.value === definition.requirement ? raw('selected') : ''}>${r.label}</option>`)}
            </select>
            ${finished > 0 ? html`<small class="muted">Fixed: ${finished} person(s) already finished
              it this way.</small>` : ''}</div>
          <div><label for="assign_when">Assigned</label>
            <select id="assign_when" name="assign_when">
              ${ASSIGN_WHEN.map((a) => html`
                <option value="${a.value}" ${a.value === definition.assign_when ? raw('selected') : ''}>${a.label}</option>`)}
            </select></div>
          ${forms.length === 0 ? '' : html`
            <div><label for="form">Form to fill in</label>
              <select id="form" name="form">
                <option value="">- none -</option>
                ${forms.map((f) => html`
                  <option value="${f.slug}" ${f.slug === currentForm ? raw('selected') : ''}>${f.internal_name}</option>`)}
              </select></div>`}
        </div>

        <label for="instructions">Instructions</label>
        <textarea id="instructions" name="instructions">${definition.instructions}</textarea>

        <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
          <input type="checkbox" name="required" value="1" ${definition.required ? raw('checked') : ''}>
          Required
        </label>

        <div class="actions"><button type="submit">Save</button></div>
      </form>

      <h2>Who has it</h2>
      ${people.length === 0 ? empty(
        definition.assign_when === 'manual'
          ? 'Nobody. This task is only given out by hand -- use the button below.'
          : 'Nobody yet. It is handed out as speakers are told they are in.')
        : html`
        <div class="scroll">
        <table>
          <thead><tr><th>Person</th><th>For</th><th>Status</th><th>Finished</th></tr></thead>
          <tbody>
            ${people.map((p) => html`
              <tr>
                <td>${fullName(p)}<br><span class="muted">${p.email}</span></td>
                <td>${p.submission_code
                  ? html`<a href="/e/${event.slug}/submissions/${p.submission_code}"><code>${p.submission_code}</code></a>`
                  : html`<span class="muted">them personally</span>`}</td>
                <td><span class="pill ${p.status}">${p.status}</span></td>
                <td>${p.completed_at ? dateOnly(p.completed_at, event.timezone) : html`<span class="muted">-</span>`}</td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}

      ${definition.retired_at ? '' : html`
        <form method="post" action="/e/${event.slug}/tasks/definitions/${definition.slug}/assign">
          <p class="muted">Give it to everybody who is already accepted. Nobody gets it twice.</p>
          <button type="submit" class="secondary">Assign it now</button>
        </form>`}

      <h2>Stop collecting it</h2>
      ${finished > 0 ? html`
        <p class="muted">${finished} person(s) have finished this, so it cannot be deleted:
          deleting it would delete that record and unhook anything they uploaded for it.
          ${definition.retired_at ? 'It is already retired, which is the safe way to stop asking.' : html`
            Retiring stops it being assigned and stops the reminders, and keeps what they did.`}</p>
        ${definition.retired_at ? '' : html`
          <form method="post" action="/e/${event.slug}/tasks/definitions/${definition.slug}/retire">
            <button type="submit" class="secondary">Retire this task</button>
          </form>`}` : html`
        <p class="muted">Nobody has finished this yet, so it can go entirely, along with the
          ${usage.todo ?? 0} outstanding cop${(usage.todo ?? 0) === 1 ? 'y' : 'ies'} of it.</p>
        <div class="actions">
          ${definition.retired_at ? '' : html`
            <form method="post" class="inline"
                  action="/e/${event.slug}/tasks/definitions/${definition.slug}/retire">
              <button type="submit" class="secondary">Retire it</button>
            </form>`}
          <form method="post" class="inline"
                action="/e/${event.slug}/tasks/definitions/${definition.slug}/delete">
            <button type="submit" class="danger">Delete it</button>
          </form>
        </div>`}
    `,
  }));
}

function updateDefinition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const definition = requireDefinition(ctx, event, ctx.params.task);

  const usage = taskDefinitionUsage(ctx.db, definition.id);
  const finished = (usage.done ?? 0) + (usage.waived ?? 0);

  // A partial save: absent means "leave it alone", not "blank it". The same
  // rule the form editor learned the hard way -- a curl caller renaming a thing
  // must not silently clear its deadline.
  const columns = [];
  const values = [];
  const put = (column, value) => { columns.push(`${column} = ?`); values.push(value); };

  if (ctx.fields.has('title')) put('title', ctx.fields.require('title'));
  if (ctx.fields.has('instructions')) put('instructions', ctx.fields.get('instructions'));
  if (ctx.fields.has('due_at')) put('due_at', dueFrom(ctx.fields.get('due_at')));

  // Changing the shape of a task people already hold would leave their copies
  // attached to a rule that no longer describes them: a person-level copy of a
  // task that is now one-per-session, or a "confirm it" copy of a task that now
  // wants a file that was never uploaded. Refuse, and name the way through.
  if (ctx.fields.has('applies_to')) {
    const appliesTo = pick(ctx, 'applies_to', APPLIES_TO);
    if (appliesTo !== definition.applies_to && usage.total > 0) {
      throw badRequest(
        `'${definition.title}' has already been given to ${usage.total} person(s) as a `
        + `${appliesLabel(definition.applies_to).toLowerCase()}`,
        'who gets a copy cannot change underneath them. Retire this task and create the '
        + 'replacement, so the old copies keep meaning what they meant');
    }
    put('applies_to', appliesTo);
  }

  if (ctx.fields.has('requirement')) {
    const requirement = pick(ctx, 'requirement', REQUIREMENTS);
    if (requirement !== definition.requirement && finished > 0) {
      throw badRequest(
        `${finished} person(s) have already finished '${definition.title}' by `
        + `${requirementLabel(definition.requirement).toLowerCase()}`,
        'changing what finishing it means would make their record wrong. Retire this task '
        + 'and create the replacement');
    }
    put('requirement', requirement);
    put('form_id', formIdFor(ctx, event, requirement));
  } else if (ctx.fields.has('form')) {
    put('form_id', formIdFor(ctx, event, definition.requirement));
  }

  const fromTheForm = ctx.fields.has('task_form');
  if (fromTheForm || ctx.fields.has('required')) put('required', ctx.fields.bool('required') ? 1 : 0);

  let assignWhen = definition.assign_when;
  if (ctx.fields.has('assign_when')) {
    assignWhen = pick(ctx, 'assign_when', ASSIGN_WHEN);
    put('assign_when', assignWhen);
  }

  if (columns.length > 0) {
    ctx.db.prepare(`UPDATE task_definition SET ${columns.join(', ')} WHERE id = ?`)
      .run(...values, definition.id);
  }

  // Switching a task to on_accept is the same promise creating one that way
  // makes, so it keeps the same answer: everybody already accepted gets it.
  const assigned = assignWhen === 'on_accept' && definition.assign_when !== 'on_accept'
    ? assignToAlreadyAccepted(ctx.db, ctx.db.prepare('SELECT * FROM task_definition WHERE id = ?').get(definition.id))
    : 0;

  return redirect(`/e/${event.slug}/tasks/definitions/${definition.slug}`
    + (assigned ? `?assigned=${assigned}` : ''));
}

function moveDefinition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const definition = requireDefinition(ctx, event, ctx.params.task);

  moveTaskDefinition(ctx.db, event.id, definition, ctx.fields.choice('direction', ['up', 'down']));
  return redirect(`/e/${event.slug}/tasks/definitions`);
}

function assignDefinition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const definition = requireDefinition(ctx, event, ctx.params.task);

  if (definition.retired_at) {
    throw badRequest(`'${definition.title}' is retired, so it is not being collected`,
      `bring it back first: POST /e/${event.slug}/tasks/definitions/${definition.slug}/restore`);
  }

  const assigned = assignToAlreadyAccepted(ctx.db, definition);
  return redirect(`/e/${event.slug}/tasks/definitions/${definition.slug}?assigned=${assigned}`);
}

function retireDefinition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const definition = requireDefinition(ctx, event, ctx.params.task);

  const dropped = retireTaskDefinition(ctx.db, definition);
  return redirect(`/e/${event.slug}/tasks/definitions/${definition.slug}?dropped=${dropped}`);
}

function restoreDefinition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const definition = requireDefinition(ctx, event, ctx.params.task);

  const assigned = restoreTaskDefinition(ctx.db, definition);
  return redirect(`/e/${event.slug}/tasks/definitions/${definition.slug}?assigned=${assigned}`);
}

/**
 * Remove a task.
 *
 * The database refuses this once anybody has completed it (migration 012), and
 * would do so with a perfectly good sentence. Checking here as well is not
 * belt and braces for its own sake: this way the refusal can name the specific
 * task and count the specific people, and the trigger stays as the backstop for
 * everything that does not come through a handler.
 */
function deleteDefinition(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const definition = requireDefinition(ctx, event, ctx.params.task);

  const usage = taskDefinitionUsage(ctx.db, definition.id);
  const finished = (usage.done ?? 0) + (usage.waived ?? 0);

  if (finished > 0) {
    throw badRequest(
      `${finished} person(s) have already completed '${definition.title}'`,
      'deleting it would delete that record, and unhook anything they uploaded for it. '
      + `Retire it instead -- it stops being assigned and chased, and their work is kept: `
      + `POST /e/${event.slug}/tasks/definitions/${definition.slug}/retire`);
  }

  ctx.db.prepare('DELETE FROM task_definition WHERE id = ?').run(definition.id);

  const outstanding = usage.todo ?? 0;
  const message = outstanding > 0
    ? `Deleted '${definition.title}' and ${outstanding} outstanding cop${outstanding === 1 ? 'y' : 'ies'} of it.`
    : `Deleted '${definition.title}'.`;
  return redirect(`/e/${event.slug}/tasks/definitions?done=${encodeURIComponent(message)}`);
}
