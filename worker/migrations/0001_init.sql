-- knag — initial schema.
--
-- Naming follows claude-shared/docs/guides/database-conventions.md:
-- plural tables, `is_` boolean prefix, `_at` timestamps, idx_{table}_{column}.
--
-- All access to these tables goes through worker/src/store.ts. No SQL anywhere
-- else in the tree — that chokepoint is what keeps a future schema change to one
-- file (spec §17).

-- Live state. Exactly one row, id = 1 (DOC_ID in store.ts).
CREATE TABLE documents (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  body       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,   -- ISO8601 UTC, always with Z
  source     TEXT    NOT NULL    -- 'pwa' | 'agent' | 'system'
);

-- Append-only history, coalesced: a save within 10 minutes of the newest
-- unsealed revision updates it in place rather than inserting. Full snapshots,
-- not diffs — the document is a few KB and diffs are computed at read time.
CREATE TABLE revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  body       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  created_at TEXT    NOT NULL,
  -- Sealed revisions are never coalesced into. clear-completed seals the newest
  -- revision first, so the pre-clear state cannot be swallowed by the window.
  is_sealed  INTEGER NOT NULL DEFAULT 0,
  source     TEXT    NOT NULL,
  event_type TEXT                 -- NULL | 'clear_completed'
);

-- Explicit record of swept items, so "what did I finish" is a lookup rather than
-- a diff. This is the authoritative done-record; the revision diff is derived.
CREATE TABLE cleared_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES revisions(id),
  line_text   TEXT    NOT NULL,
  cleared_at  TEXT    NOT NULL
);

-- Only the SHA-256 of the cookie value is stored, never the value itself.
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  device_label TEXT             -- 'iphone', 'ipad', 'mac' — optional, set at login
);

CREATE INDEX idx_revisions_created_at ON revisions(created_at);
CREATE INDEX idx_cleared_items_cleared_at ON cleared_items(cleared_at);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- First boot. Without this every read on a fresh deploy has no row to find.
-- The Worker is defensive about it anyway (spec §14.5) — a missing row reads as
-- an empty body at version 0 rather than an error — but seeding here means the
-- normal path never exercises the defensive one.
INSERT INTO documents (id, body, version, updated_at, source)
VALUES (1, '', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system');
