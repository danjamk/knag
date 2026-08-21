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

### Added

- **A page switcher, manage-pages, and templates** (#154) — the part a person can see.
  The page's name in tier 1 is a drop-up now: current page in amber, the rest in chalk,
  one last row for the rare verbs. **No icons, no counts, no last-modified times** — the
  row is its name, because anything else is a column and a column is a file manager. It
  never scrolls, because the server caps pages at nine.

  🔴 **knag has no index.** There is no screen that lists your pages and nothing to pick
  from on the way in — **launch opens the last page you were on**, which is device state
  and never synced.

  Manage-pages is a third pane of the settings dialog: the name is an editable field
  rather than a rename *mode*, templates toggle per page, and delete asks nothing —
  which #154's schema is what makes honest.

  Two things that were single-valued and quietly wrong once a second page existed: the
  undo offer's `localStorage` key (wipe the shopping list, switch to today, and today
  offered to bring the shopping list back — into today), and the poll, which now asks
  about the open page only so §14.4's budget does not multiply by nine.

- **`/api/pages`** — create, rename, save-a-template and retire (#154). The switcher's
  API, with no switcher yet. The list carries `id`, `name` and `has_template` and nothing
  else: anything more is a column, and a column is a file manager.

  🔴 **Deleting a page removes no rows.** `deleted_at` is stamped, the page leaves every
  list and lookup, and every revision and cleared item it ever had stays exactly where it
  was — which is what makes "delete does not confirm" honest rather than a lie, with no
  undo screen to fall back on. Recovering a page is clearing one column. The unique name
  index became partial so a retired page's name is free to reuse.

  The default page cannot be deleted, and that is structural: it is what a request naming
  no page resolves to, what every MCP tool writes to, and what §14.5's defensive read
  answers for.

- **An optional `page` on all four MCP tools** (#153, phase 6b of #123), resolved **by
  name**, case-insensitively. Omit it for the default page, which is what every call meant
  before pages existed — optional because a required parameter would break every deployed
  Claude Code config the moment it shipped.

  🔴 **An unrecognised name is an error listing the pages that exist, never a fall back to
  the default.** Whole-document write is the only write there is, so an agent told to write
  to a page that was since renamed would otherwise byte-preserve its lines straight into
  the wrong document. The error is also the only way to learn the names: knag has no index
  and no tool that lists pages, on purpose.

  `knag_read` now echoes back the page name it answered with, so a write can name the page
  it read and the agent contract's "report the diff" stays answerable once there are
  several.

- **A page dimension behind the API** — the expand half of pages (#152, phase 6a of
  #123). Nothing on screen changes: one page becomes "page 1 of n" and every request
  that names no page behaves exactly as it did.

  A new `pages` table rather than a column, because `documents` carries
  `CHECK (id = 1)` and SQLite has no `ALTER TABLE ... DROP CONSTRAINT` — lifting it is a
  full table rebuild, which is destructive. `documents` stays and is dual-written so the
  previous Worker can still serve a current document if this one is rolled back. Dropping
  it is a later release.

### Fixed

- 🔴 **Two queries that were correct only because there was one page.**
  `newestUnsealedRevision` asked for the newest unsealed revision full stop, so a save to
  one page inside the ten-minute coalescing window would have been folded into another
  page's revision — one page's history quietly containing another page's body. The wipe's
  `(SELECT max(id) FROM revisions)` would have sealed the wrong page's newest revision.

  Neither raises an error, and neither was reachable before this release. Both were found
  by writing a test with a second page in it, which is the argument for shipping the
  schema on its own before anything can create one.

## [1.0.1] — 2026-08-20

The first hour on 1.0, on a real desktop and a real phone.

Six things, all reported by the operator and none by the suite — which is the pattern
this project keeps repeating and keeps being right about. Two were defects with a shared
shape: **something moved or came back when nothing should have.**

### Fixed

- **The page wipe flashed the page back before it went.** `animateWipe` released its
  decorations on its own resolve, so every collapsed line snapped to full height and
  opacity and sat there for the whole 200ms of `--page-beat` before the repaint took it
  away again. The beat was holding a *full* board — which means §6b's empty-board moment,
  the pause the whole `fall` timing was built around, had never once run. The surface now
  holds the lines hidden until the caller releases them, in the same task as the repaint.

  🔴 This is very likely the "the wipe page does not seem like the fall we designed"
  from 0.13.0, which was carried on #121 as a tuning question. It was not a tuning
  question.

- **`bring back` needed two clicks on desktop.** `wipe page` lives on the ledge, so the
  ledge is always open at the moment the recovery line appears below it — and focusing
  the button closed the ledge, which took 56px out of the layout *between the mousedown
  and the mouseup* and moved the button out from under the pointer. No `click` was ever
  dispatched. The recovery line counts as chrome now, which is also just true of it.

  iOS Safari does not focus a `<button>` on tap, which is why this was desktop-only.

### Changed

- **Devices is a second pane of the settings dialog, not a full-bleed screen.** Same
  dialog, same backdrop, same focus trap, a back control where the close control is. The
  argument that made it a screen (#132 §3d — a modal cannot hold a list whose length
  nobody controls) needed a scroll and a cap, both of which a pane has; it did not need
  to throw the reader out of Settings to get them. The settings pane still does not
  scroll, which is the half of that rule that was ever load-bearing.
- **The settings head and its close control are legible.** `--dim` on `--board` is about
  3.9:1 — under AA at any size — which is right for a value at rest beside a label and
  wrong for the two things that say what the surface is and how to leave it. The close is
  a drawn glyph now, like every other control in the product, rather than the text
  character `×`.
- **The build line reads at `--size-machine`**, which is the size that token's own
  comment has always assigned it. It was set to `--size-micro` — the env badge's size —
  and 11px `--dim` put "is my change live" back to being a round trip.
- **One group label in Settings, not two.** `the page` sat under a head that says
  `settings`, above four rows visibly about the page. `you` stays, because what follows
  it is a genuine change of subject.

## [1.0.0] — 2026-08-20

One page, one editing surface. The row list is gone.

**1.0 is a claim about shape, not a count of closed issues.** It means the
single-document product is done — the point at which adding anything more means adding a
second document, which is a different product. It was held back from the landing page
release for one reason: the shape still had two editing surfaces in it.

### Removed

- **The row list**, and everything that existed to make a *row boundary* behave like a
  *line boundary*: `client/src/caret.ts` in full, the four arrow-key branches, `neighbor`,
  `splitAt`, `mergeBackward`, `editorIn`, `focusRow`, `captureCaret`, `syncFromRow`, the
  per-row `<textarea>` rendering, and the `list` view option.

  🔴 On one document those *are* line boundaries and the platform owns them. #84 and #88
  were both bugs in the arrow code; neither has an equivalent now.

  It shipped in 0.8.0 *beside* the CodeMirror surface rather than instead of it, because
  every defect this project has shipped was found by a person on a phone rather than by
  the suite — so the replacement was used against the real page for two weeks first. That
  was the precondition ADR-007 set for itself, and it was met the way it intended: by the
  operator saying the editor had stopped feeling like the new thing.

- **The per-row offline exemption.** Offline used to keep editable exactly the row you
  were mid-sentence in and freeze the rest — an affordance only a list of separate fields
  can offer. One contenteditable has no per-row anything, so offline freezes all of it,
  which is what the editing surface has done since it shipped. `rowIsEditable` and
  `EditableState` went with it.

  What that rule protected is unchanged: the dirty guard still holds unsaved keystrokes,
  the count is still visible rather than hidden behind one word, and on reconnect the
  pending save is still an ordinary versioned write rather than a queue (spec §12).

- **`browser/arrows.spec.ts` and `browser/editing.spec.ts`**, whose subjects no longer
  exist. 🔴 Two tests from the second were **ported rather than deleted** — neither was
  ever about rows, both are about the save and poll cycle under fast input, and that cycle
  is unchanged. Deleting a file wholesale is how coverage is lost by accident.

### Changed

- **The editing surface is the default and the only one.** A device still holding
  `knag.view: "list"` resolves to it silently — the value is simply not in the allowed
  list any more, so the existing validation does the migration and no code was written
  for it.
- **`[data-rows]` holds only Arrange now**, which builds its own rows from the block
  array and never shares an element with the surface. That separation is what kept the
  sort mode when the editing surface replaced the rows (ADR-007 §4).
- **`splitLine` is tested directly** for the first time. It was only ever covered
  *through* `splitAt`, the row-model adapter over it — so this deletion would have
  silently left the one function the surface calls on every Enter with no tests at all.

### Fixed

- **A remote update no longer loses focus in raw view.** The caret restoration path
  queried `[data-rows]`, found nothing there, and concluded focus had been lost while the
  textarea still had it. It went with the row list.

**The bundle is 6.4kb smaller** — 327.2kb to 320.8kb minified, from 1,726 deleted lines
against 505 added. #113 guessed this would "claw back some of the +85 KB" and it claws
back less: CodeMirror *is* the +85 KB, and it stays. What came back was the row model
wrapped around it.

Closes #113.

## [0.16.0] — 2026-08-20

knag has a landing page.

### Added

- **The landing page**, at `site/` and served from GitHub Pages. One screen of a real
  day's board, and the hero *is* the wipe: scroll it into view and six lines go, once,
  never on a loop. Then the line — **"Throwing it away is the feature."**

  The mechanics are decisions rather than defaults. **Scroll-into-view** rather than
  autoplay, because autoplay fires above the fold before anyone is looking and the reader
  arrives at a board that emptied itself with no idea what it held — and rather than a
  button, which asks someone to opt into a four-second wait for something nobody has told
  them is worth it. **Once**, because a wipe that replays every eight seconds is
  wallpaper. **Slate only**, because the app has two boards for something read over hours
  and this is read for forty seconds.

  Under `prefers-reduced-motion` the board arrives already empty with the amber line in
  place: the same picture, without the four seconds. Not a still of the *before* — the
  after-state is what the page is about.

- **An OG card** at 1200×630, which is what actually gets seen when the link is pasted.
  `site/og.png` is committed output; `site/og.html` beside it is how to change it, and
  `scripts/og-card.sh` regenerates it through the browser the repo already ships.

- **`.github/workflows/pages.yml`** — uploads a folder and does nothing else. The page is
  static and self-contained by design: no framework, no npm dependency, no CDN, and the
  fonts referenced relatively from `site/fonts/`. If that workflow ever grows a build
  step, the constraint the page was designed under has been dropped.

- **Nine static checks on the page** (`worker/test/site.test.ts`), because nothing else in
  the suite ever looks at it — it has no route and no request. Every constraint on it
  fails silently: a CDN reference works on the machine that added it, a drifted font copy
  renders in a fallback stack, a word off the kill list reads fine to whoever typed it.
  🔴 One of them counts the checked lines on the board and compares them to the number the
  amber line claims, so the page cannot state a total the picture above it contradicts.

The type answers the brief's one open question. "Heavier condensed type" does **not** mean
a fourth font file: Familjen Grotesk at **600**, with the leading under 1 and the tracking
negative, is what does the work — and it does not even need the 700 the axis stops at.
Decisions and the hero cut are [§8 of the design response](docs/design/holistic-response.md).

Closes #90.

## [0.15.0] — 2026-08-20

Settings is six rows and it fits on the screen.

### Changed

- **Settings is two groups, six rows, and it does not scroll.** `the page` holds board,
  view, text size and sound; `you` holds log out and a `devices 3 ›` row.

  🔴 The organising rule is a test rather than a layout: **a preference has a current
  value.** If a proposed row *does* something it is not a preference; if its length is not
  knowable it is a screen. That rule is the whole fix — the sheet became a junk drawer
  because it was where anything without a home went, and the reason it could was that it
  scrolled. **A sheet that scrolls is a junk drawer with a lid.**

  Every choice is its options laid out flat with the current one filled amber, three or
  fewer per row. No toggles and no disclosure rows that make you tap to find out what a
  setting is currently set to: a switch tells you a state, a pair of buttons tells you the
  state *and* the alternative in the same glance, and it costs the same height.

- **The sheet is bottom-anchored**, and `Done` became a close glyph in its head. A
  full-width button under six rows put the largest target furthest from what it closed.

### Added

- **Devices is a screen now**, and the sheet only points at it. It is the first thing in
  the product whose length the design does not control, and a modal is the one container
  that cannot hold an unbounded list — it has no navigation and no scroll that means
  anything. At two rows it looked fine in the sheet; at fifteen it *was* the sheet.
  `sign out everywhere else` went with it, since it acts on the list.

- **`carbon · N days` on the build line** — how far back the record goes, which is the one
  fact about knag a person occasionally needs and could not previously find anywhere.

  🔴 It comes from a new authenticated `GET /api/carbon`, **not** from `/health`. That is
  the one unauthenticated route in the product, and the age of your document is a fact
  about your document rather than about the deployment; putting it there would have handed
  a stranger the age of the page for the cost of a `curl`.

### Removed

- **About.** §7e names an about page directly in the list of things that never go in this
  sheet, and the rule that removes it is the rule that keeps the sheet from filling up
  again. The repo link survives on the build line — a public MIT project should not lose
  its only path back to the source over a layout decision.

### Fixed

- **`oldestRevisionAt` read the newest revision under one condition.** `created_at` is
  text and its two writers disagree on precision — revisions are `toISOString()` at
  milliseconds, migration 0002's baseline is `strftime` at seconds — so
  `...22.068Z` sorts before `...22Z` and `min()` returned the *newer* row inside a shared
  second. It now orders by `id`, which is monotonic and has no format to disagree about.
  Found by a test on the first run; in production it would have looked correct until
  someone read the number on a page created that minute.

Closes #132. Designed in [§7e](docs/design/holistic-response.md).

## [0.14.0] — 2026-08-20

The wipe makes a sound now, if you ask it to.

### Added

- **A sound for the wipe** — one, at the start, ending exactly as the last gap closes.
  Off by default, with a switch under `Sound` in Settings.

  🔴 **It is not a fixed length. It is derived from the motion:**

  ```
  knockAt      = duration + stagger × (n − 1) + collapse
  noise length = knockAt
  ```

  A fixed sound against a wipe whose length depends on how many lines are going lands the
  knock mid-motion on a long list and after silence on a short one, and the mismatch shows
  up on the very first real wipe. Instead the noise band opens as the first line starts
  moving and closes on the frame the last gap finishes closing, with the knock on that
  same frame — so a two-line sweep and a nine-line page wipe are the same event at two
  lengths rather than two sounds. Retune a motion token and the audio follows; there is no
  duration written anywhere in `sound.ts`.

  **Synthesised, never a file.** Nothing lands in `public/`, nothing joins `SHELL` in the
  service worker, and no cold offline start plays silence. An audio asset is a thing that
  can be missing, and a wipe that is silent because a cache is cold is indistinguishable
  from one that is silent because it is off.

  **`prefers-reduced-motion` silences it, with no special case.** The media query already
  rewrites every motion token to 1ms, so the formula yields a few milliseconds and the
  sound refuses to play — someone who asked for less motion is not handed the one thing
  louder. The mechanism that guarantees that is the same one that keeps the sound
  following the motion.

  🔴 **The iOS silent switch mutes Web Audio and that is not worked around.** The motion
  is the moment; this is a bonus for someone holding a phone with the ringer on. If the
  sound is ever the only thing that made a wipe feel like a release, the wipe is wrong.

### Fixed

- The `0.13.0` heading was dated the day its work was written rather than the day it
  shipped.

Completes #121. Sequencing and the synth's numbers are
[§6 of the design response](docs/design/holistic-response.md).

## [0.13.0] — 2026-08-20

The wipe stops being polite. Sound is not in this one.

### Changed

- **The daily wipe is a sweep now** — 260ms rather than 420, a 14ms stagger rather than
  26, and 28px of travel rather than 10.

  🔴 **It did not feel like anything because it was the wrong verb.** A fade with a
  leftward slide is how a *dismissed card* behaves, and a dismissed card is a thing you
  sent somewhere. Nothing goes anywhere here — the line stops being on the board. At a
  14ms stagger the lines stop being six events and become one motion, which is what a
  sweep is, and 28px is what makes it read as leaving the board rather than nudging.
- **Wiping the page is the same animation at a second timing.** Wiping completed lines is
  many small removals and reads top-down, like a list being processed. Wiping the page is
  one removal of one thing — a project ending, a week closed — so it falls, **bottom-up**,
  18px down while fading, over 380ms.

  The direction is the risk and the curve is what answers it: down is also the direction
  of deletion, so the motion has to say *released* rather than *discarded*. A discarded
  thing accelerates away; a released thing starts immediately and eases out. It keeps the
  ease the product already owns and must never become an ease-in. The travel is 18px
  rather than off the bottom of the screen, so nothing is ever seen arriving anywhere.
- **The empty board is held for 200ms** after a page wipe, before the recovery line
  arrives. The empty board is part of the animation rather than what is left when it
  stops — no confetti, no flourish, the same board given a moment of silence. It is also
  what stops the fall reading as a deletion, because the record speaks right after it.
- **The recovery line arrives rather than being simply there**, over 90ms of opacity with
  no travel. A daily sweep gets the arrival; the page wipe gets the beat first.

### Added

- `--wipe-travel`, `--page-duration`, `--page-stagger`, `--page-travel`, `--page-collapse`,
  `--page-beat` and `--recovery-in`. 🔴 The travel token is a `translate` value rather
  than a length, so it carries the **axis** as well as the distance — which is how the
  page wipe reuses the one keyframe instead of needing a second animation. Pinned by a
  test that allows exactly three `@keyframes` in the stylesheet and names why each exists.

Motion only, per [the design's own build order](docs/design/holistic-response.md) — the
sound is #121's other half and lands separately. Sequencing and numbers are §6 and §6b.

## [0.12.0] — 2026-08-19

The bar gets a second tier. Copying and wiping the page left Settings for it.

### Added

- **The ledge** — a second tier on the bar, opened by the chevron at its right edge. It
  holds `copy`, `arrange`, `settings` and, alone at the far end past a hairline,
  `wipe page`. Things that are not rare enough to be three taps and a scroll deep, and
  not permanent enough to sit above the keyboard.

  🔴 **It cannot be open while the keyboard is up**, and that is the whole reason a
  second tier was affordable. The bar is thin because it sits above the keyboard on a
  phone; anything permanent added there spends exactly the height that thinness was
  protecting. So the ledge is momentary — anything that takes focus outside the bar
  closes it, and typing is the commonest way that happens. A phone with the keyboard up
  sees the bar it saw before, minus 6px.

  There is deliberately **no pin**. It would only mean anything with the keyboard down,
  which on a phone is the situation the tension does not exist in. It is one boolean and
  it ships when someone using knag on an iPad asks for it.

### Changed

- **`copy the page` and `wipe the page` moved out of Settings** onto the ledge. Both are
  operations rather than preferences, and the sheet had become the place anything without
  a home went. `wipe page` still arms by repetition rather than growing a dialog: what
  keeps it away from the everyday `wipe N` is now the tier rather than the depth.
- **The copy confirmation moved to the machine slot.** It used to be written on the
  button, because a modal sheet covers the footer and a confirmation the reader cannot
  see is not one. On the ledge the footer is what they are looking at.
- **The wordmark left the bar**, and the page's name took its slot — `today`, a status
  display rather than a control until there is a second page to switch to. A wordmark
  inside an app you have already opened is the least load-bearing element on it. The mark
  survives on the login screen, the icon and the README.
- **The bar is 46px rather than 52px, and the type went back to 13/11px with 18px
  glyphs.** 0.11.0 fixed a real hit-target complaint by taking the touch target from 28px
  to the HIG's 44px, and let the target drag four type tokens up with it. A 44px target
  is 44px of touchable area; it is not 44px of ink. Every target is still 44px — they
  fill the bar now instead of sitting inside its padding.

All of the above is the design session's holistic pass, recorded in
[docs/design/holistic-response.md](docs/design/holistic-response.md) §3a, §4 and §5.

## [0.11.1] — 2026-08-19

Checkboxes keep their colour when the window loses focus.

### Fixed

- **The editing surface's checkboxes turned white-and-black whenever the window was not
  focused**, losing the amber and the border. Reported from real use: a screen kept open
  beside your work all day is unfocused most of the time, so this was the normal state
  rather than an edge case.

  🔴 **The two surfaces were not drawing the same control**, despite a comment saying they
  were. The row list draws a fully custom box — `appearance: none`, its own border, and a
  tick made of two rotated borders. The editing surface was drawing a **native** checkbox
  tinted with `accent-color: var(--amber)`.

  `accent-color` can only tint a control the platform still owns, and macOS desaturates
  native form controls in an inactive window. The fix is to stop letting the platform own
  one: the editor's box now mirrors the row list's rules exactly, so the claim in that
  comment is true for the first time.

  Two tests hold it — one that the control is not native, and one comparing computed
  pixels across both surfaces so "the same control" cannot quietly stop being true again.
  Neither reproduces window-blur rendering, which is not possible headlessly; they pin the
  mechanism that makes it immune.

## [0.11.0] — 2026-08-19

Bigger controls, and text you can size.

### Added

- **Text size, in Settings** ([#92](https://github.com/danjamk/knag/issues/92)). Three
  steps — 16, 18, 20 — applied to the page text and nothing else. Per device, like the
  board, and never part of the document.

  🔴 **It scales up from 16 and is offered nothing smaller.** Below 16px iOS Safari zooms
  the viewport when a field takes focus and never zooms back. Anyone wanting smaller text
  wants a smaller device.

  It moves the page and leaves the interface alone, which is the decision this turns on:
  someone raising the reading size wants more room for the document, not a louder footer.
  Both editing surfaces and raw view read the same token, so switching views cannot resize
  the page underneath you.

- **About, in Settings.** What knag is, the license, and a link to the repository. The
  human-voice half of Build, which keeps saying the same thing in numbers directly below.

### Changed

- **The footer's controls are bigger, and stay that way**. The touch target was **28px**;
  Apple's HIG minimum is 44. "The icons are too small on all devices" turned out to be a
  hit-target problem wearing a visual complaint's clothes, so it is fixed against the
  standard rather than by eye. Icons go 18px to 20px, the machine voice 13px to 14px, the
  env badge 11px to 12px, the wordmark 14px to 15px.

  The bar grows from 44px to 52px rather than to 60px, because its vertical padding drops
  a step to absorb half of it. None of this follows the reading preference — it is set
  once and fixed.

### Fixed

- **Every font size is a token now.** `--size-row` was declared and read by *nothing*,
  while seven rules named `16px` directly — the issue believed there were three. A
  preference cannot override a token nobody consumes, so this was the actual first task.
  Document surfaces take `--size-row`, controls take a new `--size-control`, and the
  shell test now pins the 16px floor on the tokens plus the absence of any small bare
  `font-size` anywhere, which is a stronger assertion than the literal it replaced.

## [0.10.0] — 2026-08-19

One tap to get the page out.

### Added

- **`copy the page`, in Settings under Page**
  ([#118](https://github.com/danjamk/knag/issues/118)). It copies `body` verbatim — no
  header, no metadata, no front matter. Anything knag adds is a byte you did not type, and
  the round trip back through raw view (spec §8) only holds because there is nothing to
  strip on the way in.

  🔴 **This is not a new capability.** In the editing surface, `⌘A` then copy has returned
  the page byte-exact since 0.8.0, and there was never a format problem to solve: the page
  is plain text, the bytes on screen are the bytes in the database
  ([ADR-004](docs/adr/ADR-004-display-matches-the-bytes.md)). What it replaces is four
  gestures and two menu waits on a phone, where the selection callout is fiddly on a long
  page.

  In Settings rather than the footer, because the footer's budget is what sits permanently
  above the keyboard (spec §7) and copying the whole page is a rare act. Above the
  whole-page wipe and not sharing its row: both are whole-page verbs, one of them throws
  the page away, and a reader reaching for one must never be a mis-tap from the other.

  The result lands on the control itself rather than the save-status line, because the
  sheet is modal and covers the footer — `copied`, or `not copied` when the clipboard
  refuses, which it does outside a secure context or on an untrusted gesture. A copy that
  silently does nothing is worse than one that admits it; you find out when you paste.

  Download and the iOS share sheet stay out, recorded on the issue with the reasons. This
  is now knag's **third** copy path and the only one with no room for interpretation —
  [#115](https://github.com/danjamk/knag/issues/115) decides for all three once there is a
  week of use to decide from.

## [0.9.1] — 2026-08-19

The wipe works in the editing surface. Both halves of it.

### Fixed

- **The wipe control was missing from the editing surface entirely**
  ([#119](https://github.com/danjamk/knag/issues/119)). `refreshClearButton` hid it on
  `view !== "list"` — a condition written before that surface existed — so the only wipe
  reachable from the editor was the whole-page one in Settings. The reorder button was
  updated for the surface in 0.8.0 and this one was missed. Raw view still hides it, which
  is the deliberate half: sweeping from the bulk-paste escape hatch would act on a
  document being rewritten by hand.

- **And the wipe did not animate there** (same issue). `animateWipe` resolved
  `li[data-index]` inside `[data-rows]`, which `paint()` empties in editor view, so it
  returned on its first guard and the checked lines vanished on the repaint. The wipe is
  the only animation in the product and the moment the nag → wipe loop is built around;
  the surface replacing the row list did not have it.

  Both stages are preserved, because the separation is the design and not an
  implementation detail: the lines go transparent **in place, holding their height**, and
  only then does one collapse close the gap. Same keyframes, same tokens, same stagger
  expression as the row list — so `prefers-reduced-motion` still collapses both surfaces
  from one place and neither can drift.

  🔴 The animation takes **lines, not block indices**. One block renders as one row in the
  list, so the two were interchangeable there — but a fenced block is one block and
  several lines, and animating by index would have faded the opening ``` and left the rest
  of the fence sitting there until the repaint.

  [ADR-007](docs/adr/ADR-007-one-editing-surface.md) is amended rather than quietly
  broken: `EditorHandle` no longer speaks *only* in document bytes. The alternative was a
  CodeMirror import in `app.ts`, which is the leak that made the row model expensive to
  replace, so the smaller one was taken — one method, with the timing still owned by
  `app.ts`.

## [0.9.0] — 2026-08-19

A session can be ended. Until now, none could.

### Added

- **Log out, and a device list you can revoke from**
  ([#125](https://github.com/danjamk/knag/issues/125)). Settings gains a **Devices**
  section listing every live session by its label and the day it started, with the
  device you are holding marked. Revoke another device and it is refused on its next
  request. `sign out everywhere else` is the panic button, and it spares the device in
  your hand on purpose.

  🔴 **Before this there was no way to end a session at all.** A session lasts a year
  deliberately — re-auth is what kills daily use ([ADR-001](docs/adr/ADR-001-passphrase-auth.md),
  spec §4) — but a session had no relationship to the passphrase that created it, so
  **changing `KNAG_PASSPHRASE` left every existing cookie live for its full year**. A lost
  phone was a year of access, and the only remedy was `DELETE FROM sessions` typed by hand
  against the only copy of the document.

  Bearer access is unchanged and stays first-class: a bearer can list and revoke, because
  `/api/*` does not do cookie-only. It cannot *log out*, having no session to end, and is
  told so with a 400 rather than a 401 — it is authenticated fine, and re-authenticating
  would not help. `KNAG_BEARER_TOKEN` is still revoked by rotating the secret.

  🔴 Sessions are named in the API by a **surrogate id, never `token_hash`**, which is the
  SHA-256 of a live credential and must not reach a response body. A test asserts the hash
  never appears, and it was checked by deliberately leaking one.

  The migration is worth recording, because the obvious version of it is impossible.
  SQLite's `ALTER TABLE` refuses to add a `PRIMARY KEY` or a `UNIQUE` column, and
  migrations here are additive-only ([ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md) §3),
  so the surrogate arrives as a plain column, a `randomblob` backfill, and a unique index
  created separately. The same trap sits in front of `documents` and its `CHECK (id = 1)`.

## [0.8.1] — 2026-08-18

### Fixed

- **The footer scrolled off the bottom of the editing surface**
  ([#116](https://github.com/danjamk/knag/issues/116)). It stayed pinned to the window in
  the row list and in raw view, and in the new surface it sat at the bottom of the *text* —
  1,223px below the fold on a sixty-line page.

  `[data-editor]` is a flex column at full height and its children are expected to claim
  the leftover space; the surface added in 0.8.0 declared neither `flex: 1` nor
  `min-height: 0`, so it sized to its content and pushed the footer past the edge.

  🔴 Not fixed with `overflow-y: auto` on the container, which is the obvious move and the
  wrong one: CodeMirror brings its own scroller, so that gives two nested — and a nested
  scroller is what made long-press-and-drag fight scrolling on iOS during the spike.
  `.cm-editor` gets a height instead, leaving one scroller.

### Notes

- **The footer's position had never been asserted anywhere.** It is checked six times for
  voice, colour, animation and control size, and in the row model the layout could not get
  it wrong, so there was nothing to test. There is now a check in every surface, and one
  that fails if a second scroller ever appears.

## [0.8.0] — 2026-08-18

Editing works the way editing works everywhere else.

### Added

- **Select and copy across lines, the way you can everywhere else**
  ([#110](https://github.com/danjamk/knag/issues/110)). Settings → View → **editor** is a
  new editing surface: one document rather than one text field per row, so dragging
  across four lines selects four lines, and copy, cut and delete act on the selection.

  Checkboxes are still real controls, still tappable while the keyboard is up, and
  toggling one still rewrites exactly the character between the brackets. Indentation is
  now literal document text rather than a CSS property derived from bytes the field never
  showed — which is *more* byte-true than the row list, not less. **Arrange is unchanged**
  and works from either surface: it renders its own rows, and a trip through it without
  dragging returns the document byte for byte.

  Typing behaves as it does in the row list, because it is the same code: `Enter`
  continues a checkbox or a bullet with the marker copied rather than normalised and the
  indentation carried, `Enter` on an empty marker leaves the list, and `--` plus a space
  becomes a checkbox that an immediate `Backspace` puts back. Inside a fence none of it
  applies — a YAML list pasted into a code block starts lines with `- `, and continuing
  it there would have knag editing code.

  **`⌘A` now selects the whole page**, where the row list made it mean one row.
  [ADR-006](docs/adr/ADR-006-cross-row-selection.md) listed keeping the old meaning as a
  reason to reject a single surface — but that was a description of the row model, not a
  decision: each row was its own field, so `⌘A` could not have meant anything else.

  **It sits beside the row list rather than replacing it**, and that is temporary. Every
  defect this project has shipped was found by a person on a phone rather than by the
  suite, so the replacement gets used against the real page before the row list is
  deleted. Switch back in the same place if it misbehaves.

  What this costs: **the client goes from 21.6 KB to 107 KB gzipped.** That is the largest
  dependency knag has taken, against a stated preference for the boring tool — and the
  argument for it is that text editing on iOS Safari is the one domain here where
  hand-rolling *is* the exotic choice. Undo, composition, dictation and paste are the
  things a maintained editor library has already fixed, and all four were verified on a
  real iPhone before this was started.

- **Line endings can now survive an editor that does not believe in them**
  ([#110](https://github.com/danjamk/knag/issues/110)). `client/src/eol.ts` splits a
  document into LF-only text plus the set of lines whose break was CRLF, maps that set
  through each edit, and rejoins on the way out.

  Nothing on screen changes. This is the first piece of the editor replacement, and it is
  first because it is the only part that can corrupt the page rather than merely look
  wrong.

  The reason it is needed: CodeMirror's document is LF-only. Pinning its line separator
  makes a *pristine* document round-trip and looks like the fix — but a lone `\r` then
  becomes ordinary line content that the caret can sit past, so typing at what looks like
  the end of a CRLF line strands the carriage return mid-line. It renders perfectly and
  corrupts on save. Measured on the
  [`spike/110-codemirror`](https://github.com/danjamk/knag/blob/spike/110-codemirror/docs/spikes/110-findings.md)
  branch.

  Held to the same bar as the block parser: `joinEndings(...splitEndings(x)) === x` over
  2,000 arbitrary **binary** strings, not merely document-shaped ones, plus a property
  that an edit confined to one line cannot disturb any other line's ending. A mixed-ending
  document — which knag has an example test for — survives editing rather than being
  normalised to whichever ending won.

## [0.7.3] — 2026-08-18

### Fixed

- **You could not see which rows you had picked**
  ([#108](https://github.com/danjamk/knag/issues/108)). Multi-select in Arrange has worked
  since 0.7.0. It just did not look like it.

  A picked row was marked by a ground shift alone — a **contrast ratio of 1.14**, where
  3.0 is the floor for a non-text interface element. On a phone in daylight that is
  nothing. Tapping rows did exactly what it was supposed to and gave back no evidence, so
  the feature read as broken.

  A picked row now carries an **amber rail** down its leading edge. Amber because it is
  the only colour in the interface and this is the machine speaking about itself — the
  same voice as `wiped 6` — and because it is the one thing on either board certain to be
  visible outdoors. Contrast goes from 1.14 to **9.5 on Slate and 3.3 on Whiteboard**.

  The ground shift stays as a secondary cue. No new colour enters the palette.

### Notes

- **Every existing test asserted the `picked` class**, which is why none of them caught
  this. There is now one that asserts the computed style, so a state that cannot be seen
  fails the suite rather than shipping.

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

[Unreleased]: https://github.com/danjamk/knag/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/danjamk/knag/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/danjamk/knag/compare/v0.16.0...v1.0.0
[0.16.0]: https://github.com/danjamk/knag/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/danjamk/knag/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/danjamk/knag/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/danjamk/knag/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/danjamk/knag/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/danjamk/knag/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/danjamk/knag/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/danjamk/knag/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/danjamk/knag/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/danjamk/knag/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/danjamk/knag/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/danjamk/knag/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/danjamk/knag/compare/v0.7.2...v0.7.3
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
