# Brief — the knag product page

**For:** the Claude Design session, which owns every visual decision in knag.
**Status:** open. Nothing here is built.
**Supersedes:** [`landing-page-brief.md`](landing-page-brief.md) §5.5 — *"nothing needs
to be written underneath it"* — and the one-screen site that answer produced. That
decision is being reversed deliberately, not forgotten. §2 says why.

Answer with decisions, not options. Where this brief is already wrong, say so.

---

## 1. Why now

The landing page shipped in 0.16.0 and is live at
[danjamk.github.io/knag](https://danjamk.github.io/knag/). It is one screen: a board, a
wipe, `wiped 6 · bring back`, *Throwing it away is the feature.*, and a link to GitHub.
It does exactly what §11 of the brand asked for and it is not a product page.

Everything that makes knag worth deploying shipped **after** it. Pages (1.1), templates
(1.1), history with per-line restore (1.2), the phone pass (1.3), the operator's own
agent instructions (1.4), drag-ordered pages (1.5). The live page describes 1.0 and says
nothing about any of it.

**This asks for a full rewrite of `site/index.html`**, still one file, still on GitHub
Pages, still the same URL. The hero is the only part with a prior ruling behind it and
§4.1 asks whether it survives.

🔴 **Nothing on the roadmap covers this.** Phase 5 · #90 shipped the landing page and
closed; the queue past 8b/8c is Phase 9 · multi-user · 1.6. So this is new work and it
needs an issue and a roadmap entry before it becomes a release — including where it sits
relative to Phase 9, which changes what §8 is allowed to promise.

## 2. The decision being reversed, and why

`landing-page-brief.md` §5.5 asked how much page there is below the hero, and quoted
brand §11: *"nothing needs to be written underneath it."* The answer was a one-screen
site, and it was right for a repo whose entire product was a page you wipe.

Three things changed:

1. **The product is no longer one page.** Up to nine, switched from a drop-up, each with
   its own history and its own template. The four things a person actually uses knag for
   are four pages, and a site that implies one document is now describing an older
   product.
2. **The differentiator turned out to be the agent, not the minimalism.** The business
   model doc reaches this and states it flatly: *"the minimalism is the philosophy; the
   agent access is the moat."* Every product in the comparable set is a to-do app.
   knag is a to-do app **with a first-class MCP server**, and nothing in the $36/yr band
   has one. The live page does not mention it.
3. **There is a use case that shows all of it in one loop**, and it is in §5.

🔴 The reversal is scoped: **there is more page, not a louder page.** The voice does not
change, the palette does not change, and the wipe is still the first thing anyone sees.

## 3. What the page has to say, in priority order

The operator's own list of what stands out, re-ranked by what is defensible:

| | The claim | Why it ranks here |
|---|---|---|
| 1 | **Claude writes to the same page you do** | The only claim in this list a competitor cannot make tomorrow. Four MCP tools, OAuth for claude.ai / Desktop / mobile, a static bearer for Claude Code. |
| 2 | **It is on every device, in about four seconds** | Table stakes as a claim, decisive as a demonstration — and it is the second beat of the one animated scene, so it costs nothing extra to prove. |
| 3 | **Nothing is lost** | Not a feature. It is the mechanism that makes the wipe free, so it belongs beside the wipe rather than in a list. |
| 4 | **Nothing else is in it** | Shown by the Out list, never claimed as "simple." Every to-do app on earth claims simple. |
| 5 | **A page per thing you are doing** | Nine, no folders, no index. Load-bearing: without it §5's use cases contradict the copy. |

🔴 **The page never says "AI."** It says *Claude*, or *your agent*. "AI-powered" is on
the kill list and the test asserts it; the surrounding vocabulary — *powered by*,
*intelligent*, *smart* — is the same failure a word later.

## 4. What the app can lend it

Unchanged from `landing-page-brief.md` §3, plus what shipped since:

| | |
|---|---|
| Tokens | `public/index.html` `:root`, both boards, flat hexes. The live page already carries slate verbatim. |
| Motion | `--wipe-duration` 260ms · `--wipe-stagger` 14ms · `--wipe-collapse` 130ms · `--wipe-travel` -28px, at the app's own numbers. The page runs the real wipe, not an impression of it. |
| Typefaces | `site/fonts/` — Familjen Grotesk variable 400–700, DM Mono 300/400, subset woff2, byte-identical to `public/fonts/` and tested. |
| Mark | `public/icons/knag-icon.svg`; wordmark lockup at `docs/assets/knag-wordmark.svg`, generated not drawn. |
| Glyphs | Eight inline SVG paths in `client/src/app.ts` — 16-unit grid, 1.5 stroke, square caps. The ledge's are 24px since 1.5.0. |
| The real screens | `public/index.html` + `client/src/app.ts`, deployed and current. |

### 4.1 The hero

The live hero is nine lines of a real day, six of them done, a scroll-triggered wipe,
then one amber mono line and the headline. **The question is whether it survives a page
being built underneath it.**

The argument for keeping it verbatim: it is the brand's outdoor voice, it is four
seconds, it works, and it is already tested. The argument against: its sub line —
*"One page. Wiped every morning."* — is now the only thing above the fold, it describes
the 1.0 product, and it spends the most valuable line on the page restating the
headline. **That line is the one thing this brief is confident should change.**

## 5. The one animated scene

One use case gets a full scene. It is the workout, and it is the only one that carries
all five claims in a single loop:

| Beat | What happens | Which claim |
|---|---|---|
| 1 | *"push day, 45 minutes"* — lines arrive on the page one at a time, not typed by a person | 1 |
| 2 | The same page, on a second surface, already holding them | 2 |
| 3 | Boxes fill one at a time, at a thumb's pace | 5 (this is the page you actually use) |
| 4 | Wipe. `wiped 8 · bring back` | the wipe |
| 5 | One amber mono line carrying last week's numbers | 3 |

The other three use cases are **a row of text and nothing else** — shopping list built
inside a conversation about dinner, work tasks wiped daily, a thought caught on whichever
device is in your hand. They do not get scenes. Three more animations would turn the one
expressive moment in the product into wallpaper, which is the reasoning the live page
already applies to looping the hero.

🔴 **Beat 1 is the hardest visual problem on the page**, and it is a ruling this brief
cannot make — see §7.1.

## 6. Hard constraints

Everything in `landing-page-brief.md` §4 still binds. Restated because a rewrite is
exactly when a constraint gets dropped:

- **Static, self-contained, one file.** `pages.yml` uploads `site/` as a folder and its
  own comment says that if it ever grows a build step, the constraint has been quietly
  dropped. No framework, no npm, no CDN, no external fetch of any kind.
- **Fonts are local and byte-identical to `public/fonts/`.** A drifted copy renders in a
  fallback stack and looks merely unfinished rather than broken. Tested.
- **Slate only.** No `prefers-color-scheme` block. Tested.
- **`--amber-loud` `#FF8A00`** is the page's one permission the app does not have. Amber
  is still the only colour; a third means something went wrong.
- **700 is the heaviest weight that exists.** The live page answers this with 600 at
  `clamp(40px, 9vw, 88px)`, leading under 1, tracking -0.025em. If the product page needs
  a second display treatment, it comes from the same axis or it comes with a written
  justification for a fourth font file.
- **No screenshots in browser chrome.** Brand §13, explicit — and §7.2 asks whether a
  phone bezel is the same sin.
- **The kill list in full** — gradients, glassmorphism, glow, blur-behind, purple/indigo
  AI palettes, sparkle icons, robot illustrations, confetti, chalk-script fonts, cream +
  serif + terracotta, and the words *seamless / effortless / supercharge / unlock /
  reimagine / AI-powered*.
- **`prefers-reduced-motion` has an answer in every scene**, not just the hero. The
  hero's answer is arrival at the after-state. A five-beat narrative has no single
  after-state, which is §7.4.
- **Every claim is true of code that has shipped.** The numbers are in §9.

## 7. Decisions this brief needs

1. 🔴 **How the agent is depicted.** Beat 1 has to read as *something other than you put
   these lines here* without a chat bubble, a robot, a sparkle, or a purple gradient —
   all four are on the kill list and the first is the category cliché. The one asset the
   brand already owns is the two voices: DM Mono is what the app says about itself.
   Whether that stretches to *what the agent did* is a genuine typographic question, and
   it was already flagged as one for the history pane. Rule on it.

2. **Whether a second surface can be shown at all.** Beat 2 is "the same page, somewhere
   else," and the honest way to draw that is two devices. Brand §13 bans browser chrome.
   A phone bezel is not browser chrome, and it may be the same instinct. If the answer is
   no bezel, beat 2 needs a different mechanic — the board reflowing to a phone's measure,
   a second column, something else.

3. **Scene triggers.** The hero is scroll-triggered, once, on `IntersectionObserver` at
   0.25 — chosen because it guarantees the reader is looking at the full board at the
   moment it empties. The workout scene is five beats and longer than four seconds. Same
   mechanic, a pinned scroll-scrubbed sequence, or a control the reader presses.

4. **The reduced-motion answer for a five-beat scene.** The hero's answer is that the
   board arrives already empty with the amber line in place, because the after-state is
   what the page is about. A narrative has no equivalent. A still per beat, one still of
   the end, or prose.

5. **The hero's sub line** — see §4.1. It is the highest-value line on the page and it
   currently describes 1.0.

6. **Section count and order**, given §3's ranking. This brief's proposal is: hero ·
   the agent (with the scene) · the record · a page per thing · what it does not have ·
   deploy it yourself. Six. If that is five or seven, say which.

7. **The OG card.** `site/og.png` is committed output from `scripts/og-card.sh` and it is
   what a pasted link actually renders as. Same card, or re-cut for a product page.

## 8. What the page asks for

**Deploy it yourself.** There is no signup, no waitlist, no hosted version and no email
capture — knag is a Cloudflare Worker and a D1 database in *your* account, MIT, and the
data is yours in a way no comparable product's is. That is the CTA and it is also a
claim worth making out loud.

The live page's test asserts exactly one link on the page and that it points at the
repo. A product page needs more than one — quick start, spec, philosophy — so §10 has
the test change that goes with it.

## 9. The numbers, verified

Every one of these is true of `main` today. Nothing else may appear as a number.

| Claim | Value | Source |
|---|---|---|
| Sync while you are editing | **4s** | spec §14.4 |
| Idle 2–15 min / >15 min / hidden | 15s / 60s / stopped | spec §14.4 |
| On focus or tab-visible | immediate, regardless of tier | spec §14.4 |
| Pages | **up to nine**, no index, launch opens the last one you were on | spec §12 |
| MCP tools | four — `knag_read`, `knag_write`, `knag_wipe`, `knag_history` | spec §10 |
| Agent clients | claude.ai / Desktop / mobile via OAuth 2.1; Claude Code via bearer | ADR-005 |
| The record is never pruned | the only `DELETE` in the tree is on `sessions`; retiring a page is `UPDATE pages SET deleted_at`, and its history stays | `worker/src/store.ts`, migration 0005 |
| History pane | **seven days**, per page, tap a line to bring it back | 1.2.0 |
| The permanent record | `cleared_items`, never pruned, any date range through the API | spec §5 |
| `bring back` | one tap, expires at the device's next local midnight | philosophy §4 |
| Wipe scopes | finished rows, or the whole page | spec §12 |
| The wipe control | **`wipe 3`** — a labelled word with the count inside it, never a glyph. At zero it renders nothing | spec §7 |
| The whole-page wipe | lives on the ledge, confirms by repetition — `again to confirm` — never a dialog | spec §7 |
| With a template | the whole-page wipe lays the template back down and reads `reset page` | 1.1.1 |
| Boards | slate and whiteboard — **in the app**, not on this page | spec §9 |
| Stack | Cloudflare Worker + D1, PWA, no framework, MIT | README |

🔴 **Do not claim non-Anthropic MCP clients.** ADR-005 names the surfaces it was built
against and nothing in the repo asserts that a third-party client works. "Works with
Claude" is defensible; "works with any MCP client" is a support burden the page would be
signing up for.

🔴 **Phase 9 is multi-user, and it ships 1.6.** §8's framing — one operator, your
Cloudflare account, your data — is true today and is the next thing on the roadmap to
change. The page should not be written so that multi-user makes it a lie, which mostly
means saying *your account* rather than *one person only*.

🔴 **The history claim needs its two halves kept straight.** The pane shows seven days.
The record of what you finished is `cleared_items`, which is never pruned — so *"what did
I lift in March"* is answerable, and it is answered by asking Claude, not by scrolling.
A page that says "full history" and ships a seven-day pane has written a bug report.

## 10. What the rewrite breaks, and the fix

`worker/test/site.test.ts` is nine static checks and it is the only thing that ever looks
at this file. Four assertions are written against the one-screen page and will fail:

| Assertion | Why it breaks | The fix |
|---|---|---|
| `expect(links).toHaveLength(1)` | A product page links to the quick start and the docs | An allowlist of destinations rather than a count. The rule being protected is *no signup*, not *one anchor*. |
| `toContain("One page. Wiped every morning.")` | §7.5 changes it | Assert whatever the new sub line is |
| `not.toMatch(/\byour pages\b/i)` | 🔴 **This assertion is now wrong.** It was written in 0.16.0 to enforce "no second document"; pages shipped in 1.1 | Replace the pattern with what is *still* out: `folders`, `search`, `due dates`, `tags`, `notebooks`, `second brain` |
| `wiped (\d+)` vs `<li data-done>` count | There are two boards on the page now | Run the check per board, not per document |

Five hold unchanged and must keep holding: no off-origin references, font byte-equality,
no `prefers-color-scheme`, a reduced-motion answer in both halves, and the kill list.

Two files know the page exists and both are in scope: `worker/test/site.test.ts` holds
the assertions, and `vitest.config.ts` reads `site/index.html` and the two font
directories at config time and hands them over as bindings, because the test runtime has
no filesystem. Nothing else in the suite ever looks at this file — **there is no browser
test and no route**, so every constraint on it is the kind that fails silently.

Add one: **no `<video>`, no `<img>` of an animated format** — if the answer to §7.3 is
that the scenes are real DOM at the app's own tokens, a test should say so, because a
recorded GIF is exactly the shortcut a later edit takes.

## 11. Out

- Any claim knag does not deliver. No metrics, no testimonials, no logos, no roadmap.
- Signup, waitlist, email capture, analytics, pricing.
- The word "AI" as a modifier. Claude has a name.
- Anything implying folders, search, tags, due dates, notifications, or a second brain.
- Onboarding. There is nothing to onboard.
- A second animated use case. §5 decides this and it is not a budget question.

## References

- [`landing-page-brief.md`](landing-page-brief.md) — the brief this supersedes in part,
  and §2–§4 of it still apply in full
- `site/index.html` — the live page, and the reference implementation for how an app
  animation is restaged on a static page
- `worker/test/site.test.ts` — the nine checks, four of which change
- [`../spec.md`](../spec.md) §12 scope · §14.4 polling · §10 MCP · §5 history
- [`../philosophy.md`](../philosophy.md) §4 — the daily fresh list is a habit, not a
  feature, and the page must not imply the app performs it
- [`holistic-response.md`](holistic-response.md) §7 the switcher · §8 slate-only
- `knag-brand-v2.md` §11 the outdoor voice · §12 hard constraints · §13 kill on sight
- [ADR-004](../adr/ADR-004-display-matches-the-bytes.md) — governs the *app*. This page
  may render whatever it likes, because it is not the page.
