-- Users, and an owner on every page and session (#230, ADR-008 §1 and §5).
--
-- Additive, in migration 0004's pattern: new columns default to the operator, so every
-- page, session and grant that exists today carries over untouched, and the Worker live
-- during the migration window (ADR-002 §3) never reads a column it does not know about.
--
-- 🔴 The operator is a `role`, never `id = 1`. The literal 1 below is a migration-time
-- fact — this INSERT chooses the seed row's id so the DEFAULT clauses and the backfill in
-- 0010 can name it — and nothing at runtime resolves the operator by number. `auth.ts`
-- asks `WHERE role = 'operator'`. `DEFAULT_PAGE_ID` was "the only row there can be" before
-- it was "the page a request that names none is about", and untangling the two meanings
-- cost a release (#152). Identity is not a row number.
--
-- `email` is NULL on the seed row and stays so until #231 learns the operator's address
-- from `KNAG_OPERATOR_EMAIL` on the first login request. A migration cannot read a
-- secret, and a placeholder address would be a value something could match against.
-- Nullable-with-a-unique-index is the same shape as `sessions.public_id` (0003): SQLite
-- treats NULLs as distinct, so one row without an address is fine and two cannot collide.
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT,                       -- unique, case-insensitive; NULL only on the seed row until #231
  role         TEXT NOT NULL DEFAULT 'member',   -- 'operator' | 'member'
  created_at   TEXT NOT NULL,              -- ISO8601 UTC, always with Z
  revoked_at   TEXT,                       -- stamped by revoke (#232); a revoked user's sessions do not resolve
  last_seen_at TEXT                        -- written by #232, throttled; never on every poll
);

CREATE UNIQUE INDEX idx_users_email ON users(email COLLATE NOCASE);

INSERT INTO users (id, email, role, created_at)
VALUES (1, NULL, 'operator', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

-- Every existing page and session is the operator's. `NOT NULL DEFAULT 1` is what makes
-- the backfill a DEFAULT rather than an UPDATE, exactly as `revisions.page_id` in 0004.
-- No REFERENCES clause, for 0004's reason: a column added by ALTER TABLE may carry a
-- foreign key only if its default is NULL. Ownership is enforced in store.ts, where every
-- read and write names the owner it is about.
ALTER TABLE pages    ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN user_id  INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_pages_owner    ON pages(owner_id);
CREATE INDEX idx_sessions_user  ON sessions(user_id);

-- 🔴 A page name is unique **per owner**, not globally. Two people each have a `today`.
-- Dropping and recreating an index is not destructive (0005 did the same): no row is
-- touched, and the rule the old Worker sees during the window is strictly wider than the
-- one it enforced, so it cannot fail a write it would previously have accepted.
DROP INDEX idx_pages_name;
CREATE UNIQUE INDEX idx_pages_name ON pages(owner_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
