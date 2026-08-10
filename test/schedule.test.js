// Placing a session, and the things that have to happen alongside it.
//
// These exist because 189 passing tests did not catch either bug they cover.
// Both were the same mistake: a second interface reimplementing a write instead
// of calling the first one, and drifting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeSession } from '../src/core/schedule.js';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { newEvent, addPerson, addSpeaker, outboxFor } from './helpers.js';

/** An accepted, notified session with one speaker, a room to put it in, and a spare room. */
function bookableSession({ notified = true } = {}) {
  const { db, event } = newEvent();
  const person = addPerson(db);
  db.prepare(`INSERT INTO event_membership (event_id, person_id, role) VALUES (?, ?, 'owner')`)
    .run(event.id, person.id);

  const room = db.prepare(
    `INSERT INTO room (event_id, slug, name, capacity) VALUES (?, 'redwood', 'Redwood Hall', 300) RETURNING id`,
  ).get(event.id);
  const other = db.prepare(
    `INSERT INTO room (event_id, slug, name, capacity) VALUES (?, 'alder', 'Alder Room', 80) RETURNING id`,
  ).get(event.id);

  const sub = createSubmission(db, { eventId: event.id, title: 'A talk', status: 'pending' });
  addSpeaker(db, sub.id, person.id, { primary: true });
  decide(db, [sub.id], 'accept');
  if (notified) notify(db, [sub.id]);

  return { db, event, person, sub, room, other };
}

const AT = { startsAt: '2026-10-12T16:00:00Z', endsAt: '2026-10-12T16:45:00Z' };
const LATER = { startsAt: '2026-10-12T18:00:00Z', endsAt: '2026-10-12T18:45:00Z' };

test('placing a session sends its speakers a calendar invite', () => {
  const { db, event, sub, room } = bookableSession();

  const result = placeSession(db, event.id, sub.id, { roomId: room.id, ...AT });

  assert.equal(result.moved, true);
  assert.deepEqual(result.clashes, []);
  assert.equal(result.invited.messages, 1);
  assert.equal(result.invited.sequence, 0);
  assert.equal(outboxFor(db, { kind: 'calendar_invite' }).length, 1);
});

test('moving it again updates the entry already in the calendar rather than adding one', () => {
  const { db, event, sub, room } = bookableSession();
  placeSession(db, event.id, sub.id, { roomId: room.id, ...AT });

  const result = placeSession(db, event.id, sub.id, { roomId: room.id, ...LATER });

  assert.equal(result.invited.sequence, 1, 'SEQUENCE must advance so calendars revise in place');
  const sent = outboxFor(db, { kind: 'calendar_invite' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].ics_uid, sent[1].ics_uid, 'the same session keeps one UID for life');
});

test('re-saving the same slot sends nothing', () => {
  const { db, event, sub, room } = bookableSession();
  placeSession(db, event.id, sub.id, { roomId: room.id, ...AT });

  const result = placeSession(db, event.id, sub.id, { roomId: room.id, ...AT });

  assert.equal(result.moved, false);
  assert.equal(result.invited, null);
  assert.equal(outboxFor(db, { kind: 'calendar_invite' }).length, 1);
});

test('a speaker who has not been told their decision gets no calendar hold', () => {
  const { db, event, sub, room } = bookableSession({ notified: false });

  const result = placeSession(db, event.id, sub.id, { roomId: room.id, ...AT });

  assert.equal(result.moved, true, 'the session still gets its slot');
  assert.equal(result.invited, null, 'but an invite would leak a decision nobody has heard');
  assert.equal(outboxFor(db, { kind: 'calendar_invite' }).length, 0);
});

test('a clash changes nothing at all', () => {
  const { db, event, person, sub, room } = bookableSession();
  placeSession(db, event.id, sub.id, { roomId: room.id, ...AT });

  // A second talk by the same speaker, at the same time, in the other room.
  const clashing = createSubmission(db, { eventId: event.id, title: 'Another talk', status: 'pending' });
  addSpeaker(db, clashing.id, person.id, { primary: true });
  decide(db, [clashing.id], 'accept');
  notify(db, [clashing.id]);

  const before = db.prepare('SELECT * FROM submission WHERE id = ?').get(clashing.id);
  const result = placeSession(db, event.id, clashing.id, { roomId: room.id, ...AT });
  const after = db.prepare('SELECT * FROM submission WHERE id = ?').get(clashing.id);

  assert.ok(result.clashes.length > 0);
  assert.equal(result.moved, false);
  assert.equal(result.invited, null);
  assert.equal(after.starts_at, before.starts_at, 'a refused move leaves the old schedule intact');
  assert.equal(after.room_id, before.room_id);
  assert.equal(outboxFor(db, { kind: 'calendar_invite' }).length, 1, 'and mails nobody');
});

test('moving a published session does not quietly unpublish it', () => {
  // The bug this covers: `published` was written on every save, so a caller who
  // moved a talk to a new time without mentioning publication took it off the
  // public agenda. Omitting the field has to mean "leave it alone".
  const { db, event, sub, room } = bookableSession();
  db.prepare(`UPDATE submission SET content_status = 'approved' WHERE id = ?`).run(sub.id);
  placeSession(db, event.id, sub.id, { roomId: room.id, ...AT, published: true });
  assert.equal(db.prepare('SELECT published FROM submission WHERE id = ?').get(sub.id).published, 1);

  placeSession(db, event.id, sub.id, { roomId: room.id, ...LATER });

  assert.equal(db.prepare('SELECT published FROM submission WHERE id = ?').get(sub.id).published, 1,
    'a reschedule that said nothing about publication must not unpublish');
});

test('publication still changes when the caller asks for it', () => {
  const { db, event, sub, room } = bookableSession();
  db.prepare(`UPDATE submission SET content_status = 'approved' WHERE id = ?`).run(sub.id);

  placeSession(db, event.id, sub.id, { roomId: room.id, ...AT, published: true });
  assert.equal(db.prepare('SELECT published FROM submission WHERE id = ?').get(sub.id).published, 1);

  placeSession(db, event.id, sub.id, { roomId: room.id, ...AT, published: false });
  assert.equal(db.prepare('SELECT published FROM submission WHERE id = ?').get(sub.id).published, 0);
});

test('placing a session stamps updated_at', () => {
  const { db, event, sub, room } = bookableSession();
  db.prepare(`UPDATE submission SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?`).run(sub.id);

  placeSession(db, event.id, sub.id, { roomId: room.id, ...AT });

  const after = db.prepare('SELECT updated_at FROM submission WHERE id = ?').get(sub.id);
  assert.notEqual(after.updated_at, '2020-01-01T00:00:00Z');
});
