// Database access. One SQLite file, opened once, migrated on open.
//
// There is no ORM and no query builder. Queries are SQL strings next to the code
// that needs them, which means you can read any handler and know exactly what it
// does to the database.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = dirname(SRC_DIR);
const MIGRATIONS_DIR = join(SRC_DIR, 'migrations');

export const DEFAULT_DB_PATH = join(ROOT_DIR, 'data', 'conference.db');

/**
 * Open a database and bring it up to date.
 *
 * Pass ':memory:' for tests. Any other path is created if missing, along with
 * its parent directory.
 */
export function openDatabase(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  // WAL lets readers proceed during a write, which matters because the public
  // agenda is read constantly while organizers edit it. NORMAL synchronous is
  // the standard companion to WAL: durable across process crashes, and only at
  // risk from an OS-level crash mid-write.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
}

/**
 * Apply every migration that has not run yet, in filename order, each in its own
 * transaction. Migrations are append-only: never edit one that has shipped.
 */
export function migrate(db, { log = () => {} } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migration').all().map((r) => r.name),
  );

  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));

  for (const name of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)')
        .run(name, now());
      db.exec('COMMIT');
      log(`applied ${name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${name} failed: ${err.message}`, { cause: err });
    }
  }

  return pending;
}

// --- small helpers used everywhere -----------------------------------------

/** Current time as ISO-8601 UTC, second precision. The app's only clock. */
export function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Turn arbitrary text into a URL-safe slug.
 *
 * Every user-facing identifier goes through here. Slugs are what appear in URLs
 * instead of integer ids or UUIDs, so that both humans and small language models
 * can read, remember, and retype them without corrupting them.
 */
export function slugify(text, { maxLength = 60 } = {}) {
  const base = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return base || 'item';
}

/**
 * Slugify, then append -2, -3, ... until the slug is free.
 *
 * `isTaken` is a predicate so this works for any table without this module
 * needing to know the schema.
 */
export function uniqueSlug(text, isTaken, options) {
  const base = slugify(text, options);
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}
