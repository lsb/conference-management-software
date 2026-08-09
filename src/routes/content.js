// The organizer's view of everything speakers have sent in: the files, their
// versions, the conversation about them, and the approval that decides whether
// a session reaches the public agenda.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, notFound } from '../http/router.js';
import {
  versionsOf, commentsOn, addComment, setContentStatus, revisionsOf,
  restoreRevision, snapshot, CONTENT_STATUSES,
} from '../core/content.js';
import { isImage, readStoredFile } from '../core/files.js';
import { buildZip } from '../core/zip.js';
import {
  findEvent, findSubmission, requireOrganizer, organizerNav, empty, tabs, fullName, dateOnly,
} from './shared.js';

export function mountContent(router) {
  router.get('/e/:event/files', fileLibrary,
    'Every file speakers have sent in, with who sent it, when, and how many versions.');
  router.get('/e/:event/files/:slug', fileDetail,
    'One file: its versions, and the conversation about it.');
  router.post('/e/:event/files/:slug/comments', postComment,
    'Add a comment to a file. Body: body.');

  router.post('/e/:event/submissions/:code/content', postContentStatus,
    'Set a session\'s content status. Body: content_status=draft|in_review|approved.');
  router.post('/e/:event/submissions/:code/edit', postEditContent,
    'Edit a session\'s title and description, keeping the previous version.');
  router.post('/e/:event/submissions/:code/restore/:revision', postRestore,
    'Put a session\'s content back to an earlier version.');

  router.get('/e/:event/files.zip', filesZip,
    'Every current deliverable in one archive. ?group=speaker|session|flat, ?task=slug to narrow.');
}

/**
 * Every current deliverable, in one archive.
 *
 * Only current versions: an AV team wants the deck that is going on screen, not
 * a folder containing four attempts at it. Grouping is a real choice, because
 * "all the slides" and "everything from this speaker" are different jobs.
 */
function filesZip(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const grouping = ctx.query.get('group') ?? 'speaker';
  if (!['speaker', 'session', 'flat'].includes(grouping)) {
    throw badRequest(`unknown grouping '${grouping}'`, 'use group=speaker, group=session, or group=flat');
  }

  const taskSlug = ctx.query.get('task');
  if (taskSlug) {
    const known = ctx.db.prepare('SELECT slug FROM task_definition WHERE event_id = ?')
      .all(event.id).map((t) => t.slug);
    if (!known.includes(taskSlug)) {
      throw badRequest(`no task called '${taskSlug}' at this event`,
        known.length ? `tasks are: ${known.join(', ')}` : 'this event has no tasks');
    }
  }

  const rows = ctx.db.prepare(
    `SELECT f.slug, f.filename, f.created_at,
            p.first_name, p.last_name,
            s.code AS submission_code, s.title AS submission_title,
            td.slug AS task_slug, td.title AS task_title
       FROM file f
       LEFT JOIN person p ON p.id = f.uploaded_by_person_id
       LEFT JOIN task_instance ti ON ti.file_id = f.id
       LEFT JOIN task_definition td ON td.id = ti.definition_id
       LEFT JOIN submission s ON s.id = ti.submission_id
      WHERE f.event_id = ? AND f.superseded_at IS NULL
        AND (? IS NULL OR td.slug = ?)
      ORDER BY p.last_name, f.created_at`,
  ).all(event.id, taskSlug ?? null, taskSlug ?? null);

  const files = [];
  for (const row of rows) {
    const stored = readStoredFile(ctx.db, row.slug);
    if (!stored) continue;   // a row whose bytes are gone is skipped, not fatal

    const who = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'unknown';
    const folder = grouping === 'speaker' ? who
      : grouping === 'session' ? (row.submission_code ?? 'no session')
        : '';

    files.push({
      name: folder ? `${folder}/${row.filename}` : row.filename,
      data: stored.data,
      date: row.created_at,
    });
  }

  if (files.length === 0) {
    throw badRequest('there are no files to download',
      taskSlug ? `nobody has uploaded anything for '${taskSlug}' yet`
        : `uploads appear at /e/${event.slug}/files`);
  }

  const archive = buildZip(files);
  return {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-length': String(archive.length),
      'content-disposition': `attachment; filename="${event.slug}-files.zip"`,
    },
    body: archive,
  };
}

// --- the library -----------------------------------------------------------

function fileLibrary(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  // Only the current version of each lineage, with a count of what is behind it.
  const files = ctx.db.prepare(
    `SELECT f.*, p.first_name, p.last_name, p.slug AS person_slug,
            (SELECT count(*) FROM file v WHERE v.root_file_id = f.root_file_id) AS versions,
            (SELECT count(*) FROM file_comment c
               JOIN file v2 ON v2.id = c.file_id
              WHERE v2.root_file_id = f.root_file_id) AS comments,
            td.title AS task_title, s.code AS submission_code, s.title AS submission_title
       FROM file f
       LEFT JOIN person p ON p.id = f.uploaded_by_person_id
       LEFT JOIN task_instance ti ON ti.file_id = f.id
       LEFT JOIN task_definition td ON td.id = ti.definition_id
       LEFT JOIN submission s ON s.id = ti.submission_id
      WHERE f.event_id = ? AND f.superseded_at IS NULL
      ORDER BY f.created_at DESC`,
  ).all(event.id);

  return ok(page({
    title: `Files - ${event.name}`,
    nav: organizerNav(event, 'Files'),
    wide: true,
    body: html`
      <h1>Files</h1>
      <p class="sub">Everything speakers have uploaded. Older versions are kept and
        stay reachable from each file.</p>

      ${files.length === 0 ? empty('Nothing has been uploaded yet.') : html`
        <form method="get" action="/e/${event.slug}/files.zip" class="row" style="margin-bottom:1.25rem">
          <div>
            <label for="group">Download everything, in folders by</label>
            <select id="group" name="group">
              <option value="speaker">Speaker</option>
              <option value="session">Session</option>
              <option value="flat">No folders</option>
            </select>
          </div>
          <div>
            <label for="task">Only one deliverable <small>optional</small></label>
            <select id="task" name="task">
              <option value="">Everything</option>
              ${ctx.db.prepare('SELECT slug, title FROM task_definition WHERE event_id = ? ORDER BY sort_order')
                .all(event.id).map((t) => html`<option value="${t.slug}">${t.title}</option>`)}
            </select>
          </div>
          <div style="flex:0 0 auto"><button type="submit">Download archive</button></div>
        </form>

        <div class="scroll">
        <table>
          <thead><tr><th>File</th><th>For</th><th>From</th><th>Uploaded</th>
            <th class="num">Versions</th><th class="num">Comments</th></tr></thead>
          <tbody>
            ${files.map((f) => html`
              <tr>
                <td><a href="/e/${event.slug}/files/${f.slug}"><strong>${f.filename}</strong></a>
                  <br><span class="muted">${f.content_type} &middot; ${Math.max(1, Math.round(f.byte_size / 1024))} KB</span></td>
                <td>${f.task_title ?? html`<span class="muted">a profile photo</span>`}
                  ${f.submission_code ? html`<br><a href="/e/${event.slug}/submissions/${f.submission_code}">
                    <code>${f.submission_code}</code></a>` : ''}</td>
                <td>${f.first_name ? `${f.first_name} ${f.last_name}` : html`<span class="muted">unknown</span>`}</td>
                <td class="muted">${f.created_at}</td>
                <td class="num">${f.versions}</td>
                <td class="num">${f.comments}</td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}
    `,
  }));
}

function findFile(ctx, event, slug) {
  const file = ctx.db.prepare('SELECT * FROM file WHERE slug = ? AND event_id = ?')
    .get(slug, event.id);
  if (!file) throw notFound(`no file '${slug}' in this event`,
    `the library is at /e/${event.slug}/files`);
  return file;
}

function fileDetail(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const file = findFile(ctx, event, ctx.params.slug);

  const versions = versionsOf(ctx.db, file.id);
  const comments = commentsOn(ctx.db, file.id);
  const current = versions[0];

  return ok(page({
    title: `${file.filename} - ${event.name}`,
    nav: organizerNav(event, 'Files'),
    body: html`
      <p class="sub"><a href="/e/${event.slug}/files">&larr; All files</a></p>
      <h1>${file.filename}</h1>
      <p class="sub">${file.content_type} &middot;
        ${Math.max(1, Math.round(file.byte_size / 1024))} KB &middot;
        version ${file.version} of ${versions.length}</p>

      ${isImage(file) ? html`<p><img src="/files/${file.slug}" alt="${file.filename}"
        style="max-width:24rem;border-radius:8px"></p>` : ''}
      <p><a class="button" href="/files/${file.slug}">Download this version</a></p>

      <h2>Versions</h2>
      <p class="sub">Every upload is kept. The newest is current; the others stay
        downloadable, because somebody has usually already printed from one of them.</p>
      <table>
        <thead><tr><th>Version</th><th>Uploaded by</th><th>When</th><th>Size</th><th></th></tr></thead>
        <tbody>
          ${versions.map((v) => html`
            <tr>
              <td>${v.version}${v.id === current.id ? html` <span class="pill accepted">current</span>` : ''}</td>
              <td>${v.first_name ? `${v.first_name} ${v.last_name}` : html`<span class="muted">unknown</span>`}</td>
              <td class="muted">${v.created_at}</td>
              <td>${Math.max(1, Math.round(v.byte_size / 1024))} KB</td>
              <td><a href="/files/${v.slug}">Download</a>
                ${v.id === file.id ? '' : html` &middot;
                  <a href="/e/${event.slug}/files/${v.slug}">Open</a>`}</td>
            </tr>`)}
        </tbody>
      </table>

      <h2>Comments</h2>
      ${comments.length === 0 ? empty('Nothing said about this yet.') : html`
        <div class="stack">
          ${comments.map((c) => html`
            <div class="card">
              <p style="margin:0 0 .25rem"><strong>${c.first_name
                ? `${c.first_name} ${c.last_name}` : 'Someone'}</strong>
                <span class="muted">${c.created_at} &middot; on version ${c.version}</span></p>
              <p style="margin:0">${c.body}</p>
            </div>`)}
        </div>`}

      <form method="post" action="/e/${event.slug}/files/${file.slug}/comments">
        <label for="body">Add a comment</label>
        <textarea id="body" name="body" required
                  placeholder="Thanks - please confirm the final version by Tuesday."></textarea>
        <div class="actions"><button type="submit">Comment</button></div>
      </form>
    `,
  }));
}

function postComment(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const file = findFile(ctx, event, ctx.params.slug);

  addComment(ctx.db, file.id, ctx.person?.id ?? null,
    ctx.fields.require('body', 'write something before commenting'));

  return redirect(`/e/${event.slug}/files/${file.slug}`);
}

// --- approval, editing, and history ----------------------------------------

function postContentStatus(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const submission = findSubmission(ctx.db, event.id, ctx.params.code);

  const status = ctx.fields.choice('content_status', CONTENT_STATUSES);
  setContentStatus(ctx.db, submission.id, status, { actorPersonId: ctx.person?.id ?? null });

  return redirect(`/e/${event.slug}/submissions/${submission.code}`
    + `?done=${encodeURIComponent(`Content marked ${status.replace('_', ' ')}`)}`);
}

function postEditContent(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const submission = findSubmission(ctx.db, event.id, ctx.params.code);

  const title = ctx.fields.require('title');
  const description = ctx.fields.get('description');

  if (title === submission.title && description === submission.description) {
    return redirect(`/e/${event.slug}/submissions/${submission.code}`);
  }

  // Snapshot what it said before touching it, so the history reads as a list of
  // previous states rather than a list of edits with the current one missing.
  snapshot(ctx.db, submission, { actorPersonId: ctx.person?.id ?? null });

  ctx.db.prepare(
    'UPDATE submission SET title = ?, description = ?, updated_at = ? WHERE id = ?',
  ).run(title, description, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), submission.id);

  return redirect(`/e/${event.slug}/submissions/${submission.code}?done=Content+saved`);
}

function postRestore(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const submission = findSubmission(ctx.db, event.id, ctx.params.code);

  try {
    restoreRevision(ctx.db, submission.id, Number(ctx.params.revision),
      { actorPersonId: ctx.person?.id ?? null });
  } catch (err) {
    throw badRequest(err.message, `the history is on /e/${event.slug}/submissions/${submission.code}`);
  }

  return redirect(`/e/${event.slug}/submissions/${submission.code}?done=Restored+an+earlier+version`);
}

/**
 * The content panel for the submission detail page.
 *
 * Exported rather than routed: it belongs on the page an organizer is already
 * looking at, not behind another click.
 */
export function contentPanel(ctx, event, submission) {
  const revisions = revisionsOf(ctx.db, submission.id);
  const statusLabels = { draft: 'Draft', in_review: 'In review', approved: 'Approved' };

  return html`
    <h2>Content</h2>
    <p class="sub">Approval says the words are right. Publishing, on the schedule
      form above, says the world may read them. A session needs both to appear
      on the public agenda.</p>

    <form method="post" action="/e/${event.slug}/submissions/${submission.code}/content" class="row">
      <div>
        <label for="content_status">Status</label>
        <select id="content_status" name="content_status">
          ${CONTENT_STATUSES.map((s) => html`
            <option value="${s}" ${s === submission.content_status ? raw('selected') : ''}>${statusLabels[s]}</option>`)}
        </select>
      </div>
      <div style="flex:0 0 auto"><button type="submit">Save status</button></div>
    </form>
    ${submission.content_approved_at
      ? html`<p class="muted">Approved ${submission.content_approved_at}.</p>` : ''}

    <form method="post" action="/e/${event.slug}/submissions/${submission.code}/edit">
      <label for="c_title">Title</label>
      <input type="text" id="c_title" name="title" value="${submission.title}" required>
      <label for="c_description">Description</label>
      <textarea id="c_description" name="description">${submission.description}</textarea>
      <div class="actions"><button type="submit">Save content</button></div>
    </form>

    <h3>History</h3>
    ${revisions.length === 0 ? empty('No edits yet.') : html`
      <table>
        <thead><tr><th>When</th><th>Edited by</th><th>What it said</th><th></th></tr></thead>
        <tbody>
          ${revisions.map((r) => html`
            <tr>
              <td class="muted">${r.created_at}</td>
              <td>${r.first_name ? `${r.first_name} ${r.last_name}` : html`<span class="muted">unknown</span>`}</td>
              <td><strong>${r.title}</strong><br>
                <span class="muted">${String(r.description).slice(0, 120)}${r.description.length > 120 ? '…' : ''}</span>
                ${r.note ? html`<br><span class="muted">${r.note}</span>` : ''}</td>
              <td>
                <form method="post" class="inline"
                      action="/e/${event.slug}/submissions/${submission.code}/restore/${r.id}">
                  <button type="submit" class="secondary">Restore this</button>
                </form>
              </td>
            </tr>`)}
        </tbody>
      </table>`}
  `;
}
