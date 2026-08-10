// Who is asking.
//
// Speakers get in by clicking a link we emailed them. There are no passwords,
// because the requirement is explicitly that a speaker reaches their portal
// "without forcing them through a heavy signup", and because a password is one
// more thing for somebody to lose the week before a conference.
//
// Only hashes of tokens are stored. A leaked database copy therefore hands out
// no live sessions, which matters because the database file is the thing people
// will email each other as a backup.

import { randomBytes, createHash, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { now } from '../db.js';

const MAGIC_LINK_TTL_MINUTES = 60;

// A speaker holds their own biography; staff hold accept, decline, irreversible
// notify, and bulk mail. NIST SP 800-63B-4 puts those at different assurance
// levels, so they get different lifetimes rather than one compromise.
const SPEAKER_SESSION_DAYS = 30;        // AAL1
const STAFF_SESSION_HOURS = 24;         // AAL2 absolute
const STAFF_IDLE_MINUTES = 60;          // AAL2 idle

export const SESSION_COOKIE = 'conf_session';

/**
 * What this instance calls itself.
 *
 * One declared fact, doing four jobs that were previously done by guessing or
 * not at all: whether cookies get the Secure flag, what origin a cross-site
 * check compares against, what host absolute URLs in outgoing messages use, and
 * -- the reason it is not optional -- closing the host-header injection where
 * an attacker sending `Host: evil.example` to a sign-in route caused a live
 * token to be written into the outbox pointing at their server.
 *
 * It is not host sniffing. The app is told what it is; it does not deduce it.
 */
export const PUBLIC_ORIGIN =
  (process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

const SECURE_COOKIES = PUBLIC_ORIGIN.startsWith('https:');

const hash = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

function isoIn({ minutes = 0, days = 0 }) {
  return new Date(Date.now() + minutes * 60_000 + days * 86_400_000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Mint a one-time sign-in link for a person. Returns the raw token; only its
 * hash is kept, so this is the last moment the token exists in readable form.
 */
export function createMagicLink(db, personId, eventId = null) {
  const token = newToken();
  db.prepare(
    `INSERT INTO magic_link (token_hash, person_id, event_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hash(token), personId, eventId, isoIn({ minutes: MAGIC_LINK_TTL_MINUTES }), now());
  return token;
}

/**
 * Exchange a magic-link token for a session token.
 *
 * Single use and time limited. Returns null for anything expired, already used,
 * or unrecognised -- the caller shows the same message for all three, so a
 * stranger cannot distinguish "wrong token" from "expired token".
 */
export function consumeMagicLink(db, token) {
  if (!token) return null;
  const link = db.prepare('SELECT * FROM magic_link WHERE token_hash = ?').get(hash(token));
  if (!link || link.used_at || link.expires_at < now()) return null;

  db.prepare('UPDATE magic_link SET used_at = ? WHERE id = ?').run(now(), link.id);
  return startSession(db, link.person_id);
}

/**
 * Begin a session for somebody who has just proved who they are.
 *
 * The one place a session is created, so the lifetime rule cannot be applied in
 * one sign-in path and forgotten in another. Both deadlines are worked out here
 * from what the person can do, which keeps the per-request check to two
 * comparisons and no branch.
 */
export function startSession(db, personId) {
  const staff = holdsStaffPower(db, personId);
  const sessionToken = newToken();

  db.prepare(
    `INSERT INTO auth_session (token_hash, person_id, expires_at, idle_deadline, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hash(sessionToken), personId,
    staff ? isoIn({ minutes: STAFF_SESSION_HOURS * 60 }) : isoIn({ days: SPEAKER_SESSION_DAYS }),
    staff ? isoIn({ minutes: STAFF_IDLE_MINUTES }) : null,
    now(), now());

  return { token: sessionToken, personId, staff };
}

/** Anyone who is an admin, or holds any role on any event. */
function holdsStaffPower(db, personId) {
  const person = db.prepare('SELECT is_admin FROM person WHERE id = ?').get(personId);
  if (person?.is_admin) return true;
  return Boolean(db.prepare('SELECT 1 FROM event_membership WHERE person_id = ? LIMIT 1').get(personId));
}

/**
 * The person making this request, or null.
 *
 * Two ways in, because two kinds of caller. A browser sends a cookie. Anything
 * scripted sends `authorization: bearer <token>`, which is one flag on a curl
 * line where a cookie jar is a login request, a jar file and two more flags --
 * a difference that decides whether a recipe in llms.txt is followable.
 *
 * The bearer path is also why CSRF has a clean answer: a browser cannot be
 * induced to attach an Authorization header to a cross-site form post, so
 * bearer-authenticated requests are not ambient-credential requests at all.
 */
export function currentPerson(db, cookies = {}, headers = {}) {
  const bearer = bearerFrom(headers);
  if (bearer) return personForApiToken(db, bearer);

  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = db.prepare(
    `SELECT p.*, s.id AS session_id, s.idle_deadline FROM auth_session s
       JOIN person p ON p.id = s.person_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(hash(token), now());

  if (!row) return null;
  if (row.idle_deadline && row.idle_deadline < now()) {
    db.prepare('DELETE FROM auth_session WHERE id = ?').run(row.session_id);
    return null;
  }

  // Push the idle deadline out, but not on every request: a write per page view
  // for a value with an hour of slack is pure cost.
  if (row.idle_deadline) {
    db.prepare('UPDATE auth_session SET last_seen_at = ?, idle_deadline = ? WHERE id = ?')
      .run(now(), isoIn({ minutes: STAFF_IDLE_MINUTES }), row.session_id);
  }

  delete row.session_id;
  delete row.idle_deadline;
  return row;
}

function bearerFrom(headers) {
  const value = headers?.authorization ?? headers?.Authorization;
  if (!value) return null;
  const match = /^bearer\s+(\S+)$/i.exec(String(value).trim());
  return match ? match[1] : null;
}

function personForApiToken(db, token) {
  const row = db.prepare(
    `SELECT p.*, t.id AS token_id FROM api_token t JOIN person p ON p.id = t.person_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?)`,
  ).get(hash(token), now());

  if (!row) return null;
  db.prepare('UPDATE api_token SET last_used_at = ? WHERE id = ?').run(now(), row.token_id);
  delete row.token_id;
  return row;
}

/**
 * Mint an API token. Returns the raw value, which is the last time it is
 * readable; only the hash is kept.
 */
export function createApiToken(db, personId, name, { expiresAt = null } = {}) {
  const token = newToken();
  db.prepare(
    `INSERT INTO api_token (token_hash, person_id, name, prefix, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hash(token), personId, name, token.slice(0, 8), expiresAt, now());
  return token;
}

// --- passwords -------------------------------------------------------------
//
// Staff only. See migration 011 for why staff need a password at all: with no
// mail transport, a link-only sign-in for the people who run the conference is
// an outage waiting for its first locked-out organizer.

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 131072, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };

/**
 * OWASP's parameters for scrypt when Argon2id is unavailable: N=2^17, r=8, p=1.
 *
 * Two things Node makes easy to get wrong. Its defaults are N=2^14, below that
 * floor, so the parameters are always passed. And `maxmem` defaults to 32 MiB
 * while these parameters need about 128, so it throws unless raised. Always the
 * async form: this is a fifth of a second of CPU, and the synchronous version
 * would stop the entire server for that long.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`
    + `${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/** Verify against a stored hash, reading its parameters from the hash itself. */
export async function passwordMatches(password, stored) {
  if (!stored) return false;
  const [scheme, N, r, p, salt, derived] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;

  const expected = Buffer.from(derived, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function setPassword(db, personId, hashString) {
  db.prepare(
    `INSERT INTO person_credential (person_id, password_hash, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (person_id) DO UPDATE SET password_hash = excluded.password_hash,
                                           updated_at = excluded.updated_at`,
  ).run(personId, hashString, now());
}

export const credentialFor = (db, personId) =>
  db.prepare('SELECT * FROM person_credential WHERE person_id = ?').get(personId) ?? null;

export function signOut(db, cookies = {}) {
  const token = cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM auth_session WHERE token_hash = ?').run(hash(token));
}

// --- organizer access ------------------------------------------------------

/**
 * There is no `organizerAccessIsOpen()` any more, and its absence is the point.
 *
 * It used to return true whenever HOST was loopback, and canOrganize()
 * short-circuited on it. That made the app two different products: wide open on
 * a laptop, entirely shut on any public address, with only the first one ever
 * exercised. The deployed behaviour was the untested one, which is exactly
 * backwards, and it hid real faults -- /login was broken for months because
 * local development never has to sign in.
 *
 * Authorization is now read from the database on every request. That is a
 * property worth keeping deliberately: revoking somebody's membership takes
 * effect on their next click, with no sessions to hunt down. Do not cache roles
 * on the session row.
 */

/** The roles a person holds on an event. */
export function rolesFor(db, eventId, personId) {
  if (!personId) return [];
  return db.prepare('SELECT role FROM event_membership WHERE event_id = ? AND person_id = ?')
    .all(eventId, personId).map((r) => r.role);
}

export function canOrganize(db, eventId, person) {
  if (!person) return false;
  if (person.is_admin) return true;
  const roles = rolesFor(db, eventId, person.id);
  return roles.includes('owner') || roles.includes('organizer');
}

export function canReview(db, eventId, person) {
  if (!person) return false;
  if (person.is_admin) return true;
  return rolesFor(db, eventId, person.id).length > 0;
}

// --- the setup token -------------------------------------------------------

const SETUP_TOKEN_KEY = 'setup_token_hash';

/**
 * Record the hash of the operator's setup token, so a fresh container can be
 * claimed by whoever holds it.
 *
 * Deliberately NOT the Jenkins pattern of printing a secret to the console. A
 * container's stdout is routinely shipped to a log aggregator with far broader
 * read access than the database, so logging a credential writes it down into a
 * lower-trust system (CWE-532). When no token is configured we generate one and
 * write it to a file with mode 0600, and log only the path.
 *
 * The 32-character floor is not arbitrary. Only the hash is stored, and storing
 * a fast unsalted hash is the correct treatment for a high-entropy secret (NIST
 * SP 800-63B: look-up secrets with 112+ bits SHALL be hashed with an approved
 * one-way function) -- but it is the wrong treatment for a guessable one. The
 * floor is what keeps the assumption true.
 */
export function recordSetupToken(db, token) {
  if (String(token).length < 32) {
    throw new Error('SETUP_TOKEN must be at least 32 characters; '
      + 'generate one with: openssl rand -base64 32');
  }
  db.prepare(
    `INSERT INTO instance_setting (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETUP_TOKEN_KEY, hash(token), now());
}

/**
 * Whether this is the setup token.
 *
 * Compares hashes rather than raw strings so that `secretsMatch`'s length check
 * cannot itself become an oracle for how long the real token is.
 */
export function setupTokenMatches(db, supplied) {
  const row = db.prepare('SELECT value FROM instance_setting WHERE key = ?').get(SETUP_TOKEN_KEY);
  if (!row || !supplied) return false;
  return secretsMatch(hash(supplied), row.value);
}

export const hasAdmin = (db) =>
  Boolean(db.prepare('SELECT 1 FROM person WHERE is_admin = 1 LIMIT 1').get());

// --- throttling ------------------------------------------------------------

/**
 * Record a failed credential attempt and say whether the caller has had too
 * many. Cheap, and it survives a restart, which an in-memory counter does not.
 */
export function tooManyAttempts(db, key, { limit = 10, windowMinutes = 15 } = {}) {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare('DELETE FROM auth_attempt WHERE at < ?').run(since);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM auth_attempt WHERE key = ? AND at >= ?')
    .get(key, since);
  return n >= limit;
}

export function recordAttempt(db, key) {
  db.prepare('INSERT INTO auth_attempt (key, at) VALUES (?, ?)').run(key, now());
}

export const clearAttempts = (db, key) =>
  db.prepare('DELETE FROM auth_attempt WHERE key = ?').run(key);

/** Whether cookies should carry Secure, derived from PUBLIC_ORIGIN. */
export const cookiesAreSecure = () => SECURE_COOKIES;

/** Constant-time comparison, for anywhere a caller supplies a secret directly. */
export function secretsMatch(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
