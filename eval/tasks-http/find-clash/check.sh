# Ground truth comes from the app's own conflict detection, which is covered by
# unit tests of its own. What is being measured here is whether the model can
# find the answer, not whether the detector is right.
answer=$(cat)

codes=$(./bin/conf conflicts manzanita-2026 --json | node -e '
  let raw = "";
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    const clash = JSON.parse(raw).find((c) => c.kind === "speaker_double_booked");
    process.stdout.write(clash ? clash.sessions.join(" ") : "");
  });
')

if [ -z "$codes" ]; then
  echo "no speaker double-booking in the seed; this task cannot be scored"
  exit 2
fi

echo "expected to mention: $codes"
for code in $codes; do
  if ! printf '%s' "$answer" | grep -qi -- "$code"; then
    echo "missing $code"
    exit 1
  fi
done
