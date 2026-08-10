-- 011_accounts.sql
--
-- Accounts, so that who may organize is a fact in the database rather than a
-- fact about which network interface the server happens to be bound to.
--
-- What this replaces: `organizerAccessIsOpen()` returned true whenever HOST was
-- loopback, and canOrganize() short-circuited on it. Every organizer screen was
-- therefore wide open locally and slammed shut on any public address, which
-- meant the app behaved like two different products depending on how it was
-- started, and that the deployed behaviour was the one nobody ever exercised.
-- It also hid real holes: /login was broken for months and nothing noticed,
-- because local development never needs to sign in.
--
-- Three principals, three credentials, and that is a deliberate cost. DESIGN.md
-- asks for one obvious way to do each thing, and this is three. It is worth it
-- only because they are genuinely different people:
--
--   a speaker   clicks a link. No password, ever -- the requirement is that they
--               reach their portal without a heavy signup, and a password is one
--               more thing to lose the week before a conference.
--   staff       type an email and a password. This is the one that needs saying:
--               this app has no SMTP and never sends anything, so a magic link
--               cannot be delivered to an organizer who is locked out. Making
--               staff sign-in link-only would not be friction at a boundary that
--               deserves it, it would be an outage.
--   a script    sends a bearer token. curl, the eval harness, the acceptance
--               suite, CI. One header is something a recipe can carry; a cookie
--               jar is not.

-- Instance administrator. A column on `person` rather than a table because
-- ctx.person is already a whole row on every request, so this costs no extra
-- query, and because it is not a secret.
--
-- Deliberately narrow. Everything an organizer does day to day -- accept,
-- decline, notify, mail, schedule, publish -- is per-event and stays that way.
-- This exists for the three things that have no event to check against:
-- bootstrapping the first account, recovering an event whose only owner has
-- left, and granting the first membership on an event you are not yet in.
ALTER TABLE person ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0
  CHECK (is_admin IN (0, 1));

-- Passwords live in their own table so that `SELECT * FROM person` -- which is
-- what ctx.person is, and what gets handed to shaping functions all over the
-- app -- can never accidentally carry a hash into a response.
--
-- scrypt, N=2^17 r=8 p=1, per OWASP's Password Storage guidance, which ranks
-- Argon2id first and scrypt second and specifies exactly these parameters when
-- Argon2id is unavailable. It is unavailable: it is not in node:crypto and this
-- project takes no dependencies. Node's own scrypt defaults (N=2^14) are below
-- that floor, so the parameters are always passed explicitly, and stored in the
-- hash string so they can be raised later and old hashes upgraded on next use.
CREATE TABLE person_credential (
  person_id     INTEGER PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,          -- scrypt$N$r$p$<salt-b64u>$<derived-b64u>
  updated_at    TEXT NOT NULL
);

-- Credentials for things that are not browsers.
--
-- Only the hash is stored, like every other token here. `prefix` is the first
-- few characters kept in the clear so a token is identifiable in a list without
-- being reconstructable -- "which of these is the eval harness's" is a question
-- an organizer has to be able to answer before revoking one.
CREATE TABLE api_token (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  person_id    INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  expires_at   TEXT,
  last_used_at TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX api_token_by_person ON api_token (person_id);

-- Idle timeout, alongside the absolute deadline already in expires_at.
--
-- Staff hold accept, decline, irreversible notify and bulk mail; a speaker holds
-- their own biography. NIST SP 800-63B-4 puts those at different assurance
-- levels and this app can simply follow it: staff 24h absolute / 1h idle (AAL2),
-- speakers 30 days (AAL1). Both deadlines are computed when the session is
-- minted, so the per-request check stays two comparisons and no branch.
ALTER TABLE auth_session ADD COLUMN last_seen_at TEXT;
ALTER TABLE auth_session ADD COLUMN idle_deadline TEXT;
CREATE INDEX auth_session_by_person ON auth_session (person_id);

-- Instance-wide state. Currently one row: the hash of the setup token.
CREATE TABLE instance_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Failed credential attempts, for throttling. A table rather than memory, so it
-- survives a restart and needs no second datastore.
CREATE TABLE auth_attempt (
  id  INTEGER PRIMARY KEY,
  key TEXT NOT NULL,                    -- 'signin:<email>' | 'setup:<ip>'
  at  TEXT NOT NULL
);
CREATE INDEX auth_attempt_by_key ON auth_attempt (key, at);
