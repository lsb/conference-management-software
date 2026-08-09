-- 009_publish_requires_approval.sql
--
-- `published = 1` on its own does nothing, and said nothing about it.
--
-- Every public surface requires accepted AND published AND content approved.
-- Somebody who sets the flag whose name is `published` has every reason to
-- believe they have published something. They have not, there is no error, and
-- they find out from an empty website -- if they ever find out at all.
--
-- We have now watched this happen twice. Once to us, when the approval gate
-- shipped and the seed published without approving, and the demo agenda went
-- blank with nothing saying so. And once to a local model driving the app,
-- which ran the UPDATE, read back published = 1, and reported that the session
-- was now on the public agenda. It was not.
--
-- A warning on the organizer dashboard was the first fix. It does not help,
-- because it is on a screen you have no reason to visit when you believe you
-- have already finished. So the database refuses instead, and says what to do.
--
-- This is deliberately at the lowest level rather than in a handler: the
-- failures both arrived through paths no handler was on -- a seed script and a
-- sqlite3 shell.

CREATE TRIGGER submission_publish_requires_approval_update
BEFORE UPDATE OF published ON submission
WHEN NEW.published = 1 AND NEW.content_status <> 'approved'
BEGIN
  SELECT RAISE(ABORT,
    'a session cannot be published until its content is approved. '
    || 'Approve it first: POST /e/<event>/submissions/<code>/content with content_status=approved');
END;

CREATE TRIGGER submission_publish_requires_approval_insert
BEFORE INSERT ON submission
WHEN NEW.published = 1 AND NEW.content_status <> 'approved'
BEGIN
  SELECT RAISE(ABORT,
    'a session cannot be created already published unless its content is approved');
END;

-- Anything already in this state was published before the rule existed. Rather
-- than leave rows the trigger would now reject, make them consistent: they are
-- on the public agenda, so somebody did approve of them being there.
UPDATE submission SET content_status = 'approved'
 WHERE published = 1 AND content_status <> 'approved';
