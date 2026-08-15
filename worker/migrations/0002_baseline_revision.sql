-- Seed one revision from whatever the document is right now.
--
-- Revisions arrive with issue #7, after the document has already been edited. Without
-- this, the state at the moment the log was introduced is the one state never
-- recoverable from it: the first write after this ships snapshots its own *result*, so
-- everything before it would be gone. That contradicts principle 4 — deletion is not
-- loss.
--
-- Sealed on purpose. An unsealed baseline would be coalesced into by the very next
-- save, which would overwrite the thing this row exists to preserve.
--
-- Additive-only, per ADR-002 §3: it adds a row, changes no schema, and the currently
-- deployed Worker does not read this table at all — so the gap between `make migrate`
-- and `make deploy` is uneventful.
--
-- On a fresh database this records the seeded empty document, which is correct: the
-- log then starts at "empty" rather than at the first thing typed.
INSERT INTO revisions (body, version, created_at, is_sealed, source, event_type)
SELECT body, version, updated_at, 1, source, NULL
  FROM documents
 WHERE id = 1;
