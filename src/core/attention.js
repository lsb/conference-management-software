// What needs attention right now.
//
// One list, two interfaces. `conf status` and `GET /api/events/<event>` both
// answer the same question, and until this file existed they answered it with
// two independent copies of the same five queries. They agreed, but only by
// coincidence: adding an item to one and forgetting the other would have left
// the CLI and the API quietly disagreeing about whether a conference was in
// trouble. That is the exact failure the two-interfaces rule exists to prevent,
// and the dashboard was the one place still breaking it.
//
// Every item is returned whatever its count, including zero. The callers differ
// on purpose about what to do with a zero -- the CLI prints it, because "0
// awaiting a decision" is information, and the API omits it, because
// `needs_attention` is a list of things that need attention. What they must not
// differ on is the set of things checked.
//
// `key` is stable and is what a caller keys its own phrasing off: the CLI points
// at a `conf` command, the API at a URL. The `text` here is the neutral wording
// both start from.

import { findConflicts, unscheduledSessions, withdrawnFromSlots } from './schedule.js';
import { awaitingNotification } from './submissions.js';
import { outstandingTasks, taskDefinitions } from './tasks.js';

export function needsAttention(db, eventId) {
  const counts = Object.fromEntries(
    db.prepare('SELECT status, count(*) AS n FROM submission WHERE event_id = ? GROUP BY status')
      .all(eventId).map((r) => [r.status, r.n]),
  );

  const conflicts = findConflicts(db, eventId).filter((c) => c.severity === 'error');
  const definitions = taskDefinitions(db, eventId).filter((t) => !t.retired_at);
  const outstanding = outstandingTasks(db, eventId);
  const dropped = withdrawnFromSlots(db, eventId);

  return [
    { key: 'awaiting_decision', count: counts.pending ?? 0,
      text: 'submission(s) awaiting a decision' },

    { key: 'awaiting_notification', count: awaitingNotification(db, eventId).length,
      text: 'decided but not yet told' },

    // Ordered above the softer items because it is the only one that means
    // something has already gone wrong rather than something is still to do.
    { key: 'withdrew_from_programme', count: dropped.length,
      text: 'withdrew from a slot in the programme',
      codes: dropped.map((s) => s.code) },

    { key: 'unscheduled', count: unscheduledSessions(db, eventId).length,
      text: 'accepted session(s) with no room or time' },

    { key: 'conflicts', count: conflicts.length,
      text: 'scheduling conflict(s)' },

    // A zero here means one of two very different things, and the difference
    // matters: everybody is up to date, or nobody was ever asked for anything.
    // The second reads as "all done" and is how an event reaches its speakers
    // having never requested a bio, a headshot or a set of slides.
    { key: 'outstanding_tasks', count: outstanding.length,
      text: 'outstanding speaker task(s)',
      nothing_is_asked: definitions.length === 0 },
  ];
}
