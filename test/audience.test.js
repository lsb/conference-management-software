import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIENCES, resolveAudience, audienceSizes, UnknownAudienceError } from '../src/core/audience.js';
import { createSubmission, decide, notify, setStatus } from '../src/core/submissions.js';
import { renderTemplate, templateVariables } from '../src/core/mail.js';
import { newEvent, addPerson, addSpeaker, addTaskDefinition } from './helpers.js';

/** One person per interesting state, so every audience has something to find. */
function populated() {
  const { db, event } = newEvent();
  const people = {};
  const make = (key, status, { notifyIt = false } = {}) => {
    const person = addPerson(db, { first: key, last: 'Person', email: `${key}@example.com` });
    const sub = createSubmission(db, { eventId: event.id, title: `Talk by ${key}`, status: 'draft' });
    addSpeaker(db, sub.id, person.id, { primary: true });
    if (status !== 'draft') setStatus(db, sub.id, 'pending');
    if (status === 'accepted') decide(db, [sub.id], 'accept');
    if (status === 'declined') decide(db, [sub.id], 'decline');
    if (notifyIt) notify(db, [sub.id]);
    people[key] = { person, sub };
  };

  addTaskDefinition(db, event.id, { slug: 'headshot', title: 'Headshot',
    appliesTo: 'person', requirement: 'file' });

  make('drafter', 'draft');
  make('waiting', 'pending');
  make('winner', 'accepted', { notifyIt: true });
  make('loser', 'declined', { notifyIt: true });
  make('queued', 'accepted');   // decided, deliberately NOT notified

  return { db, event, people };
}

test('every declared audience resolves', () => {
  const { db, event } = populated();
  for (const audience of AUDIENCES) {
    assert.doesNotThrow(() => resolveAudience(db, event.id, audience.key), audience.key);
  }
});

test('an unknown audience names the valid ones', () => {
  const { db, event } = populated();
  try {
    resolveAudience(db, event.id, 'everyone-ever');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof UnknownAudienceError);
    assert.match(err.message, /accepted-speakers/);
    assert.match(err.hint, /all-submitters/);
  }
});

test('accepted speakers means told, not merely decided', () => {
  const { db, event } = populated();
  const emails = resolveAudience(db, event.id, 'accepted-speakers').map((p) => p.email);

  assert.deepEqual(emails, ['winner@example.com']);
  assert.ok(!emails.includes('queued@example.com'),
    'somebody in the accept queue has not been told and is not yet a speaker');
});

test('the pending audience excludes the decision queues', () => {
  // Mailing somebody whose decision is recorded but unsent, in a batch addressed
  // to people awaiting a decision, is how a decision leaks early.
  const { db, event } = populated();
  const emails = resolveAudience(db, event.id, 'pending-submitters').map((p) => p.email);

  assert.deepEqual(emails, ['waiting@example.com']);
  assert.ok(!emails.includes('queued@example.com'));
});

test('declined means told they were declined', () => {
  const { db, event } = populated();
  assert.deepEqual(
    resolveAudience(db, event.id, 'declined-submitters').map((p) => p.email),
    ['loser@example.com'],
  );
});

test('the outstanding-task audience can be narrowed to one task', () => {
  const { db, event } = populated();
  addTaskDefinition(db, event.id, { slug: 'agreement', title: 'Agreement',
    appliesTo: 'person', requirement: 'acknowledge' });

  const all = resolveAudience(db, event.id, 'outstanding-tasks');
  assert.deepEqual(all.map((p) => p.email), ['winner@example.com'],
    'only the notified acceptance has tasks assigned');

  const headshots = resolveAudience(db, event.id, 'outstanding-tasks', { taskSlug: 'headshot' });
  assert.deepEqual(headshots.map((p) => p.email), ['winner@example.com']);

  const nothing = resolveAudience(db, event.id, 'outstanding-tasks', { taskSlug: 'agreement' });
  assert.deepEqual(nothing, [], 'a task added after acceptance is not retroactively owed');
});

test('a person appears once however many submissions they have', () => {
  const { db, event, people } = populated();
  const second = createSubmission(db, { eventId: event.id, title: 'Another', status: 'pending' });
  addSpeaker(db, second.id, people.waiting.person.id, { primary: true });

  const emails = resolveAudience(db, event.id, 'pending-submitters').map((p) => p.email);
  assert.deepEqual(emails, ['waiting@example.com'], 'deduplicated, not sent twice');
});

test('audienceSizes reports a count for every audience', () => {
  const { db, event } = populated();
  const sizes = audienceSizes(db, event.id);
  assert.equal(sizes.length, AUDIENCES.length);
  assert.ok(sizes.every((s) => typeof s.count === 'number' && s.label && s.description));
  assert.equal(sizes.find((s) => s.key === 'all-submitters').count, 5);
});

test('an unknown placeholder survives rendering so it can be spotted', () => {
  const rendered = renderTemplate('Hi {{first_name}}, see {{portal_url}} and {{typo_here}}',
    { first_name: 'Ada', portal_url: 'http://x' });

  assert.equal(rendered, 'Hi Ada, see http://x and {{typo_here}}');
  assert.deepEqual(templateVariables(rendered), ['typo_here'],
    'the composer can warn about exactly this before sending to everyone');
});
