-- Expand: `settings` becomes `user_settings` (#234, ADR-008 §5). Release one of three.
--
-- 🔴 Migration 0007's header said multi-user would add an owner column to `settings`
-- rather than a second table. It cannot: `key` is that table's primary key, and SQLite
-- will not add a composite primary key to a live table. So this is the three-release
-- expand/contract from ADR-002 §3, and #155 is the worked example:
--
--   1. This release — create the new table, backfill, **write both, read new**.
--   2. The next — stop writing `settings`. No migration; it looks skippable and is the
--      one that does the work, because the Worker live during release 3's migration
--      must be one that no longer writes the table being dropped.
--   3. The one after — drop `settings`. `make backup` first, always.
--
-- The backfill names the seed operator by its migration-time id, for 0009's reason: the
-- row was created with `id = 1` two statements ago and nothing at runtime uses the number.
CREATE TABLE user_settings (
  user_id    INTEGER NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,   -- ISO8601 UTC, always with Z
  PRIMARY KEY (user_id, key)
);

INSERT INTO user_settings (user_id, key, value, updated_at)
SELECT 1, key, value, updated_at FROM settings;
