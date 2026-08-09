// A sign-in page for demonstrations and automated evaluation.
//
// The real way in is a magic link: you type your address at /portal/sign-in, we
// email you a one-time token, you click it. That is correct and it is unusable
// by anything that cannot read a mailbox -- a person showing the app on a
// projector, a scripted walkthrough, a browser agent being scored on how many
// steps a task takes.
//
// So this page puts the seeded people behind four buttons. It mints nothing new:
// it uses core/auth.js's own magic link and consumes it immediately, which is
// exactly what the call-for-papers form already does the moment somebody
// submits a proposal. There is one session mechanism in this app and this is it.

import { html, page } from '../http/html.js';
import { ok, redirect, forbidden } from '../http/router.js';
import { now } from '../db.js';
import { createMagicLink, consumeMagicLink, SESSION_COOKIE, rolesFor } from '../core/auth.js';
import { cookieHeader } from '../http/request.js';
import { fullName } from './shared.js';

export function mountDemoAuth(router) {
  router.get('/login', loginPage,
    'One-click sign-in as any seeded person, for demos and automated evaluation.');

  router.post('/login', postLogin,
    'Sign in. Send persona=organizer|speaker|speaker2|reviewer, or an email address.');
}

// ---------------------------------------------------------------------------
// What this page is allowed to do, and where
// ---------------------------------------------------------------------------

/**
 * Whether the demo sign-in page is available.
 *
 * The reasoning, written down because "any password works" deserves an argument
 * rather than an apology:
 *
 * On loopback this page gives away nothing that is not already given away.
 * `organizerAccessIsOpen()` in core/auth.js already lets anybody who can reach
 * 127.0.0.1 open every organizer screen without signing in, on the grounds that
 * they could equally well open the SQLite file sitting next to the server. A
 * button that signs you in as Jordan is strictly less access than the door that
 * is already open, so on loopback this is on.
 *
 * Off loopback that argument collapses. There, organizer routes demand a real
 * signed-in member, and a page that hands out a session for any person row would
 * be a straightforward authentication bypass -- worse than an open organizer UI,
 * because it also reaches speakers' own portals, which are never open. So off
 * loopback this is off, and only an explicit DEMO_LOGIN=1 turns it back on: that
 * is a deployment saying out loud "this instance is a demo, its data is fixture
 * data, sign in as anyone". Setting DEMO_LOGIN=0 closes it even on loopback, for
 * anybody who wants the app to behave as it would in production.
 *
 * Two further limits keep this from being a hole rather than a door:
 * this route never creates a person, so it can only sign you in as somebody a
 * seed already put in the database; and it grants nothing but a normal session,
 * so every permission check downstream is the one it always was.
 */
export function demoLoginIsOpen({
  flag = process.env.DEMO_LOGIN,
  host = process.env.HOST ?? '127.0.0.1',
} = {}) {
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function requireDemoLogin() {
  if (demoLoginIsOpen()) return;
  throw forbidden('the demo sign-in page is disabled on this host',
    'ask for a one-time link at /portal/sign-in, or start the server with DEMO_LOGIN=1');
}

// ---------------------------------------------------------------------------
// The personas
// ---------------------------------------------------------------------------

/**
 * The four seeded identities, in the order they appear on the page.
 *
 * `label` is what the button says. Short and single-purpose, because whatever is
 * driving this page may be looking a control up by the text on it, and a button
 * that says "Sign in as Priya Raman (speaker)" is four ways to get that wrong.
 * The name and address live outside the button, where they inform a human
 * without widening what the button is called.
 */
const PERSONAS = [
  // Labels are chosen so that no label is a prefix of another. An automated
  // helper that clicks "the control whose label starts with X" has to find
  // exactly one match, and "Speaker" is a prefix of "Speaker 2".
  { key: 'organizer', label: 'Organizer', email: 'sbek-organizer@example.com', lands: 'organizer' },
  { key: 'speaker', label: 'Speaker', email: 'sbek-speaker@example.com', lands: 'speaker' },
  { key: 'speaker2', label: 'Co-speaker', email: 'sbek-speaker2@example.com', lands: 'speaker' },
  { key: 'reviewer', label: 'Reviewer', email: 'sbek-reviewer@example.com', lands: 'reviewer' },
];

/**
 * Addresses that mean the same human as one of the four above.
 *
 * This table exists because the fixture is described in more than one document
 * and the documents disagree: the same reviewer is `sbek-reviewer@example.com`
 * in one place and `sam.reviewer@sbek-test.example.com` in another. Whoever is
 * typing has a fifty-fifty chance of picking the spelling this database does not
 * hold, and the wrong outcome -- a second Sam Whitfield, with an empty portal and
 * no reviews -- is silent and confusing.
 *
 * So both spellings resolve to the one row. Listed explicitly rather than
 * derived, because the derivation does not work: `priya.speaker@...` shortens to
 * "priya", and this instance has two Priyas once Manzanita is seeded alongside
 * DevFlow. An alias table can be right about that; a rule cannot.
 */
const EMAIL_ALIASES = {
  'jordan.organizer@sbek-test.example.com': 'sbek-organizer@example.com',
  'priya.speaker@sbek-test.example.com': 'sbek-speaker@example.com',
  'marcus.speaker@sbek-test.example.com': 'sbek-speaker2@example.com',
  'sam.reviewer@sbek-test.example.com': 'sbek-reviewer@example.com',
};

const localPart = (email) => String(email).split('@')[0].toLowerCase();

/** The first word of a local part: `priya.speaker` and `priya-speaker` both give `priya`. */
const firstWord = (email) => localPart(email).split(/[.\-_+]/)[0];

/**
 * Find the one person an address means, or null.
 *
 * Three attempts, narrowest first:
 *
 *   1. the address itself, which is how `person.email` is already matched
 *      everywhere else in the app;
 *   2. the alias table above;
 *   3. the first word of the local part, against both the local part of every
 *      known address and every first name -- but only when exactly one person
 *      answers to it. `jordan.organizer@anywhere` is unambiguously Jordan;
 *      `priya.speaker@anywhere` is two people, so it is nobody, and the caller is
 *      told the address is unknown rather than being signed in as a coin flip.
 *
 * Never creates a row. An address this cannot place is an address this instance
 * has not been seeded with.
 */
export function resolvePersonByEmail(db, email) {
  const wanted = String(email ?? '').trim();
  if (wanted === '') return null;

  const byEmail = db.prepare('SELECT * FROM person WHERE email = ? COLLATE NOCASE');

  const exact = byEmail.get(wanted);
  if (exact) return exact;

  const alias = EMAIL_ALIASES[wanted.toLowerCase()];
  if (alias) {
    const aliased = byEmail.get(alias);
    if (aliased) return aliased;
  }

  const word = firstWord(wanted);
  if (word === '') return null;

  const candidates = db.prepare('SELECT * FROM person').all().filter((person) =>
    firstWord(person.email) === word || person.first_name.toLowerCase() === word);

  return candidates.length === 1 ? candidates[0] : null;
}

// ---------------------------------------------------------------------------
// Where somebody lands
// ---------------------------------------------------------------------------

/**
 * The event a person's screens should open on.
 *
 * An event they staff, if they staff one; otherwise the next one to happen,
 * which is the one a speaker submitting today is submitting to.
 */
function homeEventFor(db, person) {
  const staffed = db.prepare(
    `SELECT e.* FROM event e
       JOIN event_membership m ON m.event_id = e.id AND m.person_id = ?
      ORDER BY e.starts_at DESC LIMIT 1`,
  ).get(person.id);

  return staffed ?? db.prepare('SELECT * FROM event ORDER BY starts_at DESC LIMIT 1').get();
}

/**
 * The screen that is worth being on, given who somebody is.
 *
 * An organizer wants the dashboard, a reviewer wants their queue, a speaker
 * wants their portal. Landing all three on the same page would cost every one of
 * them a click to leave it.
 */
function destinationFor(db, person, event, lands = null) {
  if (!event) return '/';

  const roles = rolesFor(db, event.id, person.id);
  const role = lands
    ?? (roles.includes('owner') || roles.includes('organizer') ? 'organizer'
      : roles.includes('reviewer') ? 'reviewer' : 'speaker');

  if (role === 'organizer') return `/e/${event.slug}`;
  if (role === 'reviewer') return `/review/${event.slug}`;
  return `/portal/${event.slug}`;
}

/**
 * Start a session for a person.
 *
 * A magic link, minted and spent in the same breath. Writing to `auth_session`
 * directly would mean copying core/auth.js's token hashing into a second place,
 * and two pieces of code that must agree about how a session is stored are one
 * piece of code too many.
 */
function signIn(db, person, event) {
  const token = createMagicLink(db, person.id, event?.id ?? null);
  return consumeMagicLink(db, token);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** The open call for papers a visitor is most likely to want. */
function openCallForPapers(db) {
  return db.prepare(
    `SELECT e.slug AS event_slug, e.name AS event_name, f.slug AS form_slug
       FROM form f JOIN event e ON e.id = f.event_id
      WHERE f.kind = 'submission' AND (f.close_at IS NULL OR f.close_at > ?)
      ORDER BY e.starts_at DESC, f.id LIMIT 1`,
  ).get(now());
}

function loginPage(ctx, { error = '' } = {}) {
  requireDemoLogin();

  const cfp = openCallForPapers(ctx.db);
  const rows = PERSONAS.map((persona) => ({
    persona,
    person: resolvePersonByEmail(ctx.db, persona.email),
  }));
  const seeded = rows.filter((row) => row.person);

  return ok(page({
    title: 'Sign in',
    body: html`
      <h1>Sign in</h1>
      <p class="sub">This instance holds fixture data. Pick who to be.</p>

      ${error ? html`<p class="flash error">${error}</p>` : ''}

      ${seeded.length === 0 ? html`
        <p class="empty">Nobody is seeded yet. Run <code>npm run seed</code> and
          <code>npm run seed:devflow</code>.</p>` : html`
        <table>
          <tbody>
            ${seeded.map(({ persona, person }) => html`
              <tr>
                <td style="width:11rem">
                  <form method="post" action="/login">
                    <input type="hidden" name="persona" value="${persona.key}">
                    <button type="submit">${persona.label}</button>
                  </form>
                </td>
                <td>
                  <strong>${fullName(person)}</strong>
                  ${person.job_title ? html`<br><span class="muted">${person.job_title}${
                    person.company ? html`, ${person.company}` : ''}</span>` : ''}
                  <br><span class="muted"><code>${person.email}</code></span>
                </td>
              </tr>`)}
          </tbody>
        </table>`}

      <h2>Or by address</h2>
      <p class="muted">Any seeded address works, and so does any password, including
        none. Nothing here creates an account.</p>
      <form method="post" action="/login">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" autocomplete="username">
        <label for="password">Password</label>
        <input type="text" id="password" name="password" autocomplete="off">
        <div class="actions"><button type="submit">Sign in</button></div>
      </form>

      ${cfp ? html`
        <p><a href="/submit/${cfp.event_slug}/${cfp.form_slug}">Open the
          ${cfp.event_name} call for papers</a> &mdash; no account needed.</p>` : ''}

      <p class="muted">The real way in is a one-time link, at
        <a href="/portal/sign-in">/portal/sign-in</a>. This page exists so a demo
        does not have to wait for an inbox.</p>
    `,
  }));
}

function postLogin(ctx) {
  requireDemoLogin();

  const key = ctx.fields.get('persona');
  const persona = PERSONAS.find((p) => p.key === key);

  if (key && !persona) {
    return loginPage(ctx, {
      error: `There is no '${key}' persona. Try one of: ${PERSONAS.map((p) => p.key).join(', ')}.`,
    });
  }

  // The password field is accepted and never looked at, deliberately: there is no
  // password column in this schema and there never was one. It is on the page
  // because a sign-in form without one confuses anybody -- or anything -- that
  // expects to fill in two boxes. See demoLoginIsOpen() above for why accepting
  // anything at all is defensible here and nowhere else.
  const email = persona ? persona.email : ctx.fields.get('email');

  if (email === '') {
    return loginPage(ctx, { error: 'Enter an email address, or use one of the buttons.' });
  }

  const person = resolvePersonByEmail(ctx.db, email);

  if (!person) {
    return loginPage(ctx, {
      error: `Nobody here uses ${email}. This page signs you in as somebody a seed`
        + ' already created; it does not make accounts.',
    });
  }

  const event = homeEventFor(ctx.db, person);
  const session = signIn(ctx.db, person, event);

  return redirect(destinationFor(ctx.db, person, event, persona?.lands), {
    headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, session.token) },
  });
}
