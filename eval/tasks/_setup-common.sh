# Reset the conference to its seeded state. Sourced by each task's setup.sh so
# attempt 2 cannot succeed on work attempt 1 already did.
npm run seed >/dev/null 2>&1
