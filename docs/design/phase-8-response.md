# Phase 8 — the four rulings

**Status:** Accepted
**Received:** 2026-08-25
**Answers:** [phase-8-brief.md](phase-8-brief.md) and [phase-8-prompt.md](phase-8-prompt.md), sent the same day
**Amends:** [holistic-response.md](holistic-response.md) §4, §7 and §7e — each amendment is dated in place

The session returned a rulings document and one artwork set. As with every response,
the document itself is not committed — it is a snapshot with its own runtime — and
everything in it that decides something is written here. The artwork is committed:
`public/icons/*-dev*`, eight files, named to sit beside the prod set.

Two of the four proposals were changed. §2 keeps the 11px label and moves the glyph
further than proposed, because the constraint on the ledge is width and the brief
measured height. §5 takes the grip. §3 and §4 land close to where the brief pointed.

---

## §2 · #197 · two numbers

**The label holds at 11px. The glyph goes to 24.**

| | shipped | proposed | ruled |
|---|---|---|---|
| ledge label | `--size-micro` 11px | 13px | **11px, unchanged** |
| ledge glyph | 18px | 20px | **24px** |

56px holds 13px labels vertically, and that was never the question. A ledge item is
`flex: 1 1 auto` with a 44px floor, and four 13px mono labels beside `wipe page` overrun
a 390px phone by 3px and a 375px one by 18. The overlap #192 just fixed comes back — the
dead margin is gone, but the room it freed is roughly the room 13px consumes.

```
390 − 20 padding − 24 gaps − 17 hairline − 111 wipe page = 218 for four items

at 11px  44 · 48 · 54 · 48 = 194   24 spare
at 13px  44 · 56 · 65 · 56 = 221   3 over at 390, 18 over at 375
```

So the loudness comes out of the axis that is free. 18 → 24 is a third larger and it
is the part of the item you aim at; the label goes on doing the job §4 gave it —
disambiguating a glyph rather than being read across a room. Nothing binds to the
reading preference, so **§3b is not amended** and the ledge does not become an
exception to it.

24 + 3 + 11 = 38 inside a 48px item inside the 56px ledge, so no height token moves
and the stroke stays at 1.5 on the 16-unit viewBox. **If it still reads small after a
week, the next move is the free axis again** — `--ledge-height` 56 → 64 with the glyph
at 26 — not the label.

**Applied as:** `--ledge-glyph: 24px`, on `.ledge-item svg` and nothing else.

---

## §3 · #196 · a dev mark

**The same block, unfilled.**

Dev is the cursor before it has anything to say. Filled against unfilled is the fastest
binary there is at 16px — it is the checkbox the product already ships — and it adds no
shape, no second colour and no letter. Nothing in the mark moves: the outer bounds of
the block are prod's exact rect, the amber is the same amber, and the difference is that
the middle is board.

| | geometry on 512 |
|---|---|
| icon | prod block `176 123 160 266`, stroke inward 48 |
| maskable | `185 143 142 226`, stroke 44 — inside the middle 80% |
| favicon | stroke 64 — an optical bump so the ring survives 16px |
| colour | `#FFB000` on `#11150F`, both boards, as prod |

One deviation from a single geometry, and it is the same concession the maskable
already makes: the favicon carries a thicker ring, because a 9.4% stroke rasterises to
1.5px at 16px and the ring is the whole signal.

Files, in `public/icons/`:

- `knag-icon-dev.svg` · `knag-icon-dev-192.png` · `knag-icon-dev-512.png`
- `knag-icon-dev-maskable.svg` · `knag-icon-dev-512-maskable.png`
- `favicon-dev.svg` · `favicon-dev-32.png` · `favicon-dev-16.png`

The env badge in the bar stays as it is. It says which environment you are in once you
are looking at the page; the tile says it before you tap.

**Applied as:** `devManifest` swaps the icon array off prod; the client swaps the four
icon link tags off prod (`wearDevMark`); `sw.js` precaches both sets. A test reads all
three against the files on disk.

---

## §4 · #190 · the operator's instructions

**A second destination in `you`, and §7e loses a sentence.**

Shape 1, the `agent` row. Not manage-pages: these instructions are account-wide, and a
global setting reached through a pane about pages reads as per-page — which is the one
thing it must not say, since the agent will act on it across all nine. #194 drew the
`this device` boundary for exactly this arrival, and the far side of it is where a
server-held setting belongs.

What §7e loses is the clause, not the rule. "The only chevron" was a way of saying a
chevron means a destination and destinations are rare; two of them, both in `you`, both
list-shaped or text-shaped, keeps that true. The sheet still does not scroll, every
choice is still flat, and the row still shows a current value — `set` or `not set`,
which is as much of 4000 characters as a row can honestly hold.

```
you
  this device      log out
  agent            set          ›
  devices          3            ›
```

| | |
|---|---|
| row | `agent prompt` · value `set` / `not set` · chevron — the ruling said `agent`; renamed by the operator after a day on the phone, 2026-08-25 (1.5.2) |
| pane head | `agent prompt` |
| status | `saving` / `saved` / `not saved` — the bar's words, no button |
| refusal | `too long · 4000` |
| note | *Every agent conversation on this account starts with this, under the heading **The operator adds:** — page purposes, house style, standing rules. 4000 characters.* |

Three decisions inside the pane. **The textarea is the first thing under the head**, so
the keyboard never covers it; it **saves on blur and on back, with no save button**,
because the product has one save model and a button here would invent a second. It is
**set in the body face at 16px, not mono** — a person wrote it, and the two-voice rule
puts the machine's voice only on the status line and the heading it quotes. And there
is **no counter until 3600**, where it turns amber and counts down; a character count on
an empty field is the app asking to be filled.

---

## §5 · #195 · the drag affordance

**The grip, and it is Arrange's glyph.**

Long-press dies on the text field: a long press inside an input is the platform's
selection gesture, and taking it means fighting iOS for it. Up and down controls cost
two 44px targets on every row, which on a 390px phone leaves the name about 110px of
the 390 — the control that reorders nine pages would be twice the size of the control
that names them.

A grip is the one affordance that does not compete for the touch it needs, because it
is a separate 36px target with a handle SortableJS already binds this way in Arrange.
Same glyph, `⠿` at `--target-arrange`, dim at rest and `--ink` while dragging: it is
the same verb on a different list, and a second glyph would imply a second kind of
reordering. §7 said manage-pages borrows Arrange's grammar wholesale, and this is the
last piece of it.

```
⠿  today      template  delete
⠿  work       template  delete
⠿  reading    template  delete
```

The grip takes 40px of the row including its gap, and the name field absorbs it. If
the row proves too tight in use, the control to reconsider is `template` — a
word-labelled button for the rarest verb on the row — not the grip and not the name. No
new motion: the drag is SortableJS moving the row under the finger, and the wipe is
still the only animation. The order commits on drop through the existing route, and a
refusal goes to `data-manage-error`, which is already the pane's voice.

---

## Amendments written into holistic-response.md

| Where | What | Date |
|---|---|---|
| §4 | ledge glyph 18 → 24, label unchanged at 11 | 2026-08-25 · #197 |
| §3b | unchanged — nothing on the ledge follows the reading preference | — |
| §7e | "the only chevron" → a chevron is a destination, and there are two | 2026-08-25 · #190 |
| §7 | manage-pages takes Arrange's grip at `--target-arrange` | 2026-08-25 · #195 |
