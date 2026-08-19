# knag — a holistic design pass

**For the Claude Design session. Written 2026-08-19.**

You shipped knag's identity — the two boards, the two faces, the amber, the mark — and you
hold the design system. **You also have the repo**, so this brief does not restate what is
in it. Copying the palette in here would only give it something to go stale against, and
today has been a long lesson in exactly that.

What this is instead: a reading list, an account of what has been decided **without you**,
and the four things we want your eye on.

## What we want back

**One view of the whole product, through 1.2.** Not four answers to four issues.

There is a new organizing idea in §4 that came from use rather than from design — a second
tier on the bottom bar — and it may be the thing that resolves two of the open issues on
its own. It needs designing, testing against everything that has to fit on it, and telling
us if it is wrong.

Most useful, in order:

1. **The bar, and what goes on it** (§4–§5). The organizing question, and the one that
   makes the rest fall out.
2. **A verdict on §3** — decisions taken in the build without you. "That was right",
   "change it", and "that is a symptom of something bigger" are all useful. Please do not
   be polite about it.
3. **Motion and sound for the wipe** (§6) — the one place the product is allowed to be
   expressive.
4. **The screens behind the bar** (§7) — history, documents, and the multi-tenant
   surfaces that 1.1 and 1.2 need.
5. **The positioning line** (§8), which the landing page hangs on.

🔴 **This is mobile-first, throughout.** Not responsive-down-from-desktop. The product is
used on a phone with a keyboard up and a thumb reaching from the bottom of the screen;
everything else is the accommodation.

Anything you think we are getting wrong that is not on this list is more valuable than
anything that is.

## 1. Read these first

Roughly in this order. Everything visual is in one HTML file, which is the whole point.

| | |
|---|---|
| `public/index.html` | The entire interface. Both `:root` blocks hold every colour, size, space and motion token; nothing outside them names one, and a test enforces it |
| `docs/roadmap.md` | Where this is going, and why in that order. The release shape in §"The release shape" is the frame for everything below |
| `CLAUDE.md` | The conventions, including the ones about your work — amber, two boards, two faces, one animation |
| `docs/adr/ADR-004-display-matches-the-bytes.md` | Why there is no rendered formatting. Read before proposing anything that renders |
| `docs/design/landing-page-brief.md` | The existing landing-page brief. Its §5 lists what it is still waiting on; none of it has changed |
| `CHANGELOG.md`, 0.8.0 onward | What has shipped since your bundle, in the order it happened and with the reasoning |

The three issues with open design questions are **#121**, **#120** and **#132**, plus
**#90** for the landing page.

---

## 2. What changed since your bundle

The largest change is structural and the repo tells it better than this can — see
[ADR-007](../adr/ADR-007-one-editing-surface.md) — but the short version, because it
affects everything you look at:

**The editing surface was replaced.** knag used to render one form control per row. It is
now a single CodeMirror document, because a DOM selection cannot span two form controls and
selecting across lines is the most ordinary thing a text editor does. The checkbox is still
a real tappable control drawn over the bytes and the row geometry was matched deliberately,
so it looks closer to the old one than it sounds — but **the row list is on its way out**,
and a mode in Settings goes with it.

Shipped since, all visible in Settings: **Devices** (live sessions, revoke, log out),
**copy the page**, **Text size**, **About**. Settings has gone from four sections to seven.
The wipe now animates in the new surface, which it did not for a day.

---

## 3. 🔴 Decisions made without you

`CLAUDE.md` says colour, type, motion and icons come from your session rather than from the
build. That held for months. On 2026-08-19 it bent four times in one day, each time
defensibly, which is precisely how a system drifts.

**These are the ones to review. Overrule any of them.**

### a. The footer's controls got bigger — the one that matters

The touch target was **28px**; Apple's HIG minimum is 44pt. The complaint was "the icons
are a bit too small on all devices", which turned out to be a hit-target problem rather
than a visual one, so it was fixed against the standard: target 28→**44px**, icons 18→20px,
`--size-machine` 13→14, `--size-micro` 11→12, `--size-wordmark` 14→15. The bar grew 44→52px
with its vertical padding dropping a step to absorb the rest.

🔴 **44px is a floor, not a design.** The bar may now be heavier than the product wants, or
the icons may want redrawing at the larger size rather than scaling into it. The whole
footer is four tokens; changing it is an afternoon.

### b. Text size scales the page and not the chrome

Three steps — 16 · 18 · 20 — moving `--size-row` only. Controls hold at a fixed
`--size-control: 16px`. The argument: someone raising the reading size wants more room for
the document, not a louder interface. The counter nobody made: at 20px page text, 14px
chrome may read as undersized rather than quiet.

### c. `copy the page` sits above `wipe the page`, on its own row

Both are whole-page verbs and one throws the page away, so they do not share a row. A
safety decision rather than a visual one, and it makes the section taller.

### d. Devices renders as a plain list

Label, start date, `revoke` per row; the current device in amber with the words "this
device" instead of a control. **The first thing in the interface whose length is unknown**
— fine at two rows, the whole sheet at fifteen.

---

## 4. The organizing idea: a second tier on the bar

This came from use, not from design, and it may be the thing that resolves two open issues
at once.

**The bar at the bottom is loved for being thin.** Three controls, a wordmark and a save
status. That thinness is deliberate — spec §7 says its budget is what sits permanently
above the keyboard on a phone.

**And it is the reason Settings has become a junk drawer.** Everything that could not
justify a permanent slot went into a modal sheet, so operations that are not rare —
copying the page, wiping the page — are three taps and a scroll away. Settings has gone
from four sections to seven, and #132 was filed to redesign it.

### The proposal

A control on the bar that **expands it to a second tier on demand**, holding operations
that deserve to be reachable but not permanent. **Pin it to keep it open**, or let it
collapse.

Two tiers of reachability rather than one, and a modal sheet that goes back to being what
it should be: **preferences, not operations.**

🔴 **What this resolves without being asked to.** #120 asks where the whole-page wipe
belongs on the main screen — it belongs on tier 2. #132 asks what shape Settings should be
— much of the answer is that half its contents leave. **Please push back if that is wrong**,
but if it is right, one design replaces two.

### The tension to solve, stated plainly

The bar's whole rationale is that it is thin, because it sits above the keyboard on a
phone. **A pinned second tier permanently eats vertical space in exactly the situation the
constraint exists for.** That is the design problem, and it is not obviously solvable by
making tier 2 small — the controls still have to clear 44px.

Worth knowing: the recovery line (`wiped 6 · bring back`) already appears *above* the bar
as transient chrome after a wipe, so a second tier is not the only thing competing for that
edge.

### It needs a name

The code calls it `footer`, which is HTML rather than product. It has never had a name in
the product's own vocabulary — which is the board, the page, the wipe, the nag, Arrange.

A blackboard's bottom ledge is a **chalk tray** or rail, which fits Slate exactly. One
caution: `docs/design/landing-page-brief.md` records that "the tray" was proposed once
before, for the recovery concept, before "history" won. So the word is free but carries a
prior association. **Naming is yours.**

---

## 5. Everything that has to fit, and how often it is used

The inventory, frequency-ordered. This is the input to the tiering question — it is not a
proposal, and the grouping is deliberately not pre-decided.

| Operation | How often | Where it is today |
|---|---|---|
| **wipe completed** | several times a day | tier 1 · hidden at zero |
| **document selector** | several times a day, once it exists | 🔴 does not exist |
| **Arrange** — reorder, multi-select, delete | weekly | tier 1 |
| **copy the page** | occasional | buried in Settings |
| **history / yesterday** | occasional, and urgently after regret | 🔴 does not exist |
| **wipe the page** | when a project ends | buried in Settings |
| **new · rename · delete document** | rare | 🔴 does not exist |
| Settings — board, view, text size | set once, then never | Settings, correctly |
| Devices, profile | rare | Settings, correctly |
| Build info | never; it is a diagnostic | Settings, and nobody acts on it |

🔴 **The document selector is not a second-tier operation.** Once there is more than one
page it is plausibly the **most-used control in the product after the wipe** — and it is
not only a control, it is a *status display*: which page am I looking at. The bar already
carries one status (`saved`, `offline`, `wiped 6`), so this is a second, and they are
different kinds of thing.

That may be the strongest argument for the second tier existing at all, or the strongest
argument that the selector belongs on tier 1 and something else moves down. That is the
call we want you to make.

---

## 6. #121 — Make the wipe feel like a release · still the important one

The nag → wipe loop *is* the product. Lines accumulate and nag by existing; the wipe is the
payoff. Today the payoff is a 420ms fade and a 160ms collapse. **It is correct, it is quiet,
and it does not feel like anything** — a judgment the repo cannot tell you, which is why it
is here.

This is the one moment the product is allowed to be expressive, and the only one that would
demo well. Options to try on a phone, not a single answer.

What must survive:

- **Two stages, in this order.** The lines go transparent *in place, holding their height*,
  and only then does one collapse close the gap. Both at once makes the page jump under the
  thumb that just tapped, and the release stops feeling like a release and starts feeling
  like a mis-tap. Tokens and reasoning are in `public/index.html`.
- It runs in **two surfaces** — a CodeMirror document, and a list of rows in Arrange. Both
  read the same tokens today, deliberately.

**On sound**, three constraints already settled so you can design inside them:

- **Web Audio synthesis, not an audio file.** Nothing to ship, nothing to add to the service
  worker's precache, tuned by editing numbers. We need a *direction* — character, length,
  pitch movement — not a `.wav`.
- 🔴 **The iOS silent switch mutes Web Audio.** Ringer off means no sound and there is no
  honest way around it. **The motion has to carry the moment alone**; sound is a bonus.
- One sound. The same restraint that gives the product one animation and one colour.

---

## 7. The screens behind the bar

Three surfaces that do not exist yet. Each has a shape in mind, described here as a
starting point rather than a specification — **all three are yours to disagree with.**

### History — 1.0's last open question (#91)

The record already exists and is complete: every save is logged and coalesced, and wiped
items are stored separately as "what actually got finished". There is no *screen*, and the
one-tap `bring back` after a wipe is currently the whole of the undo.

The shape in mind:

> **"Yesterday"**, or a date navigator. Enter a dialog, then play **forward and backward**
> through the days to see what changed. On any day, **select lines to restore** — a checkbox
> on the right — and a restore action **appends them to the current page** rather than
> overwriting it. Copying a selection out should work too.

🔴 Note the two properties that are not negotiable, and that shape already respects:
restoring **appends to the page as it is now** rather than writing an old body back — the
alternative loses whatever was typed since — and the record is read-only history rather
than a document you can edit.

Also worth noting: the bring-back offer expires at the device's next local midnight, so
`history` is what someone reaches for once regret arrives later than that. It is the
recovery path for exactly the case where the cheap one has lapsed.

### The document selector — 1.1 (#123)

A **handful** of pages. Not a file manager, and explicitly no search, no folders, no tags —
the number is small enough to see all of at once, and keeping it that way is the point.

The shape in mind:

> A **drop-up** from the bar, or an icon that shows the current document and opens the
> choice. At the end of the list, a **"manage documents"** entry opening a dialog for the
> rare operations — new, rename, delete, and possibly sort order and which one is the
> default.

Each page also has a **default template** — the text a new page starts from. A shopping list
starts from the standing items; a todo starts from its usual sections. The mechanism is
deliberately the cheapest possible one: *save the current page as this page's template*.
There is no template language and there will not be one.

🔴 **What "you land on the page" has to survive.** knag's premise is that you open it and
you are looking at your page — no navigation, no picking, no home screen. Every
multi-document product eventually becomes a file manager, and the thing that prevents it is
a decision made before the switcher is built. **Please say what that decision should be.**

### Profile and login — 1.2 (#122)

**Multi-tenant, and isolated.** Each person gets their own knag — their own page, their own
handful of documents. Nothing overlaps, nothing is shared, nobody sees anyone else's
anything. There is no collaboration, no attribution, no presence, and none of that is
coming.

That makes the UI genuinely small, and the read from the product side is that it is: a
**profile section in Settings**, and a **new login screen**.

🔴 **One thing to know before designing the login screen: the credential model is not
decided.** Today knag has a single shared passphrase, which by construction fails on the
first additional person. `docs/adr/ADR-001-passphrase-auth.md` records why it was chosen and
names this exact moment as its expiry. #122 is scoped as *a spike on the auth model, then a
decision* — the candidates are an identity provider, an email link, or something else, and
they produce visibly different login screens.

So: **design the surface, and say what it needs from the credential model** rather than
assuming one. If a particular shape of login is much better for this product, that is a
useful input to a decision that has not been made yet.

The existing login screen is worth looking at first — it is one field, deliberately, and it
is the only screen in the product that is not the page.

---

## 8. The positioning line, for the landing page

The owner's framing, verbatim, and it is sharper than anything currently written down:

> The approach here is a **behavior**. Not an app, not a task list, not a notepad.

`docs/philosophy.md` argues the same position at length — knag makes throwing things away
feel good; the nag is the tension, the wipe is the release, the record is what makes the
release free — and §2 of it places the product against Forster, Carroll, Lee and Burkeman,
refusing the mechanic of each.

**What is missing is the one line.** The landing-page brief already decides the hero *is*
the wipe — a real day's list, filled, wiped, a beat of empty slate, then one quiet amber
line. What it does not have is the sentence underneath.

If "a behavior, not an app" is the right line, say so and shape it. If it is the right idea
in the wrong words, that is exactly the work. And if it belongs in `philosophy.md` as well
as on the page, say that too.

---

## 9. The boundary

These are in `CLAUDE.md` and the ADRs, and each has a decision record behind it. Listed
here only so nothing is violated by accident:

amber is the **only** colour · two boards, no third · two faces with two jobs · **one**
animation, and the wipe is it · the display never diverges from the document's bytes
(ADR-004) · 16px is a hard floor on anything editable · everything is a token.

**If a proposal needs one of these to give, say so explicitly and say why.** That is a
conversation worth having and a bad one to have by accident — the failure mode is a bundle
that breaks one without noticing and has to be rejected after the work is done.

Out of scope entirely: search, tags, attachments, offline editing, rich formatting, day
boundaries, rollover, and anything that turns one page into a note system. `docs/spec.md`
§12 is the list and it is load-bearing.

---

## 10. What the repo will not tell you

- **The wipe does not feel like anything.** It is technically correct and emotionally flat.
- **The bar is loved for being thin**, and that same thinness is why Settings became a junk
  drawer. Both halves are true and the second one is what §4 is trying to fix.
- **The footer may now be too heavy** after §3a. It went up on a standard, not on taste, and
  nobody has looked at it as a composition.
- **Settings is a scroll on a phone** and nobody has decided what it should be instead.
- **Copying the page and wiping the page are too many taps away.** Not broken — just further
  than their frequency deserves.
- **"You land on the page"** is the premise most at risk from 1.1, and nothing yet protects
  it.

---

## 11. How to answer

Whatever form suits — tokens, a written direction, annotated layouts, motion curves, a
description of a sound, a sketch of the bar in both states. **Tokens are the cheapest thing
for us to apply**, since every colour and size already lives in two `:root` blocks and
nowhere else. Prose about *why* is the most valuable thing to keep.

**Say what you would build first.** Some of this is 1.0 and some is two releases out; if the
bar's second tier should ship before the wipe gets its motion, or the other way round, that
ordering is useful.

If the honest answer to any of it is "leave it alone", that is a real answer. Several of
these are refinements to things that already work.

**#90, the landing page**, is unchanged and still waiting on the decisions in its own brief
(`docs/design/landing-page-brief.md` §5). The one thing that moved: the hero is now
buildable, because the wipe animates in both surfaces as of today. Whatever §6 produces is
what the page gets to show.
