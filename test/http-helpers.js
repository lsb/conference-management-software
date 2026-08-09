import { Readable } from 'node:stream';
import { createApp, respond } from '../src/server.js';

/**
 * An app backed by an in-memory database.
 *
 * Requests go through the real router, the real body parsing, and the real
 * handlers -- everything except a socket. That is deliberate: the bugs worth
 * catching here are routing collisions, validation, and redirects, and none of
 * them need TCP.
 */
export function newApp() {
  return createApp({ dbPath: ':memory:' });
}

export async function get(app, url, { cookies = {} } = {}) {
  return respond(app, { method: 'GET', url, headers: headersFor(cookies) });
}

/** POST a form, the way a browser would. */
export async function post(app, url, fields = {}, { cookies = {} } = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) body.append(key, one);
  }
  const encoded = body.toString();

  const req = Readable.from([Buffer.from(encoded)]);
  req.headers = { 'content-type': 'application/x-www-form-urlencoded' };

  return respond(app, {
    method: 'POST',
    url,
    headers: { ...headersFor(cookies), 'content-type': 'application/x-www-form-urlencoded' },
    req,
  });
}

function headersFor(cookies) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  return { host: '127.0.0.1:8080', ...(jar ? { cookie: jar } : {}) };
}

/** Assert a response redirected, and return where to. */
export function redirectedTo(response) {
  if (response.status !== 303 && response.status !== 302) {
    throw new Error(`expected a redirect, got ${response.status}: ${String(response.body).slice(0, 300)}`);
  }
  return response.headers.location;
}

/** The error a handler threw, for asserting on the message and its hint. */
export async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to fail, but it succeeded');
}
