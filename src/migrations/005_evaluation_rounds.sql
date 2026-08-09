-- 005_evaluation_rounds.sql
--
-- Review rounds were modelled as little more than a name and a list of numeric
-- criteria. Real programme committees need more, and the gaps showed up as soon
-- as anyone tried to run a second round:
--
--   * A scorecard is not all numbers. "Recommendation: accept / maybe / reject"
--     is the field committees actually argue about, and a free-text field is
--     where the argument gets made.
--
--   * Reviewer pools belong to a round. The people who triage two hundred
--     abstracts in round one are usually not the people who pick between the
--     final forty.
--
--   * Blind review has to be a property of the round, because the first round is
--     often anonymous and the last one deliberately is not -- by then you are
--     weighing whether this specific person can carry a keynote.
--
--   * A cap on assignments per reviewer is the difference between volunteers
--     finishing and volunteers quietly giving up.

ALTER TABLE criterion ADD COLUMN field_type TEXT NOT NULL DEFAULT 'number'
  CHECK (field_type IN ('number', 'select', 'text'));

-- Comma-separated choices for a 'select' criterion, e.g. 'Accept,Maybe,Reject'.
-- Kept inline rather than in a child table: these are three words an organizer
-- types once, and a join to read them would be all cost and no benefit.
ALTER TABLE criterion ADD COLUMN choices TEXT NOT NULL DEFAULT '';

ALTER TABLE evaluation_plan ADD COLUMN anonymize INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evaluation_plan ADD COLUMN max_per_reviewer INTEGER;
ALTER TABLE evaluation_plan ADD COLUMN description TEXT NOT NULL DEFAULT '';

-- A round runs between two dates. Reviewers ask "when is this due" more than
-- any other question, and the answer belongs on the round rather than in a
-- reminder email somebody has to go and find.
ALTER TABLE evaluation_plan ADD COLUMN opens_at TEXT;
ALTER TABLE evaluation_plan ADD COLUMN closes_at TEXT;

-- Who reviews in this round. A person can sit in several rounds' pools, and a
-- round can exist before anyone is in it.
CREATE TABLE plan_reviewer (
  plan_id   INTEGER NOT NULL REFERENCES evaluation_plan(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (plan_id, person_id)
);

-- A 'select' or 'text' criterion has no meaningful numeric value, so `score`
-- gains a text column. `value` stays for numbers, and aggregate scoring reads
-- only numeric criteria -- averaging "Accept" with 4 would be arithmetic on a
-- word.
ALTER TABLE score ADD COLUMN text_value TEXT NOT NULL DEFAULT '';

-- Existing plans keep their reviewers: before this migration, anybody with the
-- reviewer role on the event could review anything in it.
INSERT INTO plan_reviewer (plan_id, person_id, added_at)
SELECT ep.id, m.person_id, ep.created_at
  FROM evaluation_plan ep
  JOIN event_membership m ON m.event_id = ep.event_id AND m.role = 'reviewer';
