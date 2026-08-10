// Who a bulk message goes to.
//
// Audiences are named, not hand-assembled. An organizer picks "everyone who
// still owes a headshot" and the list is derived at send time, so it cannot be a
// stale copy-paste from a spreadsheet — which is exactly the failure this
// product exists to remove.
//
// Every audience is also previewable before sending, over both surfaces:
// `conf mail <event> --audience <key> --dry-run`, and
// `GET /api/events/<event>/audiences?audience=<key>`. Nobody should ever press
// send on a list they have not seen -- including a caller that is a program,
// which is why the preview is not only a rendered HTML table.

/**
 * The audiences an organizer can pick, in the order they appear in the UI.
 *
 * `key` is stable and appears in URLs and the API; `label` is what a human
 * reads. Adding one here is all that is needed for it to appear everywhere.
 */
export const AUDIENCES = [
  { key: 'accepted-speakers', label: 'Accepted speakers',
    description: 'Everyone with at least one accepted session, told about it.' },
  { key: 'pending-submitters', label: 'Awaiting a decision',
    description: 'Everyone whose submission has not been decided yet.' },
  { key: 'declined-submitters', label: 'Declined submitters',
    description: 'Everyone who was told no. Use gently.' },
  { key: 'outstanding-tasks', label: 'Anyone with an outstanding task',
    description: 'Accepted speakers who still owe something.' },
  { key: 'draft-submitters', label: 'Unfinished drafts',
    description: 'People who started a submission and never sent it.' },
  { key: 'all-submitters', label: 'Everyone who submitted',
    description: 'Every person attached to any submission for this event.' },
];

const QUERIES = {
  'accepted-speakers': `
    SELECT DISTINCT p.* FROM person p
      JOIN submission_participant sp ON sp.person_id = p.id
      JOIN submission s ON s.id = sp.submission_id
     WHERE s.event_id = ? AND s.status = 'accepted' AND s.notified_at IS NOT NULL`,

  // Deliberately excludes the queue states. Mailing somebody whose decision is
  // recorded but unsent, in a batch addressed to "people awaiting a decision",
  // is how a decision leaks early.
  'pending-submitters': `
    SELECT DISTINCT p.* FROM person p
      JOIN submission_participant sp ON sp.person_id = p.id
      JOIN submission s ON s.id = sp.submission_id
     WHERE s.event_id = ? AND s.status = 'pending'`,

  'declined-submitters': `
    SELECT DISTINCT p.* FROM person p
      JOIN submission_participant sp ON sp.person_id = p.id
      JOIN submission s ON s.id = sp.submission_id
     WHERE s.event_id = ? AND s.status = 'declined' AND s.notified_at IS NOT NULL`,

  'outstanding-tasks': `
    SELECT DISTINCT p.* FROM person p
      JOIN task_instance ti ON ti.person_id = p.id
      JOIN task_definition td ON td.id = ti.definition_id
     WHERE td.event_id = ? AND ti.status = 'todo'`,

  'draft-submitters': `
    SELECT DISTINCT p.* FROM person p
      JOIN submission_participant sp ON sp.person_id = p.id
      JOIN submission s ON s.id = sp.submission_id
     WHERE s.event_id = ? AND s.status = 'draft'`,

  'all-submitters': `
    SELECT DISTINCT p.* FROM person p
      JOIN submission_participant sp ON sp.person_id = p.id
      JOIN submission s ON s.id = sp.submission_id
     WHERE s.event_id = ?`,
};

export class UnknownAudienceError extends Error {
  constructor(key) {
    super(`unknown audience '${key}'. Use one of: ${AUDIENCES.map((a) => a.key).join(', ')}`);
    this.name = 'UnknownAudienceError';
    this.hint = `valid audiences: ${AUDIENCES.map((a) => a.key).join(', ')}`;
  }
}

/**
 * Resolve an audience to actual people, ordered so a preview reads sensibly.
 *
 * `taskSlug` narrows 'outstanding-tasks' to one particular thing, so "chase the
 * people who owe a headshot" is expressible without writing a new audience.
 */
export function resolveAudience(db, eventId, key, { taskSlug = null } = {}) {
  const sql = QUERIES[key];
  if (!sql) throw new UnknownAudienceError(key);

  if (key === 'outstanding-tasks' && taskSlug) {
    return db.prepare(`${sql} AND td.slug = ? ORDER BY p.last_name, p.first_name`)
      .all(eventId, taskSlug);
  }
  return db.prepare(`${sql} ORDER BY p.last_name, p.first_name`).all(eventId);
}

/** Every audience with its current size, for the picker. */
export function audienceSizes(db, eventId) {
  return AUDIENCES.map((audience) => ({
    ...audience,
    count: resolveAudience(db, eventId, audience.key).length,
  }));
}
