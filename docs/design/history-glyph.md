# The history glyph

One glyph, for the ledge item that opens the history pane (#91). The pane shipped in
1.2.0 with a bare word where its icon goes, because icons come from the design session
and are not invented here.

Bundle: **History glyph design**, 2026-08-22. Companion to
[history-response.md](history-response.md), which ruled on the pane itself.

## The mark

```html
<rect x="10" y="3.5" width="3.5" height="9" fill="currentColor" stroke="none"/>
<path d="M7.5 7.25v1.5"/>
<path d="M4.5 7.25v1.5"/>
```

The block cursor — the only shape the brand owns — set at the right of the box, with two
small marks receding left, the direction a wiped row leaves in. It reads as *things stood
here on earlier days and the record of them is still on the board.*

Three elements, no overlap. The block renders 9px tall at 18px; square caps carry each
1.5-unit tick to a 3px mark, so both read on either board. Everything centres on one
line, and the gaps tighten leftward — 4.25 units centre-to-centre, then 3.

🔴 **The two marks are the same size on purpose.** A taper would draw a bar chart, and a
chart implies there is something here to query — the one thing this pane must never
suggest, and the whole reason its rows are wipes rather than lines.

## Four things it is not, and why

Each is the obvious thing to reach for, and each is wrong for a different reason. If a
future bundle proposes one of these, this is the argument to answer.

| Not | Because |
|---|---|
| a clock or watch face | knag has no time features — no reminders, no due dates, no scheduling. A clock promises one. |
| a document, page, stack, or list of lines | Spec §12's Out list bars any UI implying a second document exists. The pane's argument with that constraint is that **rows are wipes, not lines**; a document glyph concedes it at the door. |
| a counterclockwise or undo arrow | `bring back` is a separate control one tap away and it *is* undo. This pane is for looking, days later. Two undo symbols side by side is worse than the word alone. |
| a bin or trash can | Nothing is deleted — that is the product's premise. And there is nothing in it to empty. |

## Why it does not collide

At 18px, against its three neighbours and the bar's ledge chevron, it is the only glyph
with a solid vertical block, the only one whose weight sits right of centre, and the only
one that leaves the left third of the box nearly empty. Copy fills the box with two large
outlined rects; arrange's verticals run full height and carry heads; settings is
horizontal. Nothing else in the set is a block-and-marks.
