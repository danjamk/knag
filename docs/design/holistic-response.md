# The holistic pass — what the design session sent back

**Status:** Accepted
**Received:** 2026-08-19
**Answers:** [holistic-brief.md](holistic-brief.md), sent the same day
**Supersedes:** parts of #92 as shipped in 0.11.0 — see [§3a](#3a--the-bar-put-back-on-a-diet) and [§7e](#7e--132--settings)

The session returned an interactive document — four wipe candidates and three
sound characters you can tap on a phone, plus prototypes of every screen below.
**It is not committed.** It is a 280KB snapshot that carries its own font bundle
and a runtime, it is a moment in a conversation rather than a source of truth,
and everything in it that decides something is written down here instead. Ask the
design session for it again if the prototypes are wanted; tapping the four wipes
on a real phone is worth more than any description of them.

What follows is the record: the verdicts, the token deltas, and the order to
build in. Where a number appears here it is the number to apply.

---

## The four flags — decided

The session flagged everything that asks the house rules to give, rather than
doing it quietly. All four were accepted on 2026-08-19.

| Flag | What it asks | Decision |
|---|---|---|
| **The ledge moves** | A 90ms height change — a second thing on screen that is not still | **Yes.** It runs on `--state-duration`, the same token as the press tint. `CLAUDE.md` now says state changes are not animation, so the rule keeps its teeth |
| **The wordmark leaves the bar** | Brand, not an ADR. The page selector takes its slot | **Yes.** The mark survives on login, the icon, the landing page and the README — and on the empty board, where the cursor is the whole picture |
| **The page wipe is a second timing** | Same keyframes, same ease, page-scoped tokens | **Yes.** One animation at two scales, not two animations |
| **The bar's type goes back** | `--size-machine` 14 → 13, `--size-micro` 12 → 11, icons 20 → 18 | **Yes**, on trial. This reverses half of #92, shipped hours earlier — see §3a |

Everything else holds unchanged: amber is still the only colour, two boards, two
faces, nothing renders what the bytes do not say, nothing editable goes below 16px.

---

## §4 · The ledge

**The second tier is right. Pinning it is what is wrong.**

The idea holds because it is a reachability model rather than a container: tier 1
is what you step over to read the page, tier 2 is what you reach for on purpose,
and the sheet is what you set once. Settings became a junk drawer because there
was no middle rung, not because it was badly organised.

The brief's tension — the bar is thin *because* it sits above the keyboard — is
real and is not solvable by making tier 2 small. So it is not solved:

> **The ledge is momentary.** It opens when you reach for it, it closes when you
> have used it, and **it cannot be open while the keyboard is up.**

Focus the document and the ledge collapses. Nothing permanent is ever added above
the keyboard, so the bar's rationale survives intact — a phone with the keyboard
up sees the same bar it sees today, minus 6px.

**Pin does not ship.** It only means anything when the keyboard is down, which on
a phone is most of the time it is not wanted. One boolean; add it when someone on
an iPad asks.

**The name.** A blackboard's ledge is where the chalk and the eraser sit: not the
board, not put away, and everything on it is a thing you pick up and put back. It
is the object the metaphor already contains and a noun a person can say. The verb
is `open the ledge`. In code it can stay `footer`; the product should not.

```
tier 1 · permanent, above the keyboard
  today ▾        the page, and which page
  saved          the machine slot
  wipe 3         the loop
  ⌃              the ledge

the ledge · momentary, 56px, never with the keyboard
  history · copy · arrange · settings  |  wipe page

the sheet · preferences, set once
  board · view · text size · sound · you
```

🔴 **Amended 2026-08-25 (#192): the ledge opens *above* the bar.** The list above is
reachability order, not layout, and it was read as layout — the ledge shipped below the
bar, so with the footer pinned to the bottom, opening pushed the bar up 56px and put
`wipe page` under the pointer that had just tapped the chevron. 1.2.0 nudged the wipe
control 44px clear of the chevron, which cost the four labels their room on a phone. The
switcher already rose above the bar; the ledge now does the same, the bar never moves, and
the chevron that opened it closes it at the same coordinates. The chevron points up
because that is the direction it opens.

🔴 **Amended 2026-08-25 (#197): the glyph is 24px; the label stays at 11.** The ledge
read like a footnote on a phone at text size 20, and the build proposed 13px labels over
20px glyphs. The ruling — [phase-8-response.md §2](phase-8-response.md#2--197--two-numbers)
— is that the constraint on the ledge is width, not height: four 13px mono labels beside
`wipe page` overrun a 390px phone by 3px and a 375px one by 18, which is the overlap #192
had just removed. So the loudness comes out of the free axis — glyph 18 → 24, a third
larger and the part of the item you aim at — and the label goes on disambiguating a
glyph rather than being read across a room. §3b is *not* amended: nothing on the ledge
follows the reading preference. If it still reads small after a week, the next move is
`--ledge-height` 56 → 64 with the glyph at 26, not the label.

### New tokens

```css
--ledge-height: 56px;
--ledge-duration: 90ms;              /* = --state-duration */
--ledge-ease: var(--wipe-ease);
--ledge-glyph: 24px;                 /* 2026-08-25, #197 — was an 18 attribute on the SVGs */
```

---

## §5 · The inventory, tiered

**The page selector is tier 1, and the wordmark is what pays for it.**

It is not a second-tier operation, and it is two things at once — a control and a
status display. A status display you have to open is not a status display. So it
sits on tier 1 permanently, at the left edge, in the slot the wordmark holds
today, because **a wordmark inside an app you have already opened is the least
load-bearing element on the bar.**

That keeps tier 1 at three controls and two statuses, which is what it holds
today. The bar does not grow to carry 1.1 — which is the whole reason to design
this before #123 rather than after.

Before there is a second page the slot reads `today`: the page's own name, no
caret, not a control. **One page is not a special case of many; many is the
special case, and it earns the caret by existing.**

---

## §3 · The four build decisions, reviewed

### §3a · The bar, put back on a diet

**Right call, no composition.** Fixing a hit-target complaint against the HIG was
correct and should not be undone. What drifted is that the target dragged four
type tokens up with it:

> A 44px target is 44px of touchable area; it is not 44px of ink, and nothing
> about it required the machine voice to grow.

| Token | 0.11.0 | Apply |
|---|---|---|
| `--target` | 44px | **44px — unchanged.** The target is not the ink |
| bar icon size | 20px | 18px |
| `--size-machine` | 14px | 13px |
| `--size-micro` | 12px | 11px |
| `--size-wordmark` | 15px | gone from the bar |
| footer padding | `--space-2` | 3px, targets overhang into the safe-area inset |
| bar height | 52px | 46px |

The inset below the bar is touchable and currently spends its height on nothing.
Every target stays legal at 44px while the bar loses 6px.

🔴 **This contradicts the report that produced #92** — that the icons and text
read too small on every device. The session's position is that this was "a
hit-target problem wearing a visual complaint's clothes". It is cheap to test and
cheap to reverse: nothing outside `public/index.html` references these tokens, and
`browser/settings.spec.ts` already pins the 44px targets. If it still reads small
on a phone, the session is wrong and 14/12 comes back.

### §3b · Text size scales the page, not the chrome — leave it alone

> Chrome that grows with reading preference is chrome asking to be read, and this
> bar is explicitly the thing you step over. At 20px page text a 13px machine
> voice does not read as undersized; it reads as further away, which is where it
> belongs.

### §3c · Copy above wipe, its own row — moot

Both verbs are operations and both leave for the ledge. The instinct carries
across: on the ledge they are separated by a hairline with the destructive one
alone at the far end, and `wipe page` **keeps arming by repetition rather than
growing a dialog.**

🔴 This supersedes the task in #120 that asks the confirmation to become a
`<dialog>`.

### §3d · Devices as a plain list — a symptom

Devices is the first thing in the product whose length is unknown, and **a modal
sheet is the one container that cannot hold an unbounded list** — it has no
navigation and no scroll of its own that means anything.

> The general form of the symptom: Settings is being used as the place where
> anything without a home goes, including things whose size the design cannot
> predict. The ledge fixes the frequency half of that. This is the other half —
> the sheet holds fixed-size preferences, and anything list-shaped gets a screen.

🔴 **Amended 2026-08-20 (#149), after use.** The diagnosis stands and the sheet's
rule is unchanged; **"screen" turned out to be one word too strong.** It shipped as a
full-bleed surface that closed the sheet on the way in, and the first report back was
that it read as being thrown out of Settings rather than as going one level into it.

What the argument above actually needs is a **scroll of its own and a knowable cap** —
neither of which requires the full bleed, and both of which a second *pane* of the same
dialog has. Devices is a pane now: same dialog, same backdrop, same focus trap, a back
control where the close control was. The settings pane still does not scroll, which is
the sentence that was ever load-bearing.

The claim that did not survive contact is "a modal has no navigation": a pane with a
back control **is** navigation. The claim about scroll was true of the *settings* pane
and was over-generalised to the container.

Manage-pages (§7f) and history inherit the pane, not the screen.

---

## §6 · The wipe — #121

**It does not feel like anything because it is a departure. It should be a removal.**

A fade with a leftward slide is how a dismissed card behaves, and a dismissed card
is a thing you sent somewhere. Nothing goes anywhere here; the line stops being on
the board. The board metaphor already owns the right gesture and it is not smooth:
chalk comes off in passes, unevenly, and it is gone before you expect.

**Settled: sweep.** At 14ms the lines stop being six events and become one motion,
which is what a sweep is.

| Token | Now | Apply |
|---|---|---|
| `--wipe-duration` | 420ms | 260ms |
| `--wipe-stagger` | 26ms | 14ms |
| `--wipe-collapse` | 160ms | 130ms |
| `--wipe-travel` | *(literal 10px)* | **28px** — new token |
| `--wipe-ease` | `cubic-bezier(.2,.7,.3,1)` | unchanged |
| `--recovery-in` | — | **90ms** — new, = `--state-duration` |

28px is what makes it read as leaving the board rather than nudging. 130ms closes
the gap while the motion is still in the eye rather than after it.

**One addition that costs nothing:** the amber recovery line arrives *as the
collapse ends*, at 90ms opacity with no travel. Today it is simply there.
Arriving after the release gives the moment a downbeat — the board empties, and
then the record speaks.

Under `prefers-reduced-motion` the stepped opacity collapses to the existing 1ms
and the line still leaves. Nothing new is needed.

### Sound — `land`, and its length is computed

Three characters were built on the same synth and the same lowpass sweep, differing
only in how they end. **`land`** closes with a single soft low knock at the moment
the collapse finishes, so the sound and the gap closing are one event. `snap` ends
on a bright tick and is "a phone-and-a-week question". `settle` ends by narrowing
with no transient and survives the most repetitions.

🔴 **The sound is not a fixed length. It is derived from the motion:**

```
knockAt      = duration + stagger × (n − 1) + collapse
noise length = knockAt
```

The band opens as the first line starts moving and closes exactly when the last
gap finishes closing, with the knock on that same frame. A four-line wipe and a
nine-line page wipe are then the same event at two lengths rather than two sounds.
It also means the audio needs no maintenance — retune a motion token and it
follows — and under `prefers-reduced-motion` the formula yields a sound too short
to play, so it does not, which is correct behaviour rather than a special case.

Still one sound at the start rather than one per line, still low enough not to
compete with a notification, still **off by default** with the switch in the sheet.

> The silent switch is not worked around and should not be. The motion is the
> moment; the sound is a bonus for the person holding a phone with the ringer on.

### §6b · Wiping the page — a different sentence

Wiping completed lines is many small removals. Wiping the page is **one removal of
one thing** — a project ending, a week closed. The same motion at greater length
says "that was thirty lines" when it should say "that was the page".

**Settled: fall.** The design rule: the page leaves as a single object, and **the
empty board is part of the animation** rather than what is left when it stops.

```css
--page-duration: 380ms;
--page-stagger: 16ms;    /* bottom-up */
--page-travel: 18px;     /* translateY, fades on the way */
--page-collapse: 200ms;
--page-beat: 200ms;      /* empty board, held */
/* --wipe-ease unchanged — never ease-in */
/* --recovery-in: 90ms, after the beat */
```

Two guards, and they are the whole difference between released and discarded:

- **The curve.** A discarded thing accelerates away; a released thing starts
  immediately and eases out. Keep `cubic-bezier(.2,.7,.3,1)`, never a linear or
  ease-in fall.
- **The travel is 18px, not off the bottom of the screen.** The lines fade while
  they drop, so nothing is ever seen arriving anywhere. A page that visibly exits
  downward is a page going into a bin; a page that dissolves on its way down is a
  page being let go.

Then the beat: **200ms of empty board before the cursor returns, another 90 before
the amber line.** Long enough to register as silence, short enough that nobody
thinks it broke — and it is what stops `fall` from reading as deletion, because
the record speaks right after.

Sound is `land` at page scale: same synth, knock lower and later, length from the
same formula.

`wash` and `cascade` stay worth keeping in the file. If `fall` feels like deletion
after a week of real use, `wash` is the answer — same two-stage structure with the
direction removed.

---

## §7 · The screens

### History — #91

**It is not a dialog.** A dialog is for a decision you make and dismiss; this is a
place you go, look around in, and come back from. It is the only surface in the
product with navigation of its own, so it is a **full screen from the ledge** and
inherits a real back affordance, real scroll and a bottom bar for its one action.

- **Opens on yesterday, not today.** Today is on the board behind you, and the
  name of the thing people reach for is "yesterday".
- **The selection checkbox is on the right**, deliberately mirrored from the
  page's own checkbox on the left. This is not the page and must never be
  mistaken for it.
- **Two headings** — what got finished, and what was on the page. They answer
  different questions and the record already stores them separately.
- The action says **`add 3 to the page`**, never "restore". Restore implies the
  page goes back to how it was, which is exactly what is not happening. At zero
  selected it is dim and says `select lines`.
- Everything is machine voice except the lines themselves, which stay in Familjen
  Grotesk. **That contrast is what tells you at a glance that you are looking at a
  record rather than a document** — no banner, no "read only" chip.

### The page selector — #123

A drop-up from tier 1. The list is the whole feature: current page in amber, the
rest in chalk, a last row for the rare operations. No icons, no counts, no
last-modified times — **anything else you add is a column, and a column is a file
manager.**

The decision that protects "you land on the page" is one sentence:

> **knag has no index.** There is no screen that lists your pages — only a control
> that switches between them, and it is never the thing you land on.

Three rules follow:

1. **Launch always opens the last page you were on.** Never a picker, never a
   default page, and the selector is never open on load.
2. **The list is capped at nine.** Not a limit anyone hits — a tripwire. If
   someone reaches it, the answer is not pagination; it is that the cap was the
   product and knag is being used as something else.
3. **The list never scrolls.** A scrolling switcher is a file manager with the
   lights off, and the cap exists precisely so that "does it fit on the screen at
   once" stays a design constraint rather than a preference.

What the cap buys, stated plainly: search arrives the moment the list stops
fitting; then folders, because search implies a namespace; then a home screen,
because a namespace needs a root. Every one of those is on [spec §12](../spec.md)'s
Out list.

> A forbidden feature comes back every six months. An unnecessary one does not
> come up.

**Naming:** the selector shows the page's name and nothing about pages in general.
No "all pages", no plural anywhere in the UI. The product still says *the page*; it
just knows which one.

### Managing pages — a screen, from the end of the selector

Same reason as §3d: a list whose length the design does not control cannot live in
a modal. It borrows **Arrange's grammar wholesale** rather than inventing a second
editing idiom — grips on the left, one row picked at a time with the amber rail.
Nothing behind a swipe, nothing behind a long press.

**Rename is not a control.** The name is a live text field, like every other line
in knag — tap it and type. That is one fewer verb, and it is the product's own
rule about rows applied to a list of pages.

The picked page's three rare verbs sit in the bottom bar: `make default`,
`save as template` (that is the whole template mechanism — saving the page as it
stands), and `delete`, which arms by repetition and **names what it will destroy on
the second tap**. Deleting a page is the only irreversible act in the product; it
is the one place a sentence is worth more than a glyph.

Deliberately absent: counts, dates, sizes, search, an "all pages" heading, per-page
icons. The cap is stated here and nowhere else — `4 of 9` in machine voice, top
right, because this is the one screen where someone is about to add to it.

**Ships in the same PR as the selector.** The screen is where the destructive
per-page verbs live, so shipping the selector without it means new · rename ·
delete land in the sheet first and move later.

🔴 **Amended 2026-08-25 (#195): the rows take Arrange's grip.** Order became a
server-side fact in 1.4.0 and needed a control on rows that already carry a text field.
Long-press is the platform's selection gesture inside an input; up/down costs two 44px
targets a row and leaves the name ~110px of a 390px phone. The grip is the one affordance
that does not compete for the touch it needs — `⠿` at `--target-arrange`, dim at rest and
ink under the finger, the same handle SortableJS already binds in Arrange
([phase-8-response.md §5](phase-8-response.md#5--195--the-drag-affordance)). Same verb on
a different list; a second glyph would imply a second kind of reordering. The order
commits on drop through the route; a refusal goes to the pane's error line.

### Login and profile — #122

**The surface should not change shape at all:** one field, one optional device
label, one button, no sign-up, no onboarding, nothing about what knag is. What
changes is what the field holds, and that is a decision not yet made. What the
login surface needs from the credential model, in order:

1. **An identifier the person already knows.** Anything that asks someone to
   invent and remember a second thing fails where the shared passphrase does.
2. **No recovery flow.** knag cannot afford a "forgot your…" screen, a reset email
   template and a support path. Losing it has to be self-service and unattended.
3. **At most one added screen.** A redirect that leaves knag and comes back
   through a consent page is two, and it lands on a product whose entire premise is
   that you open it and you are looking at your page.
4. **The device label has to survive.** It is what makes Devices legible and the
   one thing only the person can supply.

**An email link is the best fit and it is not close.** One field, an identifier
they cannot lose, recovery *is* the login flow, and it costs exactly one added
state. An identity provider puts another company's name and logo on the only
screen that is not the page — which breaks the two-voice rule and adds a colour
before anyone types anything. Per-user passphrases keep today's screen and inherit
today's problem.

**What the #122 spike must answer:** does the link land you on *the page* or on a
"logged in" screen — it must be the page. And does an existing session survive a
new link on the same device — it must, or every re-login costs a device row.

Profile is a section in the sheet with two rows — the address and log out — plus
Devices, which is a screen off it. No avatar, no display name, no "member since":
nobody else can see it, so it is data with no reader.

### §7e · #132 · Settings

**Once the operations leave, Settings is six rows and it fits on the screen.**

The organizing rule is a test rather than a layout:

> **A preference has a current value.** If a proposed row has no value to show, it
> is not a preference and it does not live here.

It stays a sheet rather than becoming a screen, because it now has a fixed and
knowable length. **It does not scroll, and that is a constraint** — a sheet that
scrolls is a junk drawer with a lid, and it is exactly how this one got the way it
did.

| Group | Rows |
|---|---|
| *(unlabelled)* | board · view · text size · **sound** (new, `off` by default) |
| **you** | log out — gains the address in 1.2 · `devices  3  ›` |

One boundary is the whole information architecture, and it stays where it is when 1.2
lands because the account rows were always going to arrive and now they have somewhere
to arrive.

🔴 **Amended 2026-08-20 (#149).** This shipped with both groups labelled, and the
first one was cut after use: `the page` sat directly under a head that says `settings`,
above four rows visibly about the page, and named nothing the reader could not already
see. `you` earns its line precisely because what follows it *is* a change of subject. The
boundary is the information; the second label was the only one carrying any.

🔴 **Amended 2026-08-24 (#194).** The first label is back, with a different job. After a
few days of use the question was "do these apply to every device?" — and they do not:
every row above `you` is localStorage. `this device` names the one thing the reader cannot
see, which is the same test #149 applied, returning the other answer. Same word the
`log out` row already uses, so the sheet says it twice and means it both times. It also
draws the boundary the first server-held setting (#190) will arrive on the far side of.

**Every choice is its options laid out flat, current one filled in amber.** No
toggles, no switches, no disclosure rows that make you tap to find out what a
setting is currently set to. Three or fewer options each, so they fit the row at
380px.

> A switch tells you a state; a pair of buttons tells you the state and the
> alternative in the same glance, and it costs the same height.

`devices` is the one row that is a destination rather than a choice, and it is
marked as one — a count and a chevron, **the only chevron in the sheet.**

🔴 **Amended 2026-08-25 (#190): there are two, and both are in `you`.** The operator's
instructions — 4000 characters the server holds and appends to every agent conversation —
needed a surface, and a textarea collided with this section twice: a preference has a
current value, and devices was the only chevron. The ruling
([phase-8-response.md §4](phase-8-response.md#4--190--the-operators-instructions)) is an
`agent` row under `you`, showing `set` or `not set`, opening a pane whose textarea is the
first thing under the head and saves on blur and on back with no button. What §7e loses
is the clause, not the rule: a chevron means a destination and destinations are rare.
Not manage-pages, because a global setting reached through a pane about pages reads as
per-page — the one thing it must not say.

The build line stays at the bottom, unlabelled, and gains one clause:
`carbon · 41 days`. How far back the record goes is the one fact about knag a
person occasionally needs and currently cannot find anywhere. It is a statement,
not a setting, which is why it sits with the version rather than in a group.

🔴 **This is the one thing in §7e that is not markup.** It needs
`min(created_at)` from `revisions` — a store query and a field on a response
that already exists.

**No new tokens.** 10px radius on the sheet, 3px on the controls, 56px rows, the
amber field for the chosen option, the existing backdrop at `.55`.

```
what left, and where it went

copy the page      → the ledge
Arrange            → the ledge
wipe the page      → the ledge, far end
history            → the ledge, opens a screen
new · rename page  → manage pages
delete page        → manage pages
devices            → a second pane, pointed at here   (a screen until #149)
```

**What does not go in here, ever.** Anything with a verb. Anything whose length
the design does not control. Anything you would touch more than once a month. An
about page, a changelog, a help link, a feedback form, a rate-us row, an export
button, a theme beyond the two boards.

🔴 **About is deleted**, three days after it shipped in 0.11.0. Accepted — it was
always the weaker half of #92, and the rule that removes it is the rule that keeps
the sheet from filling up again. **One amendment:** the repo link moves onto the
build line rather than being lost, because a public MIT project should keep one
path back to the source. `v0.11.1+5c0145d · prod · github` costs nothing.

---

## §8 · The line

**Right idea, wrong words — and the wrong job.**

> "A behavior — not an app, not a task list, not a notepad" is the truest sentence
> written about this product, and it is a sentence for you, not for the reader.

It is a category claim, and category claims make the reader hold three negations,
discard them, and infer what is left. Under a hero that has just shown them the
whole thing in four seconds, that is the wrong ask. **It belongs at the top of
[philosophy.md](../philosophy.md)**, where an argument is what the reader came for.

The page needs a line that names what they just watched:

> ## Throwing it away is the feature.

Runner-up — *A list nags by existing.* — states the mechanism instead of the
payoff. `One page. Wiped every morning.` is already in the system and is still the
best subhead.

**The hero, first cut.** The board is full when you arrive; the wipe runs once on
scroll-into-view rather than on load; the line is already set below the fold-line
so nobody arrives after the joke. No loop. Under reduced motion the board arrives
already empty with the amber line in place — the same picture without the four
seconds. **Slate only**, which answers decision 3 of #90: a page read for forty
seconds does not need two boards.

---

## Build order

The session's own sequence, adopted into [roadmap.md](../roadmap.md):

| | | |
|---|---|---|
| 1 | **The ledge, with the bar's diet in the same PR** | #139 · closes #120 |
| 2 | **The wipe** — motion first, sound behind a switch | #121 |
| 3 | **Settings becomes preferences** | #132 |
| 4 | **The landing page** | #90 · **1.0** |
| 5 | **The selector, with manage-pages in the same PR** | #123 · 1.1 |
| 6 | **History** | #91 · 1.1 |
| 7 | **Login**, after the spike | #122 · 1.2 |

The ledge is first because it is tokens plus one container, it unblocks #120 and
most of #132, and **every other surface here needs somewhere to live.** Ship the
wipe's motion alone if the sound needs a week of living with.

## What the session said to leave alone

> The checkbox, the row geometry and the two-stage structure of the wipe. All
> three are right, and the only reason the wipe is flat is the curve it moves
> along.
