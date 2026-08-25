-- Settings the server holds (#190).
--
-- One table, key/value, and today one key: `agent_instructions` — the free text the
-- operator appends to the MCP server's instructions. Every other preference in the
-- product is localStorage, per device, and this is the first that is not: it is about
-- the account rather than the browser, and it has to reach a bearer caller that has no
-- browser at all.
--
-- Additive (ADR-002 §3): a new table, read by nothing the live Worker runs during the
-- migration window. Multi-user (#122) adds an owner column here rather than a second
-- table; nothing in the shape assumes there is only one operator, only that today there is.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL   -- ISO8601 UTC, always with Z
);
