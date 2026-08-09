-- 008_speaker_crm.sql
--
-- The cross-event layer. `person` has been global from the first migration,
-- which is what makes this possible at all, but nothing hung off it: you could
-- see that somebody spoke in 2025 and 2026 only by looking at two events.
--
-- What a programme chair actually keeps, and has been keeping in a spreadsheet:
--
--   * notes about a person that are not about one submission ("great on stage,
--     needs a hard deadline for slides");
--   * tags to slice the list by ("keynote material", "local", "declined 2025");
--   * saved searches, because "AI people we have not invited yet" is a question
--     asked every year and rebuilt by hand every year;
--   * a record of who has been approached and how far that got.
--
-- All of it is organization-wide rather than per-event. That is the point.

CREATE TABLE person_note (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  author_person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX person_note_by_person ON person_note (person_id, created_at);

-- Free-form and organization-wide. Deliberately not the per-event `tag`
-- taxonomy: that describes a talk's subject, this describes a person, and
-- conflating them would put "Beginner" next to "never returns email".
CREATE TABLE person_tag (
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (person_id, tag)
);

CREATE INDEX person_tag_by_tag ON person_tag (tag);

-- A saved search. Stored as its criteria rather than as a list of people, so it
-- keeps answering the question instead of freezing one afternoon's answer --
-- which is the whole difference between a segment and a spreadsheet tab.
CREATE TABLE segment (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL DEFAULT '',
  tag         TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  spoke_at_event_id INTEGER REFERENCES event(id) ON DELETE SET NULL,
  never_spoken INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- --- sourcing --------------------------------------------------------------

CREATE TABLE pipeline_stage (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- A terminal stage ends the conversation, one way or the other. Kept as a
  -- flag rather than inferred from position, because "Declined" sits at the end
  -- of the board and "Confirmed" does too.
  is_terminal INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pipeline_card (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  stage_id   INTEGER NOT NULL REFERENCES pipeline_stage(id) ON DELETE CASCADE,
  event_id   INTEGER REFERENCES event(id) ON DELETE SET NULL,
  score      INTEGER,
  rationale  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person_id, event_id)
);

-- Every move, kept. "Who talked to them and when did this stall" is the
-- question a pipeline exists to answer, and a current-stage column alone
-- cannot answer it.
CREATE TABLE pipeline_move (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL REFERENCES pipeline_card(id) ON DELETE CASCADE,
  from_stage_id INTEGER REFERENCES pipeline_stage(id) ON DELETE SET NULL,
  to_stage_id INTEGER NOT NULL REFERENCES pipeline_stage(id) ON DELETE CASCADE,
  actor_person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE INDEX pipeline_move_by_card ON pipeline_move (card_id, created_at);

-- The stages a conference actually uses. Editable, but a board with no columns
-- is not usable and asking somebody to invent them before they can add anybody
-- is a poor first five minutes.
INSERT INTO pipeline_stage (slug, name, sort_order, is_terminal) VALUES
  ('identified', 'Identified',  1, 0),
  ('researching', 'Researching', 2, 0),
  ('contacted', 'Contacted',    3, 0),
  ('interested', 'Interested',  4, 0),
  ('confirmed', 'Confirmed',    5, 1),
  ('declined', 'Declined',      6, 1);
