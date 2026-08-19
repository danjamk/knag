# knag — a holistic design pass

**For the Claude Design session. Written 2026-08-19.**

You shipped knag's identity — the two boards, the two faces, the amber, the mark — and you
hold the design system. **You also have the repo**, so this brief does not restate what is
in it. Copying the palette in here would only give it something to go stale against, and
today has been a long lesson in exactly that.

What this is instead: a reading list, an account of what has been decided **without you**,
and the four things we want your eye on.

## What we want back

**One holistic take, not four bundles.** The asks in §4 are each individually small and
each individually a chance to make the product slightly less coherent. A pass that looks at
the whole surface as it is *now*, says what has drifted, and gives a direction to build the
next phase against is worth more than four correct answers.

Most useful, in order:

1. **A verdict on §3** — the decisions taken in the build without you. "That was right",
   "change it", and "that is a symptom of something bigger" are all useful. Please do not
   be polite about it.
2. **Motion and sound for the wipe** (#121) — the one place the product is allowed to be
   expressive.
3. **A shape for Settings** (#132), now seven sections and one variable-length list.
4. **Where the whole-page wipe goes** on the main screen (#120).

Anything you think we are getting wrong that is *not* on this list is more valuable than
anything that is.

---

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

## 4. The four asks

### #121 — Make the wipe feel like a release · the important one

The nag → wipe loop *is* the product. Lines accumulate and nag by existing; the wipe is the
payoff. Today the payoff is a 420ms fade and a 160ms collapse. **It is correct, it is
quiet, and it does not feel like anything** — which is a judgment the repo cannot tell you,
so it is here.

This is the one moment the product is allowed to be expressive, and the only one that would
demo well. Options to try on a phone, not a single answer.

What must survive:

- **Two stages, in this order.** The lines go transparent *in place, holding their height*,
  and only then does one collapse close the gap. Both at once makes the page jump under the
  thumb that just tapped, and the release stops feeling like a release and starts feeling
  like a mis-tap. The tokens and the reasoning are in `public/index.html`.
- It runs in **two surfaces** — a CodeMirror document, and a list of rows in Arrange. Both
  read the same tokens today, deliberately.

**On sound**, three constraints already settled so you can design inside them rather than
around them:

- **Web Audio synthesis, not an audio file.** Nothing to ship, nothing to add to the
  service worker's precache, and it is tuned by editing numbers. What we need is a
  *direction* — character, length, pitch movement — not a `.wav`.
- 🔴 **The iOS silent switch mutes Web Audio.** Ringer off means no sound and there is no
  honest way around it. **The motion has to carry the moment alone**; sound is a bonus on
  top of something that already works.
- One sound. The same restraint that gives the product one animation and one colour.

### #120 — The whole-page wipe, onto the main screen

It is in Settings today, deliberately: wiping completed is every morning, wiping the page
is when a project ends, and the one place you must not hide a destructive branch is inside
the control people tap without looking. The ask is to bring it out anyway, behind a
confirmation that is a real stop rather than the current confirm-by-repetition.

**Where it goes is the question.** The footer's budget is what sits permanently above the
keyboard on a phone, and it now holds four controls at the larger size.

### #132 — A shape for Settings

Seven sections, one of them a variable-length list. Board and View are display preferences,
Devices is security, Build is diagnostics — three kinds of thing in one flat list. Three
sections carry explanatory paragraphs, which is either the right amount of teaching or a
sign the controls do not explain themselves.

🔴 **Note what is about to move**, so this is not designed around furniture that is
leaving: View loses `list` and probably disappears; Page loses the whole-page wipe to #120;
1.1 adds page switching, which is navigation rather than a setting.

### #90 — The landing page

`docs/design/landing-page-brief.md` still stands and its §5 lists what it waits on. The one
thing that changed: **the hero is now buildable** — the wipe animates in both surfaces as
of today, so whatever #121 produces is what the landing page gets to show.

---

## 5. The boundary

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

## 6. What the repo will not tell you

- **The wipe does not feel like anything.** It is technically correct and emotionally flat.
- **The footer may now be too heavy.** See §3a. It went up on a standard, not on taste, and
  nobody has looked at it as a composition.
- **Settings is a scroll on a phone** and nobody has decided what it should be instead.
- **Nothing has been designed for 1.1 or 1.2.** Pages will need a switcher; multi-user will
  need some notion of who you are. Both land in surfaces you are about to shape, so a pass
  that anticipates them is worth much more than one that solves only today's four asks.

## 7. How to answer

Whatever form suits — tokens, a written direction, annotated layouts, motion curves, a
description of a sound. **Tokens are the cheapest thing for us to apply**, since every
colour and size already lives in two `:root` blocks and nowhere else. Prose about *why* is
the most valuable thing to keep.

If the honest answer to any of it is "leave it alone", that is a real answer. Three of the
four asks are refinements to things that already work.
