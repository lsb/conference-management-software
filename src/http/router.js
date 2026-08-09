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
