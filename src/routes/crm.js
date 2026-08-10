// The speaker database, across every event.
//
// Deliberately not under `/e/<event>/`. The whole point is that it is not
// scoped to one conference: "have we had this person before" and "who do we
// know in this field that we have never invited" are questions that only make
// sense above an event, and a per-event screen cannot ask them.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, forbidden, notFound } from '../http/router.js';
import {
  searchPeople, personHistory, addNote, notesOn, addTag, removeTag, tagsOn, allTags,
  findDuplicates, mergePeople, saveSegment, segments, runSegment,
  stages, board, enroll, moveCard, movesFor,
} from '../core/crm.js';
import { canOrganize } from '../core/auth.js';
import { empty, fullName, dateOnly, statusPill } from './shared.js';

export function mountCrm(router) {
  router.get('/crm', directory,
    'The speaker database across every event. ?q=, ?tag=, ?company=, ?event=slug, ?never_spoken=1.');
  router.post('/crm/segments', createSegment, 'Save the current search as a named segment.');
  router.get('/crm/segments/:slug', showSegment, 'Run a saved segment now.');

  router.get('/crm/people/:slug', profile,
    'One person: everything they have done here, their notes, and their tags.');
  router.post('/crm/people/:slug/notes', postNote, 'Add an internal note about somebody.');
  router.post('/crm/people/:slug/tags', postTag, 'Tag somebody. Body: tag.');
  router.post('/crm/people/:slug/tags/remove', postRemoveTag, 'Remove a tag.');
  router.post('/crm/people/:slug/enroll', postEnroll, 'Put somebody into the sourcing pipeline.');

  router.get('/crm/duplicates', duplicates, 'People who look like the same human twice.');
  router.post('/crm/merge', postMerge, 'Fold one record into another. Body: keep, merge (slugs).');

  router.get('/crm/pipeline', pipeline, 'The sourcing board.');
  router.post('/crm/pipeline/:id/move', postMove, 'Move a card to another stage. Body: stage.');
}

/**
 * The CRM spans events, so there is no single event to check membership
 * against. Anybody who can organize anything can see it, which is the same
 * trust boundary as the speaker list they can already read.
 */
function requireAnyOrganizer(ctx) {
  const events = ctx.db.prepare('SELECT id FROM event').all();
  if (events.some((e) => canOrganize(ctx.db, e.id, ctx.person))) return;

  // Two things were wrong here, and both only showed themselves off loopback.
  //
  // It returned early when the instance had no events, which was meant to keep
  // a brand-new instance usable and instead left the cross-event speaker
  // database -- every name, email and private note we hold -- open to anyone
  // for as long as no event existed.
  //
  // And it refused with 400 rather than 403, so a caller checking for "am I
  // allowed?" sailed straight past it and read the failure as a bad request.
  throw forbidden('organizer access required',
    'scripts: send `authorization: bearer <token>` (mint one at /account). '
    + 'People: sign in at /sign-in.');
}

function crmNav(current) {
  const items = [['/crm', 'Directory'], ['/crm/pipeline', 'Sourcing'],
    ['/crm/duplicates', 'Duplicates']];
  return html`
    <header class="bar">
      <div class="inner">
        <strong>Speaker database</strong>
        <nav>
          ${items.map(([href, label]) => html`
            <a href="${href}" ${current === label ? raw('aria-current="page"') : ''}>${label}</a>`)}
        </nav>
        <span class="spacer"></span>
        <span class="who"><a href="/">All events</a></span>
      </div>
    </header>`;
}

function personRow(p) {
  return html`
    <tr>
      <td><a href="/crm/people/${p.slug}"><strong>${fullName(p)}</strong></a>
        <br><span class="muted">${p.email}</span></td>
      <td>${p.job_title}${p.company ? html`<br><span class="muted">${p.company}</span>` : ''}</td>
      <td class="num">${p.events_spoken > 0
        ? html`<strong>${p.events_spoken}</strong>`
        : html`<span class="muted">never</span>`}</td>
      <td class="num">${p.submissions}</td>
      <td>${p.tags ?? ''}</td>
      <td class="num">${p.notes || ''}</td>
    </tr>`;
}

function peopleTable(rows) {
  return rows.length === 0 ? empty('Nobody matches.') : html`
    <div class="scroll">
    <table>
      <thead><tr><th>Person</th><th>Role</th><th class="num">Spoke at</th>
        <th class="num">Submissions</th><th>Tags</th><th class="num">Notes</th></tr></thead>
      <tbody>${rows.map(personRow)}</tbody>
    </table>
    </div>`;
}

// --- directory -------------------------------------------------------------

function currentFilters(ctx) {
  const eventSlug = ctx.query.get('event') ?? '';
  const event = eventSlug
    ? ctx.db.prepare('SELECT id FROM event WHERE slug = ?').get(eventSlug)
    : null;

  return {
    query: ctx.query.get('q') ?? '',
    tag: ctx.query.get('tag') ?? '',
    company: ctx.query.get('company') ?? '',
    eventSlug,
    spokeAtEventId: event?.id ?? null,
    neverSpoken: ctx.query.get('never_spoken') === '1',
  };
}

function directory(ctx) {
  requireAnyOrganizer(ctx);
  const filters = currentFilters(ctx);
  const rows = searchPeople(ctx.db, filters);

  const events = ctx.db.prepare('SELECT slug, name FROM event ORDER BY starts_at DESC').all();
  const tags = allTags(ctx.db);
  const saved = segments(ctx.db);
  const total = ctx.db.prepare('SELECT count(*) AS n FROM person').get().n;
  const done = ctx.query.get('done');

  return ok(page({
    title: 'Speaker database',
    nav: crmNav('Directory'),
    wide: true,
    body: html`
      <h1>Speaker database</h1>
      <p class="sub">Everyone who has ever submitted, spoken, or reviewed, across every
        event. <strong>${rows.length}</strong> of ${total} shown.</p>
      ${done ? html`<p class="flash">${done}</p>` : ''}

      <form method="get" class="row" style="margin-bottom:1rem">
        <div><label for="q">Search <small>name, email, company, or job title</small></label>
          <input type="text" id="q" name="q" value="${filters.query}"></div>
        <div><label for="tag">Tag</label>
          <select id="tag" name="tag">
            <option value="">Any</option>
            ${tags.map((t) => html`
              <option value="${t.tag}" ${t.tag === filters.tag ? raw('selected') : ''}>${t.tag} (${t.n})</option>`)}
          </select></div>
        <div><label for="event">Spoke at</label>
          <select id="event" name="event">
            <option value="">Any event</option>
            ${events.map((e) => html`
              <option value="${e.slug}" ${e.slug === filters.eventSlug ? raw('selected') : ''}>${e.name}</option>`)}
          </select></div>
        <div style="flex:0 0 auto">
          <label style="display:flex;gap:.4rem;align-items:center;font-weight:400;margin-top:1.6rem">
            <input type="checkbox" name="never_spoken" value="1"
                   ${filters.neverSpoken ? raw('checked') : ''}> Never spoken
          </label>
        </div>
        <div style="flex:0 0 auto"><button type="submit">Search</button>
          <a class="button secondary" href="/crm">Clear</a></div>
      </form>

      ${peopleTable(rows)}

      <h2>Save this search</h2>
      <p class="sub">A segment stores what you asked for, not who matched today, so it
        keeps answering the question as people come and go.</p>
      <form method="post" action="/crm/segments" class="row">
        <input type="hidden" name="q" value="${filters.query}">
        <input type="hidden" name="tag" value="${filters.tag}">
        <input type="hidden" name="company" value="${filters.company}">
        <input type="hidden" name="event" value="${filters.eventSlug}">
        ${filters.neverSpoken ? html`<input type="hidden" name="never_spoken" value="1">` : ''}
        <div><label for="name">Call it</label>
          <input type="text" id="name" name="name" required placeholder="AI people we have not invited"></div>
        <div style="flex:0 0 auto"><button type="submit">Save segment</button></div>
      </form>

      ${saved.length > 0 ? html`
        <h2>Saved segments</h2>
        <table>
          <thead><tr><th>Segment</th><th>Asks for</th><th class="num">Matches now</th></tr></thead>
          <tbody>
            ${saved.map((s) => html`
              <tr>
                <td><a href="/crm/segments/${s.slug}"><strong>${s.name}</strong></a></td>
                <td class="muted">
                  ${[s.query && `matching "${s.query}"`, s.tag && `tagged ${s.tag}`,
                    s.company && `at ${s.company}`, s.never_spoken && 'never spoken']
                    .filter(Boolean).join(', ') || 'everybody'}
                </td>
                <td class="num">${runSegment(ctx.db, s).length}</td>
              </tr>`)}
          </tbody>
        </table>` : ''}
    `,
  }));
}

function createSegment(ctx) {
  requireAnyOrganizer(ctx);
  const eventSlug = ctx.fields.get('event');
  const event = eventSlug
    ? ctx.db.prepare('SELECT id FROM event WHERE slug = ?').get(eventSlug)
    : null;

  const segment = saveSegment(ctx.db, {
    name: ctx.fields.require('name', 'give the segment a name you will recognise'),
    query: ctx.fields.get('q'),
    tag: ctx.fields.get('tag'),
    company: ctx.fields.get('company'),
    spokeAtEventId: event?.id ?? null,
    neverSpoken: ctx.fields.bool('never_spoken'),
  });

  return redirect(`/crm/segments/${segment.slug}`);
}

function showSegment(ctx) {
  requireAnyOrganizer(ctx);
  const segment = ctx.db.prepare('SELECT * FROM segment WHERE slug = ?').get(ctx.params.slug);
  if (!segment) {
    const known = segments(ctx.db).map((s) => s.slug);
    throw notFound(`no segment '${ctx.params.slug}'`,
      known.length ? `segments are: ${known.join(', ')}` : 'no segments have been saved');
  }

  const rows = runSegment(ctx.db, segment);
  return ok(page({
    title: `${segment.name} - speaker database`,
    nav: crmNav('Directory'),
    wide: true,
    body: html`
      <p class="sub"><a href="/crm">&larr; Directory</a></p>
      <h1>${segment.name}</h1>
      <p class="sub"><strong>${rows.length}</strong> people match right now.
        Resolved when you loaded this page, not when the segment was saved.</p>
      ${peopleTable(rows)}
    `,
  }));
}

// --- one person ------------------------------------------------------------

function findPerson(ctx, slug) {
  const person = ctx.db.prepare('SELECT * FROM person WHERE slug = ?').get(slug);
  if (!person) throw notFound(`no person '${slug}'`, 'the directory is at /crm');
  return person;
}

function profile(ctx) {
  requireAnyOrganizer(ctx);
  const person = findPerson(ctx, ctx.params.slug);

  const history = personHistory(ctx.db, person.id);
  const notes = notesOn(ctx.db, person.id);
  const tags = tagsOn(ctx.db, person.id);
  const spokenAt = new Set(history.filter((h) => h.status === 'accepted').map((h) => h.event_slug));

  const card = ctx.db.prepare(
    `SELECT c.*, s.name AS stage_name, s.slug AS stage_slug
       FROM pipeline_card c JOIN pipeline_stage s ON s.id = c.stage_id
      WHERE c.person_id = ? LIMIT 1`,
  ).get(person.id);

  return ok(page({
    title: `${fullName(person)} - speaker database`,
    nav: crmNav('Directory'),
    body: html`
      <p class="sub"><a href="/crm">&larr; Directory</a></p>
      <h1>${fullName(person)}</h1>
      <p class="sub">${[person.job_title, person.company].filter(Boolean).join(', ')}
        ${person.email ? html` &middot; ${person.email}` : ''}</p>
      <p class="sub">
        Spoken at <strong>${spokenAt.size}</strong> event${spokenAt.size === 1 ? '' : 's'},
        ${history.length} submission${history.length === 1 ? '' : 's'} in total.
      </p>

      <h2>History</h2>
      ${history.length === 0 ? empty('Nothing yet. Somebody added them by hand, or they reviewed.') : html`
        <table>
          <thead><tr><th>Event</th><th>Session</th><th>Status</th><th>Role</th></tr></thead>
          <tbody>
            ${history.map((h) => html`
              <tr>
                <td>${h.event_name}<br><span class="muted">${dateOnly(h.starts_at, 'UTC')}</span></td>
                <td><a href="/e/${h.event_slug}/submissions/${h.code}">${h.title}</a></td>
                <td>${statusPill(h.status)}</td>
                <td class="muted">${h.role}</td>
              </tr>`)}
          </tbody>
        </table>`}

      <h2>Tags</h2>
      <p>
        ${tags.length === 0 ? html`<span class="muted">None.</span>` : tags.map((t) => html`
          <form method="post" action="/crm/people/${person.slug}/tags/remove" class="inline">
            <input type="hidden" name="tag" value="${t}">
            <button type="submit" class="pill draft"
                    style="border:0;cursor:pointer" title="Remove">${t} &times;</button>
          </form> `)}
      </p>
      <form method="post" action="/crm/people/${person.slug}/tags" class="row">
        <div><label for="tag">Add a tag</label>
          <input type="text" id="tag" name="tag" required placeholder="keynote material"></div>
        <div style="flex:0 0 auto"><button type="submit">Add</button></div>
      </form>

      <h2>Notes</h2>
      <p class="sub">Internal, and never shown to the speaker.</p>
      ${notes.length === 0 ? empty('Nothing recorded.') : html`
        <div class="stack">
          ${notes.map((n) => html`
            <div class="card">
              <p class="muted" style="margin:0 0 .25rem">
                ${n.first_name ? `${n.first_name} ${n.last_name}` : 'Someone'} &middot; ${n.created_at}</p>
              <p style="margin:0">${n.body}</p>
            </div>`)}
        </div>`}
      <form method="post" action="/crm/people/${person.slug}/notes">
        <label for="body">Add a note</label>
        <textarea id="body" name="body" required
                  placeholder="Met at DevFlow 2026 - strong on CI topics; shortlist for a keynote."></textarea>
        <div class="actions"><button type="submit">Save note</button></div>
      </form>

      <h2>Sourcing</h2>
      ${card ? html`
        <p>In the pipeline at <strong>${card.stage_name}</strong>
          ${card.score != null ? html` &middot; scored ${card.score}` : ''}.
          <a href="/crm/pipeline">See the board</a>.</p>
        ${card.rationale ? html`<p class="muted">${card.rationale}</p>` : ''}`
        : html`
        <form method="post" action="/crm/people/${person.slug}/enroll" class="row">
          <div><label for="score">Score <small>optional, 0 to 100</small></label>
            <input type="number" id="score" name="score" min="0" max="100"></div>
          <div><label for="rationale">Why</label>
            <input type="text" id="rationale" name="rationale"
                   placeholder="Strong platform-engineering track record."></div>
          <div style="flex:0 0 auto"><button type="submit">Add to the pipeline</button></div>
        </form>`}
    `,
  }));
}

function postNote(ctx) {
  requireAnyOrganizer(ctx);
  const person = findPerson(ctx, ctx.params.slug);
  addNote(ctx.db, person.id, ctx.person?.id ?? null,
    ctx.fields.require('body', 'write something before saving a note'));
  return redirect(`/crm/people/${person.slug}`);
}

function postTag(ctx) {
  requireAnyOrganizer(ctx);
  const person = findPerson(ctx, ctx.params.slug);
  addTag(ctx.db, person.id, ctx.fields.require('tag'));
  return redirect(`/crm/people/${person.slug}`);
}

function postRemoveTag(ctx) {
  requireAnyOrganizer(ctx);
  const person = findPerson(ctx, ctx.params.slug);
  removeTag(ctx.db, person.id, ctx.fields.require('tag'));
  return redirect(`/crm/people/${person.slug}`);
}

function postEnroll(ctx) {
  requireAnyOrganizer(ctx);
  const person = findPerson(ctx, ctx.params.slug);

  enroll(ctx.db, {
    personId: person.id,
    score: ctx.fields.int('score', null),
    rationale: ctx.fields.get('rationale'),
    actorPersonId: ctx.person?.id ?? null,
  });
  return redirect('/crm/pipeline');
}

// --- duplicates ------------------------------------------------------------

function duplicates(ctx) {
  requireAnyOrganizer(ctx);
  const groups = findDuplicates(ctx.db).map((g) => ({
    ...g,
    people: g.slugs.split(',').map((slug) =>
      ctx.db.prepare(
        `SELECT p.*, (SELECT count(*) FROM submission_participant sp WHERE sp.person_id = p.id) AS submissions
           FROM person p WHERE p.slug = ?`,
      ).get(slug)),
  }));

  return ok(page({
    title: 'Duplicates - speaker database',
    nav: crmNav('Duplicates'),
    wide: true,
    body: html`
      <h1>Possible duplicates</h1>
      <p class="sub">Matched on name, because email is already unique and can never find
        them. That is also how duplicates arise: a work address one year, a personal
        one the next.</p>

      ${groups.length === 0 ? empty('Nobody appears twice.') : groups.map((g) => html`
        <fieldset>
          <legend>${g.people[0].first_name} ${g.people[0].last_name}</legend>
          <table>
            <thead><tr><th>Keep</th><th>Email</th><th class="num">Submissions</th>
              <th>Company</th><th>Has a bio</th></tr></thead>
            <tbody>
              ${g.people.map((p) => html`
                <tr>
                  <td><code>${p.slug}</code></td>
                  <td>${p.email}</td>
                  <td class="num">${p.submissions}</td>
                  <td>${p.company}</td>
                  <td>${p.biography ? 'yes' : html`<span class="muted">no</span>`}</td>
                </tr>`)}
            </tbody>
          </table>

          <form method="post" action="/crm/merge" class="row">
            <div><label for="keep_${g.people[0].slug}">Keep</label>
              <select id="keep_${g.people[0].slug}" name="keep">
                ${g.people.map((p) => html`<option value="${p.slug}">${p.email}</option>`)}
              </select></div>
            <div><label for="merge_${g.people[0].slug}">Fold in</label>
              <select id="merge_${g.people[0].slug}" name="merge">
                ${[...g.people].reverse().map((p) => html`<option value="${p.slug}">${p.email}</option>`)}
              </select></div>
            <div style="flex:0 0 auto"><button type="submit">Merge them</button></div>
          </form>
          <p class="muted">Everything the folded-in record owns moves across: submissions,
            tasks, reviews, notes, tags, and files. Nothing is discarded.</p>
        </fieldset>`)}
    `,
  }));
}

function postMerge(ctx) {
  requireAnyOrganizer(ctx);
  const keep = findPerson(ctx, ctx.fields.require('keep'));
  const merge = findPerson(ctx, ctx.fields.require('merge'));

  if (keep.id === merge.id) {
    throw badRequest('those are the same record',
      'choose a different record to fold in');
  }

  mergePeople(ctx.db, keep.id, merge.id, { actorPersonId: ctx.person?.id ?? null });
  return redirect(`/crm/people/${keep.slug}`);
}

// --- pipeline --------------------------------------------------------------

function pipeline(ctx) {
  requireAnyOrganizer(ctx);
  const columns = board(ctx.db);
  const allStages = stages(ctx.db);
  const total = columns.reduce((sum, c) => sum + c.cards.length, 0);

  return ok(page({
    title: 'Sourcing - speaker database',
    nav: crmNav('Sourcing'),
    wide: true,
    body: html`
      <h1>Sourcing</h1>
      <p class="sub">${total} ${total === 1 ? 'person' : 'people'} being approached.
        Move somebody with the buttons; every move is kept, so "when did this stall"
        has an answer.</p>

      ${total === 0 ? empty('Nobody is in the pipeline. Add somebody from their profile in the directory.') : ''}

      ${columns.map(({ stage, cards }) => html`
        <h2>${stage.name} <span class="muted">(${cards.length})</span>
          ${stage.is_terminal ? html`<span class="pill draft">final</span>` : ''}</h2>
        ${cards.length === 0 ? html`<p class="muted">Nobody here.</p>` : html`
          <div class="stack">
            ${cards.map((c) => html`
              <div class="card">
                <strong><a href="/crm/people/${c.person_slug}">${c.first_name} ${c.last_name}</a></strong>
                ${c.company ? html` <span class="muted">&middot; ${c.company}</span>` : ''}
                ${c.score != null ? html` <span class="pill accepted">${c.score}</span>` : ''}
                ${c.rationale ? html`<p class="muted" style="margin:.35rem 0">${c.rationale}</p>` : ''}
                <form method="post" action="/crm/pipeline/${c.id}/move" class="row">
                  <div>
                    <label for="stage_${c.id}">Move to</label>
                    <select id="stage_${c.id}" name="stage">
                      ${allStages.filter((s) => s.id !== stage.id).map((s) => html`
                        <option value="${s.slug}">${s.name}</option>`)}
                    </select>
                  </div>
                  <div><label for="note_${c.id}">Note <small>optional</small></label>
                    <input type="text" id="note_${c.id}" name="note"
                           placeholder="Left a voicemail; follow up next week."></div>
                  <div style="flex:0 0 auto"><button type="submit">Move</button></div>
                </form>
                ${historyFor(ctx, c.id)}
              </div>`)}
          </div>`}`)}
    `,
  }));
}

function historyFor(ctx, cardId) {
  const moves = movesFor(ctx.db, cardId);
  if (moves.length <= 1) return '';
  return html`
    <details>
      <summary class="muted">${moves.length} moves</summary>
      <table><tbody>
        ${moves.map((m) => html`
          <tr>
            <td class="muted">${m.created_at}</td>
            <td>${m.from_name ? `${m.from_name} to ${m.to_name}` : `added at ${m.to_name}`}</td>
            <td class="muted">${m.note}</td>
          </tr>`)}
      </tbody></table>
    </details>`;
}

function postMove(ctx) {
  requireAnyOrganizer(ctx);
  const id = Number(ctx.params.id);

  try {
    moveCard(ctx.db, id, ctx.fields.require('stage'), {
      actorPersonId: ctx.person?.id ?? null,
      note: ctx.fields.get('note'),
    });
  } catch (err) {
    throw badRequest(err.message, 'the board is at /crm/pipeline');
  }

  return redirect('/crm/pipeline');
}
