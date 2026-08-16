# Changelog

All notable changes to knag are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow
[SemVer](https://semver.org/) per
[claude-shared/docs/guides/versioning-and-releases.md](../claude-shared/docs/guides/versioning-and-releases.md):
a version names released code, and a deployment reports `<version>+<shortsha>` for
exactly what it is running.

**This file starts at 0.1.11.** Everything before it was build mode — a shape still
moving, with the patch bumped per PR and no releases cut. Backfilling entries from
git history would produce something nobody could trust, so the release below
summarises the phase rather than pretending it was written as it happened.

## [Unreleased]

### Added

- **The MCP server at `POST /mcp`**, with four tools — `knag_read`, `knag_write`,
  `knag_wipe`, `knag_history` ([#14](https://github.com/danjamk/knag/issues/14)). This
  is the agent half of the product rather than a feature bolted on: knag is one
  plain-text page precisely so an agent can read all of it and rewrite all of it. It is
  also, for now, the only way to read history. A conflict reaches the agent as a
  correctable result carrying the current version *and* body — never an HTTP 500 —
  because the contract is "re-read and re-apply", not "retry".
- **Server instructions carry the product voice**, not just the agent contract. `wiped
  6` rather than "Successfully cleared 6 completed items!" — one string, and every agent
  conversation is on-brand.
- **`GET /api/history?since=&until=`** — what changed and what got finished, grouped by
  local day ([#15](https://github.com/danjamk/knag/issues/15)). Each revision in range
  carries the lines that `appeared` and `disappeared` since the one before it, and each
  day carries the `cleared_items` swept that day, which are the authoritative record of
  what was done. Both parameters take a bare date or a full ISO instant; the default is
  the last seven days.
- **Timezone-aware day boundaries.** "What did I finish Tuesday" is a local-time
  question, and answered in UTC it files everything after ~7pm Chicago onto Wednesday.
  Boundaries resolve to local midnight in `KNAG_TZ` and grouping is by local date. The
  conversion is a fixed point over `Intl.DateTimeFormat` rather than offset arithmetic:
  a single probe is right for every local midnight in Chicago and an hour wrong for
  03:30 on a spring-forward morning. Verified against both US transitions and against a
  zone that springs forward *at* midnight, where the day knag reports starts when the
  day actually starts.

### Changed

- **`/mcp` is bearer-only**, unlike every other route, which accepts the session cookie
  too. It is what makes `/mcp` free of ambient authority — the premise behind logging a
  foreign `Origin` rather than blocking it, which is the rule that keeps claude.ai's web
  app working. Pinned in `pnpm test:security`.
- **Rendered formatting is out, and now says why**
  ([ADR-004](docs/adr/ADR-004-display-matches-the-bytes.md)). The rule behind
  three decisions already made separately: the display never diverges from the
  bytes. Indentation was never covered by it and already works; bold, italic and
  styled headings are not coming. Documentation only — no behavior changed.
- **The 7-day iOS cookie check is deferred**, not dropped ([#4](https://github.com/danjamk/knag/issues/4)).
  Holding a phone untouched for a week blocks the more valuable activity — using
  knag. Nothing since the auth work has touched auth, and the failure mode
  self-reports: ITP fires only after seven days of inactivity, so if it ever bites
  you simply get logged out. Run it on a second iOS device when convenient.

### Fixed

- **`make health ENV=dev` now checks dev.** A single `HOST` in `.env` satisfied both
  environments and silently overrode the Makefile's per-environment default, so the
  dev check pointed at the prod domain — which does not resolve. The one command
  whose job is verifying a deployment had therefore never verified dev.

## [0.1.11] — 2026-08-15

The first plateau: a legal pad you can actually live in.

### Added

- **One typing-first editor.** Every row is a live text field with its checkbox
  beside it — no mode to choose, no tap-to-activate step. `Enter` splits a line,
  `Backspace` at the start merges it into the one above, arrows cross at the
  boundaries. Fenced code blocks are editable in place.
  ([ADR-003](docs/adr/ADR-003-single-mode-editor.md))
- **`--` plus a space becomes a checkbox**, and an immediate `Backspace` undoes it,
  so a literal `--` is still typeable. A single `- ` stays a literal dash: rendering
  it as a bullet would be the first place the display differs from the bytes.
- **A row mode for rearranging** — drag by the grip, copy a row, delete a row.
  Delete does not confirm, because the revision log is the undo.
- **Clear completed**, which sweeps checked items and writes what it removed to an
  explicit done-record, so "what did I finish" is a lookup rather than a diff.
- **A coalesced revision log.** Every save is recorded; saves within ten minutes of
  each other fold into one entry. Deletion is not loss.
- **Live sync across devices**, polled with adaptive backoff so three devices stay
  inside the free tier. A remote update is never applied while you are typing — it
  waits for the cursor to leave.
- **Optimistic concurrency on every write.** An iPad left open for three days cannot
  save a stale body over a week of work; it gets a conflict carrying the current
  document instead.
- **Passphrase login** with a year-long, server-set session cookie, and a separate
  bearer token for agents. ([ADR-001](docs/adr/ADR-001-passphrase-auth.md))
- **Light, dark, and system themes**, following the OS by default and following it as
  it changes.
- **A settings panel** carrying theme, the raw-text escape hatch, and the build
  info — version, environment, commit and local deploy time.
- **Installable as a PWA** on iPhone, iPad and macOS, with a service worker that
  caches the shell and never a document response.

### Notes

- **Nothing is normalized.** Indentation, blank lines, trailing whitespace, CRLF, and
  `*` vs `-` all survive a round trip. This is enforced by a property test over
  generated documents, not by inspection.
- **Not yet included:** the MCP server and the history API. Both are specified and
  deliberately deferred.
- **Not yet verified:** that the session cookie survives seven days of iOS inactivity.
  Checked 2026-08-22. If it does not, auth needs rework.

[Unreleased]: https://github.com/danjamk/knag/compare/v0.1.11...HEAD
[0.1.11]: https://github.com/danjamk/knag/releases/tag/v0.1.11
