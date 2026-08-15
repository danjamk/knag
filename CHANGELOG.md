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

### Changed

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
