-- 001_initial.sql
--
-- The whole data model, in one file, on purpose. If you are an AI assistant or a new
-- contributor trying to understand this app, this file is the place to start.
--
-- Conventions used throughout:
--
--   * Timestamps are TEXT in ISO-8601 UTC, e.g. '2026-10-12T16:00:00Z'. SQLite has no
--     date type. Events carry an IANA `timezone` used only for display.
--   * Every record a human or a URL refers to has a `slug`: short, lowercase,
--     hyphenated, stable. Integer ids are internal and never appear in a URL.
--   * Booleans are INTEGER 0/1.
--   * Enumerations use CHECK constraints rather than lookup tables, so the legal
--     values are readable right here.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

-- One row per human, shared across every event. This is what makes the
-- multi-event speaker CRM possible: the same person submitting to the 2026 and
-- 2027 conferences is one row, so "who have we invited before" is answerable and
-- we never send duplicate outreach.
CREATE TABLE person (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',

  -- Optional profile fields, all speaker-editable from the portal.
  salutation    TEXT NOT NULL DEFAULT '',
  honorific     TEXT NOT NULL DEFAULT '',
  pronouns      TEXT NOT NULL DEFAULT '',
  gender        TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  biography     TEXT NOT NULL DEFAULT '',
  headshot_file_id INTEGER REFERENCES file(id) ON DELETE SET NULL,

  link_linkedin TEXT NOT NULL DEFAULT '',
  link_x        TEXT NOT NULL DEFAULT '',
  link_facebook TEXT NOT NULL DEFAULT '',
  link_website  TEXT NOT NULL DEFAULT '',

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Events and their vocabulary
-- ---------------------------------------------------------------------------

CREATE TABLE event (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  event_type   TEXT NOT NULL DEFAULT 'Conference',
  website_url  TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  timezone     TEXT NOT NULL DEFAULT 'UTC',      -- IANA name, display only
  starts_at    TEXT,
  ends_at      TEXT,
  description  TEXT NOT NULL DEFAULT '',
  logo_file_id       INTEGER REFERENCES file(id) ON DELETE SET NULL,
  background_file_id INTEGER REFERENCES file(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Who can act on an event, and as what. A person with no membership row is a
-- speaker/submitter only: they reach their own portal, nothing else.
CREATE TABLE event_membership (
  event_id  INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'organizer', 'reviewer')),
  PRIMARY KEY (event_id, person_id)
);

-- Tracks and rooms are explicit tables rather than generic options because
-- conflict detection reads them: a room has a capacity and holds one session at
-- a time, a track is a parallel programming stream an attendee follows.
CREATE TABLE track (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, slug)
);

CREATE TABLE room (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  capacity   INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, slug)
);

-- The remaining dropdowns (format, level, language, tag) are pure enumerations
-- an organizer edits per event, so they share one table keyed by `kind`.
CREATE TABLE taxonomy_option (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('format', 'level', 'language', 'tag')),
  slug       TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, kind, slug)
);

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------

CREATE TABLE file (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  event_id      INTEGER REFERENCES event(id) ON DELETE CASCADE,
  uploaded_by_person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_path  TEXT NOT NULL,          -- relative to data/uploads/
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Submission forms
-- ---------------------------------------------------------------------------

CREATE TABLE form (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'submission'
                   CHECK (kind IN ('submission', 'contact', 'group')),

  -- Organizers name a form for themselves; submitters see something else.
  internal_name  TEXT NOT NULL,
  external_title TEXT NOT NULL DEFAULT '',
  page_heading   TEXT NOT NULL DEFAULT '',
  welcome_message TEXT NOT NULL DEFAULT '',

  collect_participants INTEGER NOT NULL DEFAULT 1,

  close_at       TEXT,                  -- NULL means open indefinitely
  submission_limit INTEGER,             -- per submitter; NULL means unlimited
  allow_multiple_drafts INTEGER NOT NULL DEFAULT 0,

  auto_redirect_to_portal INTEGER NOT NULL DEFAULT 1,
  success_message TEXT NOT NULL DEFAULT '',

  send_confirmation_email INTEGER NOT NULL DEFAULT 1,
  confirmation_email_body TEXT NOT NULL DEFAULT '',

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (event_id, slug)
);

-- An ordered, reorderable list of questions. `locked` fields map to a column on
-- `submission` or `person` and cannot be deleted; everything else is a custom
-- question whose answer lands in `submission_answer`.
CREATE TABLE form_field (
  id          INTEGER PRIMARY KEY,
  form_id     INTEGER NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  section     TEXT NOT NULL CHECK (section IN ('abstract', 'participant')),
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  help_text   TEXT NOT NULL DEFAULT '',
  field_type  TEXT NOT NULL CHECK (field_type IN (
                'text', 'textarea', 'richtext', 'email', 'phone', 'url',
                'number', 'date', 'select', 'multiselect', 'checkbox', 'file')),
  -- For select/multiselect: which taxonomy the choices come from. Not a foreign
  -- key, because `taxonomy_option.kind` is deliberately non-unique (many options
  -- share a kind).
  options_kind TEXT CHECK (options_kind IS NULL
                 OR options_kind IN ('format', 'level', 'language', 'tag')),
  maps_to     TEXT,          -- e.g. 'submission.title', 'person.email'; NULL = custom
  required    INTEGER NOT NULL DEFAULT 0,
  locked      INTEGER NOT NULL DEFAULT 0,
  max_chars   INTEGER,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (form_id, slug)
);

-- Conditional logic: show `field_id` only when another field's answer matches.
CREATE TABLE form_field_condition (
  id             INTEGER PRIMARY KEY,
  field_id       INTEGER NOT NULL REFERENCES form_field(id) ON DELETE CASCADE,
  when_field_id  INTEGER NOT NULL REFERENCES form_field(id) ON DELETE CASCADE,
  operator       TEXT NOT NULL CHECK (operator IN ('equals', 'not_equals', 'includes', 'is_blank', 'is_present')),
  value          TEXT NOT NULL DEFAULT ''
);

-- "Cap the combined length of several text fields" -- print programs have hard
-- column widths, so submitters need a live combined counter.
CREATE TABLE form_char_limit (
  id         INTEGER PRIMARY KEY,
  form_id    INTEGER NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  max_chars  INTEGER NOT NULL
);

CREATE TABLE form_char_limit_field (
  limit_id INTEGER NOT NULL REFERENCES form_char_limit(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES form_field(id) ON DELETE CASCADE,
  PRIMARY KEY (limit_id, field_id)
);

-- ---------------------------------------------------------------------------
-- Submissions
--
-- A submission and a session are THE SAME ROW at different points in its life.
-- Accepting does not copy an abstract into a new session record; it advances
-- this row's status and lets the scheduling columns below be filled in. This is
-- the single most important decision in the schema -- see docs/DECISIONS.md D3.
-- ---------------------------------------------------------------------------

CREATE TABLE submission (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,            -- 'SESS-4': short, speakable, quotable in email
  form_id     INTEGER REFERENCES form(id) ON DELETE SET NULL,  -- NULL = added by an organizer
  submitted_by_person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,

  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',

  track_id    INTEGER REFERENCES track(id) ON DELETE SET NULL,
  format_option_id   INTEGER REFERENCES taxonomy_option(id) ON DELETE SET NULL,
  level_option_id    INTEGER REFERENCES taxonomy_option(id) ON DELETE SET NULL,
  language_option_id INTEGER REFERENCES taxonomy_option(id) ON DELETE SET NULL,

  -- The five-state machine plus withdrawal. accept_queue and decline_queue are
  -- staging states: a decision is recorded but the speaker has not been told.
  -- Notifying is a separate, explicit action -- see docs/DECISIONS.md D2.
  --
  --   draft -> pending -+-> accept_queue  --(notify)--> accepted
  --                     +-> decline_queue --(notify)--> declined
  --   (any) -> withdrawn
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                'draft', 'pending', 'accept_queue', 'decline_queue',
                'accepted', 'declined', 'withdrawn')),
  decided_at  TEXT,
  decided_by_person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  notified_at TEXT,

  -- Scheduling. Meaningful once accepted; a NULL starts_at on an accepted
  -- submission is exactly the "still needs a time slot" dashboard warning.
  room_id     INTEGER REFERENCES room(id) ON DELETE SET NULL,
  starts_at   TEXT,
  ends_at     TEXT,
  published   INTEGER NOT NULL DEFAULT 0,  -- incomplete sessions stay off the public agenda

  capacity          INTEGER,
  ceu_credits       REAL,
  client_session_id TEXT NOT NULL DEFAULT '',

  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (event_id, code)
);

CREATE INDEX submission_by_status ON submission (event_id, status);
CREATE INDEX submission_by_slot   ON submission (event_id, starts_at);

-- Who is on a submission, and in what role. `sort_order` preserves billing order.
CREATE TABLE submission_participant (
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  person_id     INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'speaker',
  is_primary_contact INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (submission_id, person_id, role)
);

CREATE INDEX submission_participant_by_person ON submission_participant (person_id);

-- Answers to custom (non-`maps_to`) form questions.
CREATE TABLE submission_answer (
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  field_id      INTEGER NOT NULL REFERENCES form_field(id) ON DELETE CASCADE,
  value         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (submission_id, field_id)
);

CREATE TABLE submission_tag (
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  option_id     INTEGER NOT NULL REFERENCES taxonomy_option(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, option_id)
);

CREATE TABLE submission_file (
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  file_id       INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, file_id)
);

-- ---------------------------------------------------------------------------
-- Evaluation
-- ---------------------------------------------------------------------------

-- A plan is one round of review. Multiple rounds = multiple plans, each with its
-- own criteria and assignments, so round 2 can score different things than round 1.
CREATE TABLE evaluation_plan (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  round      INTEGER NOT NULL DEFAULT 1,
  is_open    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, slug)
);

CREATE TABLE criterion (
  id         INTEGER PRIMARY KEY,
  plan_id    INTEGER NOT NULL REFERENCES evaluation_plan(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  label      TEXT NOT NULL,
  help_text  TEXT NOT NULL DEFAULT '',
  scale_min  INTEGER NOT NULL DEFAULT 1,
  scale_max  INTEGER NOT NULL DEFAULT 5,
  weight     REAL NOT NULL DEFAULT 1.0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_id, slug)
);

CREATE TABLE review (
  id            INTEGER PRIMARY KEY,
  plan_id       INTEGER NOT NULL REFERENCES evaluation_plan(id) ON DELETE CASCADE,
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  reviewer_person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  -- 'ai' marks a machine-assisted review so it can be weighted or hidden
  -- separately. Human reviewers must never be silently averaged with a model.
  source        TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'ai')),
  status        TEXT NOT NULL DEFAULT 'assigned'
                  CHECK (status IN ('assigned', 'in_progress', 'submitted', 'declined')),
  comment       TEXT NOT NULL DEFAULT '',
  conflict_of_interest INTEGER NOT NULL DEFAULT 0,
  assigned_at   TEXT NOT NULL,
  submitted_at  TEXT,
  UNIQUE (plan_id, submission_id, reviewer_person_id)
);

CREATE INDEX review_by_submission ON review (submission_id);
CREATE INDEX review_by_reviewer   ON review (reviewer_person_id, status);

CREATE TABLE score (
  review_id    INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES criterion(id) ON DELETE CASCADE,
  value        REAL NOT NULL,
  PRIMARY KEY (review_id, criterion_id)
);

-- ---------------------------------------------------------------------------
-- Speaker tasks
-- ---------------------------------------------------------------------------

-- What a speaker owes. A definition is the template; an instance is one person's
-- copy of it. The reminder engine and the "who still owes what" dashboard both
-- read `task_instance`.
CREATE TABLE task_definition (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',

  -- 'person'     -> one instance per accepted speaker (e.g. sign the agreement)
  -- 'submission' -> one instance per accepted session (e.g. upload slides)
  applies_to  TEXT NOT NULL CHECK (applies_to IN ('person', 'submission')),

  requirement TEXT NOT NULL CHECK (requirement IN ('acknowledge', 'form', 'file')),
  form_id     INTEGER REFERENCES form(id) ON DELETE SET NULL,

  due_at      TEXT,
  required    INTEGER NOT NULL DEFAULT 1,

  -- 'on_accept' assigns automatically the moment a submission becomes accepted,
  -- which is what makes the CFP-to-portal handoff feel instant.
  assign_when TEXT NOT NULL DEFAULT 'on_accept'
                CHECK (assign_when IN ('on_accept', 'manual')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, slug)
);

CREATE TABLE task_instance (
  id            INTEGER PRIMARY KEY,
  definition_id INTEGER NOT NULL REFERENCES task_definition(id) ON DELETE CASCADE,
  person_id     INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  submission_id INTEGER REFERENCES submission(id) ON DELETE CASCADE,  -- NULL for person-level
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done', 'waived')),
  completed_at  TEXT,
  file_id       INTEGER REFERENCES file(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (definition_id, person_id, submission_id)
);

CREATE INDEX task_instance_by_person ON task_instance (person_id, status);

CREATE TABLE task_answer (
  task_instance_id INTEGER NOT NULL REFERENCES task_instance(id) ON DELETE CASCADE,
  field_id         INTEGER NOT NULL REFERENCES form_field(id) ON DELETE CASCADE,
  value            TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (task_instance_id, field_id)
);

-- ---------------------------------------------------------------------------
-- Communications
-- ---------------------------------------------------------------------------

CREATE TABLE email_template (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,        -- {{placeholders}} resolved at render time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, slug)
);

-- Every outbound message is rendered and stored here first, whether or not a
-- delivery sink is configured. "What exactly did we send that speaker, and when"
-- is a question organizers ask constantly -- see docs/DECISIONS.md D5.
CREATE TABLE outbox (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  to_person_id  INTEGER REFERENCES person(id) ON DELETE SET NULL,
  to_email      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'submission_confirmation', 'decision', 'task_reminder',
                  'close_date_reminder', 'bulk', 'calendar_invite')),
  template_slug TEXT,
  submission_id INTEGER REFERENCES submission(id) ON DELETE SET NULL,
  task_instance_id INTEGER REFERENCES task_instance(id) ON DELETE SET NULL,

  -- A calendar invite must reuse its UID and bump SEQUENCE on reschedule,
  -- otherwise the speaker gets a second event instead of an updated one.
  ics_uid       TEXT,
  ics_sequence  INTEGER,
  ics_body      TEXT,

  created_at    TEXT NOT NULL,
  sent_at       TEXT,
  send_error    TEXT
);

CREATE INDEX outbox_by_person ON outbox (to_person_id, created_at);
CREATE INDEX outbox_unsent    ON outbox (sent_at) WHERE sent_at IS NULL;

-- Guards the reminder engine against sending the same nag twice.
CREATE TABLE reminder_log (
  task_instance_id INTEGER NOT NULL REFERENCES task_instance(id) ON DELETE CASCADE,
  rule             TEXT NOT NULL,     -- e.g. 'due_in_7_days'
  sent_at          TEXT NOT NULL,
  PRIMARY KEY (task_instance_id, rule)
);

-- ---------------------------------------------------------------------------
-- Portal content and public embeds
-- ---------------------------------------------------------------------------

CREATE TABLE resource_page (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',    -- rich text, may contain embed HTML
  published  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, slug)
);

CREATE TABLE embed (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  feed       TEXT NOT NULL CHECK (feed IN (
               'agenda', 'session_list', 'schedule_itinerary',
               'speaker_list', 'speaker_gallery')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  filter_track_id INTEGER REFERENCES track(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, slug)
);

-- ---------------------------------------------------------------------------
-- Authentication
--
-- Speakers must reach their portal "without forcing them through a heavy
-- signup", so there are no passwords: a one-time link is emailed and exchanged
-- for a session cookie. Only hashes are stored, so a leaked database does not
-- hand out live sessions.
-- ---------------------------------------------------------------------------

CREATE TABLE magic_link (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  event_id   INTEGER REFERENCES event(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE auth_session (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Status changes on submissions are contested after the fact ("I never declined
-- that"), so they are recorded rather than inferred.
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  actor_person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL,       -- 'submission', 'person', 'task_instance', ...
  subject_id   INTEGER NOT NULL,
  verb       TEXT NOT NULL,         -- 'created', 'status_changed', 'notified', ...
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX activity_by_subject ON activity (subject_type, subject_id, created_at);
