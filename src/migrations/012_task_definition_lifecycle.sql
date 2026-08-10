-- 012_task_definition_lifecycle.sql
--
-- Task definitions became editable by organizers, so for the first time they
-- can also be deleted -- and `task_instance.definition_id` is ON DELETE CASCADE.
-- Removing "Upload your slides" in March would take with it the record that
-- eleven speakers had already done it, silently, in one statement, along with
-- the rows that tie their uploaded decks to the thing they were uploaded for.
--
-- That is the failure this repo has now shipped twice in other forms (see 009
-- and the `published = 1` incident in USABILITY-LOG.md): a write that succeeds,
-- destroys something, and says nothing. The cascade is right for a definition
-- nobody has acted on -- a typo, a task added to the wrong event -- and wrong
-- for one people have finished.
--
-- So there are two verbs instead of one:
--
--   DELETE   allowed only while nobody has completed or been excused from the
--            task. It takes the outstanding assignments with it, which is what
--            "this task was a mistake" means.
--
--   RETIRE   sets `retired_at`. The task stops being assigned to anybody new,
--            its outstanding assignments are dropped so nobody is chased for it
--            any more, and every completed instance -- with its file, its
--            timestamp, and its place in the audit trail -- stays exactly where
--            it is. This is what "we are not collecting this any more" means.
--
-- The trigger below is what makes the difference discoverable: it refuses the
-- destructive case in a sentence naming the other verb. It sits in the database
-- rather than in the handler on purpose, because both previous incidents
-- arrived through paths no handler was on -- a seed script and a sqlite3 shell.

ALTER TABLE task_definition ADD COLUMN retired_at TEXT;

-- Retired tasks are excluded from assignment by `src/core/tasks.js`, and this is
-- the index that keeps the exclusion cheap on the list and dashboard queries.
CREATE INDEX task_definition_live ON task_definition (event_id, retired_at);

-- The `event still exists` guard is what keeps deleting a whole conference
-- working: that arrives here as a cascade, the definitions go with the event
-- inside the same statement, and nobody is trying to protect the completed work
-- of an event that is on its way out with everything else. Same shape as the
-- routing-rule guards in 010.
CREATE TRIGGER task_definition_delete_blocked_by_completed_work
BEFORE DELETE ON task_definition
WHEN EXISTS (SELECT 1 FROM task_instance
              WHERE definition_id = OLD.id AND status IN ('done', 'waived'))
 AND EXISTS (SELECT 1 FROM event WHERE id = OLD.event_id)
BEGIN
  SELECT RAISE(ABORT,
    'speakers have already completed this task, and deleting it would delete '
    || 'that record along with the link to anything they uploaded for it. '
    || 'Retire it instead -- it stops being assigned and stops being chased, '
    || 'and what people have done stays: '
    || 'POST /e/<event>/tasks/definitions/<task>/retire, or '
    || 'conf tasks <event> --retire <task>');
END;
