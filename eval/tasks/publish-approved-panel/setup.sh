source eval/tasks/_setup-common.sh

# The seed leaves SESS-6 accepted but with no slot, which would make this two
# jobs. Give it a room and a time in a corner of the grid nothing else uses, so
# the only things standing between the panel and the public agenda are the two
# this task is about: approving the content, and publishing.
sqlite3 data/conference.db "
  UPDATE submission
     SET room_id   = (SELECT r.id FROM room r JOIN event e ON e.id = r.event_id
                       WHERE e.slug = 'manzanita-2026' AND r.slug = 'madrone-studio'),
         starts_at = '2026-10-13T18:00:00Z',
         ends_at   = '2026-10-13T18:45:00Z'
   WHERE code = 'SESS-6'
     AND event_id = (SELECT id FROM event WHERE slug = 'manzanita-2026');"
