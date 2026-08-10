// Routing.
//
// A route is a method, a path pattern, and a handler. That is the whole design.
// Patterns use `:name` for a segment, and matches arrive as `req.params`.
//
// The route table doubles as documentation: `/llms.txt` is generated from it,
// so a route cannot be added without becoming discoverable, and the docs cannot
// drift out of date with the code.

import { SafeHtml } from './html.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * Register a route.
   *
   * `doc` describes the route for `/llms.txt`. It is not optional in spirit: a
   * route nobody can discover may as well not exist.
   */
  add(method, pattern, handler, doc = null) {
    this.routes.push({ method, pattern, handler, doc, regex: patternToRegex(pattern) });
    return this;
  }

  get(pattern, handler, doc) { return this.add('GET', pattern, handler, doc); }
  post(pattern, handler, doc) { return this.add('POST', pattern, handler, doc); }

  /** Find the handler for a request, or null. HEAD is served by GET. */
  match(method, pathname) {
    const wanted = method === 'HEAD' ? 'GET' : method;
    for (const route of this.routes) {
      if (route.method !== wanted) continue;
      const m = route.regex.exec(pathname);
      if (m) return { route, params: m.groups ? { ...m.groups } : {} };
    }
    return null;
  }

  /** Which methods would have matched this path, for a correct 405. */
  allowedFor(pathname) {
    return [...new Set(
      this.routes.filter((r) => r.regex.test(pathname)).map((r) => r.method),
    )];
  }

  /**
   * Routes that look like what somebody asked for and did not get.
   *
   * Written after watching a local model, told to accept a submission, try
   * `POST /e/x/submissions/SESS-15/accept` -- a reasonable guess, and wrong,
   * because deciding is `/decide` with the decision in the body. It got a bare
   * 404, went and read llms.txt, and came back with the right call a round trip
   * later. The round trip is the waste: the answer was one segment away and we
   * knew it. `bin/conf` has suggested near-miss commands since Run 8 for exactly
   * this reason; the router had never learned the trick.
   *
   * Scored on shape, not on spelling: the same number of segments, and at most
   * one literal segment that differs. Counting mismatched segments rather than
   * summing letter distance is what makes this useful -- "accept" and "decide"
   * are one word apart in meaning and five letters apart in text, and a
   * letter-distance threshold tight enough to be quiet would reject exactly the
   * case worth catching. Letter distance only breaks ties.
   */
  suggestionsFor(method, pathname, limit = 3) {
    const asked = pathname.split('/').filter(Boolean);

    const sameShape = this.routes
      .filter((r) => r.method === method && r.doc)
      .map((route) => {
        const parts = route.pattern.split('/').filter(Boolean);
        if (parts.length !== asked.length) return null;

        let wrong = 0;
        let drift = 0;
        let shared = 0;
        let farthest = 0;
        for (const [i, part] of parts.entries()) {
          if (part.startsWith(':')) continue;          // a parameter fits anything
          if (part === asked[i]) { shared += 1; continue; }
          wrong += 1;
          const d = editDistance(part, asked[i]);
          drift += d;
          farthest = Math.max(farthest, d / Math.max(part.length, asked[i].length));
        }

        // Three conditions, and the third was learned the expensive way.
        //
        // At least one fixed word in common, or this is not a near miss but a
        // different question: without it /gallery/:event/:person is offered for
        // any three-segment path at all.
        //
        // And the odd word out has to be plausible, judged by how much of the
        // rest you got right rather than by spelling.
        //
        // `/api/sessions` was answered with "did you mean GET /api/people?"; the
        // model followed it and got 188 lines about people for a question about
        // schedule clashes. But `/api/events/x/submissions/SESS-15/accept`
        // really does mean `/decide`, and `accept` and `decide` share not one
        // letter in the same place. Spelling cannot tell those apart -- it puts
        // them within 0.2 of each other -- so context does: `accept` arrived
        // with three literal segments already correct, `sessions` with one.
        //
        // The more of a path somebody got right, the likelier it is that the one
        // word they got wrong is the word we know. A wrong suggestion is worse
        // than none, because it costs a request and fills a context that has
        // very little room; saying nothing is allowed.
        const plausible = wrong === 0 || shared >= 2 || farthest <= 0.5;
        return wrong <= 1 && shared >= 1 && plausible ? { route, wrong, drift } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.wrong - b.wrong || a.drift - b.drift)
      .slice(0, limit)
      .map((s) => `${s.route.method} ${s.route.pattern}`);

    if (sameShape.length > 0) return sameShape;

    // Nothing of the same shape. Try the last word instead, because dropping the
    // event scope is the most common way to guess wrong here: `/api/sessions`,
    // `/api/speakers` and `/api/tasks` were all tried for routes that live under
    // `/api/events/:event/`. Different segment counts, so the check above cannot
    // see them, and a caller who guesses this way currently gets nothing.
    const tail = asked[asked.length - 1];
    if (!tail) return [];

    return this.routes
      .filter((r) => r.method === method && r.doc)
      .filter((r) => {
        const parts = r.pattern.split('/').filter(Boolean);
        return parts[parts.length - 1] === tail && parts[0] === asked[0];
      })
      .slice(0, limit)
      .map((r) => `${r.method} ${r.pattern}`);
  }
}

/** Levenshtein, small and adequate: these are path segments, not documents. */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

function patternToRegex(pattern) {
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return escapeRegex(segment);

      // A parameter may carry a literal suffix, as in `:code.ics`, so a URL can
      // end in a file extension that clients care about. The capture is lazy so
      // the suffix binds to the end rather than being swallowed by the name.
      const [name, ...suffix] = segment.slice(1).split('.');
      return suffix.length === 0
        ? `(?<${name}>[^/]+)`
        : `(?<${name}>[^/]+?)${escapeRegex(`.${suffix.join('.')}`)}`;
    })
    .join('/');
  return new RegExp(`^${source}/?$`);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- responses -------------------------------------------------------------
//
// Handlers return one of these rather than writing to the socket, so a handler
// stays a plain function of a request. That is what lets the CLI and the tests
// call the same code without a server running.

export function ok(body, { status = 200, headers = {} } = {}) {
  const isHtml = body instanceof SafeHtml;
  return {
    status,
    headers: { 'content-type': isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', ...headers },
    body: String(body),
  };
}

export function json(data, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: `${JSON.stringify(data, null, 2)}\n`,
  };
}

export function text(body, { status = 200, headers = {} } = {}) {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body };
}

export function redirect(location, { status = 303, headers = {} } = {}) {
  return { status, headers: { location, ...headers }, body: '' };
}

/**
 * An error that says what to do about it.
 *
 * `hint` is the important half. A bare 400 makes a caller -- human or model --
 * guess and retry at random; naming the missing field makes the next attempt
 * correct. See docs/DESIGN.md.
 */
export class HttpError extends Error {
  constructor(status, message, hint = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.hint = hint;
  }
}

export const badRequest = (message, hint) => new HttpError(400, message, hint);
export const notFound = (message, hint) => new HttpError(404, message, hint);
export const forbidden = (message, hint) => new HttpError(403, message, hint);
