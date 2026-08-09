// Apply pending migrations and report what happened.
//
//   npm run migrate

import { openDatabase, DEFAULT_DB_PATH, migrate } from './db.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.argv[2] ?? DEFAULT_DB_PATH;

mkdirSync(dirname(path), { recursive: true });
const db = new DatabaseSync(path);
db.exec('PRAGMA foreign_keys = ON');

const applied = migrate(db, { log: (m) => console.log(m) });

if (applied.length === 0) console.log('database is up to date');
else console.log(`applied ${applied.length} migration(s) to ${path}`);

db.close();
