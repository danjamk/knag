-- Login codes (#231, ADR-008 §2). Additive: a new table nothing live reads.
--
-- One row per "type your email, get a mail". The mail carries a link and a six-digit
-- code, and both point at this row: the link by `link_hash`, the code by the browser
-- that asked for it — `request_hash` is the SHA-256 of a short-lived cookie set on the
-- request, so a code typed anywhere but the screen that sent for it is worth nothing.
-- That binding is what makes six digits safe with a five-attempt limit.
--
-- 🔴 Hashes only, as `sessions` does. A dump of this table lets nobody log in.
--
-- `device_label` rides here because it is typed on the first screen and the session is
-- minted on the second. `next` is the OAuth consent hand-off (`/oauth/authorize?…`),
-- validated at write time to that one prefix, so a link tapped on a desktop lands on the
-- consent screen it was sent for rather than on the page.
CREATE TABLE login_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  link_hash    TEXT    NOT NULL,
  code_hash    TEXT    NOT NULL,
  request_hash TEXT    NOT NULL,
  device_label TEXT,
  next         TEXT,
  created_at   TEXT    NOT NULL,   -- ISO8601 UTC, always with Z
  expires_at   TEXT    NOT NULL,   -- ten minutes for a login; #232's invite is seven days
  consumed_at  TEXT,               -- single use: set by the one statement that wins
  attempts     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_login_codes_link    ON login_codes(link_hash);
CREATE UNIQUE INDEX idx_login_codes_request ON login_codes(request_hash);
-- The per-address throttle counts a person's recent rows (one a minute, five an hour).
CREATE INDEX idx_login_codes_user_created   ON login_codes(user_id, created_at);
