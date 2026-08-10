// The handoff from the public form into the speaker portal.
//
// The customer annotated two things on their screenshots more strongly than
// anything else: the submitter confirmation email ("must have") and the success
// page that carries you into the portal ("make sure this works"). Both hang off
// the same link, and that link was dead.
//
// Why it survived every kind of testing that is not this: the response that
// hands you the link also signs you in with a cookie, so by hand you land in
// your portal and the product looks fine. The link only fails tomorrow, in
// somebody else's inbox, where nobody is watching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, get, post, redirectedTo } from './http-helpers.js';

async function callForSpeakers(app) {
  redirectedTo(await post(app, '/e/new', {
    name: 'DevFlow Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-14',
    timezone: 'America/Los_Angeles', with_defaults: '1',
  }));
  const event = 'devflow-conf-2027';
  await post(app, `/e/${event}/settings/tracks`, { name: 'Retrieval' });
  const form = redirectedTo(await post(app, `/e/${event}/forms`, {
    internal_name: 'CFP 2027', with_defaults: '1',
  })).split('/').pop();
  return { event, form };
}

const PROPOSAL = {
  title: 'Retrieval that actually retrieves', description: 'On chunking.',
  format: 'talk-30-min', track: 'retrieval', 'first-name': 'Priya', 'last-name': 'Raman',
  email: 'priya@example.com', biography: 'Engineer.',
};

/** The confirmation message as it was actually rendered into the outbox. */
const confirmation = (app) => app.db.prepare(
  `SELECT * FROM outbox WHERE kind = 'submission_confirmation' ORDER BY id DESC`).get();

/** Every token offered to the submitter: in the email, and on the success page. */
function tokensIn(text) {
  return [...String(text).matchAll(/enter\?token=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

test('the link in the confirmation email still works afterwards', async () => {
  const app = newApp();
  const { event, form } = await callForSpeakers(app);

  await post(app, `/submit/${event}/${form}`, PROPOSAL);

  const message = confirmation(app);
  assert.ok(message, 'a confirmation should have been queued');
  const [token] = tokensIn(message.body);
  assert.ok(token, 'the confirmation should carry a portal link');

  // A fresh visit, carrying no cookie: this speaker is opening their email
  // tomorrow, on their phone, having never had a session on this device.
  const entered = await get(app, `/portal/${event}/enter?token=${token}`);

  assert.notEqual(entered.status, 410,
    'the emailed link had been spent by the request that sent it');
  assert.equal(entered.status, 303);
  assert.match(redirectedTo(entered), new RegExp(`/portal/${event}`));
});

test('the link on the success page still works afterwards', async () => {
  const app = newApp();
  const { event, form } = await callForSpeakers(app);
  // Turn off the redirect so the success page is what we actually get back.
  await post(app, `/e/${event}/forms/${form}/settings`,
    { internal_name: 'CFP 2027', settings_form: '1' });

  const response = await post(app, `/submit/${event}/${form}`, PROPOSAL);

  const [token] = tokensIn(response.body);
  assert.ok(token, 'the success page should offer a way into the portal');

  const entered = await get(app, `/portal/${event}/enter?token=${token}`);
  assert.equal(entered.status, 303, 'the success-page link must outlive the response carrying it');
});

test('the submitter is still signed in immediately, without going to their email', async () => {
  // The fix must not reintroduce the friction the single token was there to
  // remove: having just typed a biography, you should already be in the portal.
  const app = newApp();
  const { event, form } = await callForSpeakers(app);

  const response = await post(app, `/submit/${event}/${form}`, PROPOSAL);

  const cookie = response.headers?.['set-cookie'];
  assert.ok(cookie && /conf_session=/.test(String(cookie)),
    'the response should carry a session, not just a link to one');
});

test('renaming a form over curl does not switch off its confirmation email', async () => {
  // The two things the customer marked hardest -- the confirmation email and the
  // handoff into the portal -- were both checkboxes on a settings form that
  // rewrote every column on every save. Changing the form's name from curl
  // turned both off, silently.
  const app = newApp();
  const { event, form } = await callForSpeakers(app);
  const before = app.db.prepare('SELECT * FROM form WHERE slug = ?').get(form);
  assert.equal(before.send_confirmation_email, 1, 'the default form should start with it on');

  await post(app, `/e/${event}/forms/${form}/settings`, { internal_name: 'Renamed' });

  const after = app.db.prepare('SELECT * FROM form WHERE slug = ?').get(form);
  assert.equal(after.internal_name, 'Renamed', 'the rename should have happened');
  assert.equal(after.send_confirmation_email, 1, 'and nothing else should have');
  assert.equal(after.auto_redirect_to_portal, before.auto_redirect_to_portal);
  assert.equal(after.welcome_message, before.welcome_message);
  assert.equal(after.success_message, before.success_message);
});

test('the settings form can still untick a box', async () => {
  const app = newApp();
  const { event, form } = await callForSpeakers(app);

  // What a browser sends when you untick "send a confirmation": the marker, and
  // no checkbox. Absence has to mean off here, or nothing could ever be turned off.
  await post(app, `/e/${event}/forms/${form}/settings`,
    { internal_name: 'CFP 2027', settings_form: '1' });

  const after = app.db.prepare('SELECT * FROM form WHERE slug = ?').get(form);
  assert.equal(after.send_confirmation_email, 0);
});

test('the email and the page offer the same keepsake link, and it is one-time', async () => {
  const app = newApp();
  const { event, form } = await callForSpeakers(app);
  await post(app, `/e/${event}/forms/${form}/settings`,
    { internal_name: 'CFP 2027', settings_form: '1', send_confirmation_email: '1' });

  const response = await post(app, `/submit/${event}/${form}`, PROPOSAL);
  const pageToken = tokensIn(response.body)[0];
  const emailToken = tokensIn(confirmation(app).body)[0];

  assert.equal(pageToken, emailToken,
    'the same keepsake link belongs in both places, so either one gets you in');

  // Using it consumes it -- that is what a one-time link is -- but it had to
  // survive being handed over at all, which is the bug.
  assert.equal((await get(app, `/portal/${event}/enter?token=${pageToken}`)).status, 303);
  assert.equal((await get(app, `/portal/${event}/enter?token=${pageToken}`)).status, 410,
    'and it is genuinely one-time, not merely long-lived');
});
