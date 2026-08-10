// A black-box HTTP client for the acceptance suite.
//
// Nothing in test/acceptance/ imports from src/. Everything these tests know
// about the app they learned over HTTP, which is the whole point: the same
// files must run against a remote deployment where there is no source to
// import and no database to open. An import here would be a bug -- it would
// pass against a remote URL while quietly testing local code.
//
// Zero dependencies: node:test, built-in fetch, and two node: builtins.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** Where the app under test lives. Override to point at any deployment. */
export const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

/**
 * How many times to retry a request that never reached the server.
 *
 * Only connection failures are retried, never HTTP statuses: a 500 is a result
 * and must be reported, but an ECONNREFUSED while somebody restarts the server
 * is noise. Set ACCEPTANCE_RETRIES=0 to see connection errors immediately.
 */
const RETRIES = Number(process.env.ACCEPTANCE_RETRIES ?? 5);

/**
 * A run identifier that is obviously disposable and sorts by time.
 *
 * It goes in the slug of every record this suite creates, because there is no
 * route to delete an event (see docs/ACCEPTANCE-TESTS.md). Anything matching
 * `acceptance-<timestamp>-<random>` is litter from a test run and safe to drop.
 */
export const RUN_ID = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${randomUUID().slice(0, 6)}`;

/** A name no human or seed would have chosen, unique to this run. */
export const disposable = (what) => `Acceptance ${what} ${RUN_ID}`;

/**
 * A fresh address for a fresh person, in a domain that can never be routed even
 * if a deployment wires up SMTP.
 *
 * The run id goes in with no punctuation, deliberately. POST /submit does not
 * look people up by address alone: when an exact match fails it falls back to
 * the first word of the local part -- everything before the first `.`, `-`, `_`
 * or `+` -- and reuses the person if exactly one matches. So `speaker-run1@` and
 * `speaker-run2@` are the same human as far as the call for speakers is
 * concerned, and the second run's proposal is silently filed under the first
 * run's speaker. Keeping the local part a single unpunctuated word makes each
 * run a genuinely new person.
 */
const EMAIL_TAG = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase();
export const disposableEmail = (who) => `acceptance${EMAIL_TAG}${who}@example.invalid`;

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * A cookie jar, because plain fetch has none and this app signs you in with a
 * session cookie. One jar per persona: the organizer, the anonymous member of
 * the public, and the speaker each get their own, so a test can never pass
 * because it was accidentally still signed in as somebody else.
 */
export class CookieJar {
  #cookies = new Map();

  /** Absorb every Set-Cookie on a response. */
  store(headers) {
    const lines = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);

    for (const line of lines) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An empty value with Max-Age=0 is how this app signs you out.
      if (value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  /** The Cookie header to send, or null when the jar is empty. */
  header() {
    if (this.#cookies.size === 0) return null;
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(name) { return this.#cookies.has(name); }
  clear() { this.#cookies.clear(); }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * One HTTP identity: a cookie jar, and a label that appears in every failure
 * message so "403 forbidden" says *who* was refused.
 */
export class Client {
  constructor(label, { jar = new CookieJar() } = {}) {
    this.label = label;
    this.jar = jar;
  }

  get(path, options) { return this.request('GET', path, options); }

  /** POST a form the way a browser would. */
  postForm(path, fields = {}, options = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) body.append(key, String(one));
    }
    return this.request('POST', path, {
      ...options,
      body: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...options.headers },
      summary: body.toString().slice(0, 300),
    });
  }

  /** POST JSON, the way the /api routes document themselves. */
  postJson(path, payload, options = {}) {
    const body = JSON.stringify(payload);
    return this.request('POST', path, {
      ...options,
      body,
      headers: { 'content-type': 'application/json', ...options.headers },
      summary: body.slice(0, 300),
    });
  }

  async request(method, path, { body, headers = {}, summary = null, origin = null } = {}) {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const sent = { ...headers };
    const cookie = this.jar.header();
    if (cookie) sent.cookie = cookie;
    if (origin) sent.origin = origin;

    let lastError = null;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        // Manual redirects: a 303 and its Location are the assertion in most of
        // this app, and following them would throw that away.
        const response = await fetch(url, { method, headers: sent, body, redirect: 'manual' });
        const text = await response.text();
        this.jar.store(response.headers);
        return new Result({
          method, url, client: this.label, requestSummary: summary,
          status: response.status, headers: response.headers, body: text,
        });
      } catch (err) {
        // Only connection-level failures land here; an HTTP error is a Result.
        lastError = err;
        if (attempt === RETRIES) break;
        await sleep(150 * (attempt + 1));
      }
    }

    throw new Error(
      `${method} ${url} never reached a server (as ${this.label}, after ${RETRIES + 1} attempts).\n`
      + `  cause: ${lastError?.cause?.code ?? lastError?.cause?.message ?? lastError?.message}\n`
      + `  BASE_URL is ${BASE_URL}. Is the app running and reachable from here?`,
    );
  }
}

/** One response, plus enough context to explain a failure without a debugger. */
class Result {
  constructor(fields) { Object.assign(this, fields); }

  get location() { return this.headers.get('location'); }
  get contentType() { return this.headers.get('content-type') ?? ''; }

  /** The JSON body, or a failure that shows what came back instead. */
  json() {
    try {
      return JSON.parse(this.body);
    } catch {
      throw new Error(`${describeCall(this)}\n\nexpected a JSON body, could not parse it`);
    }
  }
}

// ---------------------------------------------------------------------------
// Failure messages
//
// These tests will one day fail against a remote box where nobody can attach a
// debugger, so the message has to carry the whole story: which call, as whom,
// what came back.
// ---------------------------------------------------------------------------

export function describeCall(result) {
  const lines = [`${result.method} ${result.url}  ->  ${result.status}`, `  as: ${result.client}`];
  if (result.requestSummary) lines.push(`  sent: ${result.requestSummary}`);
  if (result.location) lines.push(`  location: ${result.location}`);
  lines.push(`  content-type: ${result.contentType || '(none)'}`);
  lines.push(`  body: ${readableBody(result)}`);
  return lines.join('\n');
}

/**
 * The part of a response a human needs.
 *
 * Every HTML page here carries a kilobyte of inline CSS before it says
 * anything, so an untrimmed body excerpt is a screenful of colour variables
 * and no error message.
 */
export function readableBody(result, limit = 700) {
  let text = result.body ?? '';
  if (text === '') return '(empty)';

  if (!(result.contentType ?? '').includes('json')) {
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(text);
    if (main) text = main[1];
    text = stripTags(text);
  }

  text = text.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}... (${result.body.length} bytes total)` : text;
}

export function stripTags(html) {
  return html
    .replace(/<(style|script|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&middot;/g, '.')
    .replace(/&mdash;/g, '--')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function fail(result, expectation, note) {
  const suffix = note ? `\n  note: ${note}` : '';
  throw new Error(`${expectation}\n\n${describeCall(result)}${forbiddenHint(result)}${suffix}`);
}

/**
 * A 403 from an organizer route off loopback is not a mystery, it is the
 * documented behaviour, and the fix is a flag rather than a bug report.
 */
function forbiddenHint(result) {
  if (result.status !== 403 || !/organizer access required/i.test(result.body)) return '';
  return '\n  hint: organizer routes are open only when the server binds loopback. Against any'
    + '\n        other host you must sign in first: set ACCEPTANCE_ORGANIZER_EMAIL to a person'
    + '\n        who owns or organizes an event there, and run the deployment with DEMO_LOGIN=1'
    + '\n        so POST /login can exchange that address for a session.';
}

export function expectStatus(result, expected, note) {
  const wanted = Array.isArray(expected) ? expected : [expected];
  if (!wanted.includes(result.status)) {
    fail(result, `expected HTTP ${wanted.join(' or ')}, got ${result.status}`, note);
  }
  return result;
}

/** Assert a redirect and hand back where it went. */
export function expectRedirect(result, { to = null, note } = {}) {
  expectStatus(result, [302, 303], note);
  const location = result.location;
  if (!location) fail(result, 'expected a Location header on the redirect', note);
  if (to && !location.includes(to)) {
    fail(result, `expected the redirect to go to something containing "${to}", it went to "${location}"`, note);
  }
  return location;
}

export function expectBodyContains(result, needle, note) {
  const haystack = result.contentType.includes('json') ? result.body : stripTags(result.body);
  if (!haystack.includes(needle)) {
    fail(result, `expected the response to mention "${needle}", it did not`, note);
  }
  return result;
}

export function expectBodyLacks(result, needle, note) {
  const haystack = result.contentType.includes('json') ? result.body : stripTags(result.body);
  if (haystack.includes(needle)) {
    fail(result, `expected the response NOT to mention "${needle}", but it did`, note);
  }
  return result;
}

export function expectHeader(result, name, expected, note) {
  const actual = result.headers.get(name);
  if (actual === null) fail(result, `expected a ${name} header, there was none`, note);
  if (expected !== undefined && actual !== expected) {
    fail(result, `expected ${name}: ${expected}, got ${name}: ${actual}`, note);
  }
  return actual;
}

export function expectNoHeader(result, name, note) {
  const actual = result.headers.get(name);
  if (actual !== null) fail(result, `expected no ${name} header, got ${name}: ${actual}`, note);
}

/**
 * Pull one capture out of a response, with a failure that shows what was there.
 *
 * Pass `from` to search something other than the body -- usually a Location
 * header, which is where this app hands back the slug it has just minted.
 */
export function extract(result, pattern, what, { from = null } = {}) {
  const found = pattern.exec(from ?? result.body);
  if (!found) {
    fail(result, `could not find ${what} ${from ? `in "${from}"` : 'in this response'} `
      + `(pattern ${pattern})`);
  }
  return found[1];
}

/**
 * Guard a step whose input an earlier step should have produced.
 *
 * Without this, one broken step further up turns into a page of confusing
 * TypeErrors further down.
 */
export function required(value, what) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`prerequisite missing: ${what}.\n`
      + '  An earlier step in this file did not complete. Fix the first failure above;'
      + ' this one is a consequence.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reading the app's HTML
//
// The suite has no database and no source, so anything it needs to know it
// reads off a page -- exactly as an operator with only curl would have to.
// ---------------------------------------------------------------------------

/** Every `name=` on an input, textarea, or select inside a given form. */
export function formFieldNames(result, actionContains) {
  const forms = result.body.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  const form = forms.find((f) => f.includes(actionContains));
  if (!form) {
    fail(result, `expected a <form> whose action contains "${actionContains}"; `
      + `found ${forms.length} form(s) on the page`);
  }
  const names = new Set();
  for (const [, name] of form.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/gi)) {
    names.add(name);
  }
  return names;
}

/**
 * The outbox, parsed out of the organizer page.
 *
 * GET /api/events/:event/outbox is the pleasant way to count messages, but it
 * publishes neither a message id nor a body, so reading what an email actually
 * said means scraping the HTML table. See docs/ACCEPTANCE-TESTS.md.
 */
export function parseOutbox(result) {
  const body = result.body;
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/i.exec(body);
  if (!tbody) {
    if (/no messages|nothing has been sent/i.test(stripTags(body))) return [];
    fail(result, 'expected the outbox page to contain a <tbody> of messages');
  }

  const rows = [];
  for (const [, chunk] of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...chunk.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]).trim());
    const id = /\/outbox\/(\d+)/.exec(chunk)?.[1];
    if (!id) continue;
    rows.push({
      id: Number(id),
      created_at: cells[0] ?? '',
      to: cells[1] ?? '',
      kind: cells[2] ?? '',
      subject: cells[3] ?? '',
      submission: cells[4] ?? '',
      delivered: !/not sent/i.test(cells[5] ?? ''),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Wait for the app to answer, so a restart mid-run is a pause and not a failure. */
export async function waitForServer(client) {
  const health = await client.get('/healthz');
  expectStatus(health, 200, `the app must be running at ${BASE_URL} before this suite starts`);
  return health;
}

/**
 * Sign in as somebody who can organize.
 *
 * This matters far more off loopback than on it. The app opens every organizer
 * route to anyone when it is bound to 127.0.0.1, so locally this is optional --
 * but POST /e/new only records an owner when somebody is signed in, so an event
 * created anonymously on a remote box is unmanageable by anyone, forever.
 * Signing in first is what makes one suite work in both places.
 *
 * Returns how it got in, for the record and for failure messages.
 */
export async function signInAsOrganizer(client) {
  const email = process.env.ACCEPTANCE_ORGANIZER_EMAIL;

  if (email) {
    const result = await client.postForm('/login', { email });
    if (result.status === 303) return { signedIn: true, how: `POST /login as ${email}` };
    return {
      signedIn: false,
      how: `POST /login as ${email} was refused`,
      detail: readableBody(result, 300),
    };
  }

  const result = await client.postForm('/login', { persona: 'organizer' });
  if (result.status === 303) return { signedIn: true, how: 'POST /login persona=organizer' };

  return {
    signedIn: false,
    how: 'nobody: POST /login persona=organizer did not sign in',
    detail: readableBody(result, 300),
  };
}
