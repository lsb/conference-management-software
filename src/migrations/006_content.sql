-- 006_content.sql
--
-- Three gaps in how content is handled, all of which bite late and quietly.
--
-- 1. Re-uploading a deck replaced it. A speaker who uploaded the wrong file on
--    Friday and the right one on Monday left no way to get Friday's back, and
--    an organizer who had already printed from v1 had no way to see what
--    changed. Versions are now kept, with the newest current and the older ones
--    still reachable.
--
-- 2. There was nothing to say about a file. "Is this the final deck?" and
--    "please confirm by Tuesday" were happening in email, which is exactly the
--    thing this product exists to pull out of email.
--
-- 3. `published` was doing two jobs: "this is finished" and "show this to the
--    public". They are different decisions made by different people at
--    different times, and conflating them means either publishing drafts or
--    forgetting to publish finished work.

-- --- file versions ---------------------------------------------------------

-- Files in a chain share a lineage. The first upload is its own root; each
-- later one points at the root, so "all versions of this" is one query and does
-- not walk a linked list.
ALTER TABLE file ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE file ADD COLUMN root_file_id INTEGER REFERENCES file(id) ON DELETE SET NULL;
ALTER TABLE file ADD COLUMN superseded_at TEXT;

UPDATE file SET root_file_id = id WHERE root_file_id IS NULL;

CREATE INDEX file_by_lineage ON file (root_file_id, version);

-- --- comments on files -----------------------------------------------------

CREATE TABLE file_comment (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  person_id  INTEGER REFERENCES person(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX file_comment_by_file ON file_comment (file_id, created_at);

-- --- content approval ------------------------------------------------------

-- Separate from `published`. Approval says the content is correct and ready;
-- publishing says the world may see it. An organizer approves a session's
-- description; publishing the whole programme is a later, deliberate act.
ALTER TABLE submission ADD COLUMN content_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (content_status IN ('draft', 'in_review', 'approved'));
ALTER TABLE submission ADD COLUMN content_approved_at TEXT;
ALTER TABLE submission ADD COLUMN content_approved_by_person_id INTEGER
  REFERENCES person(id) ON DELETE SET NULL;

-- Anything already visible to the public was, in effect, approved. Recording
-- that keeps existing agendas from emptying out the moment this ships.
UPDATE submission SET content_status = 'approved' WHERE published = 1;

-- --- revisions -------------------------------------------------------------

-- A snapshot of the editable content of a submission, written before each
-- change, so an edit can be undone by somebody who is not holding a backup.
-- Only title and description: those are what gets edited and argued about, and
-- storing whole rows would make restoring a revision able to resurrect a
-- decision or a room booking.
CREATE TABLE submission_revision (
  id            INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  changed_by_person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE INDEX submission_revision_by_submission ON submission_revision (submission_id, created_at);
