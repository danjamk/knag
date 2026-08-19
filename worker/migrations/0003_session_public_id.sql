-- Give every session a surrogate id that is safe to put in a response body (#125).
--
-- 🔴 `token_hash` is the primary key and it is the SHA-256 of a live credential. It
-- must never leave the Worker, so revoking a session by name needs an identifier that
-- is not derived from the secret at all. `public_id` is 16 random bytes, unrelated to
-- the token, and knowing one grants nothing — revocation is still authenticated.
--
-- 🔴 Three statements rather than one column definition, and that is not style.
-- SQLite's ALTER TABLE refuses to add either a PRIMARY KEY or a UNIQUE column:
--
--     ALTER TABLE sessions ADD COLUMN id INTEGER PRIMARY KEY AUTOINCREMENT;
--       → Cannot add a PRIMARY KEY column
--     ALTER TABLE sessions ADD COLUMN public_id TEXT UNIQUE;
--       → Cannot add a UNIQUE column
--
-- Both were tried. The way through is a plain column, a backfill, and a unique index
-- created separately — all three additive, which is the rule here because `make
-- migrate` runs *before* `make deploy` and the deployed Worker runs against the new
-- schema in the gap (ADR-002 §3). Rebuilding the table instead would be destructive
-- and would take two releases.
--
-- The same trap sits in front of `documents` and its `CHECK (id = 1)`, recorded in
-- spec §17 for whenever a few pages happens.

ALTER TABLE sessions ADD COLUMN public_id TEXT;

-- `randomblob` is SQLite's own, so existing sessions are backfilled here rather than
-- by a one-off script that someone has to remember to run. Sessions live a year, so
-- there are real rows to carry over — this is not a formality.
UPDATE sessions SET public_id = lower(hex(randomblob(16))) WHERE public_id IS NULL;

-- Enforced by an index because the column could not carry the constraint itself.
-- Note SQLite treats NULLs as distinct in a unique index, so this does not stop a
-- future insert that forgets to set it — `createSession` in store.ts always does, and
-- the security suite covers it.
CREATE UNIQUE INDEX idx_sessions_public_id ON sessions(public_id);
