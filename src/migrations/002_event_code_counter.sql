-- 002_event_code_counter.sql
--
-- Session codes (SESS-1, SESS-2, ...) were derived from the highest code
-- currently in the table, which meant deleting SESS-2 handed that code to the
-- next submission created. Codes appear in already-sent email and in printed
-- programmes, so reusing one points a speaker at somebody else's session.
--
-- The counter is a high-water mark instead: it only ever goes up, and a deleted
-- code stays retired.

ALTER TABLE event ADD COLUMN code_counter INTEGER NOT NULL DEFAULT 0;

-- Seed from whatever codes already exist, so an in-flight database keeps
-- counting from the right place rather than restarting at 1.
UPDATE event SET code_counter = (
  SELECT COALESCE(MAX(CAST(substr(code, instr(code, '-') + 1) AS INTEGER)), 0)
    FROM submission
   WHERE submission.event_id = event.id
     AND code GLOB 'SESS-[0-9]*'
);
