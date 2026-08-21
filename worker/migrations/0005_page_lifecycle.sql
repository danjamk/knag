-- Pages gain a lifecycle: templates and soft delete (#154).
--
-- 🔴 **Deleting a page must not delete its history.** Principle 4 is that deletion is not
-- loss and the revision log is the undo — which is also what lets the delete control skip
-- a confirmation dialog. A hard delete would make that sentence false at exactly the
-- moment it matters most, and there is no undo screen to fall back on (#91 is still 1.1).
--
-- So a page is retired rather than removed: `deleted_at` is stamped, `listPages` and
-- `findPageByName` stop returning it, and every revision and cleared item it ever had
-- stays exactly where it was. Recovering one is clearing a single column.

ALTER TABLE pages ADD COLUMN deleted_at TEXT;

-- 🔴 The unique index has to become **partial**, or a deleted name stays taken forever —
-- delete `shopping`, and you can never make a page called `shopping` again. That reads as
-- a bug and there is no screen that would explain it.
--
-- Dropping and recreating an index is not a destructive migration: no row is touched and
-- nothing is unrecoverable. What it does open is a window between `make migrate` and
-- `make deploy` where uniqueness is briefly enforced by the *new* rule while the old
-- Worker is still running — which is strictly wider, never narrower, so the old Worker
-- cannot fail a write it would previously have accepted (ADR-002 §3).
DROP INDEX idx_pages_name;
CREATE UNIQUE INDEX idx_pages_name ON pages(name COLLATE NOCASE) WHERE deleted_at IS NULL;
