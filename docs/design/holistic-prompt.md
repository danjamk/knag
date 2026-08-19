# The prompt

Paste into the Claude Design session. It has the repo, so this points rather than explains;
`docs/design/holistic-brief.md` is the brief it refers to.

---

knag has moved on since you last shaped it, and I would rather you look at the whole thing
once than answer four questions separately.

Start with **`docs/design/holistic-brief.md`**. You have the repo, so it points at files
rather than restating them — §1 is a short reading list, and `public/index.html` holds the
entire interface with every token in two `:root` blocks.

The part I actually want your eye on is **§3: four design decisions made in the build
without you**, on one day, each individually defensible. That is how a system drifts. The
one that matters most is the footer — its touch target went from 28px to 44px on an
accessibility argument, and 44px is a floor rather than a design. I do not know whether
what came out the other side is right, and nobody has looked at that bar as a composition.

Then, in order:

**The wipe** (#121). This is the one moment the product is allowed to be expressive — a
list accumulates, nags by existing, and the wipe is the release. Right now it is a 420ms
fade and a 160ms collapse: correct, quiet, and it does not feel like anything. I want
options to try on a phone rather than one answer. Two constraints in §4 are unusual enough
to read before designing — the sound has to be synthesised rather than shipped as a file,
and the iOS silent switch will mute it entirely, so the motion has to carry the moment on
its own.

**Settings** (#132), now seven sections and one list of unknown length. §4 says which parts
are about to move, so it is not designed around furniture that is leaving.

**The whole-page wipe** (#120) — where it goes on the main screen, given the footer's
budget.

Two things about how this lands:

- **Tokens we can apply in an afternoon.** Every colour and size already lives in those two
  `:root` blocks and nowhere else, enforced by a test.
- **§5 is a boundary, not a starting position.** Amber is the only colour, two boards and
  no third, two faces with two jobs, one animation, and the display never diverges from the
  document's bytes. Each has an ADR behind it. If something you want to propose needs one
  of them to give, say so explicitly and say why — worth discussing, bad to do by accident.

Aim past what is in front of us. The next two releases add a handful of pages and then a
small multi-user pilot; a pass that anticipates a page switcher and some notion of identity
is worth much more than one that solves only today's four asks. `docs/roadmap.md` has the
shape.

If the honest answer to any of this is "leave it alone", that is a real answer.
