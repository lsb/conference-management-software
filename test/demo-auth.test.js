import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersonByEmail, demoLoginIsOpen } from '../src/routes/demo-auth.js';
import { newEvent, addPerson } from './helpers.js';

/**
 * The fixture as it exists once both seeds have run: the four DevFlow people,
 * plus the Manzanita people whose first names collide with two of them. The
 * collisions are the point -- they are why the alias table cannot be a rule.
 */
function seeded() {
  const { db } = newEvent();
  const people = {
    jordan: addPerson(db, { first: 'Jordan', last: 'Alvarez', email: 'sbek-organizer@example.com' }),
    priya: addPerson(db, { first: 'Priya', last: 'Raman', email: 'sbek-speaker@example.com' }),
    marcus: addPerson(db, { first: 'Marcus', last: 'Okafor', email: 'sbek-speaker2@example.com' }),
    sam: addPerson(db, { first: 'Sam', last: 'Whitfield', email: 'sbek-reviewer@example.com' }),

    otherPriya: addPerson(db, { first: 'Priya', last: 'Raghunathan', email: 'priya.raghunathan@example.com' }),
    otherMarcus: addPerson(db, { first: 'Marcus', last: 'Bell', email: 'marcus.bell@example.com' }),
  };
  return { db, people };
}

const countPeople = (db) => db.prepare('SELECT count(*) AS n FROM person').get().n;

test('the address a person was seeded with finds them', () => {
  const { db, people } = seeded();
  assert.equal(resolvePersonByEmail(db, 'sbek-speaker@example.com').id, people.priya.id);
});

test('an address is matched without regard to case', () => {
  const { db, people } = seeded();
  assert.equal(resolvePersonByEmail(db, 'SBEK-Reviewer@Example.com').id, people.sam.id);
});

test('surrounding whitespace does not stop a match', () => {
  const { db, people } = seeded();
  assert.equal(resolvePersonByEmail(db, '  sbek-organizer@example.com  ').id, people.jordan.id);
});

test('both documented spellings of an address reach the same person', () => {
  const { db, people } = seeded();
  const pairs = [
    ['sbek-organizer@example.com', 'jordan.organizer@sbek-test.example.com', people.jordan],
    ['sbek-speaker@example.com', 'priya.speaker@sbek-test.example.com', people.priya],
    ['sbek-speaker2@example.com', 'marcus.speaker@sbek-test.example.com', people.marcus],
    ['sbek-reviewer@example.com', 'sam.reviewer@sbek-test.example.com', people.sam],
  ];

  for (const [canonical, alias, expected] of pairs) {
    assert.equal(resolvePersonByEmail(db, canonical).id, expected.id, canonical);
    assert.equal(resolvePersonByEmail(db, alias).id, expected.id, alias);
  }
});

test('the alias table wins over a first name two people share', () => {
  const { db, people } = seeded();

  // Without the table, 'priya.speaker@...' shortens to "priya", and this
  // instance has two of those. The table is what makes the answer definite.
  assert.equal(resolvePersonByEmail(db, 'priya.speaker@sbek-test.example.com').id, people.priya.id);
  assert.equal(resolvePersonByEmail(db, 'marcus.speaker@sbek-test.example.com').id, people.marcus.id);
});

test('an unlisted address still resolves when its first word names one person', () => {
  const { db, people } = seeded();
  assert.equal(resolvePersonByEmail(db, 'jordan.alvarez@some-other-domain.test').id, people.jordan.id);
  assert.equal(resolvePersonByEmail(db, 'jordan-organizer@elsewhere.test').id, people.jordan.id);
});

test('an ambiguous first word resolves to nobody rather than to a guess', () => {
  const { db } = seeded();

  // Two Priyas, two Marcuses, and 'sbek' is the front of all four fixture
  // addresses. Signing somebody in as the wrong person is worse than not
  // signing them in.
  assert.equal(resolvePersonByEmail(db, 'priya.raman@unknown.test'), null);
  assert.equal(resolvePersonByEmail(db, 'marcus@unknown.test'), null);
  assert.equal(resolvePersonByEmail(db, 'sbek@unknown.test'), null);
});

test('an unknown address resolves to nobody', () => {
  const { db } = seeded();
  for (const address of ['nobody@example.com', '', null, undefined, '   ', '@example.com']) {
    assert.equal(resolvePersonByEmail(db, address), null, JSON.stringify(address));
  }
});

test('resolving never creates a person', () => {
  const { db } = seeded();
  const before = countPeople(db);

  for (const address of [
    'sbek-speaker@example.com', 'priya.speaker@sbek-test.example.com',
    'sam.reviewer@sbek-test.example.com', 'nobody@example.com',
  ]) {
    resolvePersonByEmail(db, address);
  }

  assert.equal(countPeople(db), before,
    'both spellings of an address are one person, and a stranger is none');
});

test('demo sign-in is open on loopback and closed anywhere else', () => {
  assert.equal(demoLoginIsOpen({ flag: undefined, host: '127.0.0.1' }), true);
  assert.equal(demoLoginIsOpen({ flag: undefined, host: 'localhost' }), true);
  assert.equal(demoLoginIsOpen({ flag: undefined, host: '::1' }), true);
  assert.equal(demoLoginIsOpen({ flag: undefined, host: '0.0.0.0' }), false);
  assert.equal(demoLoginIsOpen({ flag: undefined, host: '10.0.0.4' }), false);
});

test('DEMO_LOGIN decides it either way when it is set', () => {
  assert.equal(demoLoginIsOpen({ flag: '1', host: '0.0.0.0' }), true);
  assert.equal(demoLoginIsOpen({ flag: '0', host: '127.0.0.1' }), false);
});
