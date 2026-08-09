import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, get, post, redirectedTo, failure } from './http-helpers.js';

async function eventWithForm(app, formFields = {}) {
  redirectedTo(await post(app, '/e/new', {
    name: 'DevFlow Conf 2027', starts_at: '2027-05-12', ends_at: '2027-05-14',
    timezone: 'America/Los_Angeles', with_defaults: '1',
  }));
  const slug = 'devflow-conf-2027';
  await post(app, `/e/${slug}/settings/tracks`, { name: 'AI Engineering' });
  await post(app, `/e/${slug}/settings/tracks`, { name: 'Platform and Infra' });

  const to = redirectedTo(await post(app, `/e/${slug}/forms`, {
    internal_name: 'CFP 2027 (main round)', external_title: 'Call for Speakers',
    with_defaults: '1', ...formFields,
  }));
  return { slug, form: to.split('/').pop() };
}

test('a new form is immediately public and asks the usual questions', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);

  const publicPage = await get(app, `/submit/${slug}/${form}`);
  assert.equal(publicPage.status, 200);
  for (const label of ['Title', 'Description', 'Track', 'Format', 'First name', 'Email']) {
    assert.match(publicPage.body, new RegExp(label), `the public form should ask for ${label}`);
  }
});

test('every dropdown on a new form actually has choices in it', async () => {
  // This is the bug we shipped once: a required Track field with an empty
  // dropdown, which nobody could answer.
  const app = newApp();
  const { slug, form } = await eventWithForm(app);
  const body = (await get(app, `/submit/${slug}/${form}`)).body;

  for (const match of body.matchAll(/<select id="f_([a-z-]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option value="([^"]*)"/g)]
      .map((m) => m[1]).filter(Boolean);
    assert.ok(options.length > 0, `the '${match[1]}' dropdown rendered with no choices`);
  }
});

test('a dropdown with nowhere to get choices from is refused when it is added', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);

  const err = await failure(post(app, `/e/${slug}/forms/${form}/fields`, {
    label: 'Audience level', field_type: 'select', section: 'abstract',
  }));
  assert.match(err.message, /needs somewhere to get its choices from/);
  assert.match(err.hint, /Track, Format, Level, or Language/);
});

test('a custom question is added and appears on the public form', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);

  await post(app, `/e/${slug}/forms/${form}/fields`, {
    label: 'Key takeaway', field_type: 'text', section: 'abstract',
    required: '1', max_chars: '200', help_text: 'One sentence.',
  });

  const body = (await get(app, `/submit/${slug}/${form}`)).body;
  assert.match(body, /Key takeaway/);
  assert.match(body, /maxlength="200"/);
  assert.match(body, /One sentence\./);
});

test('an answer to a custom question is stored against the submission', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);
  await post(app, `/e/${slug}/forms/${form}/fields`, {
    label: 'Key takeaway', field_type: 'text', section: 'abstract', required: '1',
  });

  await post(app, `/submit/${slug}/${form}`, {
    title: 'Taming CI', description: 'Faster builds.',
    track: 'ai-engineering', format: 'talk-30-min',
    'first-name': 'Priya', 'last-name': 'Raman', email: 'priya@example.com',
    biography: 'Engineer.', 'key-takeaway': 'A decision framework.',
  });

  const answer = app.db.prepare(
    `SELECT sa.value FROM submission_answer sa JOIN form_field ff ON ff.id = sa.field_id
      WHERE ff.slug = 'key-takeaway'`,
  ).get();
  assert.equal(answer.value, 'A decision framework.');
});

test('a locked question cannot be removed', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);

  const err = await failure(post(app, `/e/${slug}/forms/${form}/fields/title/delete`));
  assert.match(err.message, /cannot be removed/);
  assert.match(err.hint, /rest of the app reads this answer/);
  assert.ok(app.db.prepare("SELECT 1 FROM form_field WHERE slug = 'title'").get());
});

test('an unlocked question can be removed', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);
  await post(app, `/e/${slug}/forms/${form}/fields`,
    { label: 'Key takeaway', field_type: 'text', section: 'abstract' });

  await post(app, `/e/${slug}/forms/${form}/fields/key-takeaway/delete`);
  assert.equal(app.db.prepare("SELECT 1 FROM form_field WHERE slug = 'key-takeaway'").get(), undefined);
});

test('questions can be reordered, and the public form follows', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);

  const order = () => app.db.prepare(
    "SELECT slug FROM form_field WHERE section = 'abstract' ORDER BY sort_order, id",
  ).all().map((f) => f.slug);

  const before = order();
  await post(app, `/e/${slug}/forms/${form}/fields/${before[1]}/move`, { direction: 'up' });
  const after = order();

  assert.equal(after[0], before[1]);
  assert.equal(after[1], before[0]);

  const body = (await get(app, `/submit/${slug}/${form}`)).body;
  assert.ok(body.indexOf(`f_${after[0]}`) < body.indexOf(`f_${after[1]}`),
    'the public form renders in the new order');
});

test('moving the first question up is a no-op rather than an error', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);
  const first = app.db.prepare(
    "SELECT slug FROM form_field WHERE section = 'abstract' ORDER BY sort_order, id").get().slug;

  const response = await post(app, `/e/${slug}/forms/${form}/fields/${first}/move`, { direction: 'up' });
  assert.equal(response.status, 303);
  assert.equal(app.db.prepare(
    "SELECT slug FROM form_field WHERE section = 'abstract' ORDER BY sort_order, id").get().slug, first);
});

test('a conditional question is recorded and described back', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);
  await post(app, `/e/${slug}/forms/${form}/fields`,
    { label: 'Workshop prerequisites', field_type: 'textarea', section: 'abstract' });

  await post(app, `/e/${slug}/forms/${form}/conditions`, {
    field_id: 'workshop-prerequisites', when_field_id: 'format',
    operator: 'equals', value: 'workshop-120-min',
  });

  const page = (await get(app, `/e/${slug}/forms/${form}`)).body;
  assert.match(page, /Workshop prerequisites/);
  assert.match(page, /Format equals/);
});

test('a question cannot be made conditional on itself', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);
  await post(app, `/e/${slug}/forms/${form}/fields`,
    { label: 'Key takeaway', field_type: 'text', section: 'abstract' });

  const err = await failure(post(app, `/e/${slug}/forms/${form}/conditions`, {
    field_id: 'key-takeaway', when_field_id: 'key-takeaway', operator: 'equals', value: 'x',
  }));
  assert.match(err.message, /cannot depend on itself/);
});

test('a close date in the past shuts the public form', async () => {
  const app = newApp();
  const { slug, form } = await eventWithForm(app);

  await post(app, `/e/${slug}/forms/${form}/settings`, {
    internal_name: 'CFP 2027 (main round)', close_at: '2020-01-01',
  });

  const body = (await get(app, `/submit/${slug}/${form}`)).body;
  assert.match(body, /closed/i);

  const err = await failure(post(app, `/submit/${slug}/${form}`, {
    title: 'Too late', description: 'x', 'first-name': 'A', 'last-name': 'B',
    email: 'a@example.com', biography: 'y', track: 'ai-engineering', format: 'talk-30-min',
  }));
  assert.match(err.message, /has closed/);
});

test('a close date today still lets somebody submit', async () => {
  // "Closes on the 30th" has to mean the 30th is usable, or every deadline is
  // secretly a day earlier than it says.
  const app = newApp();
  const { slug, form } = await eventWithForm(app);
  const today = new Date().toISOString().slice(0, 10);

  await post(app, `/e/${slug}/forms/${form}/settings`,
    { internal_name: 'CFP', close_at: today });

  const response = await post(app, `/submit/${slug}/${form}`, {
    title: 'Just in time', description: 'x', 'first-name': 'A', 'last-name': 'B',
    email: 'a@example.com', biography: 'y', track: 'ai-engineering', format: 'talk-30-min',
  });

  // The response is either a redirect into the portal or a thank-you page,
  // depending on the form's auto-redirect setting. What matters is that the
  // proposal was accepted rather than refused as late.
  assert.ok(response.status === 303 || response.status === 200, `got ${response.status}`);
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM submission WHERE title = 'Just in time'").get().n, 1);
});

test('a settings post with an unticked box turns that setting off', async () => {
  // Standard form semantics: a checkbox that is not sent is off. Worth pinning,
  // because the alternative -- only updating what was sent -- would make it
  // impossible to ever untick anything.
  const app = newApp();
  const { slug, form } = await eventWithForm(app);

  await post(app, `/e/${slug}/forms/${form}/settings`,
    { internal_name: 'CFP', send_confirmation_email: '1' });
  assert.equal(app.db.prepare('SELECT send_confirmation_email AS enabled FROM form WHERE slug = ?').get(form).enabled, 1);

  await post(app, `/e/${slug}/forms/${form}/settings`, { internal_name: 'CFP' });
  assert.equal(app.db.prepare('SELECT send_confirmation_email AS enabled FROM form WHERE slug = ?').get(form).enabled, 0);
});

test('two forms can run at once with different deadlines', async () => {
  const app = newApp();
  const { slug } = await eventWithForm(app);
  const second = redirectedTo(await post(app, `/e/${slug}/forms`, {
    internal_name: 'Lightning round', with_defaults: '1',
  })).split('/').pop();

  await post(app, `/e/${slug}/forms/${second}/settings`,
    { internal_name: 'Lightning round', close_at: '2020-01-01' });

  assert.match((await get(app, `/submit/${slug}/cfp-2027-main-round`)).body, /Your proposal/);
  assert.match((await get(app, `/submit/${slug}/${second}`)).body, /closed/i);
});
