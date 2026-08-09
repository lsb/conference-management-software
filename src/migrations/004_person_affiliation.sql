-- 004_person_affiliation.sql
--
-- Public speaker listings are expected to show who somebody is as well as what
-- they are called: "Priya Raman, Principal Engineer, Latticework Systems". We
-- were storing only the name and a free-text biography, which meant the job
-- title and employer could only be dug out of prose -- not something a session
-- card, a directory row, or a printed programme can do.
--
-- Kept as two plain columns rather than a separate affiliation table. A person
-- has one current job as far as a conference programme is concerned, and the
-- historical record of where they worked in 2025 is not something we are in the
-- business of keeping.

ALTER TABLE person ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
ALTER TABLE person ADD COLUMN company   TEXT NOT NULL DEFAULT '';
