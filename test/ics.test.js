import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, uidFor, nextSequence, sendCalendarInvite } from '../src/core/ics.js';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { newEvent, addPerson, addSpeaker, outboxFor } from './helpers.js';

/** An accepted, notified, scheduled session with one speaker. */
function scheduledSession({ schedule = true } = {}) {
  const { db, event } = newEvent();
  const person = addPerson(db);
  db.prepare(`INSERT INTO event_membership (event_id, person_id, role) VALUES (?, ?, 'owner')`)
    .run(event.id, person.id);

  const roomId = db.prepare(
    `INSERT INTO room (event_id, slug, name, capacity) VALUES (?, 'redwood', 'Redwood Hall', 300) RETURNING id`,
  ).get(event.id).id;

  const sub = createSubmission(db, { eventId: event.id, title: 'A talk', status: 'pending' });
  addSpeaker(db, sub.id, person.id, { primary: true });
  decide(db, [sub.id], 'accept');
  notify(db, [sub.id]);

  if (schedule) {
    db.prepare('UPDATE submission SET room_id = ?, starts_at = ?, ends_at = ? WHERE id = ?')
      .run(roomId, '2026-10-12T16:00:00Z', '2026-10-12T16:45:00Z', sub.id);
  }
  return { db, event, person, sub };
}

test('a UID is stable and derived from things that never change', () => {
  assert.equal(uidFor('conf-2026', 'SESS-3'), 'sess-3.conf-2026@conference-management.local');
  assert.equal(uidFor('conf-2026', 'SESS-3'), uidFor('conf-2026', 'SESS-3'));
  assert.notEqual(uidFor('conf-2026', 'SESS-3'), uidFor('conf-2027', 'SESS-3'));
});

test('the calendar body is well formed', () => {
  const ics = buildIcs({
    uid: 'x@y', title: 'A talk', startsAt: '2026-10-12T16:00:00Z', endsAt: '2026-10-12T16:45:00Z',
    location: 'Redwood Hall', stampedAt: '2026-08-09T00:00:00Z',
    organizer: { name: 'Ada Lovelace', email: 'ada@example.com' },
    attendees: [{ name: 'Grace Hopper', email: 'grace@example.com' }],
  });

  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(ics, /\r\nDTSTART:20261012T160000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20261012T164500Z\r\n/);
  assert.match(ics, /\r\nSEQUENCE:0\r\n/);
  assert.match(ics, /METHOD:REQUEST/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.from(l, 'utf8').length <= 75),
    'every line fits in 75 octets');

  // The ATTENDEE property is longer than 75 octets, so it arrives folded. Read
  // it the way a calendar client does: unfold, then look.
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /ATTENDEE;CN=Grace Hopper;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:grace@example\.com/);
  assert.match(unfolded, /ORGANIZER;CN=Ada Lovelace:mailto:ada@example\.com/);
});

test('structural characters in a title are escaped, not emitted raw', () => {
  const ics = buildIcs({
    uid: 'x@y', title: 'Testing, debugging; and other arts\\crafts',
    startsAt: '2026-10-12T16:00:00Z', endsAt: '2026-10-12T16:45:00Z',
    stampedAt: '2026-08-09T00:00:00Z',
  });
  assert.match(ics, /SUMMARY:Testing\\, debugging\\; and other arts\\\\crafts/);
});

test('a long line folds without corrupting multi-byte characters', () => {
  const title = 'Wie man Modelle zuverlässig überwacht — ein Erfahrungsbericht über sehr lange Titel mit Umlauten';
  const ics = buildIcs({
    uid: 'x@y', title, startsAt: '2026-10-12T16:00:00Z', endsAt: '2026-10-12T16:45:00Z',
    stampedAt: '2026-08-09T00:00:00Z',
  });

  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.from(line, 'utf8').length <= 75, `line too long: ${line}`);
  }
  // Unfolding restores exactly what went in, umlauts intact.
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(`SUMMARY:${title}`), 'unfolds back to the original title');
});

test('rescheduling reuses the UID and increments SEQUENCE', () => {
  const { db, event, sub } = scheduledSession();

  const first = sendCalendarInvite(db, sub.id);
  assert.equal(first.sequence, 0);

  db.prepare('UPDATE submission SET starts_at = ?, ends_at = ? WHERE id = ?')
    .run('2026-10-13T18:00:00Z', '2026-10-13T18:45:00Z', sub.id);
  const second = sendCalendarInvite(db, sub.id);

  assert.equal(second.uid, first.uid, 'same UID, so the calendar updates its entry');
  assert.equal(second.sequence, 1, 'higher SEQUENCE, so the update is not ignored as stale');

  const invites = outboxFor(db, { kind: 'calendar_invite' });
  assert.equal(invites.length, 2);
  assert.deepEqual(invites.map((m) => m.ics_sequence), [0, 1]);
  assert.equal(new Set(invites.map((m) => m.ics_uid)).size, 1);
  assert.match(invites[1].ics_body, /DTSTART:20261013T180000Z/);
  assert.match(invites[1].subject, /Updated time/);
});

test('nextSequence continues from what was actually sent', () => {
  const { db, sub } = scheduledSession();
  assert.equal(nextSequence(db, sub.id), 0);
  sendCalendarInvite(db, sub.id);
  assert.equal(nextSequence(db, sub.id), 1);
});

test('a cancellation is a CANCEL at the same UID', () => {
  const { db, sub } = scheduledSession();
  sendCalendarInvite(db, sub.id);
  const cancelled = sendCalendarInvite(db, sub.id, { method: 'CANCEL' });

  const [, invite] = outboxFor(db, { kind: 'calendar_invite' });
  assert.equal(cancelled.method, 'CANCEL');
  assert.match(invite.ics_body, /METHOD:CANCEL/);
  assert.match(invite.ics_body, /STATUS:CANCELLED/);
  assert.match(invite.subject, /^Cancelled:/);
});

test('an unscheduled session generates no invite', () => {
  const { db, sub } = scheduledSession({ schedule: false });
  assert.equal(sendCalendarInvite(db, sub.id), null);
  assert.equal(outboxFor(db, { kind: 'calendar_invite' }).length, 0);
});

test('a speaker who has not been told they are in gets no calendar hold', () => {
  // A calendar entry appearing for a talk somebody does not know they are giving
  // would leak the decision, which is exactly what the two-step flow prevents.
  const { db, event } = newEvent();
  const person = addPerson(db);
  const sub = createSubmission(db, { eventId: event.id, title: 'A talk', status: 'pending' });
  addSpeaker(db, sub.id, person.id, { primary: true });
  decide(db, [sub.id], 'accept');   // decided, deliberately not notified
  db.prepare('UPDATE submission SET starts_at = ?, ends_at = ? WHERE id = ?')
    .run('2026-10-12T16:00:00Z', '2026-10-12T16:45:00Z', sub.id);

  assert.equal(sendCalendarInvite(db, sub.id), null);
  assert.equal(outboxFor(db, { kind: 'calendar_invite' }).length, 0);
});
