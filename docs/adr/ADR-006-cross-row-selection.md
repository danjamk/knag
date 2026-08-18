# ADR-006: Cross-row selection stays out of the editor

**Status:** Accepted
**Date:** 2026-08-18
**Relates to:** [ADR-003](ADR-003-single-mode-editor.md) §2 (one row per block, live
inputs), [ADR-004](ADR-004-display-matches-the-bytes.md) (the display never diverges
from the bytes)

## Context

Reported from real use: text cannot be selected the way text everywhere else can.
Dragging across several lines, or holding shift and pressing down, selects nothing past
the row it started in.

This is not a defect in a handler. **Every row is its own form control**, and a DOM
selection cannot span two of those — a platform rule, not a knag bug. It is the cost of
the row model ADR-003 chose, and it went unnoticed because nothing in the suite selects
across rows.

The cost is real. Selecting a paragraph to copy it, or removing four lines at once, is
something people do without thinking, and the only answer was Settings → Raw — a mode
switch nobody reaches for mid-gesture, six interactions round trip, and sticky once you
are in it.

The ask was explicit and worth quoting, because it is a product statement rather than a
bug report:

> the whole thing acted like a note pad everyone is used to... you type, edit, etc. like
> a normal text editor. it has a few render concepts... well basically only one...
> checkboxes. But otherwise, a normal text editor - select, cut, paste

## What was evaluated

Four options, of which the fourth was not in the original framing and turned out to be
the one worth testing.

1. **Leave it; Raw is the documented answer.** Zero risk. It is also what spec §8 already
   says — raw view exists "for sweeps, bulk paste, multi-row selection". The objection is
   the mode switch, and it is a fair one.
2. **Synthesise a selection over the textareas.** Track anchor and focus, paint an
   overlay, implement copy and delete against the block array. Rejected: iOS text
   selection is native and per-element, so this buys a **desktop-only** feature on a
   phone-first product, and making it work on touch means building selection handles,
   hit-testing and autoscroll by hand.
3. **One textarea, rows drawn on top.** Rejected: it costs the live checkbox inputs,
   grip-only drag reordering, per-row `readOnly` and the link affordance — and it makes
   `⌘A` select the whole document, contradicting the requirement that `⌘A` keep meaning
   "this row".
4. **One `contenteditable` container, rows as children.** A selection cannot cross two
   form controls, but it crosses ordinary elements freely. This gets native cross-row
   selection *including iOS long-press and drag handles*, with no synthetic overlay and
   no custom touch code. It is how Slack's composer and every ProseMirror-class editor
   work.

Option 4 is the shape of the thing the report asked for, so it was measured rather than
argued about.

## The spike, and what it found

`docs/spikes/89-row-model-probe.html`, on `spike/89-contenteditable`. A standalone page
holding a deliberately awkward document — blank line, leading indent, trailing spaces, a
`*` marker that must never become `-` — that reports live whether the DOM still holds one
row per line and whether the document rebuilt from the DOM still matches what is on
screen.

**Selection works.** Confirmed on desktop and on iPhone: it spans rows, with the right
line breaks.

**Letting the browser apply an edit destroys the document.** One Backspace over a
selection spanning three rows, in WebKit:

```html
<div class="row" data-kind="check" data-prefix="- [ ] ">
  <span class="pre" contenteditable="false">…</span>
  <span class="t">m</span>
  <span class="t" style="font-family: …; font-size: …">ndented note</span>
  <span           style="font-family: …; font-size: …">* star bullet</span>
</div>
```

Four failures from one keystroke:

- the row holds **two** `.t` spans
- a third span sits **outside the model entirely**
- WebKit **inlined computed font styles**, which is formatting this document has no way
  to represent
- content from an indented line and a `*` bullet is now inside a **checkbox** row, so it
  would save carrying a `- [ ] ` prefix it never had

🔴 **The editor renders all of it correctly.** Nothing looks wrong until the save drops
the text the model cannot see — the worst failure mode available to a store holding the
only copy of the document, and exactly what principle 3 and ADR-004 exist to prevent.

The first version of the probe reported this as clean, twice: `reconstruct()` read only
the first `.t` in a row, and the round-trip check agreed with it because both sides lost
the same text. **A self-consistent check over an incomplete read is not a check** — worth
recording, because it nearly turned a finding into a false green.

## Decision

### 1. Cross-row selection stays out of the editor

The row model keeps one form control per row. `←` `→` `↑` `↓` cross row boundaries
(#84, #88); a *selection* does not.

### 2. Raw view remains the honest fallback, and its trigger is unchanged

Spec §8 already assigns multi-row selection to raw view, and ADR-003's revisit trigger
stands: **if raw view starts being used daily rather than rarely, the row model is the
wrong shape.** That is the measurement that reopens this, not a feature count.

### 3. The need is met in Arrange instead

Arrange is already where line-level operations live — drag, copy, delete. Selecting
several rows there and copying or deleting them together delivers what the report
reached for, at whole-row granularity, on both touch and desktop, without touching the
editing model at all. That is [#96](https://github.com/danjamk/knag/issues/96).

It does not deliver partial-line selection across rows. That is the deliberate gap.

## Consequences

**`contenteditable` is not ruled out forever, and this ADR should not be read as ruling
it out.** What the spike establishes is narrower: *the browser cannot be allowed to apply
the edits.* ProseMirror, Slate and Lexical all intercept `beforeinput` and mutate their
own model rather than letting the DOM be edited. knag is closer to that than it looks —
`edit.ts` is already pure and model-based, `app.ts` already intercepts Enter, Backspace
and all four arrows, and `applyEdit` already re-renders the whole document from `body`.
The DOM is **already** a projection.

So the open question is not "rewrite the editor". It is *"is it worth intercepting every
`beforeinput` to get native selection?"* — a smaller and better-understood job than the
one this ADR declined. Revisit it if §2's trigger fires, or if partial-line selection
turns out to be what people actually wanted.

**A spike that only proves the easy half proves nothing.** Selection working was visible
in five seconds and was never the risk. The instrument had to be built to fail — starting
at "not exercised", sticky once red, and checking that the rebuild accounts for every
character on screen — before it could say anything. Keep that shape for the next one.

## Alternatives considered

Covered above. The one worth restating: **"leave it and document Raw" was the standing
decision, not a new option.** Spec §8 already said so. This ADR does not overturn it — it
adds a better answer beside it and records why the more ambitious one was declined.
