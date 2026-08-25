# Brief — Phase 8, the four small asks (#197, #196, #190, #195)

**For the Claude Design session.** You have the repo. This points rather than restates.

Four decisions, each small, none of which the build can make alone. No new feature and no
holistic pass: everything below is a number, a mark, or the shape of one surface, and each
one is already built up to the point where your answer is the missing piece. Sent as one
message because six round trips for six numbers is how a phase stalls.

---

## 1 · What shipped while you were away

A week of real use (2026-08-22 → 25) produced eight issues, and three releases carried
them — [roadmap Phase 8](../roadmap.md#phase-8--what-a-week-of-use-found--190197--ships-121-13-14).
The parts that touch your territory:

**The ledge opens above the bar now (#192, 1.3.0).** Your §4 list was reachability order
and had been read as layout: the ledge shipped *below* the bar, so with the footer pinned
to the bottom, opening pushed the bar up 56px and put `wipe page` under the pointer that
had just tapped the chevron. The 44px nudge 1.2.0 gave the wipe control was a workaround
for that, and the reason four labels ran together on a phone. Both gone. The chevron
points up because that is the direction it opens. §4 carries the dated amendment.

**The checkbox in the editing surface has a 44px target (#193, 1.3.0).** Ink unchanged at
18px; the target reaches from the screen edge through the box to the gap after it. Left
padding is still 14px — see §2.

**Dev names itself (#196 mechanism, 1.3.0).** `/manifest.json` goes through the Worker;
dev's home-screen tile reads `knag dev` and its tab `knag · dev`. The icon is still the
prod mark, because a dev mark is yours or nobody's — §3.

**Settings has two group labels again (#194, 1.2.1).** `this device` above board / view /
text size / sound, `you` below. #149 cut the first label because `the page` named nothing
the reader could not see; this one names the one thing they cannot — every row above
`you` is localStorage and the iPad will not follow. §7e carries the amendment.

**The server holds its first setting (#190, 1.4.0)** and **pages hold an order (#195,
1.4.0)** — both as server halves with a route and no surface. §4 and §5.

---

## 2 · #197 · The ledge is too small on a phone — two numbers

The screenshot that raised it: iPhone, text size at 20, and the ledge reads like a
footnote to the page. 18px glyphs over 11px labels (`--size-micro`) under a document set
at 20px. "Everything is quite small" was said about the ledge, not the bar.

Two of your rules put it there, both deliberate:

- Ledge labels are `--size-micro` with the glyph above, because "at 11px the label is the
  thing that makes a glyph unambiguous and neither is enough alone" (§4).
- Chrome holds at `--size-control` when text size is raised: "someone raising this wants
  more room for the document, not a louder interface" (§3b).

The second rule is right for the bar, which sits above the keyboard. The ledge is
different by its own definition — the rung you reach for on purpose, never open with the
keyboard up — so it is the one place a louder interface costs nothing.

**Asked:** two numbers, applied to `.ledge-item` and nothing else.

1. Ledge label size. Proposal: `--size-machine`, 13px.
2. Ledge glyph size. Proposal: 20px.

56px holds either: 20 + 3 + 13 = 36. Alternatives if you disagree: the ledge follows text
size one step per step (breaks §3b deliberately, ledge only); or hold the line and say why.
Not proposed: glyph-only on narrow screens — §4's finding stands at 18px.

Measure against the row *after* #192: the 44px dead margin is gone and a label sets its
own width from the 44px floor, so there is more room than the screenshot shows.

---

## 3 · #196 · A dev mark

Two installs of the same app on one iPad — dev is the ITP test subject, prod is the
dogfood — were identical tiles both called `knag`. The name is fixed; the tile is not. The
tab favicon has the same twin problem.

**Asked:** a dev variant of the mark. One signal, chosen by you — an amber dot, a hollow
block, a second cursor, anything that reads as "same product, not the real one" at 16px
and at 180px. Deliverables mirror the prod set exactly so they drop into
`public/icons/`: `knag-icon-dev.svg`, 192 and 512 PNGs, a 512 maskable, and a favicon.

Prod stays exactly as it is. The MCP connector icons are out of scope — they already
derive from the origin and dev and prod each advertise their own.

---

## 4 · #190 · Where the operator's instructions are edited

**What exists.** A `settings` table with one key, `agent_instructions`: free text the
operator writes, appended to the MCP server's `instructions` under a fixed heading,
`The operator adds:`, so every agent conversation carries it. Read per request, capped at
4000 characters, session or bearer, never a tool. Spec §10 has the paragraph. Today it is
set with a `curl`.

**What is needed.** A place in the app to edit a few paragraphs of plain text — page
purposes, house style, standing rules.

**Where it collides with §7e.** The settings sheet's rule is *a preference has a current
value*, three or fewer options laid flat, no disclosure rows, it does not scroll, and
`devices` is *the only chevron in the sheet*. A textarea breaks the first; a row that opens
one breaks the last.

Three shapes, none decided:

1. **`agent ›` as a second destination row under `you`**, opening a pane like devices —
   one textarea, save on blur or on leaving. Costs §7e its "only chevron" line.
2. **Reached from manage-pages**, which is already off the switcher and already about the
   pages the text mostly describes. Keeps the sheet clean; puts operator text next to
   page names, which is where an agent reads them.
3. **Something else** — it is the first server-side setting, and the `this device` / `you`
   boundary in the sheet was drawn with it in mind.

**Asked:** which surface, and the copy for its row and its head. Mobile-first: a textarea
under the keyboard on a phone is the case to design for.

---

## 5 · #195 · The drag affordance in manage-pages

**What exists.** `position`, server-side; `listPages` in that order; `PUT
/api/pages/order` taking the full list of live ids. Not a column — the list returns no
position; the order is the array's. Today it is set with a `curl`.

**What is needed.** A way to put the pages in an order from manage-pages, which is a
settings *pane* (list of rows: name field, `template`, delete) and not Arrange.

**Constraints.** §7: no icons, no counts, no last-modified — anything else is a column,
and a column is a file manager. Nine pages max. SortableJS is already vendored and
handles Arrange's grip. A rename field on every row means a drag handle competing with a
text input for the same touch.

Shapes: a grip on each row (Arrange's, at `--target-arrange`); long-press on the row
itself; or up/down controls, which is what a list of nine can afford and Arrange cannot.

**Asked:** which affordance, and whether the grip is Arrange's glyph or its own.

---

## 6 · Non-negotiables, unchanged

- **Mobile-first.** Phone, keyboard up, thumb from the bottom edge.
- **Tokens we can apply in an afternoon.** Every colour and size lives in the two `:root`
  blocks in `public/index.html`, pinned by a test. Amber is the only colour. Two faces.
- **A state change is not an animation.** The wipe is the only one.
- **Nothing renders what the bytes do not say** (ADR-004).
- **No index.** A control that switches pages, never a screen that lists them.

---

## 7 · What a good answer looks like

Four short rulings, in the order above: two numbers for §2, a mark for §3, a surface and
its copy for §4, an affordance for §5. Where you disagree with a proposal, say so and say
why — the build applies the number you give, not the one written here. Anything that
changes a decision already recorded in `holistic-response.md` gets a dated amendment
there; the build writes it.
