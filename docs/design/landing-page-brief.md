# Brief — the knag landing page

**For:** the Claude Design session, which owns every visual decision in knag.
**Status:** open. Nothing here is built.
**Supersedes:** nothing. The design system's own README lists `ui_kits/site/` — the
landing page and an OG card — but **the bundle shipped without it**. This asks for that
missing piece, plus the decisions it needs.

Answer with decisions, not options. Where this brief is already wrong, say so.

---

## 1. Why now

knag is public at `github.com/danjamk/knag` and the README carries the wordmark. A
landing page is the next surface, and it is the **only** one that runs the brand's
outdoor voice — brand §11:

> The app is quiet: slate, chalk, amber, one face, nothing raised. The landing page runs
> hot — heavier condensed type, amber pushed toward orange, big flat statements. Same
> palette family, different volume. That is not inconsistency; it is a brand that knows
> where it is.

Everything in this brief is subordinate to that paragraph.

## 2. What §11 already decides — do not re-open

- **The hero *is* the wipe.** A board full of a real day's list. Checkboxes fill. Wipe —
  everything goes. A beat of empty slate. Then one amber line, low and quiet:
  `wiped 6 · carbon has them`.

  > That is the product, the promise, and the joke in about four seconds. Nothing needs
  > to be written underneath it.

  🔴 One correction the design session should carry: **"Carbon" is dead.** It was cut,
  the design pass proposed "the tray", and the shipped word is **history** — it is
  already the MCP tool name (`knag_history`) and the API route. So the line is
  `wiped 6 · bring back`, matching the app, or `wiped 6 · it's in the history`. Pick one
  and say which.

- **`--amber-loud` `#FF8A00`** exists for this page and **never** appears in the app.
- **Display sizes** 34 / 56 / 88 / 132 are already in the design system's typography
  tokens, marked landing-page-only.
- **Two boards still apply.** The page respects `prefers-color-scheme` or it does not —
  that is a decision this brief needs (see §5).

## 3. What the app can lend it

Everything visual now lives in the repo, so the page does not start from nothing:

| | |
|---|---|
| Tokens | `public/index.html` `:root` — both boards, complete, flat hexes |
| Typefaces | `public/fonts/` — Familjen Grotesk variable + DM Mono 300/400, subset woff2, SIL OFL |
| Mark | `public/icons/knag-icon.svg`, and the wordmark lockup at `docs/assets/knag-wordmark.svg` |
| Glyphs | Eight inline SVG paths, in `client/src/app.ts` — 16-unit grid, 1.5 stroke, square caps |
| The real screen | `public/index.html` + `client/src/app.ts`, deployed and current |

The wordmark SVG is generated from DM Mono Light outlines at the Wordmark component's
own proportions (0.01em tracking, 0.14em gap, block 0.5em × 0.72em on the baseline). If
the design session wants a different lockup for the page, say so — it is generated, not
hand-drawn, so it can be regenerated.

## 4. Hard constraints

- **Static, self-contained, no framework.** It will be served from GitHub Pages. No
  build step, no npm dependency, no CDN — the fonts are already in-repo and must be
  referenced locally.
- **The heaviest weight available is 700.** Familjen Grotesk's axis is 400–700 and knag
  ships only that. "Heavier condensed type" cannot mean a weight the file does not have.
  Either pick a display face and accept a fourth font file, or specify how 700 plus
  tracking and scale does the work. **This is a real decision and the brief cannot make
  it.**
- **No screenshots in browser chrome.** Brand §13, explicit.
- **The kill list applies in full** — gradients, glassmorphism, glow, blur-behind,
  purple/indigo AI palettes, sparkle icons, robot illustrations, confetti, chalk-script
  fonts, cream + serif + terracotta, and the words seamless / effortless / supercharge /
  unlock / reimagine.
- **`prefers-reduced-motion` must have an answer.** The hero is an animation and the app
  collapses its only animation to 1ms under the preference. A hero that is the wipe
  needs to say what a reader who cannot have motion sees instead — a still of the
  after-state, a static before/after pair, or something else.

## 5. Decisions this brief needs

1. **The hero's mechanics.** Autoplay on load, scroll-triggered, or a control the reader
   presses? Autoplay costs the joke if it fires above the fold before anyone is looking;
   a button makes them opt into a four-second wait.
2. **Loop or once?** A wipe that replays every eight seconds becomes wallpaper. One that
   plays once leaves an empty board for anyone who arrives late.
3. **Does the page follow the OS board, or commit to slate?** The app has two boards
   because it is read for hours. A landing page is read for forty seconds. Committing to
   slate is defensible and halves the work; following the OS is more consistent.
4. **The display face** — see §4. A fourth font file, or 700 doing the work.
5. **How much page is there below the hero?** §11 says "nothing needs to be written
   underneath it." Taken literally that is a one-screen site. If there is more, name the
   sections; if there is not, say so and the answer is a one-screen site.
6. **What the page asks for.** knag has no signup — it is a repo you deploy yourself. So
   the call to action is GitHub, or documentation, or nothing at all. Nothing at all is a
   real option and fits the voice.
7. **The OG card** (1200×630), which the design system's README also listed and which
   also did not ship. Same palette, and it is the thing that actually gets seen when the
   link is pasted.

## 6. Out

- Any claim knag does not deliver. No "AI-powered", no roadmap, no testimonials, no
  metrics, no logos.
- Signup, waitlist, email capture, analytics.
- Anything implying a second document exists.
- Onboarding. There is nothing to onboard.

## References

- `knag-brand-v2.md` §11 the outdoor voice, §12 hard constraints, §13 kill on sight
- The design system bundle — `_ds/`, tokens and components, already landed in-repo
- [docs/spec.md](../spec.md) §12 scope, §17 what a larger future would break
- [ADR-004](../adr/ADR-004-display-matches-the-bytes.md) — applies to the *app*, not to
  this page; the landing page may render whatever it likes because it is not the page
