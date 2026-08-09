-- 003_dedupe_person_tasks.sql
--
-- `task_instance` carried UNIQUE (definition_id, person_id, submission_id) to make
-- task assignment idempotent. It does that correctly for session-level tasks and
-- not at all for person-level ones, because those have a NULL submission_id and
-- SQLite treats every NULL in a unique index as distinct from every other NULL.
--
-- So a speaker on two accepted sessions collected two "upload a headshot" tasks,
-- and a retried notification collected another. The dashboard then overstates how
-- much work is outstanding, and the reminder engine chases the same person twice
-- for the same thing.
--
-- A partial unique index says what was actually meant: at most one person-level
-- instance of a definition per person.

-- Collapse any duplicates that already exist, keeping the most complete row so
-- that work somebody has already done is not resurrected as outstanding.
DELETE FROM task_instance
 WHERE submission_id IS NULL
   AND id NOT IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (
                PARTITION BY definition_id, person_id
                ORDER BY (status = 'done') DESC, (status = 'waived') DESC, id
              ) AS rn
         FROM task_instance
        WHERE submission_id IS NULL
     )
     WHERE rn = 1
   );

CREATE UNIQUE INDEX task_instance_one_per_person
    ON task_instance (definition_id, person_id)
 WHERE submission_id IS NULL;
