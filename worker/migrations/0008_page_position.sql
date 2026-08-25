-- Pages get an order (#195).
--
-- The switcher and manage-pages listed pages by `id` — creation order — and nothing
-- could change it. Order is a property of the pages, not of a device, so it lives here
-- and every device sees the same one. It is NOT a column in the switcher: the list still
-- shows a name and nothing else (§7, "a column is a file manager"); what it is sorted by
-- is not something it displays.
--
-- Additive (ADR-002 §3): a nullable column, backfilled to `id` so the order nobody has
-- touched is exactly the order there was. The Worker live during the migration window
-- never reads it; the one that follows reads `COALESCE(position, id)`, so a row that
-- somehow has no position still sorts where it always did.
ALTER TABLE pages ADD COLUMN position INTEGER;

UPDATE pages SET position = id WHERE position IS NULL;
