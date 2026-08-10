// The embed generator.
//
// A conference already has a website. This produces the thing they paste into
// it: a self-contained HTML fragment, or the same data as JSON, XML, or a
// subscribable calendar, depending on who is building that website.
//
// Everything here is read-only from the public's point of view, and updates
// itself: publish a schedule change and every embed reflects it on the next
// request, with no copy to keep in sync.

import { html, page, raw } from '../http/html.js';
import { ok, redirect, badRequest, notFound, json } from '../http/router.js';
import { now, uniqueSlug } from '../db.js';
import { FEEDS, FORMATS, renderFeed, showsPeople } from '../core/feeds.js';
import { findEvent, requireOrganizer, organizerNav, empty } from './shared.js';

export function mountEmbeds(router) {
  router.get('/e/:event/embeds', embedList,
    'Embeds: feeds of the agenda or speakers to paste into your own website.');
  router.post('/e/:event/embeds', createEmbed,
    'Create an embed. Body: name, feed, format.');
  router.get('/e/:event/embeds/:slug', embedDetail,
    'Configure one embed and copy its snippet.');
  router.post('/e/:event/embeds/:slug', updateEmbed,
    'Save an embed\'s feed, format, filters, and fields.');
  router.post('/e/:event/embeds/:slug/delete', deleteEmbed, 'Remove an embed.');
}

function findEmbed(ctx, event, slug) {
  const embed = ctx.db.prepare('SELECT * FROM embed WHERE event_id = ? AND slug = ?')
    .get(event.id, slug);
  if (!embed) {
    const known = ctx.db.prepare('SELECT slug FROM embed WHERE event_id = ?').all(event.id)
      .map((e) => e.slug);
    throw notFound(`no embed '${slug}'`,
      known.length ? `embeds are: ${known.join(', ')}` : 'this event has no embeds yet');
  }
  return embed;
}

function publicUrl(ctx, event, embed) {
  const base = ctx.origin;
  const extension = embed.format === 'html' ? '' : `.${embed.format}`;
  return `${base}/embed/${event.slug}/${embed.slug}${extension}`;
}

function embedList(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const embeds = ctx.db.prepare('SELECT * FROM embed WHERE event_id = ? ORDER BY created_at')
    .all(event.id);

  return ok(page({
    title: `Embeds - ${event.name}`,
    nav: organizerNav(event, 'Embeds'),
    wide: true,
    body: html`
      <h1>Embeds</h1>
      <p class="sub">Feeds of your programme for your own website. They update
        themselves, so a room change reaches every page that shows it.</p>

      ${embeds.length === 0 ? empty('No embeds yet. Make one below.') : html`
        <table>
          <thead><tr><th>Name</th><th>Shows</th><th>As</th><th>URL</th><th>Enabled</th></tr></thead>
          <tbody>
            ${embeds.map((e) => html`
              <tr>
                <td><a href="/e/${event.slug}/embeds/${e.slug}"><strong>${e.name}</strong></a></td>
                <td>${FEEDS.find((f) => f.value === e.feed)?.label ?? e.feed}</td>
                <td>${FORMATS.find((f) => f.value === e.format)?.label ?? e.format}</td>
                <td><a href="${publicUrl(ctx, event, e)}"><code>${publicUrl(ctx, event, e)}</code></a></td>
                <td>${e.enabled ? 'yes' : html`<span class="muted">no</span>`}</td>
              </tr>`)}
          </tbody>
        </table>`}

      <h2>New embed</h2>
      <form method="post" action="/e/${event.slug}/embeds">
        <div class="row">
          <div><label for="name">Name <small>for you, not the public</small></label>
            <input type="text" id="name" name="name" required placeholder="Agenda for the homepage"></div>
          <div><label for="feed">Show</label>
            <select id="feed" name="feed">
              ${FEEDS.map((f) => html`<option value="${f.value}">${f.label}</option>`)}
            </select></div>
          <div><label for="format">As</label>
            <select id="format" name="format">
              ${FORMATS.map((f) => html`<option value="${f.value}">${f.label}</option>`)}
            </select></div>
          <div style="flex:0 0 auto"><button type="submit">Create</button></div>
        </div>
        <p class="muted">
          ${FORMATS.map((f) => html`<strong>${f.label}</strong>: ${f.hint} `)}
        </p>
      </form>
    `,
  }));
}

function createEmbed(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);

  const name = ctx.fields.require('name', 'for example: Agenda for the homepage');
  const slug = uniqueSlug(name,
    (s) => ctx.db.prepare('SELECT 1 FROM embed WHERE event_id = ? AND slug = ?').get(event.id, s));

  const embed = ctx.db.prepare(
    `INSERT INTO embed (event_id, slug, name, feed, format, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING *`,
  ).get(event.id, slug, name,
    ctx.fields.choice('feed', FEEDS.map((f) => f.value), 'agenda'),
    ctx.fields.choice('format', FORMATS.map((f) => f.value), 'html'),
    now());

  // Hand back the URL, because the URL is the whole point of the request.
  //
  // This used to be a bare 303 to the admin page: empty body, and a Location
  // naming the screen where you configure the thing rather than the address you
  // give the person who asked for it. Somebody told "set up a JSON feed and tell
  // them the exact URL to fetch" did the creation correctly and then had nothing
  // to report -- the public address is /embed/<event>/<slug>, and we never said
  // so anywhere in the reply.
  //
  // A browser still gets the page. Anything else gets the answer.
  if (!(ctx.headers?.accept ?? '').includes('text/html')) {
    return json({
      slug: embed.slug,
      name: embed.name,
      feed: embed.feed,
      format: embed.format,
      url: publicUrl(ctx, event, embed),
      note: 'That url is the public, cross-origin feed: give it to whoever asked for it. '
        + 'Format is a property of this embed, so a JSON feed is one made with '
        + 'format=json; adding .json to an HTML embed\'s URL converts nothing.',
      configure: `${ctx.origin}/e/${event.slug}/embeds/${embed.slug}`,
    }, { status: 201 });
  }

  return redirect(`/e/${event.slug}/embeds/${embed.slug}`);
}

function embedDetail(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const embed = findEmbed(ctx, event, ctx.params.slug);

  const tracks = ctx.db.prepare('SELECT * FROM track WHERE event_id = ? ORDER BY sort_order')
    .all(event.id);
  const url = publicUrl(ctx, event, embed);
  const rendered = renderFeed(ctx.db, event, embed, {});

  const snippet = embed.format === 'html'
    ? `<iframe src="${url}" style="width:100%;border:0;min-height:40rem" title="${embed.name}"></iframe>`
    : `fetch(${JSON.stringify(url)})`;

  return ok(page({
    title: `${embed.name} - ${event.name}`,
    nav: organizerNav(event, 'Embeds'),
    wide: true,
    body: html`
      <p class="sub"><a href="/e/${event.slug}/embeds">&larr; All embeds</a></p>
      <h1>${embed.name}</h1>
      <p class="sub">${FEEDS.find((f) => f.value === embed.feed)?.label}
        as ${FORMATS.find((f) => f.value === embed.format)?.label}
        ${embed.enabled ? '' : html` &middot; <strong>disabled</strong>`}</p>

      <h2>Paste this</h2>
      <p><a href="${url}"><code>${url}</code></a></p>
      <pre style="white-space:pre-wrap;background:var(--panel);padding:1rem;border-radius:8px">${snippet}</pre>

      <h2>Settings</h2>
      <form method="post" action="/e/${event.slug}/embeds/${embed.slug}">
        <div class="row">
          <div><label for="name">Name</label>
            <input type="text" id="name" name="name" value="${embed.name}" required></div>
          <div><label for="feed">Show</label>
            <select id="feed" name="feed">
              ${FEEDS.map((f) => html`
                <option value="${f.value}" ${f.value === embed.feed ? raw('selected') : ''}>${f.label}</option>`)}
            </select></div>
          <div><label for="format">As</label>
            <select id="format" name="format">
              ${FORMATS.map((f) => html`
                <option value="${f.value}" ${f.value === embed.format ? raw('selected') : ''}>${f.label}</option>`)}
            </select></div>
          <div><label for="filter_track">Only this track</label>
            <select id="filter_track" name="filter_track">
              <option value="">All tracks</option>
              ${tracks.map((t) => html`
                <option value="${t.slug}" ${t.id === embed.filter_track_id ? raw('selected') : ''}>${t.name}</option>`)}
            </select></div>
        </div>

        <fieldset>
          <legend>Include</legend>
          <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
            <input type="checkbox" name="include_description" value="1"
                   ${embed.include_description ? raw('checked') : ''}> Descriptions
          </label>
          <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
            <input type="checkbox" name="include_speakers" value="1"
                   ${embed.include_speakers ? raw('checked') : ''}> Speaker names
          </label>
          <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
            <input type="checkbox" name="include_room" value="1"
                   ${embed.include_room ? raw('checked') : ''}> Rooms
          </label>
          <label style="display:flex;gap:.5rem;align-items:center;font-weight:400">
            <input type="checkbox" name="enabled" value="1"
                   ${embed.enabled ? raw('checked') : ''}> Enabled
          </label>
          <label for="accent_color">Accent colour <small>styled HTML only</small></label>
          <input type="text" id="accent_color" name="accent_color"
                 value="${embed.accent_color}" placeholder="#1f52c8">
        </fieldset>

        <div class="actions"><button type="submit">Save</button></div>
      </form>

      <h2>Preview</h2>
      <p class="sub">Exactly what the URL above returns, right now.</p>
      <pre style="white-space:pre-wrap;background:var(--panel);padding:1rem;border-radius:8px;max-height:24rem;overflow:auto">${String(rendered.body).slice(0, 4000)}</pre>

      <h2>Remove</h2>
      <form method="post" action="/e/${event.slug}/embeds/${embed.slug}/delete">
        <p class="muted">Anything embedding this URL will stop working.</p>
        <button type="submit" class="secondary">Delete this embed</button>
      </form>
    `,
  }));
}

function updateEmbed(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const embed = findEmbed(ctx, event, ctx.params.slug);

  const trackSlug = ctx.fields.get('filter_track');
  const track = trackSlug
    ? ctx.db.prepare('SELECT id FROM track WHERE event_id = ? AND slug = ?').get(event.id, trackSlug)
    : null;
  if (trackSlug && !track) throw badRequest(`no track '${trackSlug}' in this event`);

  const feed = ctx.fields.choice('feed', FEEDS.map((f) => f.value));
  const format = ctx.fields.choice('format', FORMATS.map((f) => f.value));

  // A calendar of people is not a thing. Say so rather than serving an empty
  // one and letting somebody wonder why their subscription is blank.
  if (format === 'ics' && showsPeople(feed)) {
    throw badRequest('a speaker list has nothing to put in a calendar',
      'choose an agenda or a session list for iCalendar, or pick another format');
  }

  ctx.db.prepare(
    `UPDATE embed SET name = ?, feed = ?, format = ?, filter_track_id = ?,
                      include_description = ?, include_speakers = ?, include_room = ?,
                      accent_color = ?, enabled = ?
      WHERE id = ?`,
  ).run(ctx.fields.require('name'), feed, format, track?.id ?? null,
    ctx.fields.bool('include_description') ? 1 : 0,
    ctx.fields.bool('include_speakers') ? 1 : 0,
    ctx.fields.bool('include_room') ? 1 : 0,
    ctx.fields.get('accent_color'),
    ctx.fields.bool('enabled') ? 1 : 0,
    embed.id);

  return redirect(`/e/${event.slug}/embeds/${embed.slug}`);
}

function deleteEmbed(ctx) {
  const event = findEvent(ctx.db, ctx.params.event);
  requireOrganizer(ctx, event);
  const embed = findEmbed(ctx, event, ctx.params.slug);

  ctx.db.prepare('DELETE FROM embed WHERE id = ?').run(embed.id);
  return redirect(`/e/${event.slug}/embeds`);
}
