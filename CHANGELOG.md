# Changelog

All notable changes to knag are recorded here, following
[Keep a Changelog](https://keepachangelog.com/). Versions follow
[SemVer](https://semver.org/) per the house versioning doctrine:
a version names released code, and a deployment reports `<version>+<shortsha>` for
exactly what it is running.

**This file starts at 0.1.11.** Everything before it was build mode — a shape still
moving, with the patch bumped per PR and no releases cut. Backfilling entries from
git history would produce something nobody could trust, so the release below
summarises the phase rather than pretending it was written as it happened.

## [Unreleased]

## [0.7.2] — 2026-08-18

### Fixed

- **The smoke test failed the first production deploy, and production was fine**
  ([#105](https://github.com/danjamk/knag/issues/105)). Backup, migrate, deploy and the
  health check all succeeded. Seventeen seconds after `Uploaded 17 of 17 assets`, the
  smoke test found `/` returning 500, one font served as `text/plain` and one icon too —
  while the *other* font and the *other* icon were already correct.

  Nothing was misconfigured. Every one of those checks passes now with no intervention.
  Half an asset manifest resolving is what a rollout mid-flight looks like, and **no
  configuration error produces per-file inconsistency** — which is the tell worth
  remembering.

  `scripts/verify.sh` now takes the same propagation budget `scripts/health.sh` got in
  0.7.1, and both deploy workflows pass 90 seconds. The **whole** set is re-run rather
  than the failures, because a partial pass during a rollout says nothing. `make verify`
  still answers in one pass by default.

  **This completes the fix 0.7.1 claimed to make.** That release gave the budget to the
  health check alone, which was not enough: health asks the Worker one question and the
  Worker is the first thing to come up, while the smoke test asks about assets, routes
  and the OAuth layer, which are the last.

## [0.7.1] — 2026-08-18

Two holes in the deploy pipeline, found by using it.

### Changed

- **The browser suite now gates a production deploy**
  ([#101](https://github.com/danjamk/knag/issues/101)). It gated nothing before:
  `pnpm check` is a typecheck and a unit suite, and a prod deploy ran only that. Since
  the deploy workflow and CI fire independently, a production deploy could ship code
  whose browser job was red — or still running.

  That matters because of what the browser suite is *for*. Three bugs are on record that
  263 unit tests could not see — a CSS specificity conflict, a toolbar that reflowed, and
  rows clipped to zero height — and all three were found by a human on an iPhone.

  It runs as its own job in front of the deploy, holding no credential, so nothing
  touches the prod account until it is green — and the reviewer approval is asked after
  the tests pass rather than before, which is the right order to ask a human anything.

  **Dev deliberately does not have this gate.** Dev tracks `main` and is the rehearsal, so
  a bad dev deploy is information and self-corrects on the next merge. It is the one
  listed divergence between the two workflows.

### Fixed

- **A successful dev deploy reported itself as a failure**
  ([#99](https://github.com/danjamk/knag/issues/99)). `make health` asserts that what is
  live is the code that was just deployed. It was asking too soon: a deploy returns
  before the new Worker has finished rolling out, so the check read the *previous* build
  and called drift.

  Seen on the first run that could produce it — the deploy landed `0.7.0` at `12:05:25Z`,
  health asked nine seconds later and was served `0.6.2`. Nothing was wrong except the
  timing of the question, and the red run said the opposite.

  `scripts/health.sh` now takes a propagation budget and retries until the build id
  matches. Both deploy workflows pass 90 seconds. **A match returns immediately**, so a
  healthy deploy pays nothing, and `make health` still answers instantly by default —
  locally the question is "is what is live the code I am standing in", and a command that
  waits before answering that is a worse command.

  A wrong *environment* is never retried. That is `KNAG_ENV` declared in one wrangler
  block and not the other, and waiting does not fix a config error.

## [0.7.0] — 2026-08-18

Pick several rows in Arrange and copy or delete them together. And a control that had
been ignoring half of every tap.

### Added

- **Several rows at once, in Arrange** ([#96](https://github.com/danjamk/knag/issues/96)).
  Tap a row to pick it, tap again to put it back. Copy or delete then acts on everything
  picked, not just the row you tapped.

  Copy joins the rows with a line break and strips `- [ ] ` prefixes, exactly as copying
  a single row already did. Delete takes the whole set in one go and still does not ask —
  the revision log is the undo, and the picked rows are already tinted, so the size of
  the action is readable before you take it.

  Nothing new appears on screen and no new colour enters the palette: a picked row uses
  the existing ink-at-10% ground, one step above the row under your finger so the two
  stay apart while you drag one out of a selection.

  **This is the answer to "I cannot select across lines", and it is deliberately not the
  same thing** — it works on whole rows, so it cannot take half of one line through half
  of another. [ADR-006](docs/adr/ADR-006-cross-row-selection.md) records what was measured
  and why that gap is accepted.

### Fixed

- **Tapping the middle of a control in Arrange did nothing**
  ([#97](https://github.com/danjamk/knag/issues/97)). Tapping its edge worked, which is
  the sort of thing you blame on yourself rather than the app.

  Every control is a button wrapping a drawn glyph, and the three click handlers all
  checked for an HTML element before doing anything. **An SVG is not an HTML element**,
  so every tap that landed on the drawing — the middle half of a 36px control — was
  dropped in silence. Copy and delete in Arrange were both affected.

  It arrived with the design system, when the glyphs stopped being text and became
  drawings, and nothing caught it: the unit suite has no browser, and no test had ever
  clicked one of these controls. There is one now, and it clicks the glyph on purpose.

### Notes

- **`browser/arrange.spec.ts` is new**, because Arrange had no browser coverage at all
  and `wipe.spec.ts` is already at the point where `scripts/browser-tests.sh` says a spec
  file starts flaking. Twelve tests, including the one that would have caught #97.

## [0.6.2] — 2026-08-17

The up and down arrows behave like a text editor's.

### Fixed

- **`↓` and `↑` move to the next row in one press, and keep the column**
  ([#88](https://github.com/danjamk/knag/issues/88)). Two bugs in the same four keys,
  both reported from real use.

  **The first press used to be eaten.** A row is a `<textarea rows="1">`, so pressing
  `↓` inside one has no line below to go to and the browser does what it always does at
  the last line: moves the caret to the end of the text. knag only intercepted once the
  caret was *already* at the end, so changing rows cost two presses and the first one
  threw the caret somewhere you did not ask for.

  **`↑` used to land at the end of the row above** rather than at the same column. That
  was a deliberate call in [#84](https://github.com/danjamk/knag/issues/84), reading it
  as "back one line" — which is `←` semantics, not `↑` semantics.

  `←` and `→` are unchanged; they were correct as shipped.

  Two things this needed that a smaller fix would have got wrong. The arrows are now
  gated on the caret's **visual line**, not its offset, because a row wraps — a long
  note is several lines tall and `↑`/`↓` have to keep working inside it. And the
  preserved column is a **pixel x**, not a character offset: a character count is not a
  column in a proportional face, so `iiii` and `WWWW` put offset 4 nowhere near each
  other on screen.

  `↑` on the first row and `↓` on the last now do nothing, instead of letting the
  browser slam the caret to the start or end of the line.

### Notes

- **The arrows had no tests at all** before this, which is why #84's wrong call went
  unnoticed. There are now eleven, in a new `browser/arrows.spec.ts` — five of them fail
  without this fix. None of it is reachable from the unit suite: every assertion depends
  on where a glyph actually landed.
- **A goal column is not preserved across consecutive presses.** Passing `↓` through a
  short row clamps to its end and the original column is lost, where a full editor would
  remember it. That needs state surviving keystrokes and invalidated by every edit,
  click and repaint — deliberately not built.

## [0.6.1] — 2026-08-17

Infrastructure only. Nothing in the running Worker behaves differently.

### Added

- **Dev deploys itself on merge to `main`**
  ([#82](https://github.com/danjamk/knag/issues/82)). `deploy-dev.yml` runs the real
  five-step upgrade sequence — backup → migrate → deploy → health → verify — against
  the dev account on every merge, with no reviewer and no way to skip migrations.

  **The reason was never the saved `make deploy`.** It is that `deploy-prod.yml` had
  never executed: zero GitHub environments, zero secrets. So the first time that
  sequence ran *anywhere*, it would have run against production, against the prod D1,
  with every step running for the first time. Dev now rehearses it dozens of times
  first, and the two workflows are maintained as mirrors — a change to one belongs in
  both unless it is a listed divergence.

- **A deployment runbook** at [docs/deployment.md](docs/deployment.md) — what ships
  where, the exact Cloudflare API token permissions, provisioning a pipeline from
  nothing, what each credential can reach if it leaks, and what a failure at each of
  the five steps means. The provisioning checklist for production, which is still
  unprovisioned, is in there too.

### Fixed

- **`deploy-prod.yml` never set `CLOUDFLARE_ACCOUNT_ID`.** Without it wrangler resolves
  the account by calling `GET /accounts` — a lookup a token scoped tightly to one
  account can fail. Because the workflow had never run, that failure was waiting on the
  *first step of a first production deploy*, right where a first-time operator has the
  least information. Found by writing the dev workflow, which is exactly what it was
  for.

### Changed

- **[ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md) amended.** A third
  credential location now exists, so §1b states what the two-account split actually
  rests on: not the number of credentials, but that each one is readable only by the
  job that names it. Every deployment credential lives on a GitHub Environment or in
  `.env.local` — **never a repo-level secret.** §4 records why dev deploying
  automatically does not contradict production deploying manually.

## [0.6.0] — 2026-08-16

Three things found by using it. One of them was quietly discarding keystrokes.

### Fixed

- **The editor was racing its own saves, and losing**
  ([#83](https://github.com/danjamk/knag/issues/83)). Typing fast enough — a burst of
  returns, a run of line merges — put two writes in flight at once. Both carried the
  same version, because the first had not come back yet, so the server rejected the
  second as a conflict.

  That is why the cursor sometimes vanished mid-sentence, and why the footer said
  `reloaded · it changed elsewhere` when you were the only person using it: the
  "elsewhere" was your own previous keystroke.

  **It could lose text.** A conflict is resolved by loading the server's copy over the
  local one — right when another device really did write, wrong when the conflict is
  self-inflicted, and silent either way because the status line calls it a reload.
  Writes are serialised now. A real conflict from a second device still reloads and
  still says so.

- **Left and right arrows cross a row boundary**
  ([#84](https://github.com/danjamk/knag/issues/84)). Right at the end of a line moves
  to the next; left at the start moves to the end of the previous. Up and down already
  did this — the horizontal pair was simply never written, so the caret hit the end of
  a row and stopped dead.

  Up at the start of a row also stops throwing the caret to the far left of the row
  above, and neither arrow moves anything when there is a selection to collapse.

### Added

- **Enter on a hyphen bullet starts another one**
  ([#85](https://github.com/danjamk/knag/issues/85)). `- milk` + Enter gives you `- `,
  the way a checkbox already did. Enter on an empty bullet drops the marker and leaves
  the list.

  The marker is copied, never tidied: a `*` continues as `*`, and indentation carries
  across exactly. Ordered lists stay out — continuing `1. ` means renumbering, which
  would be the first edit knag makes to a line you did not touch.

## [0.5.0] — 2026-08-16

knag looks like itself. Two boards, two typefaces, one colour, and the wipe finally
animates.

### Added

- **The design system, landed** ([#70](https://github.com/danjamk/knag/issues/70)).
  Two self-hosted typefaces, subset to woff2 and precached — **Familjen Grotesk** for
  everything you wrote, **DM Mono** for everything the app says about itself. That split
  is the system: two voices, two faces, two colours.

  **Amber is now the only colour in the interface.** Everything else is chalk, ink or a
  hairline. `offline`, `not saved` and the delete control used to be red and are not any
  more — a third colour means something went wrong.

- **The screen** ([#71](https://github.com/danjamk/knag/issues/71)). Row geometry,
  Arrange mode, the footer, settings and the login screen rebuilt against the design
  pass. Rows hold a 640px measure above 900px so a wrapped line on a laptop is not 190
  characters wide.

  **The wipe animates** — and it is the only thing in the product that does. The rows
  fade in place holding their height, and only then does one collapse close the gap.
  Doing both at once makes the list jump under the thumb that just tapped, and the
  release stops feeling like a release.

  **The empty page shows one blinking cursor and nothing else.** No hint, no
  illustration, no "add your first item". A blank board is the feature.

### Changed

- **Light and Dark are now Whiteboard and Slate.** They were never themes — they are
  the two surfaces the product already had, finally told what they are. Your existing
  choice migrates; nobody gets reset to `system`.

- **The wipe control is a word with the count inside it** — `wipe 3`, not `⌫ 3`. A
  backspace glyph says the bytes are gone, and the whole argument of the product is that
  they are not. At zero it renders nothing at all.

- **Wiping completed no longer asks, at any count.** The confirm above ~10 items is
  gone: the count is now inside the control, so you read the size of the action before
  you tap it, and the recovery line makes taking it back one tap. Spec §7 amended.

- **Wiping the whole page confirms by repetition, not by dialog.** The label swaps to
  `again to confirm` and disarms itself after a few seconds, or when Settings closes. A
  browser `confirm()` was the loudest surface in an app whose whole voice is quiet.

- **The recovery line moved above the footer**, where it cannot be scrolled away or
  buried by the keyboard — the line has to be where the regret is.

- **Save status speaks in the machine voice**: `saved`, `saving`, `not saved`,
  `updated elsewhere`. Lowercase, no terminal punctuation, and amber whenever it is
  saying anything other than `saved`.

- **Every glyph is drawn now.** They used to be unicode set in DM Mono — `⠿ ⧉ × ⇅ ⚙ ↗` —
  and DM Mono has a codepoint for none of them, so all six were rendering from a
  different platform fallback face on every OS.

## [0.4.0] — 2026-08-16

knag has a mark: the block cursor. An amber block sitting after the wordmark — `knag▮`.

### Added

- **The real app icon, and a real connector icon**
  ([#72](https://github.com/danjamk/knag/issues/72)). The home screen and Claude's
  connector list both showed placeholder art until now: `scripts/make-icons.py` drew a peg
  on a wall, and the MCP server shipped deliberately without an icon at all rather than
  with a wrong one.

  The mark is the block cursor, which is the argument the product makes — a blinking
  cursor is by definition a thing that will not leave you alone. It is two rectangles, so
  it holds at 512px and at 16px.

  **The maskable icon is now its own file.** The old manifest declared the same 512 for
  both `any` and `maskable`, which meant Android's circular crop took the corners off the
  mark. The `apple-touch-icon` points at the *non*-maskable one: iOS applies its own mask,
  so handing it the pre-padded art would double-pad it.

  **The connector icons come in both boards** — slate for a dark UI, whiteboard for a
  light one — at absolute URLs derived from the request origin, so dev and prod each
  advertise their own copy rather than one pointing at the other.

### Changed

- The status-bar colour is Slate (`#11150F`), the board, rather than a neutral `#111111`.
- `scripts/make-icons.py` is deleted. It was explicitly a placeholder and it has been
  replaced.

## [0.3.0] — 2026-08-16

The agent half reaches the phone, the wipe becomes a loop you can undo, and the app stops
pretending when the network goes.

### Added

- **knag says when it is offline instead of pretending**
  ([#57](https://github.com/danjamk/knag/issues/57)). A dropped connection used to fail
  silently — the poll errored into nothing, saves errored into nothing, and the page went
  on looking live while discarding every change. The footer now reads `offline`, rows go
  read-only, and everything resumes on reconnect with no reload.

  **The row you were typing into keeps working.** Freezing mid-keystroke would eat the
  rest of the sentence you were part-way through, which is lost text you already typed —
  the failure this exists to prevent, arriving as the cure. That leaves one unsaved row,
  the footer says so (`offline · 1 unsaved`), and it saves itself on reconnect as an
  ordinary versioned write. Offline *editing* is still out: nothing is queued and nothing
  is replayed.

  **Connectivity is decided by whether requests work, not by `navigator.onLine`** — which
  reports online on a captive portal and a dead uplink, exactly when you need to be told.
  A 401 or a 409 counts as connected, because those answers travelled.

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

- **The reasoning behind bearer-only auth was wrong, and is recorded as such**
  ([ADR-005](docs/adr/ADR-005-mcp-oauth.md), [#64](https://github.com/danjamk/knag/issues/64)).
  v0.2.0 shipped a static bearer on the grounds that a single operator with no
  third-party clients does not need OAuth. The real discriminator is **which client you
  need to reach** — and knag is a phone and iPad product, so it needed OAuth from the
  start. Spec §10 carried the wrong reasoning and now carries the correction.

  The gap was closed later in this same release, so nothing shipped broken. It is kept
  here because the mistake came from a house standard that has since been amended, and a
  decision reversed without a record is one that gets made again.

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

### Notes

- **Not yet verified: a real connector completing the OAuth handshake.** Discovery,
  registration, the consent redirect and audience pinning are all exercised against a
  live deployment, and the tools were driven end to end over the static bearer. The final
  hop belongs to Claude, and no phone or iPad has done it yet. This release does not
  claim otherwise.
- **Production still does not exist.** There is one environment, dev, and it holds real
  content that `docs/adr/ADR-002` says it should not — on a `*.workers.dev` hostname with
  no rate-limit rule, and now holding OAuth grants as well. `make backup` was exercised
  for real this release and its output restored into a scratch database, so the content
  is provably recoverable; recoverable is not the same as correctly placed.
- **Four defects this release were found by using knag or by reading a log, not by the
  suite** — a page going stale on a device you return to, a smoke test structurally
  incapable of passing, a health check blind to the environment it checked, and CI
  failing a fifth of the time. The operational and test tooling remains the
  least-exercised code in the repo.
- **`page.route` does not intercept requests in the browser suite**, cause unknown. It
  rules out one way of simulating a dead uplink; the offline tests reach the same
  property from another direction and say so in place.
- **Still deferred, and still self-reporting:** the 7-day iOS cookie clock and the
  two-device 409 path ([#4](https://github.com/danjamk/knag/issues/4)). Both need real
  devices and elapsed time.

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

[Unreleased]: https://github.com/danjamk/knag/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/danjamk/knag/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/danjamk/knag/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/danjamk/knag/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/danjamk/knag/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/danjamk/knag/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/danjamk/knag/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/danjamk/knag/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/danjamk/knag/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/danjamk/knag/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/danjamk/knag/compare/v0.1.11...v0.2.0
[0.1.11]: https://github.com/danjamk/knag/releases/tag/v0.1.11
