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

- **A wipe can be taken back for the rest of the day**
  ([#59](https://github.com/danjamk/knag/issues/59)). After a wipe the footer offers
  `wiped 6 · bring back`, and one tap puts the lines where they were. This is the feature
  that makes the wipe free: throwing things away only feels good because nothing is lost,
  and until now that was true in the database and invisible on screen.

  **It re-inserts into the page as it is now — it never writes the old page back over
  it.** Writing the snapshot back is the obvious implementation and it discards
  everything typed since the wipe, which would make the safety net a worse data-loss path
  than the one it prevents. Anything added after the wipe survives, edits to surviving
  lines survive, and restoring twice changes nothing.

  Works for both scopes, including a wipe-all, where the unfinished lines come back too.
  The offer lives on the device where the wipe happened, survives a reload, and expires
  at that device's next midnight — not twenty-four hours later, so a wipe at 23:58 is not
  still being offered at lunchtime.

  Restore is an ordinary versioned write: same conflict handling as any other save, and a
  409 reloads and leaves the offer standing rather than retrying blind.

- **Wipe the whole page, not just the finished items**
  ([#58](https://github.com/danjamk/knag/issues/58)). The second scope of the product's
  central gesture, and what a short-lived page actually needs — on a grocery list you do
  not tick the last three things, you are simply done. In settings rather than on the
  toolbar, which is capped at three controls and reserved for what you reach for often.
  Always confirms, and names the number it is about to throw away.

  `knag_wipe` takes the same `scope`, and its description tells an agent plainly that
  `all` removes work that was never finished — so it does not read as equivalent to the
  safe default.

  **A wipe-all does not inflate what you got done.** Only the checked lines are recorded
  as finished; the rest are removed without being claimed as achievements. The two counts
  are reported separately for that reason. Nothing is lost either way — the whole page is
  snapshotted before the wipe, which is what
  [#59](https://github.com/danjamk/knag/issues/59) will restore from.

- **knag connects from claude.ai, Claude Desktop and mobile**
  ([#64](https://github.com/danjamk/knag/issues/64),
  [ADR-005](docs/adr/ADR-005-mcp-oauth.md)). Add the `/mcp` URL as a custom connector
  and approve it in the browser — there is nothing to paste. Previously those surfaces
  failed at client registration, because they drive an OAuth 2.1 handshake and offer no
  field for a raw header, which left the connector working only from a terminal. For a
  product whose whole point is the phone and the iPad, that was the wrong surface to
  reach.

  **The static bearer still works and is checked first.** It is what Claude Code uses,
  and it is the fallback when a connector's OAuth dance fails — two independent ways in,
  neither depending on the other.

  **Consent reuses the login knag already has.** The approval screen is gated by the
  session cookie, and a visitor without one is sent to the ordinary login and returned
  afterwards, so the passphrase is never typed into anything but the real login form.
  That is also why the new endpoint needs no rate limit of its own: it accepts no
  credential, so the only thing worth guessing is still behind `/api/login`.

  `/mcp` continues to refuse the session cookie. An OAuth access token is a bearer
  token; the cookie authenticates the consent step in a browser and never a tool call,
  so the no-ambient-authority property that the `Origin` decision rests on is unchanged.

  The audience each token is pinned to is derived from the request origin rather than
  configured, so a `*.workers.dev` host and a custom domain each advertise themselves
  correctly and there is no value to add to both wrangler env blocks and forget in one.

### Changed

- **`/mcp` reaches Claude Code only, and the docs now say so**
  ([ADR-005](docs/adr/ADR-005-mcp-oauth.md), [#64](https://github.com/danjamk/knag/issues/64)).
  Connecting knag from Claude Desktop fails at client registration: claude.ai, Desktop
  and mobile drive an OAuth 2.1 handshake and offer no field for a raw header. v0.2.0
  shipped a static bearer on the reasoning that a single operator with no third-party
  clients does not need OAuth — the real discriminator is **which client you need to
  reach**, and knag is a phone and iPad product.

  Documentation only; no behavior changed. Spec §10 carried the wrong reasoning and now
  carries the correction, and the README says plainly which surfaces work today.

### Fixed

- **The page no longer goes stale when you return to a device**
  ([#62](https://github.com/danjamk/knag/issues/62)). A remote update was withheld while
  the editor was *focused* as well as while it was dirty — and because a browser
  restores focus to the last-focused element when you return to a window, that meant the
  update was withheld precisely when you picked a device back up. It sat in a queue with
  no expiry and no visible signal until you happened to click outside the rows.

  The caret is still protected, by putting it back after the repaint rather than by
  refusing to repaint. Only unsaved keystrokes hold an update now, and a held update
  says so instead of waiting in silence.

  Found in real use, on an iPad and a laptop, after 344 passing tests. It is now covered
  by a browser suite that changes the document from outside the page and waits for it to
  notice — reverting the fix turns four of those tests red.

- **Discovery probes get an honest 404 instead of the app**
  ([#64](https://github.com/danjamk/knag/issues/64),
  [ADR-005](docs/adr/ADR-005-mcp-oauth.md) §4). `/.well-known/*` was unrouted, and
  unrouted paths are answered by the PWA shell with a `200` — so a client looking for
  OAuth metadata received an HTML document where it expected JSON, and reported knag's
  metadata as *corrupt* rather than *absent*. knag serves no such metadata yet; it now
  says so in the one way a machine can read.

  Nothing a person can see changes. It matters because it is the first thing anyone
  debugging the connector will hit, and it was pointing at the wrong problem.

- **The browser suite is no longer flaky** ([#69](https://github.com/danjamk/knag/issues/69)).
  It failed roughly a fifth of CI runs, and the failures looked like a dozen broken tests
  when they were one dead server: `wrangler dev` exits fatally partway through a long run,
  and Playwright never restarts it, so everything after that point fails at `page.goto`
  with "Could not connect". It had already sent a PR that touched only shell scripts to a
  red CI.

  Each spec file now gets its own dev server. Measured over five runs each on a clean
  tree: **one server for twenty tests failed 4 of 5; one server per file failed 0 of 10.**

  **No retries were added, deliberately.** They were the obvious fix and would have hidden
  both this failure and the next real one — and this suite is the only place several of
  knag's guarantees are checked at all.

- **`make health` never checked which environment answered.** It compared the build id
  and stopped there — but the build id is identical whichever environment a deploy lands
  in, so the one failure `KNAG_ENV` exists to catch was the one thing the check could not
  see. A `KNAG_ENV` declared in only one of the two wrangler blocks, which `CLAUDE.md`
  warns about twice, would have passed.

  `health.sh` now takes the expected environment and fails loudly when the live one
  disagrees, saying which it got. The production deploy asserts `prod`, and also runs
  the smoke test — previously it ran only the build-id check, so prod's asset routing
  had never been verified at all.

- **`make verify` was passing on checks it never ran.** The helper that reads an HTTP
  status used `curl -f`, which exits nonzero on any 4xx — and the `|| echo "000"`
  guarding it appended to the code curl had already printed. Every non-2xx check
  compared against `"401000"` and could not match.

  The two checks affected were **`/api/doc` and `/mcp` reject anonymous** — the pair
  that assert authentication is switched on at all. They now run, and they pass.

## [0.2.0] — 2026-08-15

The agent half. The page becomes something Claude can read and rewrite.

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

### Notes

- **This completes the original spec.** Every numbered step of the build order in
  `docs/spec.md` §13 has shipped. What follows is the brand pass and the ideas that
  came out of using it, not the plan it was built to.
- **Not yet verified: the MCP server against a real client.** 377 tests cover the
  transport, the auth gate, the annotations and the conflict path, and none of them
  prove the connector appears in Claude. That check is
  [#14](https://github.com/danjamk/knag/issues/14)'s last task and the issue stays open
  until it passes. An MCP server whose own tests are green and whose tool list is empty
  in the client is a real and common failure, and this release does not claim otherwise.
- **Not yet verified:** the 7-day iOS cookie question from 0.1.11, still deferred and
  still self-reporting.
- **Production does not exist yet.** There is one environment, dev, and it holds real
  content that `docs/adr/ADR-002` says it should not. Provisioning prod is the
  outstanding operational debt of this release, not a future nicety.
- **The bundle grew from 8 KiB gzipped to 211 KiB** — the MCP SDK and zod. That is 7% of
  the free-tier ceiling, and the deploy reports a 35 ms Worker startup time against a
  400 ms limit, so it is paid for.

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

[Unreleased]: https://github.com/danjamk/knag/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/danjamk/knag/compare/v0.1.11...v0.2.0
[0.1.11]: https://github.com/danjamk/knag/releases/tag/v0.1.11
