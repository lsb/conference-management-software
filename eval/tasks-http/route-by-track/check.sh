# Feature 1: custom submission forms with category-based routing.
#
# Judged by the rule existing and pointing somewhere real, not by prose. A rule
# that names a review round nobody is in, or that sets a track and no round,
# would leave proposals sorted into a queue nobody reads.
cat > /dev/null

rules=$(sqlite3 data/conference.db \
  "SELECT count(*) FROM form_routing_rule r
     JOIN form f ON f.id = r.form_id
     JOIN event e ON e.id = f.event_id
    WHERE e.slug='manzanita-2026' AND r.plan_id IS NOT NULL;")

echo "routing rules with a review round: $rules"
[ "${rules:-0}" -ge 1 ]
