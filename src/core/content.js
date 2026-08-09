// Versions, comments, approval, and revisions.
//
// The organizing idea: nothing a speaker or an organizer typed is thrown away
// by an ordinary action. Replacing a deck keeps the old one, editing an
// abstract keeps what it said before, and both are reachable from the screen
// where the change was made.

import { now } from '../db.js';
import { storeUpload } from './files.js';

/**
 * Store a new version of a file.
 *
 * `previousId` is whatever the slot currently holds. The new file joins that
 * file's lineage, takes the next version number, and the old one is marked
 * superseded rather than deleted.
 */
export function storeVersion(db, { eventId, personId, upload, previousId = null, accept = null }) {
  const stored = storeUpload(db, { eventId, personId, upload, accept });
  if (!previousId) return stored;

  const previous = db.prepare('SELECT * FROM file WHERE id = ?').get(previousId);
  if (!previous) return stored;

  const root = previous.root_file_id ?? previous.id;
  const { highest } = db.prepare(
    'SELECT max(version) AS highest FROM file WHERE root_file_id = ?',
  ).get(root);

  db.prepare('UPDATE file SET root_file_id = ?, version = ? WHERE id = ?')
    .run(root, (highest ?? 1) + 1, stored.id);
  db.prepare('UPDATE file SET superseded_at = ? WHERE id = ?').run(now(), previous.id);

  return db.prepare('SELECT * FROM file WHERE id = ?').get(stored.id);
}

/** Every version of a file, newest first. A single upload returns one row. */
export function versionsOf(db, fileId) {
  const file = db.prepare('SELECT * FROM file WHERE id = ?').get(fileId);
  if (!file) return [];

  return db.prepare(
    `SELECT f.*, p.first_name, p.last_name,
            (SELECT count(*) FROM file_comment c WHERE c.file_id = f.id) AS comments
       FROM file f LEFT JOIN person p ON p.id = f.uploaded_by_person_id
      WHERE f.root_file_id = ? ORDER BY f.version DESC`,
  ).all(file.root_file_id ?? file.id);
}

export function addComment(db, fileId, personId, body) {
  return db.prepare(
    'INSERT INTO file_comment (file_id, person_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING *',
  ).get(fileId, personId, body, now());
}

/**
 * Comments on a file, including comments on its other versions.
 *
 * A conversation about a deck does not restart because somebody uploaded a
 * corrected page; it is the same conversation about the same thing.
 */
export function commentsOn(db, fileId) {
  const file = db.prepare('SELECT * FROM file WHERE id = ?').get(fileId);
  if (!file) return [];
  const root = file.root_file_id ?? file.id;

  return db.prepare(
    `SELECT c.*, f.version, p.first_name, p.last_name
       FROM file_comment c
       JOIN file f ON f.id = c.file_id
       LEFT JOIN person p ON p.id = c.person_id
      WHERE f.root_file_id = ? OR f.id = ?
      ORDER BY c.created_at`,
  ).all(root, root);
}

// --- approval --------------------------------------------------------------

export const CONTENT_STATUSES = ['draft', 'in_review', 'approved'];

/**
 * Set a session's content status.
 *
 * Approval is what gates the public agenda. Moving a session back out of
 * approved also unpublishes it, because the alternative is content an organizer
 * has explicitly marked as not-ready sitting on the public website.
 */
export function setContentStatus(db, submissionId, status, { actorPersonId = null } = {}) {
  if (!CONTENT_STATUSES.includes(status)) {
    throw new Error(`unknown content status '${status}'. Use one of: ${CONTENT_STATUSES.join(', ')}`);
  }

  const approving = status === 'approved';
  return db.prepare(
    `UPDATE submission
        SET content_status = ?,
            content_approved_at = CASE WHEN ? THEN ? ELSE NULL END,
            content_approved_by_person_id = CASE WHEN ? THEN ? ELSE NULL END,
            published = CASE WHEN ? THEN published ELSE 0 END,
            updated_at = ?
      WHERE id = ? RETURNING *`,
  ).get(status, approving ? 1 : 0, now(), approving ? 1 : 0, actorPersonId,
    approving ? 1 : 0, now(), submissionId);
}

// --- revisions -------------------------------------------------------------

/**
 * Record what a submission's content said, before changing it.
 *
 * Called with the row as it currently is, so the history reads as a list of
 * previous states rather than a list of edits with the current one missing.
 */
export function snapshot(db, submission, { actorPersonId = null, note = '' } = {}) {
  return db.prepare(
    `INSERT INTO submission_revision (submission_id, title, description,
                                      changed_by_person_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(submission.id, submission.title, submission.description, actorPersonId, note, now());
}

export function revisionsOf(db, submissionId) {
  return db.prepare(
    `SELECT r.*, p.first_name, p.last_name
       FROM submission_revision r LEFT JOIN person p ON p.id = r.changed_by_person_id
      WHERE r.submission_id = ? ORDER BY r.created_at DESC, r.id DESC`,
  ).all(submissionId);
}

/**
 * Put a submission's content back to what a revision recorded.
 *
 * Snapshots the current state first, so restoring is itself undoable. Restoring
 * is a normal edit, not a rewind: nothing is deleted from the history.
 */
export function restoreRevision(db, submissionId, revisionId, { actorPersonId = null } = {}) {
  const revision = db.prepare(
    'SELECT * FROM submission_revision WHERE id = ? AND submission_id = ?',
  ).get(revisionId, submissionId);
  if (!revision) throw new Error(`revision ${revisionId} does not belong to that submission`);

  const current = db.prepare('SELECT * FROM submission WHERE id = ?').get(submissionId);
  snapshot(db, current, { actorPersonId, note: `replaced by a restore of ${revision.created_at}` });

  return db.prepare(
    'UPDATE submission SET title = ?, description = ?, updated_at = ? WHERE id = ? RETURNING *',
  ).get(revision.title, revision.description, now(), submissionId);
}
