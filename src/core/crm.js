// The cross-event speaker database.
//
// `person` has been global since the first migration, which is what makes this
// possible: the same human submitting in 2025 and 2027 is one row, so "have we
// had them before" is a join rather than a fuzzy name match. This is the layer
// that makes that visible and useful.

import { now, slugify } from '../db.js';

/**
 * Search the directory.
 *
 * Every filter is optional and they combine. `neverSpoken` is the one worth
 * naming: "people we know about who have never actually been on stage" is the
 * list a programme chair builds every year and loses every year.
 */
export function searchPeople(db, {
  query = '', tag = '', company = '', spokeAtEventId = null, neverSpoken = false, limit = 500,
} = {}) {
  const where = ['1 = 1'];
  const args = [];

  if (query) {
    where.push(`(p.first_name || ' ' || p.last_name LIKE ? OR p.email LIKE ?
                 OR p.company LIKE ? OR p.job_title LIKE ?)`);
    args.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (company) { where.push('p.company LIKE ?'); args.push(`%${company}%`); }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM person_tag t WHERE t.person_id = p.id AND t.tag = ?)');
    args.push(tag);
  }
  if (spokeAtEventId) {
    where.push(`EXISTS (SELECT 1 FROM submission_participant sp
                          JOIN submission s ON s.id = sp.submission_id
                         WHERE sp.person_id = p.id AND s.event_id = ? AND s.status = 'accepted')`);
    args.push(spokeAtEventId);
  }
  if (neverSpoken) {
    where.push(`NOT EXISTS (SELECT 1 FROM submission_participant sp
                              JOIN submission s ON s.id = sp.submission_id
                             WHERE sp.person_id = p.id AND s.status = 'accepted')`);
  }

  return db.prepare(
    `SELECT p.id, p.slug, p.email, p.first_name, p.last_name, p.job_title, p.company,
            (SELECT count(DISTINCT s.event_id) FROM submission_participant sp
               JOIN submission s ON s.id = sp.submission_id
              WHERE sp.person_id = p.id AND s.status = 'accepted') AS events_spoken,
            (SELECT count(*) FROM submission_participant sp
               JOIN submission s ON s.id = sp.submission_id
              WHERE sp.person_id = p.id) AS submissions,
            (SELECT group_concat(t.tag, ', ') FROM person_tag t WHERE t.person_id = p.id) AS tags,
            (SELECT count(*) FROM person_note n WHERE n.person_id = p.id) AS notes
       FROM person p
      WHERE ${where.join(' AND ')}
      ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE
      LIMIT ?`,
  ).all(...args, limit);
}

/** Everything one person has ever done here, across every event. */
export function personHistory(db, personId) {
  return db.prepare(
    `SELECT e.slug AS event_slug, e.name AS event_name, e.starts_at,
            s.code, s.title, s.status, sp.role
       FROM submission_participant sp
       JOIN submission s ON s.id = sp.submission_id
       JOIN event e ON e.id = s.event_id
      WHERE sp.person_id = ?
      ORDER BY e.starts_at DESC, s.code`,
  ).all(personId);
}

export function notesOn(db, personId) {
  return db.prepare(
    `SELECT n.*, a.first_name, a.last_name FROM person_note n
       LEFT JOIN person a ON a.id = n.author_person_id
      WHERE n.person_id = ? ORDER BY n.created_at DESC`,
  ).all(personId);
}

export function addNote(db, personId, authorId, body) {
  return db.prepare(
    'INSERT INTO person_note (person_id, author_person_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING *',
  ).get(personId, authorId, body, now());
}

export function tagsOn(db, personId) {
  return db.prepare('SELECT tag FROM person_tag WHERE person_id = ? ORDER BY tag')
    .all(personId).map((r) => r.tag);
}

export function addTag(db, personId, tag) {
  const clean = String(tag).trim().slice(0, 40);
  if (!clean) return null;
  db.prepare('INSERT OR IGNORE INTO person_tag (person_id, tag, added_at) VALUES (?, ?, ?)')
    .run(personId, clean, now());
  return clean;
}

export function removeTag(db, personId, tag) {
  db.prepare('DELETE FROM person_tag WHERE person_id = ? AND tag = ?').run(personId, tag);
}

export function allTags(db) {
  return db.prepare(
    'SELECT tag, count(*) AS n FROM person_tag GROUP BY tag ORDER BY n DESC, tag',
  ).all();
}

// --- duplicates ------------------------------------------------------------

/**
 * People who look like the same human twice.
 *
 * Matched on name, because that is how duplicates actually arise: somebody
 * submits from a work address one year and a personal one the next. Email is
 * already unique, so it can never find them.
 */
export function findDuplicates(db) {
  return db.prepare(
    `SELECT lower(first_name || ' ' || last_name) AS name, count(*) AS n,
            group_concat(slug, ',') AS slugs
       FROM person
      WHERE first_name != '' AND last_name != ''
      GROUP BY name HAVING n > 1
      ORDER BY n DESC, name`,
  ).all();
}

/**
 * Fold one person into another.
 *
 * Everything the loser owns is reassigned rather than deleted: submissions,
 * tasks, reviews, notes, tags, files, mail. A merge that quietly dropped a
 * review or a signed agreement would be worse than a duplicate.
 *
 * The winner keeps its own non-empty fields and inherits the loser's where it
 * had none, so merging never loses a biography by preferring a blank one.
 *
 * All of it in one transaction. There are twenty-odd statements here and the
 * person row is deleted by the last of them; a merge that failed half way
 * through would leave a human split across two records with their history on
 * one and their login on the other, and no way to tell that had happened.
 */
export function mergePeople(db, keepId, mergeId, { actorPersonId = null } = {}) {
  if (keepId === mergeId) throw new Error('cannot merge somebody into themselves');

  const keep = db.prepare('SELECT * FROM person WHERE id = ?').get(keepId);
  const merge = db.prepare('SELECT * FROM person WHERE id = ?').get(mergeId);
  if (!keep || !merge) throw new Error('both people must exist to merge them');

  db.exec('BEGIN');
  try {
    const result = mergeInto(db, keep, merge, actorPersonId);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function mergeInto(db, keep, merge, actorPersonId) {
  const keepId = keep.id;
  const mergeId = merge.id;

  const fields = ['first_name', 'last_name', 'job_title', 'company', 'biography',
    'phone', 'pronouns', 'honorific', 'salutation', 'gender',
    'link_website', 'link_linkedin', 'link_x', 'link_facebook'];

  for (const field of fields) {
    if (!keep[field] && merge[field]) {
      db.prepare(`UPDATE person SET ${field} = ? WHERE id = ?`).run(merge[field], keepId);
    }
  }
  if (!keep.headshot_file_id && merge.headshot_file_id) {
    db.prepare('UPDATE person SET headshot_file_id = ? WHERE id = ?')
      .run(merge.headshot_file_id, keepId);
  }

  // Participation and reviews carry unique constraints, so move what does not
  // collide and drop what does -- a duplicate row on the same submission is the
  // same fact recorded twice.
  db.prepare(
    `UPDATE OR IGNORE submission_participant SET person_id = ? WHERE person_id = ?`,
  ).run(keepId, mergeId);
  db.prepare('DELETE FROM submission_participant WHERE person_id = ?').run(mergeId);

  db.prepare('UPDATE OR IGNORE review SET reviewer_person_id = ? WHERE reviewer_person_id = ?')
    .run(keepId, mergeId);
  db.prepare('DELETE FROM review WHERE reviewer_person_id = ?').run(mergeId);

  db.prepare('UPDATE OR IGNORE task_instance SET person_id = ? WHERE person_id = ?')
    .run(keepId, mergeId);
  db.prepare('DELETE FROM task_instance WHERE person_id = ?').run(mergeId);

  db.prepare('UPDATE OR IGNORE event_membership SET person_id = ? WHERE person_id = ?')
    .run(keepId, mergeId);
  db.prepare('DELETE FROM event_membership WHERE person_id = ?').run(mergeId);

  db.prepare('UPDATE OR IGNORE person_tag SET person_id = ? WHERE person_id = ?')
    .run(keepId, mergeId);
  db.prepare('DELETE FROM person_tag WHERE person_id = ?').run(mergeId);

  db.prepare('UPDATE OR IGNORE pipeline_card SET person_id = ? WHERE person_id = ?')
    .run(keepId, mergeId);
  db.prepare('DELETE FROM pipeline_card WHERE person_id = ?').run(mergeId);

  // Reviewing duty is work somebody agreed to do, not a record of the past.
  // Left behind it cascades away with the duplicate: the plan quietly has one
  // reviewer fewer and nobody is told, which surfaces weeks later as a round
  // that will not close.
  db.prepare('UPDATE OR IGNORE plan_reviewer SET person_id = ? WHERE person_id = ?')
    .run(keepId, mergeId);
  db.prepare('DELETE FROM plan_reviewer WHERE person_id = ?').run(mergeId);

  for (const [table, column] of [
    ['person_note', 'person_id'],
    ['submission', 'submitted_by_person_id'],
    ['outbox', 'to_person_id'],
    ['file', 'uploaded_by_person_id'],

    // Authorship, all of it `ON DELETE SET NULL`, which is the right rule for a
    // person genuinely leaving and the wrong one here: this human has not left,
    // their other record has. Unmoved, "Ada decided this" becomes "somebody
    // decided this" as a side effect of tidying a duplicate, and the audit
    // trail is worth less than the tidying was.
    ['activity', 'actor_person_id'],
    ['person_note', 'author_person_id'],
    ['file_comment', 'person_id'],
    ['submission_revision', 'changed_by_person_id'],
    ['submission', 'decided_by_person_id'],
    ['pipeline_move', 'actor_person_id'],
  ]) {
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(keepId, mergeId);
  }

  // How they get in. All four cascade, so merging used to lock somebody out of
  // their own account without saying so: the password on the duplicate record
  // was destroyed, their API tokens stopped working, and the portal link
  // already sitting in their inbox started answering 410.
  //
  // The credential moves only if the survivor has none, because that row is
  // keyed by person and the surviving password is the one to trust.
  if (!db.prepare('SELECT 1 FROM person_credential WHERE person_id = ?').get(keepId)) {
    db.prepare('UPDATE person_credential SET person_id = ? WHERE person_id = ?')
      .run(keepId, mergeId);
  }
  for (const table of ['api_token', 'magic_link', 'auth_session']) {
    db.prepare(`UPDATE ${table} SET person_id = ? WHERE person_id = ?`).run(keepId, mergeId);
  }

  // The other address is worth keeping: it is how they will write to us next
  // time, and it is the evidence that this merge happened at all.
  addNote(db, keepId, actorPersonId,
    `Merged in a duplicate record: ${merge.first_name} ${merge.last_name} <${merge.email}>.`);

  db.prepare('DELETE FROM person WHERE id = ?').run(mergeId);
  return db.prepare('SELECT * FROM person WHERE id = ?').get(keepId);
}

// --- segments --------------------------------------------------------------

export function saveSegment(db, { name, query = '', tag = '', company = '', spokeAtEventId = null, neverSpoken = false }) {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; db.prepare('SELECT 1 FROM segment WHERE slug = ?').get(slug); n++) {
    slug = `${base}-${n}`;
  }
  return db.prepare(
    `INSERT INTO segment (slug, name, query, tag, company, spoke_at_event_id, never_spoken, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(slug, name, query, tag, company, spokeAtEventId, neverSpoken ? 1 : 0, now());
}

export function segments(db) {
  return db.prepare('SELECT * FROM segment ORDER BY name').all();
}

/** Resolve a saved segment now, rather than returning who matched when it was saved. */
export function runSegment(db, segment) {
  return searchPeople(db, {
    query: segment.query,
    tag: segment.tag,
    company: segment.company,
    spokeAtEventId: segment.spoke_at_event_id,
    neverSpoken: Boolean(segment.never_spoken),
  });
}

// --- pipeline --------------------------------------------------------------

/** The stages a conference actually uses, if nobody has defined any. */
const DEFAULT_STAGES = [
  ['identified', 'Identified', 1, 0],
  ['researching', 'Researching', 2, 0],
  ['contacted', 'Contacted', 3, 0],
  ['interested', 'Interested', 4, 0],
  ['confirmed', 'Confirmed', 5, 1],
  ['declined', 'Declined', 6, 1],
];

/**
 * The pipeline's stages, restoring the defaults if there are none.
 *
 * Migration 008 inserts them, but reference data inserted by a migration is
 * fragile: the seed wipes every table it finds, so a re-seed left the board
 * with no columns and no error. Ensuring them here means any database, however
 * it got into that state, has a usable board.
 */
export function stages(db) {
  const found = db.prepare('SELECT * FROM pipeline_stage ORDER BY sort_order').all();
  if (found.length > 0) return found;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO pipeline_stage (slug, name, sort_order, is_terminal) VALUES (?, ?, ?, ?)',
  );
  for (const stage of DEFAULT_STAGES) insert.run(...stage);
  return db.prepare('SELECT * FROM pipeline_stage ORDER BY sort_order').all();
}

export function board(db, eventId = null) {
  const cards = db.prepare(
    `SELECT c.*, p.slug AS person_slug, p.first_name, p.last_name, p.company, p.email,
            st.slug AS stage_slug, st.name AS stage_name, st.sort_order, st.is_terminal,
            e.name AS event_name
       FROM pipeline_card c
       JOIN person p ON p.id = c.person_id
       JOIN pipeline_stage st ON st.id = c.stage_id
       LEFT JOIN event e ON e.id = c.event_id
      WHERE (? IS NULL OR c.event_id = ?)
      ORDER BY st.sort_order, c.score IS NULL, c.score DESC, p.last_name`,
  ).all(eventId, eventId);

  return stages(db).map((stage) => ({
    stage,
    cards: cards.filter((c) => c.stage_id === stage.id),
  }));
}

export function enroll(db, { personId, stageSlug = 'identified', eventId = null, score = null, rationale = '', actorPersonId = null }) {
  const stage = stages(db).find((s) => s.slug === stageSlug);
  if (!stage) {
    throw new Error(`no pipeline stage '${stageSlug}'. Stages are: `
      + stages(db).map((s) => s.slug).join(', '));
  }

  const existing = db.prepare('SELECT * FROM pipeline_card WHERE person_id = ? AND event_id IS ?')
    .get(personId, eventId);
  if (existing) return existing;

  const card = db.prepare(
    `INSERT INTO pipeline_card (person_id, stage_id, event_id, score, rationale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(personId, stage.id, eventId, score, rationale, now(), now());

  db.prepare(
    `INSERT INTO pipeline_move (card_id, from_stage_id, to_stage_id, actor_person_id, note, created_at)
     VALUES (?, NULL, ?, ?, 'enrolled', ?)`,
  ).run(card.id, stage.id, actorPersonId, now());

  return card;
}

export function moveCard(db, cardId, stageSlug, { actorPersonId = null, note = '' } = {}) {
  const card = db.prepare('SELECT * FROM pipeline_card WHERE id = ?').get(cardId);
  if (!card) throw new Error(`no pipeline card ${cardId}`);

  const stage = stages(db).find((s) => s.slug === stageSlug);
  if (!stage) {
    throw new Error(`no pipeline stage '${stageSlug}'. Stages are: `
      + stages(db).map((s) => s.slug).join(', '));
  }
  if (stage.id === card.stage_id) return card;

  db.prepare('UPDATE pipeline_card SET stage_id = ?, updated_at = ? WHERE id = ?')
    .run(stage.id, now(), cardId);
  db.prepare(
    `INSERT INTO pipeline_move (card_id, from_stage_id, to_stage_id, actor_person_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(cardId, card.stage_id, stage.id, actorPersonId, note, now());

  return db.prepare('SELECT * FROM pipeline_card WHERE id = ?').get(cardId);
}

export function movesFor(db, cardId) {
  return db.prepare(
    `SELECT m.*, f.name AS from_name, t.name AS to_name, p.first_name, p.last_name
       FROM pipeline_move m
       LEFT JOIN pipeline_stage f ON f.id = m.from_stage_id
       JOIN pipeline_stage t ON t.id = m.to_stage_id
       LEFT JOIN person p ON p.id = m.actor_person_id
      WHERE m.card_id = ? ORDER BY m.created_at`,
  ).all(cardId);
}
