// Rendering and reading organizer-defined form fields.
//
// Shared by the public call-for-speakers form and the speaker portal's editor,
// so a submitter sees the same questions in the same order whether they are
// answering them for the first time or correcting them a week later.

import { html, raw } from '../http/html.js';
import { badRequest } from '../http/router.js';
import { now } from '../db.js';

/**
 * Progressive enhancement for conditional questions.
 *
 * The server already emits `data-show-when="slug:operator:value"` on any field
 * that has conditions, and already re-checks those conditions on submit. This
 * makes them appear and disappear as somebody answers, which is what the field
 * is for -- asking about workshop prerequisites is only sensible once they have
 * said "workshop".
 *
 * It is an enhancement, not a requirement. With scripting off every question is
 * shown, every answer is accepted, and the server decides what was relevant.
 * That is a slightly noisier form, not a broken one, which is the trade this
 * codebase takes everywhere else too.
 *
 * The one non-obvious part is `required`. A hidden field that is still marked
 * required makes a browser refuse to submit while pointing at something nobody
 * can see, so the attribute is taken off while hidden and put back when shown.
 */
export const CONDITIONAL_FIELD_SCRIPT = `
(function () {
  var groups = Array.prototype.slice.call(document.querySelectorAll('[data-show-when]'));
  if (!groups.length) return;

  function valueOf(name) {
    var els = document.getElementsByName(name);
    if (!els.length) return '';
    var el = els[0];
    if (el.type === 'checkbox') return el.checked ? '1' : '';
    if (el.multiple) {
      return Array.prototype.filter.call(el.options, function (o) { return o.selected; })
        .map(function (o) { return o.value; }).join(',');
    }
    return el.value;
  }

  function holds(rule) {
    var parts = rule.split(':');
    var actual = valueOf(parts[0]);
    var op = parts[1];
    var want = parts.slice(2).join(':');
    if (op === 'equals') return actual === want;
    if (op === 'not_equals') return actual !== want;
    if (op === 'includes') return actual.split(',').indexOf(want) !== -1;
    if (op === 'is_blank') return actual === '';
    if (op === 'is_present') return actual !== '';
    return true;
  }

  function apply() {
    groups.forEach(function (group) {
      var show = group.getAttribute('data-show-when').split('|').every(holds);
      group.hidden = !show;

      // A hidden field that is still required makes the browser refuse to
      // submit while pointing at something nobody can see.
      Array.prototype.forEach.call(group.querySelectorAll('input, select, textarea'), function (el) {
        if (!show && el.required) { el.dataset.wasRequired = '1'; el.required = false; }
        else if (show && el.dataset.wasRequired) { el.required = true; delete el.dataset.wasRequired; }
      });
    });
  }

  document.addEventListener('change', apply);
  document.addEventListener('input', apply);
  apply();
})();
`.trim();

export function fieldsOf(db, formId, section) {
  return db.prepare(
    'SELECT * FROM form_field WHERE form_id = ? AND section = ? ORDER BY sort_order, id',
  ).all(formId, section);
}

export function isClosed(form) {
  return Boolean(form.close_at && form.close_at < now());
}

/** One field's answer, accepting either its slug or its `maps_to` alias. */
export function valueOf(fields, field) {
  const alias = field.maps_to ? field.maps_to.split('.').pop() : null;
  return fields.get(field.slug) || (alias ? fields.get(alias) : '');
}

/** The names a caller may use for a field, for error messages. */
export function acceptedNames(field) {
  const alias = field.maps_to ? field.maps_to.split('.').pop() : null;
  return alias && alias !== field.slug ? `'${field.slug}' (or '${alias}')` : `'${field.slug}'`;
}

/**
 * Collect answers keyed by what they map onto, e.g. `person.first_name`.
 *
 * A field's slug is the organizer's label for it and can be anything --
 * `first-name`, `your_name`, `speaker_first`. Only `maps_to` says where the
 * answer belongs, so that is what handlers read.
 */
export function mappedValues(fields, formFields) {
  const out = {};
  for (const field of formFields) {
    if (!field.maps_to) continue;
    const value = valueOf(fields, field);
    if (value !== '') out[field.maps_to] = value;
  }
  return out;
}

/**
 * Validate submitted answers against the form's own rules.
 *
 * `requireRequired` is false when saving a draft: a draft exists precisely so
 * somebody can write the title now and the abstract on Sunday.
 */
export function validateAnswers(fields, formFields, {
  requireRequired = true, conditions = [],
} = {}) {
  const answerOf = (slug) => {
    const field = formFields.find((f) => f.slug === slug);
    return field ? valueOf(fields, field) : '';
  };

  for (const field of formFields) {
    const value = valueOf(fields, field);

    // A required question that was not asked cannot be missing. Workshop
    // prerequisites are required *of workshops*; demanding them from a lightning
    // talk would be refusing a submission over a question nobody put.
    const governing = conditions.filter((c) => c.field_slug === field.slug);
    const asked = governing.every((c) => conditionHolds(c, answerOf));

    if (requireRequired && asked && field.required && value === '') {
      throw badRequest(`missing required field: ${field.label}`,
        `send ${acceptedNames(field)} in the request body`);
    }
    if (field.max_chars && value.length > field.max_chars) {
      throw badRequest(`${field.label} is longer than ${field.max_chars} characters`,
        `it was ${value.length}`);
    }
  }
}

/**
 * The conditions attached to a field, if any.
 *
 * A field with conditions is only asked when they hold. The public form renders
 * every branch and reveals the dependent field with a small script, but the
 * *server* re-checks on submit, so the rule holds for anything posting directly.
 */
export function conditionsFor(db, formId) {
  return db.prepare(
    `SELECT c.*, w.slug AS when_slug, t.slug AS field_slug
       FROM form_field_condition c
       JOIN form_field w ON w.id = c.when_field_id
       JOIN form_field t ON t.id = c.field_id
      WHERE t.form_id = ?`,
  ).all(formId);
}

/** Whether a condition holds for a given set of answers. */
export function conditionHolds(condition, answerOf) {
  const actual = String(answerOf(condition.when_slug) ?? '');
  switch (condition.operator) {
    case 'equals': return actual === condition.value;
    case 'not_equals': return actual !== condition.value;
    case 'includes': return actual.split(',').map((v) => v.trim()).includes(condition.value);
    case 'is_blank': return actual === '';
    case 'is_present': return actual !== '';
    default: return true;
  }
}

/**
 * Render one field as HTML.
 *
 * `options` resolves a dropdown's choices; `values` supplies current answers so
 * the same function renders both a blank form and an editor.
 */
export function renderField(field, { options, values = {}, conditions = [] } = {}) {
  const id = `f_${field.slug}`;
  const current = values[field.slug] ?? '';
  const governing = conditions.filter((c) => c.field_slug === field.slug);

  const label = html`
    <label for="${id}">${field.label}${field.required ? raw(' <span class="req">*</span>') : ''}
      ${field.help_text ? html`<small>${field.help_text}</small>` : ''}
      ${governing.length > 0 ? html`<small>Asked when
        ${governing.map((c) => `${c.when_slug} ${c.operator.replace('_', ' ')} ${c.value}`).join(' and ')}</small>` : ''}
    </label>`;

  // A conditional field is wrapped so it can be revealed without script when
  // the browser supports it, and stays visible (and answerable) when it cannot.
  const wrap = (inner) => (governing.length === 0 ? inner : html`
    <div data-show-when="${governing.map((c) => `${c.when_slug}:${c.operator}:${c.value}`).join('|')}">
      ${inner}
    </div>`);

  if (field.field_type === 'select' || field.field_type === 'multiselect') {
    const choices = options(field);
    const multiple = field.field_type === 'multiselect';
    const selected = String(current).split(',').map((v) => v.trim());
    return wrap(html`${label}
      <select id="${id}" name="${field.slug}" ${multiple ? raw('multiple size="4"') : ''}
              ${field.required ? raw('required') : ''}>
        ${multiple ? '' : html`<option value="">- choose -</option>`}
        ${choices.map((c) => html`
          <option value="${c.slug}" ${selected.includes(c.slug) ? raw('selected') : ''}>${c.label}</option>`)}
      </select>`);
  }

  if (field.field_type === 'checkbox') {
    return wrap(html`
      <label for="${id}" style="display:flex;gap:.5rem;align-items:center;font-weight:400">
        <input type="checkbox" id="${id}" name="${field.slug}" value="1"
               ${current ? raw('checked') : ''}>
        ${field.label}
      </label>
      ${field.help_text ? html`<p class="muted" style="margin:.2rem 0 0">${field.help_text}</p>` : ''}`);
  }

  if (field.field_type === 'textarea' || field.field_type === 'richtext') {
    return wrap(html`${label}
      <textarea id="${id}" name="${field.slug}" ${field.required ? raw('required') : ''}
        ${field.max_chars ? raw(`maxlength="${field.max_chars}"`) : ''}>${current}</textarea>`);
  }

  if (field.field_type === 'file') {
    return wrap(html`${label}<input type="file" id="${id}" name="${field.slug}">`);
  }

  const type = { email: 'email', phone: 'tel', url: 'url', number: 'number', date: 'date' }[field.field_type] ?? 'text';
  return wrap(html`${label}
    <input type="${type}" id="${id}" name="${field.slug}" value="${current}"
      ${field.required ? raw('required') : ''}
      ${field.max_chars ? raw(`maxlength="${field.max_chars}"`) : ''}>`);
}

/**
 * Build the options resolver for a form's dropdowns.
 *
 * Tracks live in their own table rather than in `taxonomy_option`, so a field
 * mapped to `submission.track_id` reads from there; everything else reads its
 * declared taxonomy.
 */
export function optionResolver(db, eventId) {
  const taxonomy = (kind) => db.prepare(
    'SELECT slug, label FROM taxonomy_option WHERE event_id = ? AND kind = ? ORDER BY sort_order, label',
  ).all(eventId, kind);

  const tracks = () => db.prepare(
    'SELECT slug, name AS label FROM track WHERE event_id = ? ORDER BY sort_order, name',
  ).all(eventId);

  return (field) => {
    if (field.maps_to === 'submission.track_id') return tracks();
    if (field.options_kind) return taxonomy(field.options_kind);
    if (field.maps_to === 'submission.format_option_id') return taxonomy('format');
    if (field.maps_to === 'submission.level_option_id') return taxonomy('level');
    if (field.maps_to === 'submission.language_option_id') return taxonomy('language');
    return [];
  };
}

/**
 * The answers already recorded for a submission, keyed by field slug, ready to
 * pre-fill an editor.
 */
export function answersFor(db, submission, formFields) {
  const values = {};
  const custom = db.prepare(
    `SELECT ff.slug, sa.value FROM submission_answer sa
       JOIN form_field ff ON ff.id = sa.field_id WHERE sa.submission_id = ?`,
  ).all(submission.id);
  for (const row of custom) values[row.slug] = row.value;

  const lookups = {
    'submission.title': () => submission.title,
    'submission.description': () => submission.description,
    'submission.track_id': () => slugOf(db, 'track', submission.track_id),
    'submission.format_option_id': () => slugOf(db, 'taxonomy_option', submission.format_option_id),
    'submission.level_option_id': () => slugOf(db, 'taxonomy_option', submission.level_option_id),
    'submission.language_option_id': () => slugOf(db, 'taxonomy_option', submission.language_option_id),
  };

  for (const field of formFields) {
    if (!field.maps_to) continue;
    const lookup = lookups[field.maps_to];
    if (lookup) values[field.slug] = lookup() ?? '';
  }
  return values;
}

function slugOf(db, table, id) {
  if (!id) return '';
  return db.prepare(`SELECT slug FROM ${table} WHERE id = ?`).get(id)?.slug ?? '';
}

/**
 * Write submitted answers onto a submission and its submitter.
 *
 * One implementation, used by the public form and the portal editor alike, so a
 * field that saves correctly on submission also saves correctly on edit.
 */
export function applyAnswers(db, { submission, person, eventId, fields, formFields }) {
  const mapped = mappedValues(fields, formFields);
  const t = now();

  const columns = {
    'submission.title': 'title',
    'submission.description': 'description',
  };
  const lookups = {
    'submission.track_id': ['track_id', (slug) =>
      db.prepare('SELECT id FROM track WHERE event_id = ? AND slug = ?').get(eventId, slug)?.id],
    'submission.format_option_id': ['format_option_id', (slug) => optionId(db, eventId, 'format', slug)],
    'submission.level_option_id': ['level_option_id', (slug) => optionId(db, eventId, 'level', slug)],
    'submission.language_option_id': ['language_option_id', (slug) => optionId(db, eventId, 'language', slug)],
  };

  for (const [mapsTo, column] of Object.entries(columns)) {
    if (mapped[mapsTo] === undefined) continue;
    db.prepare(`UPDATE submission SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(mapped[mapsTo], t, submission.id);
  }

  for (const [mapsTo, [column, resolve]] of Object.entries(lookups)) {
    if (mapped[mapsTo] === undefined) continue;
    const id = resolve(mapped[mapsTo]);
    if (id) {
      db.prepare(`UPDATE submission SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(id, t, submission.id);
    }
  }

  // Custom questions -- anything without a `maps_to` -- keep their answers on
  // the submission rather than trying to find a column for them.
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO submission_answer (submission_id, field_id, value) VALUES (?, ?, ?)',
  );
  for (const field of formFields) {
    if (field.maps_to) continue;
    const value = valueOf(fields, field);
    if (value !== '') upsert.run(submission.id, field.id, value);
    else db.prepare('DELETE FROM submission_answer WHERE submission_id = ? AND field_id = ?')
      .run(submission.id, field.id);
  }

  if (person) {
    const personColumns = ['first_name', 'last_name', 'phone', 'biography', 'job_title', 'company'];
    for (const column of personColumns) {
      const value = mapped[`person.${column}`];
      if (value === undefined) continue;
      db.prepare(`UPDATE person SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(value, t, person.id);
    }
  }

  return mapped;
}

function optionId(db, eventId, kind, slug) {
  return db.prepare('SELECT id FROM taxonomy_option WHERE event_id = ? AND kind = ? AND slug = ?')
    .get(eventId, kind, slug)?.id;
}

/** Person-shaped answers, for the participant section of an editor. */
export function personValues(person, formFields) {
  const values = {};
  for (const field of formFields) {
    if (!field.maps_to?.startsWith('person.')) continue;
    values[field.slug] = person[field.maps_to.slice('person.'.length)] ?? '';
  }
  return values;
}
