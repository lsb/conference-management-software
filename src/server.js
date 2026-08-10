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
import { currentPerson, PUBLIC_ORIGIN, SESSION_COOKIE } from './core/auth.js';

/**
 * Refuse a state-changing request that a browser made from another site.
 *
 * This app had no CSRF defence at all, which combined with organizer access
 * being open on loopback meant any page you visited could POST to
 * 127.0.0.1:8080 and be obeyed. Closing the access hole removes most of that;
 * this closes the rest.
 *
 * `Sec-Fetch-Site` is the primary check because browsers send it to loopback
 * over plain HTTP as well as to https origins, so this behaves identically
 * locally and deployed -- which is the property the whole auth change is for.
 * `Origin` is the mandatory fallback for browsers too old to send it.
 *
 * It fails closed: a cookie-authenticated write with neither header is refused,
 * because that is what a hand-rolled cross-site form post looks like. Scripts
 * are unaffected -- they authenticate with a bearer token, and a browser cannot
 * be induced to attach an Authorization header to a cross-site form post, so a
 * bearer request is not an ambient-credential request in the first place.
 */
function refuseCrossSiteWrite(ctx) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) return;
  if (!ctx.cookies?.[SESSION_COOKIE]) return;   // not cookie-authenticated

  const site = ctx.headers['sec-fetch-site'];
  if (site) {
    if (site === 'same-origin' || site === 'none') return;
    throw new HttpError(403, `refusing a cross-site ${ctx.method}`,
      'this looked like a form post from another website');
  }

  const origin = ctx.headers.origin;
  if (origin && origin.replace(/\/+$/, '') === PUBLIC_ORIGIN) return;
  if (origin) {
    throw new HttpError(403, `refusing a ${ctx.method} from ${origin}`,
      `this instance answers to ${PUBLIC_ORIGIN}; set PUBLIC_ORIGIN if that is wrong`);
  }

  throw new HttpError(403,
    'this request carried a session cookie but no Origin or Sec-Fetch-Site header',
    'browsers always send one of these. For scripts, authenticate with '
    + '`authorization: bearer <token>` instead of a cookie, and send no cookie.');
}
import { mountPublic } from './routes/public.js';
import { mountOrganizer } from './routes/organizer.js';
import { mountPortal } from './routes/portal.js';
import { mountReviewer } from './routes/reviewer.js';
import { mountMail } from './routes/mail.js';
import { mountWidgets } from './routes/widgets.js';
import { mountDemoAuth } from './routes/demo-auth.js';
import { mountAccounts, ensureSetupToken } from './routes/accounts.js';
import { mountEvaluation } from './routes/evaluation.js';
import { mountSetup } from './routes/setup.js';
import { mountFormBuilder } from './routes/formbuilder.js';
import { mountTasks } from './routes/tasks.js';
import { mountContent } from './routes/content.js';
import { mountEmbeds } from './routes/embeds.js';
import { mountCrm } from './routes/crm.js';
import { mountApi } from './routes/api.js';

export function createApp({ dbPath = DEFAULT_DB_PATH, db = null } = {}) {
  const database = db ?? openDatabase(dbPath);
  const router = new Router();

  mountPublic(router);
  mountSetup(router);
  mountFormBuilder(router);
  mountTasks(router);
  mountContent(router);
  mountEmbeds(router);
  mountCrm(router);
  mountOrganizer(router);
  mountPortal(router);
  mountReviewer(router);
  mountMail(router);
  mountWidgets(router);
  mountDemoAuth(router);
  mountAccounts(router);
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
    // Two clauses, kept apart on purpose. When they ran together --
    // "did you mean: GET /api/events , GET /api/people? GET /llms.txt has
    // worked examples...; add ?all=1 for every route" -- callers attached
    // `?all=1` to their own failed URL instead of to /llms.txt, five times
    // across three traces. The trailing "?" after the last suggestion read as
    // part of the path, and the advice about a flag sat next to a list of URLs
    // that flag does not belong to.
    const near = app.router.suggestionsFor(method, parsed.pathname);
    throw new HttpError(404, `no route for ${method} ${parsed.pathname}`,
      (near.length ? `Closest routes: ${near.join(' | ')}. ` : '')
      + `Full documentation: ${PUBLIC_ORIGIN}/llms.txt `
      + `(and ${PUBLIC_ORIGIN}/llms.txt?all=1 lists every route).`);
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
    // What this instance calls itself, from configuration rather than from the
    // Host header. Building links from Host let an attacker send
    // `Host: evil.example` and have a live sign-in token written into the outbox
    // pointing at their server, for an organizer to click.
    origin: PUBLIC_ORIGIN,
    // Resolved lazily: most routes are public and never need to know.
    get person() {
      if (this._person === undefined) this._person = currentPerson(app.db, cookies, headers);
      return this._person;
    },
  };

  refuseCrossSiteWrite(ctx);

  return found.route.handler(ctx);
}

async function handle(app, req, res) {
  const started = process.hrtime.bigint();
  let response;
  let refusal = null;

  try {
    response = await respond(app, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      req,
    });
  } catch (err) {
    response = errorResponse(err, req);
    // Keep the reason, so the access log can say why a request was turned down
    // rather than only that it was. Watching somebody -- or something -- fail to
    // use this app, "403" tells you nothing and "403 organizer access required"
    // tells you everything.
    refusal = err.status ? [err.message, err.hint].filter(Boolean).join(' | ')
      : constraintMessage(err);
    if (!err.status && !constraintMessage(err)) console.error(err);
    else if (err.status >= 500) console.error(err);
  }

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  res.setHeader('server-timing', `app;dur=${ms.toFixed(1)}`);

  for (const [key, value] of Object.entries(response.headers ?? {})) {
    res.setHeader(key, value);
  }
  res.statusCode = response.status ?? 200;
  res.end(req.method === 'HEAD' ? undefined : response.body);

  logRequest(app, req, res, ms, refusal);
}

/**
 * One line per request, with enough on it to debug somebody else's session.
 *
 * The query string is deliberately dropped: sign-in tokens travel in it, and a
 * log file is exactly the wrong place for a live credential. What replaces it is
 * more useful anyway -- who was asking, and why they were refused.
 *
 * CONF_LOG=quiet turns it off. CONF_LOG=verbose adds the query string with any
 * token redacted, which is what you want when you are watching an agent try to
 * work out how to use the app and need to see the parameters it guessed.
 */
function logRequest(app, req, res, ms, refusal) {
  const level = process.env.CONF_LOG ?? 'normal';
  if (level === 'quiet') return;

  const [path, query] = req.url.split('?');
  const status = res.statusCode;

  let who = 'anon';
  try {
    const person = currentPerson(app.db, parseCookies(req.headers.cookie), req.headers);
    if (person) who = person.email;
  } catch { /* never let logging break a response */ }

  const parts = [
    String(status),
    req.method.padEnd(4),
    path,
    `${ms.toFixed(1)}ms`,
    who === 'anon' ? '' : `as=${who}`,
  ];

  if (level === 'verbose' && query) {
    parts.push(`?${query.replace(/(token|password)=[^&]*/gi, '$1=REDACTED')}`);
  }
  if (refusal && status >= 400) parts.push(`-- ${refusal}`);

  console.log(parts.filter(Boolean).join(' '));
}

/**
 * A rule the database enforced, phrased for whoever tripped it.
 *
 * `RAISE(ABORT, '...')` messages are written for people -- they say what is
 * wrong and what to do instead -- so surfacing them as "internal server error"
 * throws away the only useful thing about them. Genuine SQLite faults (a typo in
 * a query, a missing table) are not constraint violations and still get the
 * generic 500 they deserve.
 */
function constraintMessage(err) {
  if (err?.code !== 'ERR_SQLITE_ERROR') return null;
  const text = String(err.message ?? '');
  if (!/constraint|abort/i.test(text) && err.errcode !== 19) return null;
  return text.replace(/^stepping,\s*/, '');
}

/**
 * Render an error the way the caller can act on.
 *
 * JSON for API paths, HTML for pages, and in both cases the hint travels with
 * the message. See docs/DESIGN.md on why errors state the fix.
 */
function errorResponse(err, req) {
  const constraint = constraintMessage(err);
  if (constraint && !err.status) {
    err = new HttpError(400, constraint, 'the database refused this, so nothing was changed');
  }

  const status = err.status ?? 500;
  const message = status >= 500 ? 'internal server error' : err.message;
  const hint = status >= 500 ? 'check the server log' : (err.hint ?? '');

  if (req.url.startsWith('/api/') || (req.headers.accept ?? '').includes('application/json')) {
    return json({ error: message, ...(hint ? { hint } : {}) }, { status });
  }

  // Only a browser gets the styled page. Everybody else gets the two lines that
  // actually say something.
  //
  // A refusal used to cost 6,573 bytes to deliver "'speaker' is not a value for
  // applies_to / use person (one per speaker), or submission (one per session)"
  // -- a hundred bytes of answer wrapped in a stylesheet. We watched a local
  // model make two wrong guesses at this route, read both full pages, and run
  // out of time; the error was right and unreadable, which for a caller that is
  // not a person is the same as being wrong.
  //
  // Keyed on the caller ASKING for HTML rather than on it not asking for JSON,
  // because curl sends `*/*` or nothing at all, and defaulting the unspecified
  // case to the expensive answer gets it backwards for every script there is.
  if (!(req.headers.accept ?? '').includes('text/html')) {
    return text(`${status} ${message}\n${hint ? `${hint}\n` : ''}`, { status });
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
  router.get('/llms.txt', (ctx) => text(llmsTxt(ctx.router, { brief: !ctx.query.has('all') })),
    'This file: how to authenticate, and worked examples of the common jobs. '
    + 'The complete list of every route is at /llms.txt?all=1 -- four times longer, '
    + 'and most jobs do not need it.');

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
export function llmsTxt(router, { brief = false } = {}) {
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
    'Every page is plain HTML with plain forms, so everything here works with curl.',
    'Records are addressed by readable slugs and session codes (SESS-1), never by',
    'opaque ids. There is also a command line covering most of this: `bin/conf --help`.',
    '',
    'This is the short form: how to get in, then a worked example of each common',
    'job. It is what most callers need. The complete list of every route is at',
    `${PUBLIC_ORIGIN}/llms.txt?all=1 -- four times longer, generated from the route`,
    'table, and the place to look when no recipe below covers what you want.',
    '',
    '## Getting in',
    '',
    'Read this first. Everything under /e/ and /api/ needs organizer credentials,',
    'and behaves the same way whether this instance is on your laptop or on the',
    'internet -- there is no "it is open locally" shortcut. Without credentials you',
    'get 403 and a message saying so.',
    '',
    'For scripts, mint a token once and send it as a header on every request:',
    '',
    '    # in a browser: sign in at /sign-in, then visit /account and mint a token',
    '    AUTH="authorization: bearer <your token>"',
    `    curl -s -H "$AUTH" ${PUBLIC_ORIGIN}/api/events`,
    '',
    'Every recipe below assumes $AUTH is set that way. The command line',
    '(`bin/conf`) needs no token at all: it opens the database directly.',
    '',
    'If nobody has claimed this instance yet, /setup/claim exchanges the setup',
    'token for the first administrator account. The setup token is whatever',
    'SETUP_TOKEN was set to, or the contents of data/setup-token.',
    '',
    '## How to do the common things',
    '',
    'Recipes first, because the route list below is long and most jobs are one',
    'request. Replace EVENT with an event slug from `GET /api/events`.',
    '',
    '### Decide on submissions, then tell the speakers',
    '',
    `    curl -s -H "$AUTH" ${PUBLIC_ORIGIN}/api/events/EVENT/submissions?status=pending`,
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/api/events/EVENT/submissions/SESS-3/decide \\`,
    '         -H "content-type: application/json" -d \'{"decision":"accept"}\'',
    '    # nothing has been sent yet. This is what sends it:',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/api/events/EVENT/notify \\`,
    '         -H "content-type: application/json" -d \'{"codes":["SESS-3"]}\'',
    '',
    '### Sort arriving proposals automatically (category-based routing)',
    '',
    'A rule on a form reads one answer and decides where the proposal goes: which',
    'review round it joins, and what track it belongs to. The first matching rule',
    'wins, so put the most specific first.',
    '',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/forms/FORM/routing \\`,
    '         --data "field=track&operator=equals&value=retrieval" \\',
    '         --data "plan=first-round-ml&track=retrieval&reviewers=2"',
    '    # what the rules have actually done, and why, is on the form page:',
    `    curl -s -H "$AUTH" ${PUBLIC_ORIGIN}/e/EVENT/forms/FORM`,
    '',
    '`plan` is a review round slug and `track` a track slug; both are listed by',
    'GET /api/events/EVENT, alongside the rooms.',
    'Values compare against an answer\'s slug, not its label; a value no answer could',
    'produce is refused when you write the rule rather than never matching.',
    '',
    '### Put accepted talks into the schedule',
    '',
    `    curl -s -H "$AUTH" ${PUBLIC_ORIGIN}/api/events/EVENT/agenda      # see what has no slot`,
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/agenda/autoschedule`,
    '    # or place one by hand:',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/submissions/SESS-3/schedule \\`,
    '         --data "room=main-stage&starts_at=2027-05-12T09:00&ends_at=2027-05-12T09:45"',
    '',
    '### Get a session onto the PUBLIC agenda',
    '',
    'Two things are required and neither is enough alone: the content must be',
    'approved, and the session must be published. Setting `published` in the',
    'database on its own does nothing and the database will refuse it.',
    '',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/submissions/SESS-3/content \\`,
    '         --data "content_status=approved"',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/agenda/publish`,
    '',
    '### Give somebody a feed of the programme for their own website',
    '',
    'One request. The reply carries the public url -- read it from there rather',
    'than guessing it, because the slug comes from the name and a name that is',
    'already taken gets a different one.',
    '',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/embeds \\`,
    '         --data "name=Agenda&feed=agenda&format=json"',
    '    #  -> {"slug":"agenda","format":"json","url":"<the address to hand over>"}',
    '',
    'Formats are html, json, xml, ics. Feeds are agenda, session_list,',
    'schedule_itinerary, speaker_list, speaker_gallery.',
    '',
    'Nothing is a feed until you make one. /api/... is organizer data: it carries',
    'unapproved and unannounced sessions and sends no CORS header, so another site',
    'cannot fetch it. Pointing somebody at /api/events/EVENT/agenda does not work',
    'and does not fail loudly either -- it is simply the wrong address.',
    '',
    '### Email a group about something other than a decision',
    '',
    `    curl -s -H "$AUTH" "${PUBLIC_ORIGIN}/e/EVENT/mail?audience=outstanding-tasks"`,
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/mail \\`,
    '         --data-urlencode "audience=outstanding-tasks" \\',
    '         --data-urlencode "subject=..." --data-urlencode "body=..."',
    '',
    '### Ask speakers for something (a bio, a headshot, slides, a signed form)',
    '',
    'Nothing appears under Tasks, in the reminders, or in Files until a task exists.',
    'A task is a template; each accepted speaker gets their own copy of it.',
    '',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/tasks/definitions \\`,
    '         --data "title=Upload your slides&applies_to=submission&requirement=file" \\',
    '         --data "due_at=2027-04-30&assign_when=on_accept"',
    `    curl -s -H "$AUTH" ${PUBLIC_ORIGIN}/e/EVENT/tasks/definitions   # what is being asked for`,
    `    curl -s -H "$AUTH" ${PUBLIC_ORIGIN}/api/events/EVENT/tasks      # who still owes what`,
    '',
    '`applies_to` is person (one copy per speaker: a bio, a headshot) or submission',
    '(one copy per session, to its primary contact: the slides). `requirement` is',
    'acknowledge, form, or file. A task assigned on_accept is given to everybody',
    'ALREADY accepted as well as to future acceptances -- the redirect says how many.',
    'Use assign_when=manual to create one without handing it out.',
    '',
    'Deleting a task that people have already completed is refused, because it would',
    'delete their record too. Retire it instead: it stops being assigned and stops',
    'being chased, and what they did is kept.',
    '',
    `    curl -s -H "$AUTH" -X POST ${PUBLIC_ORIGIN}/e/EVENT/tasks/definitions/TASK/retire`,
    '',
    '### Collect what speakers have uploaded',
    '',
    `    curl -s -H "$AUTH" -o files.zip "${PUBLIC_ORIGIN}/e/EVENT/files.zip?group=speaker&task=upload-slides"`,
    '',
    '## The one rule worth knowing',
    '',
    'Recording a decision and telling the speaker are separate steps. Marking a',
    'submission accepted moves it to a queue and sends nothing; a separate notify',
    'step mails the speakers and finalises it. That is deliberate, so nobody is one',
    'click away from mailing forty people.',
    '',
    '## Every route',
    '',
  ];

  // The default stops here, and that is a decision the traces forced.
  //
  // Everything above is about six kilobytes; the route list below is eighteen
  // more. We watched a 12B model on CPU curl the whole thing, read all 167
  // routes, and run out of clock with nothing to say -- Run 1's seed.js problem
  // with our own documentation as the trap. Completeness and readability turned
  // out to be different properties and the file only had the first.
  //
  // The first attempt at this made the full list the default and offered
  // ?brief=1 to opt out, which does not work: the only place that says the
  // option exists is inside the file you have to read to find it. So the short
  // form is what you get, and the long form is one flag away. Nothing is
  // removed -- the complete list is still generated from the route table, still
  // cannot go stale, and is still the API documentation the brief asks for.
  if (brief) {
    lines.push(
      `## Every route (${documented.length} of them)`,
      '',
      'Not included here, because most jobs are covered by the recipes above and this',
      'list is four times their length:',
      '',
      `    curl -s ${PUBLIC_ORIGIN}/llms.txt?all=1`,
      '',
    );
    return `${lines.join('\n')}\n`;
  }

  for (const [group, routes] of groups) {
    lines.push(`### ${group}`, '');
    for (const route of routes) {
      lines.push(`${route.method} ${route.pattern}`);
      lines.push(`    ${route.doc}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function groupOf(pattern) {
  if (pattern.startsWith('/api/')) return 'JSON API';
  if (pattern.startsWith('/portal')) return 'Speaker portal';
  if (pattern.startsWith('/review')) return 'Reviewer';
  if (pattern.startsWith('/crm')) return 'Speaker database (across events)';
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

  // Here rather than in createApp, so the whole test suite is untouched by it
  // and no test has to know a setup token exists.
  try {
    ensureSetupToken(app.db);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

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
