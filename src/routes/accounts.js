// Getting in, and letting other people in.
//
// Trust on first use, with one gate. The first person to claim this instance
// becomes its administrator and can bless everybody else; that is the whole
// model, and it is deliberately the simplest thing that works for a tool run by
// one or two people around a conference.
//
// The gate is a setup token, and it exists because of one specific hazard: the
// URL of a deployment is public before anybody has claimed it -- it gets handed
// to people, written down, submitted. Pure trust-on-first-use means whoever
// loads that URL between "the container is listening" and "the operator opens
// their laptop" owns the conference permanently, and a redeploy onto a fresh
// volume reopens that window with the address already circulating. Gitea ships
// INSTALL_LOCK=false for exactly this reason. The token proves you are the
// operator rather than a passer-by; everything after it is ordinary TOFU.
//
// The token is never logged. When the operator does not supply one we generate
// it and write it to a file, and log the path. A container's stdout is shipped
// to places with much broader read access than its database, so printing a
// credential there writes it down into a lower-trust system (CWE-532).

import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { html, page } from '../http/html.js';
import { ok, redirect, badRequest, forbidden } from '../http/router.js';
import { cookieHeader, clearCookieHeader } from '../http/request.js';
import { now, uniqueSlug, ROOT_DIR } from '../db.js';
import {
  SESSION_COOKIE, startSession, signOut, recordSetupToken, setupTokenMatches, hasAdmin,
  hashPassword, passwordMatches, setPassword, credentialFor, createApiToken, createMagicLink,
  tooManyAttempts, recordAttempt, clearAttempts, canOrganize,
} from '../core/auth.js';
import { logActivity } from '../core/submissions.js';

const SETUP_TOKEN_FILE = join(ROOT_DIR, 'data', 'setup-token');

/**
 * Make sure this instance has a setup token, once, at boot.
 *
 * Called from the server's entry point rather than from createApp, so that the
 * whole test suite is untouched by it and no test has to know a token exists.
 */
export function ensureSetupToken(db, env = process.env, log = console.error) {
  const supplied = env.SETUP_TOKEN
    ?? (env.SETUP_TOKEN_FILE && existsSync(env.SETUP_TOKEN_FILE)
      ? readFileSync(env.SETUP_TOKEN_FILE, 'utf8').trim()
      : null);

  if (supplied) {
    recordSetupToken(db, supplied);
    return { source: 'environment' };
  }

  if (hasAdmin(db)) return { source: 'already claimed' };

  const token = randomBytes(32).toString('base64url');
  recordSetupToken(db, token);
  writeFileSync(SETUP_TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  log(`No administrator yet. Setup token written to ${SETUP_TOKEN_FILE} (mode 0600).`);
  log('Claim this instance at /setup/claim. The token is not printed here on purpose.');
  return { source: 'generated', path: SETUP_TOKEN_FILE };
}

export function mountAccounts(router) {
  router.get('/setup/claim', claimForm,
    'Claim a fresh instance: exchange the setup token for the first administrator account.');
  router.post('/setup/claim', claim,
    'Body: token, email, password. Creates or promotes an administrator and signs you in. '
    + 'The token is SETUP_TOKEN, or the contents of data/setup-token on a fresh instance.');

  router.get('/sign-in', signInForm, 'Sign in with an email address and password.');
  router.post('/sign-in', signIn, 'Body: email, password. For organizers and reviewers. '
    + 'Speakers do not have passwords; they ask for a link at /portal/sign-in.');
  router.post('/sign-out', signOutNow, 'End your session.');

  router.get('/account', account, 'Your account: set a password, and mint API tokens.');
  router.post('/account/password', changePassword, 'Body: password. Sets or replaces your password.');
  router.post('/account/tokens', mintToken,
    'Body: name. Mints an API token for scripts. Send it as `authorization: bearer <token>`. '
    + 'Shown once and never again.');
  router.post('/account/tokens/:id/revoke', revokeToken, 'Revoke one of your API tokens.');

  router.get('/e/:event/people', eventPeople, 'Who can organize or review this event.');
  router.post('/e/:event/people', grantRole,
    'Body: email, role=organizer|reviewer|owner. Adds somebody to this event and returns a '
    + 'one-time sign-in link to hand them. Creates the person if they are new.');
  router.post('/e/:event/people/:person/revoke', revokeRole, 'Remove somebody from this event.');
}

// --- claiming --------------------------------------------------------------

function claimForm(ctx) {
  const claimed = hasAdmin(ctx.db);
  return ok(page({
    title: 'Claim this instance',
    body: html`
      <h1>Claim this instance</h1>
      ${claimed
        ? html`<p class="flash">This instance already has an administrator. The setup token still
               works, and is the way back in if everybody is locked out.</p>`
        : html`<p>Nobody administers this instance yet. Whoever presents the setup token first
               becomes its administrator, and can then add everybody else.</p>`}
      <p>The token is whatever <code>SETUP_TOKEN</code> was set to. On an instance that was
         started without one, it is in <code>data/setup-token</code>.</p>
      <form method="post" action="/setup/claim">
        <div><label for="token">Setup token</label>
          <input type="password" id="token" name="token" required autocomplete="off"></div>
        <div><label for="email">Your email</label>
          <input type="email" id="email" name="email" required></div>
        <div><label for="password">Choose a password</label>
          <input type="password" id="password" name="password" required minlength="12"
                 autocomplete="new-password"></div>
        <div class="actions"><button type="submit">Claim</button></div>
      </form>`,
  }));
}

async function claim(ctx) {
  const key = `setup:${ctx.headers?.['x-forwarded-for'] ?? 'local'}`;
  if (tooManyAttempts(ctx.db, key)) {
    throw forbidden('too many attempts', 'wait fifteen minutes and try again');
  }

  const token = ctx.fields.require('token', 'the value of SETUP_TOKEN, or data/setup-token');
  const email = ctx.fields.require('email').toLowerCase();
  const password = ctx.fields.require('password');

  if (!setupTokenMatches(ctx.db, token)) {
    recordAttempt(ctx.db, key);
    // Deliberately says nothing about which part was wrong.
    throw forbidden('that is not the setup token',
      'it is the value of SETUP_TOKEN, or the contents of data/setup-token');
  }

  if (password.length < 12) {
    throw badRequest('a password needs at least 12 characters',
      'length is what makes a password hard to guess; a short complex one is not better');
  }

  clearAttempts(ctx.db, key);

  const person = upsertPerson(ctx.db, email, ctx.fields.get('first_name', 'Instance'),
    ctx.fields.get('last_name', 'Administrator'));
  ctx.db.prepare('UPDATE person SET is_admin = 1 WHERE id = ?').run(person.id);
  setPassword(ctx.db, person.id, await hashPassword(password));

  if (existsSync(SETUP_TOKEN_FILE)) unlinkSync(SETUP_TOKEN_FILE);

  logActivity(ctx.db, { eventId: null, actorPersonId: person.id, subjectType: 'person',
    subjectId: person.id, verb: 'claimed', detail: 'became an instance administrator' });

  return signedInRedirect(ctx, person.id, '/');
}

// --- signing in ------------------------------------------------------------

function signInForm(ctx) {
  return ok(page({
    title: 'Sign in',
    body: html`
      <h1>Sign in</h1>
      ${ctx.query.get('failed') ? html`<p class="flash error">Sign in failed.</p>` : ''}
      <form method="post" action="/sign-in">
        <div><label for="email">Email</label>
          <input type="email" id="email" name="email" required autocomplete="username"></div>
        <div><label for="password">Password</label>
          <input type="password" id="password" name="password" required
                 autocomplete="current-password"></div>
        <div class="actions"><button type="submit">Sign in</button></div>
      </form>
      <p><small>Speakers do not have passwords.
        <a href="/portal/sign-in">Ask for a sign-in link</a> instead.</small></p>`,
  }));
}

async function signIn(ctx) {
  const email = ctx.fields.require('email').toLowerCase();
  const password = ctx.fields.require('password');
  const key = `signin:${email}`;

  if (tooManyAttempts(ctx.db, key)) {
    throw forbidden('too many attempts', 'wait fifteen minutes and try again');
  }

  const person = ctx.db.prepare('SELECT * FROM person WHERE lower(email) = ?').get(email);
  const credential = person ? credentialFor(ctx.db, person.id) : null;

  // One message for every failure. Telling a stranger whether an address is
  // known leaks the speaker list of every conference on this instance -- the
  // same reasoning /portal/sign-in already applies.
  if (!person || !credential || !(await passwordMatches(password, credential.password_hash))) {
    recordAttempt(ctx.db, key);
    return redirect('/sign-in?failed=1');
  }

  clearAttempts(ctx.db, key);
  return signedInRedirect(ctx, person.id, ctx.query.get('next') || '/');
}

function signOutNow(ctx) {
  signOut(ctx.db, ctx.cookies);
  return redirect('/', { headers: { 'set-cookie': clearCookieHeader(SESSION_COOKIE) } });
}

/**
 * Destroy whatever session was presented, mint a new one, and go somewhere.
 *
 * The destroy is not decoration: regenerating the identifier on any change of
 * privilege is what stops session fixation, and a sign-in is the largest such
 * change there is.
 */
function signedInRedirect(ctx, personId, to) {
  signOut(ctx.db, ctx.cookies);
  const session = startSession(ctx.db, personId);
  return redirect(to, { headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, session.token) } });
}

// --- your own account ------------------------------------------------------

function requireSignedIn(ctx) {
  if (!ctx.person) {
    throw forbidden('you need to be signed in',
      'sign in at /sign-in, or send `authorization: bearer <token>`');
  }
  return ctx.person;
}

function account(ctx) {
  const person = requireSignedIn(ctx);
  const tokens = ctx.db.prepare(
    'SELECT * FROM api_token WHERE person_id = ? AND revoked_at IS NULL ORDER BY id DESC',
  ).all(person.id);
  const fresh = ctx.query.get('token');

  return ok(page({
    title: 'Your account',
    body: html`
      <h1>Your account</h1>
      <p>${person.email}${person.is_admin ? ' — instance administrator' : ''}</p>

      ${fresh ? html`
        <div class="flash">
          <p><strong>Your new API token. This is the only time it is shown.</strong></p>
          <pre>${fresh}</pre>
          <p>Use it like this:</p>
          <pre>curl -s -H "authorization: bearer ${fresh}" ${''}
     ${ctx.origin}/api/events</pre>
        </div>` : ''}

      <h2>Password</h2>
      <form method="post" action="/account/password">
        <div><label for="password">New password</label>
          <input type="password" id="password" name="password" required minlength="12"
                 autocomplete="new-password"></div>
        <div class="actions"><button type="submit">Set password</button></div>
      </form>

      <h2>API tokens</h2>
      <p>For scripts, the command line over HTTP, and automated evaluation. A token carries
         exactly your own access, and is sent as an <code>authorization: bearer</code> header.</p>
      ${tokens.length === 0 ? html`<p><small>None yet.</small></p>` : html`
        <table>
          <tr><th>Name</th><th>Starts with</th><th>Last used</th><th></th></tr>
          ${tokens.map((t) => html`
            <tr>
              <td>${t.name}</td><td><code>${t.prefix}…</code></td>
              <td>${t.last_used_at ?? 'never'}</td>
              <td><form method="post" action="/account/tokens/${String(t.id)}/revoke">
                <button type="submit">Revoke</button></form></td>
            </tr>`)}
        </table>`}
      <form method="post" action="/account/tokens">
        <div><label for="name">What is it for</label>
          <input type="text" id="name" name="name" required placeholder="eval harness"></div>
        <div class="actions"><button type="submit">Mint a token</button></div>
      </form>

      <form method="post" action="/sign-out"><button type="submit">Sign out</button></form>`,
  }));
}

async function changePassword(ctx) {
  const person = requireSignedIn(ctx);
  const password = ctx.fields.require('password');
  if (password.length < 12) {
    throw badRequest('a password needs at least 12 characters',
      'length is what makes a password hard to guess');
  }
  setPassword(ctx.db, person.id, await hashPassword(password));
  return redirect('/account');
}

function mintToken(ctx) {
  const person = requireSignedIn(ctx);
  const name = ctx.fields.require('name', 'what the token is for, e.g. "eval harness"');
  const token = createApiToken(ctx.db, person.id, name);
  return redirect(`/account?token=${encodeURIComponent(token)}`);
}

function revokeToken(ctx) {
  const person = requireSignedIn(ctx);
  ctx.db.prepare('UPDATE api_token SET revoked_at = ? WHERE id = ? AND person_id = ?')
    .run(now(), Number(ctx.params.id), person.id);
  return redirect('/account');
}

// --- blessing other people -------------------------------------------------

const ROLES = ['owner', 'organizer', 'reviewer'];

function findEventOr404(ctx) {
  const event = ctx.db.prepare('SELECT * FROM event WHERE slug = ?').get(ctx.params.event);
  if (!event) throw badRequest(`no event '${ctx.params.event}'`, 'list them: GET /api/events');
  return event;
}

function eventPeople(ctx) {
  const event = findEventOr404(ctx);
  if (!canOrganize(ctx.db, event.id, ctx.person)) {
    throw forbidden('organizer access required', 'sign in at /sign-in');
  }

  const people = ctx.db.prepare(
    `SELECT m.role, p.slug, p.email, p.first_name, p.last_name FROM event_membership m
       JOIN person p ON p.id = m.person_id WHERE m.event_id = ? ORDER BY m.role, p.last_name`,
  ).all(event.id);
  const link = ctx.query.get('link');

  return ok(page({
    title: `People — ${event.name}`,
    body: html`
      <h1>Who can work on ${event.name}</h1>
      ${link ? html`
        <div class="flash">
          <p><strong>Their one-time sign-in link. Hand it over however you normally would.</strong></p>
          <pre>${link}</pre>
          <p>This app sends no email, so nobody has been told. The link is good for one hour
             and one use.</p>
        </div>` : ''}
      <table>
        <tr><th>Role</th><th>Name</th><th>Email</th><th></th></tr>
        ${people.map((p) => html`
          <tr>
            <td>${p.role}</td><td>${p.first_name} ${p.last_name}</td><td>${p.email}</td>
            <td><form method="post" action="/e/${event.slug}/people/${p.slug}/revoke">
              <button type="submit">Remove</button></form></td>
          </tr>`)}
      </table>
      <h2>Add somebody</h2>
      <form method="post" action="/e/${event.slug}/people">
        <div><label for="email">Email</label>
          <input type="email" id="email" name="email" required></div>
        <div><label for="role">Role</label>
          <select id="role" name="role">
            ${ROLES.map((r) => html`<option value="${r}">${r}</option>`)}
          </select></div>
        <div class="actions"><button type="submit">Add</button></div>
      </form>`,
  }));
}

function grantRole(ctx) {
  const event = findEventOr404(ctx);
  if (!canOrganize(ctx.db, event.id, ctx.person)) {
    throw forbidden('organizer access required', 'sign in at /sign-in');
  }

  const email = ctx.fields.require('email').toLowerCase();
  const role = ctx.fields.choice('role', ROLES, 'organizer');
  const person = upsertPerson(ctx.db, email,
    ctx.fields.get('first_name', email.split('@')[0]), ctx.fields.get('last_name', ''));

  ctx.db.prepare(
    `INSERT INTO event_membership (event_id, person_id, role) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(event.id, person.id, role);

  // Nothing is emailed, because this app emails nobody. The link is put on the
  // screen for the person who is already looking at it to pass along, which is
  // the same thing `conf portal-link` does at the command line.
  const token = createMagicLink(ctx.db, person.id, event.id);
  const link = `${ctx.origin}/portal/${event.slug}/enter?token=${token}`;

  return redirect(`/e/${event.slug}/people?link=${encodeURIComponent(link)}`);
}

function revokeRole(ctx) {
  const event = findEventOr404(ctx);
  if (!canOrganize(ctx.db, event.id, ctx.person)) {
    throw forbidden('organizer access required', 'sign in at /sign-in');
  }
  const person = ctx.db.prepare('SELECT id FROM person WHERE slug = ?').get(ctx.params.person);
  if (person) {
    ctx.db.prepare('DELETE FROM event_membership WHERE event_id = ? AND person_id = ?')
      .run(event.id, person.id);
  }
  return redirect(`/e/${event.slug}/people`);
}

// --- shared ----------------------------------------------------------------

function upsertPerson(db, email, firstName, lastName) {
  const existing = db.prepare('SELECT * FROM person WHERE lower(email) = ?').get(email);
  if (existing) return existing;

  const base = `${firstName} ${lastName}`.trim() || email.split('@')[0];
  const slug = uniqueSlug(base, (s) => Boolean(db.prepare('SELECT 1 FROM person WHERE slug = ?').get(s)));

  const t = now();
  return db.prepare(
    `INSERT INTO person (slug, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(slug, email, firstName, lastName, t, t);
}
