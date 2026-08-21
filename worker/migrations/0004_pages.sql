-- Expand: give the document a page dimension (#152, phase 6a of #123).
--
-- 🔴 This is the *expand* half of an expand/contract pair and it is the first one this
-- project has run. `documents` is not altered and not dropped here — that is #155, in a
-- later release. Everything below is additive, because `make migrate` runs *before*
-- `make deploy` and the currently deployed Worker runs against the new schema in the gap
-- (ADR-002 §3).
--
-- 🔴 Why a new table rather than a column. §17 said the insurance was `page_id INTEGER
-- NOT NULL DEFAULT 1`, additive, one UPDATE. That is true for `revisions`. It is not
-- true for `documents`:
--
--     id INTEGER PRIMARY KEY CHECK (id = 1)
--
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT, so lifting that CHECK means a full
-- table rebuild — create, copy, drop, rename — which is destructive. `pages` is that
-- rebuild, done as an addition, with the old table left standing until it is safe to
-- drop.

-- The live state of every page. This *is* the document row — one page is one body, one
-- version, one CAS target — with `documents`'s CHECK lifted and a name added.
--
-- `template` is NULL until someone saves one, and a template is a saved body: no
-- template language, no variables, no placeholders (#154). It is here rather than in its
-- own table because it is one nullable column and a table would imply a history it does
-- not have.
CREATE TABLE pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,   -- ISO8601 UTC, always with Z
  source     TEXT    NOT NULL,   -- 'pwa' | 'agent' | 'system'
  template   TEXT,               -- NULL until saved
  created_at TEXT    NOT NULL
);

-- 🔴 Unique and case-insensitive, decided here rather than in #153 where it is needed.
-- The MCP `page` parameter resolves by *name* — an agent says `page: "shopping"`, not
-- `page: 3` — and two pages that differ only in case would make that lookup ambiguous
-- against the only copy of a document. Adding this later could fail on rows that already
-- exist, which is the whole reason a uniqueness decision is cheapest before there are
-- two of anything.
CREATE UNIQUE INDEX idx_pages_name ON pages(name COLLATE NOCASE);

-- Carry today's document over as page 1. `id` is written explicitly: it has to equal
-- DEFAULT_PAGE_ID in store.ts, which is what every existing caller resolves to.
--
-- Named `today`, which is what tier 1 has always displayed. The name is not new
-- information — it is the label coming out of the markup and into the data, which is
-- what makes it renameable in #154.
INSERT INTO pages (id, name, body, version, updated_at, source, template, created_at)
SELECT 1, 'today', body, version, updated_at, source, NULL, updated_at
  FROM documents WHERE id = 1;

-- Defensive, and for the same reason 0001 seeds `documents`: a missing row would make
-- every read take the "empty at version 0" path (spec §14.5), which is a valid state and
-- therefore indistinguishable from a failed migration. The seed means the normal path
-- never exercises the defensive one.
INSERT INTO pages (id, name, body, version, updated_at, source, template, created_at)
SELECT 1, 'today', '', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system', NULL,
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE NOT EXISTS (SELECT 1 FROM pages WHERE id = 1);

-- 🔴 The genuinely additive half, exactly as §17 predicted. Every existing revision
-- belongs to page 1, which is what the default backfills.
--
-- No REFERENCES clause, and that is SQLite rather than a choice: a column added by
-- ALTER TABLE may carry a foreign key only if its default is NULL, and this one must be
-- NOT NULL DEFAULT 1 to backfill. The integrity that matters is enforced in store.ts,
-- where every revision write takes the page it belongs to.
ALTER TABLE revisions ADD COLUMN page_id INTEGER NOT NULL DEFAULT 1;

-- 🔴 Replaces idx_revisions_created_at for every query in store.ts, all of which now
-- carry a page. The old index is left in place: dropping it is a contraction, it costs
-- one index on a table of a few hundred rows, and it goes with `documents` in #155.
CREATE INDEX idx_revisions_page_created_at ON revisions(page_id, created_at);

-- `cleared_items` needs nothing. It scopes through `revision_id`, so a cleared item's
-- page is its revision's page — asserted by a test rather than trusted.
