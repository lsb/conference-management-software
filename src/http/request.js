// Reading requests: bodies, cookies, and typed form access.

import { badRequest } from './router.js';
import { parseMultipart } from './multipart.js';
import { cookiesAreSecure } from '../core/auth.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Read the whole body, refusing anything implausibly large. */
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw badRequest('request body too large', `limit is ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Parse a request body into a plain object.
 *
 * Accepts form encoding and JSON, because the HTML forms post the former and the
 * API and CLI post the latter, and both should reach the same handler.
 */
export async function parseBody(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  const raw = await readBody(req);

  if (raw.length === 0) return new Fields({});

  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw badRequest('JSON body must be an object', 'for example: {"title": "My talk"}');
      }
      return new Fields(parsed);
    } catch (err) {
      if (err.status) throw err;
      throw badRequest(`could not parse JSON body: ${err.message}`,
        'send valid JSON, or use application/x-www-form-urlencoded');
    }
  }

  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const params = new URLSearchParams(raw.toString('utf8'));
    const out = {};
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key);
      out[key] = values.length > 1 ? values : values[0];
    }
    return new Fields(out);
  }

  if (type === 'multipart/form-data') {
    const { fields, files } = parseMultipart(raw, req.headers['content-type']);
    return new Fields(fields, files);
  }

  throw badRequest(`unsupported content-type '${type}'`,
    'use application/x-www-form-urlencoded, application/json, or multipart/form-data');
}

/**
 * Typed access to submitted values, where a missing required field produces an
 * error naming the field rather than a downstream crash.
 */
export class Fields {
  constructor(data, files = {}) {
    this.data = data;
    this.files = files;
  }

  has(name) {
    return Object.hasOwn(this.data, name);
  }

  /** An uploaded file by field name, or null when none was chosen. */
  file(name) {
    return this.files[name] ?? null;
  }

  /** An uploaded file that has to be there, named in the error when it is not. */
  requireFile(name, hint = '') {
    const file = this.file(name);
    if (!file) {
      throw badRequest(`no file uploaded for '${name}'`,
        hint || `attach a file in the '${name}' field of a multipart/form-data request`);
    }
    return file;
  }

  /** A trimmed string, or `fallback` when absent or blank. */
  get(name, fallback = '') {
    const value = this.data[name];
    if (value == null) return fallback;
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join(',');
    const trimmed = String(value).trim();
    return trimmed === '' ? fallback : trimmed;
  }

  /** A trimmed string that must be present. */
  require(name, hint = '') {
    const value = this.get(name);
    if (value === '') {
      throw badRequest(`missing required field: ${name}`,
        hint || `include '${name}' in the request body`);
    }
    return value;
  }

  /** Every value for a repeated field, always as an array. */
  list(name) {
    const value = this.data[name];
    if (value == null) return [];
    return (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
  }

  int(name, fallback = null) {
    const value = this.get(name);
    if (value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw badRequest(`field '${name}' must be a whole number, got '${value}'`);
    }
    return n;
  }

  bool(name) {
    const value = this.get(name).toLowerCase();
    return value === 'on' || value === 'true' || value === '1' || value === 'yes';
  }

  /** A value that must be one of a known set, with the set named on failure. */
  choice(name, allowed, fallback = undefined) {
    const value = this.get(name);
    if (value === '' && fallback !== undefined) return fallback;
    if (!allowed.includes(value)) {
      throw badRequest(`field '${name}' must be one of: ${allowed.join(', ')}`,
        value ? `got '${value}'` : `'${name}' was missing`);
    }
    return value;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * `Secure` comes from PUBLIC_ORIGIN being https, not from sniffing the request,
 * so a cookie behaves the same way every time this instance is started.
 *
 * No `__Host-` prefix, though both OWASP and NIST ask for one. Chrome and Safari
 * reject prefixed cookies over plain HTTP on loopback, which would make local
 * development impossible in two of three browsers without terminating TLS on a
 * laptop. The mitigation is that this app is one origin by design (D11) with no
 * subdomains to be shadowed from.
 */
export function cookieHeader(name, value, { maxAge = 60 * 60 * 24 * 30, path = '/' } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
    + (cookiesAreSecure() ? '; Secure' : '');
}

export function clearCookieHeader(name, { path = '/' } = {}) {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;
}
