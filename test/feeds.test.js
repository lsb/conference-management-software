import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeed, FEEDS, FORMATS, showsPeople } from '../src/core/feeds.js';
import { createSubmission, decide, notify } from '../src/core/submissions.js';
import { newEvent, addPerson, addSpeaker } from './helpers.js';

/** An event with two published sessions and two speakers. */
function published() {
  const { db, event } = newEvent();
  const roomId = db.prepare(
    `INSERT INTO room (event_id, slug, name) VALUES (?, 'main-stage', 'Main Stage') RETURNING id`,
  ).get(event.id).id;
  const trackId = db.prepare(
    `INSERT INTO track (event_id, slug, name) VALUES (?, 'ai', 'AI Engineering') RETURNING id`,
  ).get(event.id).id;

  const people = [
    addPerson(db, { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' }),
    addPerson(db, { first: 'Grace', last: 'Hopper', email: 'grace@example.com' }),
  ];
  db.prepare("UPDATE person SET job_title = 'Principal Engineer', company = 'Latticework' WHERE id = ?")
    .run(people[0].id);

  const times = [
    ['2026-10-12T16:00:00Z', '2026-10-12T16:45:00Z'],
    ['2026-10-12T17:00:00Z', '2026-10-12T17:45:00Z'],
  ];

  people.forEach((person, i) => {
    const sub = createSubmission(db, {
      eventId: event.id, title: `Talk ${i + 1} & friends`,
      description: 'A description with <angle> brackets and "quotes".', status: 'pending',
      trackId,
    });
    addSpeaker(db, sub.id, person.id, { primary: true });
    decide(db, [sub.id], 'accept');
    notify(db, [sub.id]);
    db.prepare(
      `UPDATE submission SET room_id = ?, starts_at = ?, ends_at = ?,
                             published = 1, content_status = 'approved' WHERE id = ?`,
    ).run(roomId, times[i][0], times[i][1], sub.id);
  });

  return { db, event, trackId };
}

function embedFor(overrides = {}) {
  return {
    slug: 'feed', name: 'Feed', feed: 'agenda', format: 'html', enabled: 1,
    filter_track_id: null, include_description: 1, include_speakers: 1,
    include_room: 1, accent_color: '', ...overrides,
  };
}

test('every declared feed renders in every declared format', () => {
  const { db, event } = published();
  for (const feed of FEEDS) {
    for (const format of FORMATS) {
      // A calendar of people is refused at configuration time, not here.
      if (format.value === 'ics' && showsPeople(feed.value)) continue;
      const out = renderFeed(db, event, embedFor({ feed: feed.value, format: format.value }));
      assert.ok(out.body.length > 0, `${feed.value} as ${format.value} rendered nothing`);
      assert.equal(out.contentType, format.type);
    }
  }
});

test('JSON is valid and carries the event and its sessions', () => {
  const { db, event } = published();
  const { body } = renderFeed(db, event, embedFor({ format: 'json' }));
  const parsed = JSON.parse(body);

  assert.equal(parsed.event.slug, event.slug);
  assert.equal(parsed.sessions.length, 2);
  assert.equal(parsed.sessions[0].code, 'SESS-1');
  assert.equal(parsed.sessions[0].room, 'Main Stage');
  assert.equal(parsed.sessions[0].speakers[0].name, 'Ada Lovelace');
  assert.equal(parsed.sessions[0].speakers[0].company, 'Latticework');
});

test('field options actually remove fields', () => {
  const { db, event } = published();
  const bare = JSON.parse(renderFeed(db, event, embedFor({
    format: 'json', include_description: 0, include_speakers: 0, include_room: 0,
  })).body);

  assert.equal(bare.sessions[0].description, undefined);
  assert.equal(bare.sessions[0].speakers, undefined);
  assert.equal(bare.sessions[0].room, undefined);
  assert.equal(bare.sessions[0].title, 'Talk 1 & friends', 'the title always survives');
});

test('a track filter narrows the feed', () => {
  const { db, event, trackId } = published();
  const other = db.prepare(
    `INSERT INTO track (event_id, slug, name) VALUES (?, 'other', 'Other') RETURNING id`,
  ).get(event.id).id;

  assert.equal(JSON.parse(renderFeed(db, event, embedFor({ format: 'json', filter_track_id: trackId })).body)
    .sessions.length, 2);
  assert.equal(JSON.parse(renderFeed(db, event, embedFor({ format: 'json', filter_track_id: other })).body)
    .sessions.length, 0);
});

test('XML is well formed even with characters that would break it', () => {
  const { db, event } = published();
  const { body } = renderFeed(db, event, embedFor({ format: 'xml' }));

  // Titles contain '&' and descriptions contain angle brackets and quotes.
  assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(body, /Talk 1 &amp; friends/);
  assert.doesNotMatch(body, /<angle>/, 'raw angle brackets would break the document');

  // Balanced tags, checked by counting rather than by eye.
  const opens = (body.match(/<session /g) ?? []).length;
  const closes = (body.match(/<\/session>/g) ?? []).length;
  assert.equal(opens, closes);
  assert.equal(opens, 2);
});

test('a speaker feed renders people, not sessions', () => {
  const { db, event } = published();
  const parsed = JSON.parse(renderFeed(db, event, embedFor({ feed: 'speaker_list', format: 'json' })).body);

  assert.equal(parsed.sessions, undefined);
  assert.equal(parsed.speakers.length, 2);
  assert.deepEqual(parsed.speakers.map((p) => p.name), ['Grace Hopper', 'Ada Lovelace'],
    'ordered by surname');
  assert.equal(parsed.speakers[1].sessions.length, 1);
});

test('the calendar holds one event per session, correctly folded', () => {
  const { db, event } = published();
  const { body } = renderFeed(db, event, embedFor({ format: 'ics' }));

  assert.match(body, /^BEGIN:VCALENDAR\r\n/);
  assert.match(body, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(body, /X-WR-CALNAME:Conf 2026/);
  assert.equal((body.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.equal((body.match(/END:VCALENDAR/g) ?? []).length, 1, 'one calendar, not two concatenated');

  for (const line of body.split('\r\n')) {
    assert.ok(Buffer.from(line, 'utf8').length <= 75, `line too long: ${line}`);
  }
});

test('calendar UIDs match the invites speakers already have', () => {
  // So somebody who is both a speaker and an attendee gets one entry, not two.
  const { db, event } = published();
  const { body } = renderFeed(db, event, embedFor({ format: 'ics' }));
  assert.match(body, /UID:sess-1\.conf-2026@conference-management\.local/);
});

test('an empty feed still produces something valid', () => {
  const { db, event } = newEvent();

  const json = JSON.parse(renderFeed(db, event, embedFor({ format: 'json' })).body);
  assert.deepEqual(json.sessions, []);

  const ics = renderFeed(db, event, embedFor({ format: 'ics' })).body;
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /END:VCALENDAR/);
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);

  assert.match(renderFeed(db, event, embedFor({ format: 'html' })).body, /Nothing published yet/);
});

test('unapproved or unpublished sessions stay out of every feed', () => {
  const { db, event } = published();
  db.prepare("UPDATE submission SET content_status = 'draft' WHERE code = 'SESS-1'").run();

  const parsed = JSON.parse(renderFeed(db, event, embedFor({ format: 'json' })).body);
  assert.deepEqual(parsed.sessions.map((s) => s.code), ['SESS-2']);
});

test('HTML escapes what it interpolates', () => {
  const { db, event } = published();
  db.prepare("UPDATE submission SET title = ? WHERE code = 'SESS-1'")
    .run('<script>alert(1)</script>');

  const { body } = renderFeed(db, event, embedFor({ format: 'html' }));
  assert.doesNotMatch(body, /<script>alert/);
  assert.match(body, /&lt;script&gt;/);
});
