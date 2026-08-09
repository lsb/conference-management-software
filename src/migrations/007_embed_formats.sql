-- 007_embed_formats.sql
--
-- An embed was a styled HTML fragment and nothing else. That covers the common
-- case -- a conference dropping its agenda into its own site -- and misses the
-- two other things people actually ask for:
--
--   * a JSON or XML feed, because the conference website is built by somebody
--     with their own templates who wants the data, not our markup;
--   * an iCalendar feed, so attendees can subscribe to the schedule rather than
--     downloading it once and never seeing the room change.
--
-- Same query behind all four. Only the rendering differs.

ALTER TABLE embed ADD COLUMN format TEXT NOT NULL DEFAULT 'html'
  CHECK (format IN ('html', 'json', 'xml', 'ics'));

-- What to include. Defaults match what the HTML fragment already showed, so
-- existing embeds render exactly as they did before this migration.
ALTER TABLE embed ADD COLUMN include_description INTEGER NOT NULL DEFAULT 1;
ALTER TABLE embed ADD COLUMN include_speakers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE embed ADD COLUMN include_room INTEGER NOT NULL DEFAULT 1;
ALTER TABLE embed ADD COLUMN accent_color TEXT NOT NULL DEFAULT '';
