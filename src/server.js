// The HTTP server.
//
//   npm start                  listen on 127.0.0.1:8080
//   PORT=3000 npm start        a different port
//   HOST=0.0.0.0 npm start     bind wider, deliberately
//
// Binds the loopback interface by default. This app holds unpublished decisions
// about people's careers and their contact details; it should not appear on a
// conference wifi network because somebody ran it in a cafe.

import { createServer } from 'node:http';
import { openDatabase, DEFAULT_DB_PATH } from './db.js';
import { Router, HttpError, ok, json, text, redirect } from './http/router.js';
import { parseBody, parseCookies } from './http/request.js';
import { page, html } from './http/html.js';
import { currentPerson } from './core/auth.js';
import { mountPublic } from './routes/public.js';
import { mountOrganizer } from './routes/organizer.js';
import { mountPortal } from './routes/portal.js';
import { mountReviewer } from './routes/reviewer.js';
import { mountMail } from './routes/mail.js';
import { mountWidgets } from './routes/widgets.js';
import { mountDemoAuth } from './routes/demo-auth.js';
import { mountEvaluation } from './routes/evaluation.js';
import { mountSetup } from './routes/setup.js';
import { mountFormBuilder } from './routes/formbuilder.js';
import { mountContent } from './routes/content.js';
import { mountEmbeds } from './routes/embeds.js';
import { mountApi } from './routes/api.js';

export function createApp({ dbPath = DEFAULT_DB_PATH, db = null } = {}) {
  const database = db ?? openDatabase(dbPath);
  const router = new Router();

  mountPublic(router);
  mountSetup(router);
  mountFormBuilder(router);
  mountContent(router);
  mountEmbeds(router);
  mountOrganizer(router);
  mountPortal(router);
  mountReviewer(router);
  mountMail(router);
  mountWidgets(router);
  mountDemoAuth(router);
  mountEvaluation(router);
  mountApi(router);
  mountMeta(router);

  return { db: database, router, handle: (req, res) => handle({ db: database, router }, req, res) };
}

/**
 * Turn one request into one response.
 *
 * Kept separate from the socket so tests and the CLI can call it directly.
 */
export async function respond(app, { method, url, headers = {}, req = null }) {
  const parsed = new URL(url, 'http://127.0.0.1');
  const found = app.router.match(method, parsed.pathname);

  if (!found) {
    const allowed = app.router.allowedFor(parsed.pathname);
    if (allowed.length > 0) {
      throw new HttpError(405, `${method} is not allowed on ${parsed.pathname}`,
        `try: ${allowed.join(', ')}`);
    }
    throw new HttpError(404, `no route for ${method} ${parsed.pathname}`,
      'GET /llms.txt lists every route this app serves');
  }

  const fields = method === 'POST' && req ? await parseBody(req) : null;
  const cookies = parseCookies(headers.cookie);

  const ctx = {
    db: app.db,
    router: app.router,
    method,
    url: parsed,
    query: parsed.searchParams,
    params: found.params,
    fields,
    cookies,
    headers,
    // Resolved lazily: most routes are public and never need to know.
    get person() {
      if (this._person === undefined) this._person = currentPerson(app.db, cookies);
      return this._person;
    },
  };

  return found.route.handler(ctx);
}

async function handle(app, req, res) {
  const started = process.hrtime.bigint();
  let response;

  try {
    response = await respond(app, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      req,
    });
  } catch (err) {
    response = errorResponse(err, req);
    if (!err.status || err.status >= 500) console.error(err);
  }

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  res.setHeader('server-timing', `app;dur=${ms.toFixed(1)}`);

  for (const [key, value] of Object.entries(response.headers ?? {})) {
    res.setHeader(key, value);
  }
  res.statusCode = response.status ?? 200;
  res.end(req.method === 'HEAD' ? undefined : response.body);

  const path = req.url.split('?')[0];
  console.log(`${res.statusCode} ${req.method.padEnd(4)} ${path} ${ms.toFixed(1)}ms`);
}

/**
 * Render an error the way the caller can act on.
 *
 * JSON for API paths, HTML for pages, and in both cases the hint travels with
 * the message. See docs/DESIGN.md on why errors state the fix.
 */
function errorResponse(err, req) {
  const status = err.status ?? 500;
  const message = status >= 500 ? 'internal server error' : err.message;
  const hint = status >= 500 ? 'check the server log' : (err.hint ?? '');

  if (req.url.startsWith('/api/') || (req.headers.accept ?? '').includes('application/json')) {
    return json({ error: message, ...(hint ? { hint } : {}) }, { status });
  }

  return ok(page({
    title: `${status} - ${message}`,
    body: html`
      <h1>${status}</h1>
      <p class="flash error">${message}</p>
      ${hint ? html`<p class="muted">${hint}</p>` : ''}
      <p><a href="/">Back to the start</a> &middot; <a href="/llms.txt">Every route this app serves</a></p>
    `,
  }), { status });
}

// --- meta routes -----------------------------------------------------------

function mountMeta(router) {
  router.get('/llms.txt', (ctx) => text(llmsTxt(ctx.router)),
    'This file. A plain-text index of every route, for humans and for models.');

  router.get('/healthz', (ctx) => {
    const { n } = ctx.db.prepare('SELECT count(*) AS n FROM event').get();
    return json({ status: 'ok', events: n });
  }, 'Liveness check.');
}

/**
 * Generate `/llms.txt` from the route table.
 *
 * Generated rather than written by hand so it cannot drift: a route that exists
 * is listed, and a route that is deleted disappears. This is the single file we
 * expect an unfamiliar assistant to read before doing anything.
 */
export function llmsTxt(router) {
  const documented = router.routes.filter((r) => r.doc);
  const groups = new Map();
  for (const route of documented) {
    const group = groupOf(route.pattern);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(route);
  }

  const lines = [
    '# Conference management',
    '',
    'A local-first tool for running a conference call-for-speakers: collecting',
    'proposals, reviewing them, deciding, telling the speakers, chasing what they',
    'owe, and building the schedule.',
    '',
    '## How to use this app',
    '',
    'Every page renders plain HTML with plain forms, so it works with curl. Every',
    'page also has a JSON twin under /api. Records are addressed by readable slugs',
    'and session codes (SESS-1, SESS-2), never by opaque ids.',
    '',
    'The one rule worth knowing: recording a decision and telling the speaker are',
    'separate steps. Marking a submission accepted moves it to a queue and sends',
    'nothing. A separate notify step mails the speakers and finalises the status.',
    'That is deliberate, so nobody is one click away from mailing forty people.',
    '',
    '## Routes',
    '',
  ];

  for (const [group, routes] of groups) {
    lines.push(`### ${group}`, '');
    for (const route of routes) {
      lines.push(`${route.method} ${route.pattern}`);
      lines.push(`    ${route.doc}`);
    }
    lines.push('');
  }

  lines.push(
    '## Examples',
    '',
    '    curl -s http://127.0.0.1:8080/api/events',
    '    curl -s http://127.0.0.1:8080/api/events/EVENT/submissions?status=pending',
    '    curl -s http://127.0.0.1:8080/api/events/EVENT/submissions/SESS-3',
    '    curl -s http://127.0.0.1:8080/api/events/EVENT/conflicts',
    '',
    '    # record a decision (sends nothing)',
    '    curl -s -X POST http://127.0.0.1:8080/api/events/EVENT/submissions/SESS-3/decide \\',
    '         -H "content-type: application/json" -d \'{"decision":"accept"}\'',
    '',
    '    # then tell the speakers',
    '    curl -s -X POST http://127.0.0.1:8080/api/events/EVENT/notify \\',
    '         -H "content-type: application/json" -d \'{"codes":["SESS-3"]}\'',
    '',
    'There is also a command line covering the same ground: `bin/conf --help`.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function groupOf(pattern) {
  if (pattern.startsWith('/api/')) return 'JSON API';
  if (pattern.startsWith('/portal')) return 'Speaker portal';
  if (pattern.startsWith('/review')) return 'Reviewer';
  if (pattern.startsWith('/submit')) return 'Public call for speakers';
  if (pattern.startsWith('/e/')) return 'Organizer';
  return 'General';
}

// --- entry point -----------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  const app = createApp();

  const server = createServer(app.handle);

  // A busy port is the most common way to start this app and think it is
  // broken. Node's default is an unhandled ECONNREFUSED-shaped stack trace,
  // which reads like a crash and is usually just "you already have one running".
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Something is already listening on ${host}:${port}.`);
      console.error(`If it is this app, it is already running: http://${host}:${port}`);
      console.error(`Check with: curl -s -o /dev/null -w '%{http_code}' http://${host}:${port}/healthz`);
      console.error(`Otherwise start this one elsewhere: PORT=${port + 1} npm start`);
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error(`Not allowed to listen on port ${port}. Ports below 1024 need privileges.`);
      console.error('Try: PORT=8080 npm start');
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    const events = app.db.prepare('SELECT slug, name FROM event ORDER BY starts_at DESC').all();
    console.log(`listening on http://${host}:${port}`);
    if (events.length === 0) {
      console.log('no events yet - run `npm run seed` for a demo conference');
    } else {
      for (const e of events) console.log(`  http://${host}:${port}/e/${e.slug}  ${e.name}`);
    }
    console.log(`  http://${host}:${port}/llms.txt  what this app serves`);
  });
}
