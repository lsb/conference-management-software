// The agenda, and the conflicts in it.
//
// Conflict detection is the actual feature behind "drag-and-drop scheduling".
// Dragging is an input method; being told immediately that you just put someone
// in two rooms at once is the value. So detection lives here, in plain
// functions, reachable from the UI, the API, and the CLI alike.

/** Half-open overlap: a session ending at 10:00 does not clash with one starting at 10:00. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** Every scheduled session for an event, with the names needed to describe it. */
export function scheduledSessions(db, eventId) {
  return db.prepare(
    `SELECT s.id, s.code, s.title, s.starts_at, s.ends_at, s.status, s.published,
            s.room_id, r.name AS room_name, r.slug AS room_slug, r.capacity AS room_capacity,
            s.track_id, t.name AS track_name, t.slug AS track_slug
       FROM submission s
       LEFT JOIN room r  ON r.id = s.room_id
       LEFT JOIN track t ON t.id = s.track_id
      WHERE s.event_id = ?
        AND s.status IN ('accept_queue', 'accepted')
        AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
      ORDER BY s.starts_at, r.sort_order, s.code`,
  ).all(eventId);
}

/** Accepted sessions with no time yet. This is a dashboard warning, not an error. */
export function unscheduledSessions(db, eventId) {
  return db.prepare(
    `SELECT s.id, s.code, s.title, s.status
       FROM submission s
      WHERE s.event_id = ? AND s.status IN ('accept_queue', 'accepted')
        AND (s.starts_at IS NULL OR s.ends_at IS NULL OR s.room_id IS NULL)
      ORDER BY s.code`,
  ).all(eventId);
}

/**
 * Everything wrong with the current schedule.
 *
 * Three kinds, in the order an organizer cares about them:
 *
 *   speaker_double_booked  someone is due on two stages at once. Unfixable on
 *                          the day, so it outranks everything else.
 *   room_double_booked     two sessions in one room.
 *   track_collision        two sessions on the same track at the same time. Not
 *                          an error -- some programmes do this deliberately --
 *                          but an attendee following that track has to choose,
 *                          so it is worth surfacing.
 *
 * Also reported, separately, are sessions that are over their room's capacity
 * and sessions that fall outside the event's own dates.
 */
export function findConflicts(db, eventId) {
  const sessions = scheduledSessions(db, eventId);
  const conflicts = [];

  const speakersBySession = new Map();
  for (const s of sessions) {
    speakersBySession.set(s.id, db.prepare(
      `SELECT p.id, p.slug, p.first_name, p.last_name
         FROM submission_participant sp JOIN person p ON p.id = sp.person_id
        WHERE sp.submission_id = ?`,
    ).all(s.id));
  }

  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (!overlaps(a.starts_at, a.ends_at, b.starts_at, b.ends_at)) continue;

      const shared = speakersBySession.get(a.id)
        .filter((p) => speakersBySession.get(b.id).some((q) => q.id === p.id));

      for (const person of shared) {
        conflicts.push({
          kind: 'speaker_double_booked',
          severity: 'error',
          sessions: [a.code, b.code],
          detail: `${person.first_name} ${person.last_name} is scheduled for both `
            + `${a.code} and ${b.code} at overlapping times`,
          person: person.slug,
        });
      }

      if (a.room_id && a.room_id === b.room_id) {
        conflicts.push({
          kind: 'room_double_booked',
          severity: 'error',
          sessions: [a.code, b.code],
          detail: `${a.room_name} holds both ${a.code} and ${b.code} at overlapping times`,
          room: a.room_slug,
        });
      }

      if (a.track_id && a.track_id === b.track_id && a.room_id !== b.room_id) {
        conflicts.push({
          kind: 'track_collision',
          severity: 'warning',
          sessions: [a.code, b.code],
          detail: `${a.track_name} runs ${a.code} and ${b.code} at the same time, `
            + 'so an attendee following that track has to choose',
          track: a.track_slug,
        });
      }
    }
  }

  const event = db.prepare('SELECT starts_at, ends_at FROM event WHERE id = ?').get(eventId);
  for (const s of sessions) {
    if (event?.starts_at && event?.ends_at
        && (s.starts_at < event.starts_at || s.ends_at > event.ends_at)) {
      conflicts.push({
        kind: 'outside_event_dates',
        severity: 'warning',
        sessions: [s.code],
        detail: `${s.code} is scheduled outside the event's own dates`,
      });
    }
  }

  const order = { error: 0, warning: 1 };
  return conflicts.sort((a, b) => order[a.severity] - order[b.severity]
    || a.kind.localeCompare(b.kind));
}

/**
 * Check a proposed time before committing to it.
 *
 * Same logic as `findConflicts`, asked prospectively, so the scheduling form can
 * refuse a move rather than accept it and then complain. `ignoreId` excludes the
 * session being moved from colliding with its own current slot.
 */
export function conflictsForSlot(db, eventId, { submissionId, roomId, startsAt, endsAt }) {
  const problems = [];
  if (!startsAt || !endsAt) return problems;
  if (startsAt >= endsAt) {
    problems.push({ kind: 'invalid_times', severity: 'error',
      detail: 'a session has to end after it starts' });
    return problems;
  }

  const others = scheduledSessions(db, eventId).filter((s) => s.id !== submissionId);
  const speakers = db.prepare(
    'SELECT person_id FROM submission_participant WHERE submission_id = ?',
  ).all(submissionId).map((r) => r.person_id);

  for (const other of others) {
    if (!overlaps(startsAt, endsAt, other.starts_at, other.ends_at)) continue;

    if (roomId && other.room_id === roomId) {
      problems.push({ kind: 'room_double_booked', severity: 'error', sessions: [other.code],
        detail: `${other.room_name} already holds ${other.code} then` });
    }

    const otherSpeakers = db.prepare(
      'SELECT person_id FROM submission_participant WHERE submission_id = ?',
    ).all(other.id).map((r) => r.person_id);

    for (const id of speakers) {
      if (!otherSpeakers.includes(id)) continue;
      const p = db.prepare('SELECT first_name, last_name FROM person WHERE id = ?').get(id);
      problems.push({ kind: 'speaker_double_booked', severity: 'error', sessions: [other.code],
        detail: `${p.first_name} ${p.last_name} is already speaking in ${other.code} then` });
    }
  }

  return problems;
}

/** Sessions grouped by day, for the day and week views. */
export function agendaByDay(db, eventId, timezone = 'UTC') {
  const byDay = new Map();
  for (const session of scheduledSessions(db, eventId)) {
    const day = localDay(session.starts_at, timezone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(session);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, sessions]) => ({ day, sessions }));
}

/**
 * Sessions grouped by track, for the track view.
 *
 * Tracks with nothing in them are still listed: an empty track is usually a
 * programming gap somebody wants to see, not noise to hide.
 */
export function agendaByTrack(db, eventId) {
  const tracks = db.prepare('SELECT * FROM track WHERE event_id = ? ORDER BY sort_order, name')
    .all(eventId);
  const sessions = scheduledSessions(db, eventId);

  const grouped = tracks.map((track) => ({
    track,
    sessions: sessions.filter((s) => s.track_id === track.id),
  }));

  const untracked = sessions.filter((s) => !s.track_id);
  if (untracked.length > 0) {
    grouped.push({ track: { name: 'No track', slug: '' }, sessions: untracked });
  }
  return grouped;
}

/**
 * A grid of days across rooms, which is what "week view" means for a conference
 * that runs three days rather than seven. Rows are time slots in the event's own
 * timezone; columns are rooms.
 */
export function agendaGrid(db, eventId, timezone = 'UTC') {
  const sessions = scheduledSessions(db, eventId);
  const rooms = db.prepare('SELECT * FROM room WHERE event_id = ? ORDER BY sort_order, name')
    .all(eventId);

  const days = [...new Set(sessions.map((s) => localDay(s.starts_at, timezone)))].sort();

  return days.map((day) => {
    const daySessions = sessions.filter((s) => localDay(s.starts_at, timezone) === day);
    const starts = [...new Set(daySessions.map((s) => s.starts_at))].sort();

    return {
      day,
      rooms,
      rows: starts.map((startsAt) => ({
        startsAt,
        time: localTime(startsAt, timezone),
        cells: rooms.map((room) =>
          daySessions.find((s) => s.starts_at === startsAt && s.room_id === room.id) ?? null),
      })),
    };
  });
}

/** Sessions grouped by room, for the rooms view. */
export function agendaByRoom(db, eventId) {
  const rooms = db.prepare('SELECT * FROM room WHERE event_id = ? ORDER BY sort_order, name')
    .all(eventId);
  const sessions = scheduledSessions(db, eventId);
  return rooms.map((room) => ({
    room,
    sessions: sessions.filter((s) => s.room_id === room.id),
  }));
}

/**
 * The slots a session could go in: each event day, each room, on the hour.
 *
 * Deliberately coarse. A conference grid is built on the hour or the half hour,
 * and offering every minute would produce a schedule no attendee could read and
 * no signage could print.
 */
export function candidateSlots(db, eventId, { fromHour = 9, toHour = 18, stepMinutes = 60 } = {}) {
  const event = db.prepare('SELECT * FROM event WHERE id = ?').get(eventId);
  if (!event?.starts_at || !event?.ends_at) return [];

  const rooms = db.prepare('SELECT * FROM room WHERE event_id = ? ORDER BY sort_order, name')
    .all(eventId);
  if (rooms.length === 0) return [];

  const days = [];
  for (let d = new Date(event.starts_at); d <= new Date(event.ends_at); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(localDay(d.toISOString(), event.timezone));
    if (days.length > 30) break;   // a conference is not a month long
  }

  const slots = [];
  for (const day of [...new Set(days)]) {
    for (let minutes = fromHour * 60; minutes < toHour * 60; minutes += stepMinutes) {
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
      const mm = String(minutes % 60).padStart(2, '0');
      for (const room of rooms) {
        slots.push({ day, time: `${hh}:${mm}`, room });
      }
    }
  }
  return slots;
}

/**
 * Place everything that has no slot yet.
 *
 * Greedy and deliberately unclever: walk the sessions longest-first, and give
 * each the first slot that does not clash. It is not an optimal timetable and
 * does not pretend to be -- it is the tedious first pass an organizer would
 * otherwise do by hand, after which they move things around by judgement we do
 * not have. Nothing it places is published; it is a draft to argue with.
 *
 * `toInstant` converts a day and a wall-clock time in the event's timezone to
 * an instant, and is injected because that conversion lives in the HTTP layer.
 */
export function autoSchedule(db, eventId, { toInstant, defaultMinutes = 45 } = {}) {
  const unscheduled = unscheduledSessions(db, eventId);
  if (unscheduled.length === 0) return [];

  const slots = candidateSlots(db, eventId);
  if (slots.length === 0) return [];

  const placed = [];
  const taken = new Set();

  for (const session of unscheduled) {
    const slot = slots.find((s) => {
      const key = `${s.day} ${s.time} ${s.room.id}`;
      if (taken.has(key)) return false;

      const startsAt = toInstant(`${s.day}T${s.time}`);
      const endsAt = new Date(Date.parse(startsAt) + defaultMinutes * 60_000)
        .toISOString().replace(/\.\d{3}Z$/, 'Z');

      return conflictsForSlot(db, eventId, {
        submissionId: session.id, roomId: s.room.id, startsAt, endsAt,
      }).filter((c) => c.severity === 'error').length === 0;
    });

    if (!slot) continue;   // nowhere free; leave it for a human

    const startsAt = toInstant(`${slot.day}T${slot.time}`);
    const endsAt = new Date(Date.parse(startsAt) + defaultMinutes * 60_000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');

    db.prepare('UPDATE submission SET room_id = ?, starts_at = ?, ends_at = ? WHERE id = ?')
      .run(slot.room.id, startsAt, endsAt, session.id);

    taken.add(`${slot.day} ${slot.time} ${slot.room.id}`);
    placed.push({ code: session.code, title: session.title, room: slot.room.name,
      day: slot.day, time: slot.time });
  }

  return placed;
}

/** The calendar date an instant falls on, in the event's own timezone. */
export function localDay(iso, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

/** A wall-clock time in the event's timezone, for display. */
export function localTime(iso, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
