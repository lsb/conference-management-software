// Mint an organizer API token and print it. Nothing else on stdout.
//
//   node eval/mint-token.js            the seeded administrator
//   node eval/mint-token.js <email>    somebody else
//
// The HTTP eval hands this to the model in its prompt, the way an operator would
// hand one to a contractor. It is the only thing the model is given besides a
// URL: no repository, no command line, no source.

import { openDatabase } from '../src/db.js';
import { createApiToken } from '../src/core/auth.js';

const email = process.argv[2] ?? 'naomi.okafor@example.com';
const db = openDatabase();

const person = db.prepare('SELECT id, email FROM person WHERE lower(email) = ?')
  .get(email.toLowerCase());

if (!person) {
  console.error(`no person with email ${email}. Run \`npm run seed\` first.`);
  process.exit(1);
}

// One per call, and never reused: a token left over from a previous attempt is
// a way for attempt N to coast on attempt N-1.
process.stdout.write(`${createApiToken(db, person.id, `eval ${new Date().toISOString()}`)}\n`);
db.close();
