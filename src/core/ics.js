// Calendar invites.
//
// The requirement is invites landing in "Gmail, Outlook, iCal". All three
// consume iCalendar, so this generates one `.ics` rather than three OAuth
// integrations that would take weeks and end up in the same place.
//
// The part that actually matters, and the part naive implementations get wrong:
// a rescheduled session must UPDATE the entry already in the speaker's calendar
// rather than add a second one. That requires keeping the same UID for the life
// of the session and incrementing SEQUENCE on every change. Get that wrong and
// a speaker with three schedule changes has four calendar entries and no idea
// which is real.

import { queueEmail } from './mail.js';

/**
 * The permanent identity of a session in every calendar it reaches.
 *
 * Built from the event slug and session code, both of which are stable for the
 * life of the session -- codes are never reused, even after a deletion.
 */
export function uidFor(eventSlug, code) {
  return `${code.toLowerCase()}.${eventSlug}@conference-management.local`;
}

/**
 * The next SEQUENCE for a session: one higher than any invite already sent.
 *
 * Reading it back from the outbox rather than storing a counter means the number
 * cannot drift away from what speakers actually received.
 */
export function nextSequence(db, submissionId) {
  const row = db.prepare(
    `SELECT max(ics_sequence) AS seq FROM outbox
      WHERE submission_id = ? AND kind = 'calendar_invite'`,
  ).get(submissionId);
  return row?.seq == null ? 0 : row.seq + 1;
}

/** iCalendar wants 20261012T163000Z. */
function stamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Commas, semicolons, backslashes and newlines are structural in iCalendar. */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold a content line to 75 octets, continuing with a leading space.
 *
 * Counted in octets rather than characters, because a fold that lands in the
 * middle of a multi-byte character corrupts it -- which is how accented speaker
 * names get mangled in calendar entries.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Do not split a UTF-8 sequence: back up off any continuation byte.
    while (end > start && end < bytes.length && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return parts.join('\r\n ');
}

/**
 * Render a VCALENDAR for one session.
 *
 * `method` is REQUEST for an invitation or an update, CANCEL to withdraw one.
 */
export function buildIcs({
  uid, sequence = 0, method = 'REQUEST',
  title, description = '', location = '',
  startsAt, endsAt, organizer, attendees = [], url = '', stampedAt,
}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//conference management//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${stamp(stampedAt ?? new Date().toISOString())}`,
    `DTSTART:${stamp(startsAt)}`,
    `DTEND:${stamp(endsAt)}`,
    `SUMMARY:${escapeText(title)}`,
    method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
  ];

  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (url) lines.push(`URL:${escapeText(url)}`);
  if (organizer) {
    lines.push(`ORGANIZER;CN=${escapeText(organizer.name)}:mailto:${organizer.email}`);
  }
  for (const attendee of attendees) {
    lines.push(
      `ATTENDEE;CN=${escapeText(attendee.name)};ROLE=REQ-PARTICIPANT;`
      + `PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee.email}`,
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/**
 * Send (or re-send) the calendar invite for a scheduled session.
 *
 * Returns null when there is nothing to send: an unscheduled session, or one
 * whose speakers have not been told they are in yet. Sending a calendar hold for
 * a talk somebody does not know they are giving would leak the decision.
 */
export function sendCalendarInvite(db, submissionId, { method = 'REQUEST', portalUrlFor } = {}) {
  const submission = db.prepare('SELECT * FROM submission WHERE id = ?').get(submissionId);
  if (!submission) throw new Error(`no submission with id ${submissionId}`);
  if (!submission.starts_at || !submission.ends_at) return null;
  if (submission.status !== 'accepted' || !submission.notified_at) return null;

  const event = db.prepare('SELECT * FROM event WHERE id = ?').get(submission.event_id);
  const room = submission.room_id
    ? db.prepare('SELECT name FROM room WHERE id = ?').get(submission.room_id)
    : null;

  const speakers = db.prepare(
    `SELECT p.* FROM submission_participant sp JOIN person p ON p.id = sp.person_id
      WHERE sp.submission_id = ? ORDER BY sp.sort_order`,
  ).all(submissionId);
  if (speakers.length === 0) return null;

  const organizer = db.prepare(
    `SELECT p.first_name, p.last_name, p.email FROM event_membership m
       JOIN person p ON p.id = m.person_id
      WHERE m.event_id = ? AND m.role = 'owner' LIMIT 1`,
  ).get(event.id);

  const uid = uidFor(event.slug, submission.code);
  const sequence = nextSequence(db, submissionId);

  const body = buildIcs({
    uid,
    sequence,
    method,
    title: `${submission.title} (${event.name})`,
    description: submission.description,
    location: [room?.name, event.location].filter(Boolean).join(', '),
    startsAt: submission.starts_at,
    endsAt: submission.ends_at,
    url: event.website_url,
    organizer: organizer
      ? { name: `${organizer.first_name} ${organizer.last_name}`.trim(), email: organizer.email }
      : null,
    attendees: speakers.map((p) => ({
      name: `${p.first_name} ${p.last_name}`.trim(), email: p.email,
    })),
  });

  const isCancel = method === 'CANCEL';
  const ids = [];

  for (const person of speakers) {
    ids.push(queueEmail(db, {
      eventId: event.id,
      to: person,
      subject: isCancel
        ? `Cancelled: ${submission.title} at ${event.name}`
        : `${sequence === 0 ? 'Calendar invite' : 'Updated time'}: ${submission.title} at ${event.name}`,
      body: isCancel
        ? `Hi {{first_name}},\n\n"${submission.title}" (${submission.code}) has been removed from the `
          + `${event.name} schedule. The calendar entry attached will remove it from your calendar.\n\n`
          + `- The ${event.name} team`
        : `Hi {{first_name}},\n\n${sequence === 0
            ? `Here is the calendar entry for your session at ${event.name}.`
            : `Your session at ${event.name} has moved. The attached entry updates the one already in your calendar.`}\n\n`
          + `  ${submission.code} - ${submission.title}\n`
          + `  ${submission.starts_at} to ${submission.ends_at}\n`
          + `${room ? `  ${room.name}\n` : ''}\n`
          + `- The ${event.name} team`,
      kind: 'calendar_invite',
      submissionId,
      vars: { event_name: event.name },
      ics: { uid, sequence, body },
    }));
  }

  return { uid, sequence, method, messages: ids.length };
}
