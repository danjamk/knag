-- Notes added to a past history entry (#253, ADR-008 §12).
--
-- Additive: a new table, read by nothing the live Worker runs during the migration
-- window (ADR-002 §3).
--
-- 🔴 **Append-only, and that is the whole point rather than a simplification.** The wipe
-- record is worth something because it is evidence of what happened; a tool that can
-- rewrite a past snapshot can quietly turn a bad session into a good one and nothing
-- downstream can tell. So there is no update path and no delete path — a correction is
-- another row. That rule lives in the absence of the routes, not in a constraint here,
-- and the tests assert the absence.
--
-- No `owner_id` column. An annotation belongs to a revision, a revision to a page, and a
-- page to an owner — the owner is reachable by join and denormalizing it would create a
-- second place for the answer to live, which is how one person ends up reading another's
-- (the two-page bug, one dimension over). Every query in `store.ts` joins to `pages` and
-- names the owner.
CREATE TABLE annotations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES revisions(id),
  text        TEXT    NOT NULL,
  -- `pwa` | `agent` | `system`, the same vocabulary `revisions.source` uses. An
  -- annotation says who added it for the same reason an entry does.
  author      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL   -- ISO8601 UTC, always with Z
);

-- The read is "every annotation for these revisions, oldest first", which is how they
-- are shown: a correction reads after the thing it corrects.
CREATE INDEX idx_annotations_revision ON annotations(revision_id, created_at);
