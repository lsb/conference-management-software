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

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { now } from '../db.js';

const MAGIC_LINK_TTL_MINUTES = 60;
const SESSION_TTL_DAYS = 30;
export const SESSION_COOKIE = 'conf_session';

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

  const sessionToken = newToken();
  db.prepare(
    'INSERT INTO auth_session (token_hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(hash(sessionToken), link.person_id, isoIn({ days: SESSION_TTL_DAYS }), now());

  return { token: sessionToken, personId: link.person_id };
}

/** The signed-in person, or null. */
export function currentPerson(db, cookies = {}) {
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = db.prepare(
    `SELECT p.* FROM auth_session s JOIN person p ON p.id = s.person_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(hash(token), now());

  return row ?? null;
}

export function signOut(db, cookies = {}) {
  const token = cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM auth_session WHERE token_hash = ?').run(hash(token));
}

// --- organizer access ------------------------------------------------------

/**
 * Whether the organizer UI is open without signing in.
 *
 * True when the server is bound to loopback. On your own machine, reaching the
 * organizer screens already requires being able to read the SQLite file next to
 * them; a login form in front of that protects nothing and would mean the
 * `npm start` demo, the CLI, and the local-model eval all have to authenticate
 * before they can do anything.
 *
 * Bind to anything else -- a LAN address, a public interface -- and this returns
 * false, so organizer routes demand a real signed-in member.
 */
export function organizerAccessIsOpen(host = process.env.HOST ?? '127.0.0.1') {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** The roles a person holds on an event. */
export function rolesFor(db, eventId, personId) {
  if (!personId) return [];
  return db.prepare('SELECT role FROM event_membership WHERE event_id = ? AND person_id = ?')
    .all(eventId, personId).map((r) => r.role);
}

export function canOrganize(db, eventId, person) {
  if (organizerAccessIsOpen()) return true;
  const roles = rolesFor(db, eventId, person?.id);
  return roles.includes('owner') || roles.includes('organizer');
}

export function canReview(db, eventId, person) {
  if (organizerAccessIsOpen()) return true;
  return rolesFor(db, eventId, person?.id).length > 0;
}

/** Constant-time comparison, for anywhere a caller supplies a secret directly. */
export function secretsMatch(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
