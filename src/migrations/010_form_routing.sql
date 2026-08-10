-- 010_form_routing.sql
--
-- Category-based routing: the answer to one question decides where a proposal
-- goes, without an organizer re-keying anything.
--
-- Conditional logic (form_field_condition, 001) decides what a submitter is
-- ASKED. Routing decides what happens to the answer once it arrives: "when
-- Track = Retrieval, put this in the first-round-ML review queue and set its
-- track to retrieval." Same shape of comparison, opposite side of the submit
-- button, so the two live side by side in the form editor and share one
-- comparison implementation (src/core/routing.js `matches`).
--
-- Three decisions worth the words:
--
-- 1. ROUTING FEEDS THE REVIEW ROUNDS THAT ALREADY EXIST. An evaluation_plan
--    already owns a reviewer pool, a per-reviewer cap, and the rule that nobody
--    reviews their own submission. Routing hands a submission to that machinery
--    -- it creates `review` rows the same way the Assign screen does -- rather
--    than inventing a second idea of "who looks at this".
--
-- 2. THE FIRST MATCHING RULE WINS. Rules are ordered and evaluated in order;
--    evaluation stops at the first match. The alternative -- apply every match --
--    reads generously but breaks on the actions themselves: a submission has one
--    track_id, so two matching rules that both set a track would resolve by
--    whichever happened to run last, which is a decision nobody can see on the
--    screen. First-match also means exactly one rule is answerable for where a
--    proposal landed, which is the entire point of recording it. An organizer
--    who wants two things done at once puts both actions on one rule; that is
--    why the action set is small and orthogonal.
--
-- 3. A RULE THAT POINTS AT NOTHING IS REFUSED, NOT IGNORED. The plan and track
--    columns are real foreign keys with no ON DELETE action, so removing a track
--    a rule depends on is refused rather than quietly blanking the rule. The
--    triggers below turn that refusal into a sentence that says what to do. This
--    repo has been bitten twice by a write that succeeded and did nothing (see
--    009 and the `published = 1` incident in USABILITY-LOG.md); a routing rule
--    that silently stops firing is the same failure, discovered weeks later by a
--    reviewer with an empty queue.

CREATE TABLE form_routing_rule (
  id         INTEGER PRIMARY KEY,
  form_id    INTEGER NOT NULL REFERENCES form(id) ON DELETE CASCADE,

  -- The category question. Restricted at the handler to the 'abstract' section:
  -- routing is about the proposal, and reading it back needs a value that lives
  -- on the submission.
  field_id   INTEGER NOT NULL REFERENCES form_field(id) ON DELETE CASCADE,
  operator   TEXT NOT NULL CHECK (operator IN (
               'equals', 'not_equals', 'includes', 'is_blank', 'is_present')),
  value      TEXT NOT NULL DEFAULT '',

  -- The actions. Each is optional on its own; the CHECK insists on at least one,
  -- because a rule that matches and does nothing is indistinguishable from a
  -- rule that never fired.
  plan_id    INTEGER REFERENCES evaluation_plan(id),
  track_id   INTEGER REFERENCES track(id),

  -- How many reviewers the plan action asks for, mirroring the "Reviewers per
  -- submission" control on the Assign screen. The plan's own cap still applies.
  reviewers  INTEGER NOT NULL DEFAULT 2 CHECK (reviewers >= 1),

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,

  CHECK (plan_id IS NOT NULL OR track_id IS NOT NULL)
);

CREATE INDEX form_routing_rule_by_form ON form_routing_rule (form_id, sort_order);

-- What routing actually did, in words, per submission.
--
-- "Why is this in the ML queue?" is asked about a specific proposal weeks after
-- the fact, usually by somebody who did not write the rule. `detail` is a
-- sentence rather than a set of ids so the answer survives the rule being
-- edited or deleted -- which is also why rule_id is SET NULL rather than
-- CASCADE: deleting a rule must not erase the record of what it did.
--
-- 'no_match' is recorded too, but only for forms that have rules at all. On a
-- form with rules, "nothing matched" is a finding; on a form without them it is
-- just the ordinary state of the world.
CREATE TABLE submission_routing (
  id            INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  rule_id       INTEGER REFERENCES form_routing_rule(id) ON DELETE SET NULL,
  form_id       INTEGER REFERENCES form(id) ON DELETE SET NULL,

  --   routed   a rule matched and every action it asked for was carried out
  --   partial  a rule matched and one was not -- an empty reviewer pool, say.
  --            The submission is not lost, but somebody has to look at it.
  --   no_match the form has rules and none of them applied
  --   failed   routing raised. Recorded rather than thrown: a stranger's
  --            proposal is never refused because organizer configuration broke.
  outcome       TEXT NOT NULL CHECK (outcome IN ('routed', 'partial', 'no_match', 'failed')),
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE INDEX submission_routing_by_submission ON submission_routing (submission_id, created_at);
CREATE INDEX submission_routing_by_form       ON submission_routing (form_id, created_at);

-- --- deleting something a rule depends on ----------------------------------
--
-- The foreign keys alone already refuse this; these only replace "FOREIGN KEY
-- constraint failed" with a sentence naming the fix, which is the house style
-- for anything the database turns down.
--
-- The `event still exists` guard is what keeps deleting a whole conference
-- working: that arrives here as a cascade, the rules go with their form inside
-- the same statement, and nobody is trying to protect a track that is on its way
-- out with everything else.

CREATE TRIGGER track_delete_blocked_by_routing_rule
BEFORE DELETE ON track
WHEN EXISTS (SELECT 1 FROM form_routing_rule WHERE track_id = OLD.id)
 AND EXISTS (SELECT 1 FROM event WHERE id = OLD.event_id)
BEGIN
  SELECT RAISE(ABORT,
    'this track is what a submission form''s routing rule assigns to, so removing '
    || 'it would leave proposals with nowhere to go. Remove the rule first: it is '
    || 'under Routing on the form, POST /e/<event>/forms/<form>/routing/<id>/delete');
END;

CREATE TRIGGER plan_delete_blocked_by_routing_rule
BEFORE DELETE ON evaluation_plan
WHEN EXISTS (SELECT 1 FROM form_routing_rule WHERE plan_id = OLD.id)
 AND EXISTS (SELECT 1 FROM event WHERE id = OLD.event_id)
BEGIN
  SELECT RAISE(ABORT,
    'this review round is what a submission form''s routing rule assigns to, so '
    || 'removing it would leave proposals unreviewed. Remove the rule first: it is '
    || 'under Routing on the form, POST /e/<event>/forms/<form>/routing/<id>/delete');
END;
