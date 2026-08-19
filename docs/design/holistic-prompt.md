# The prompt

Paste into the Claude Design session. It has the repo, so this points rather than explains;
`docs/design/holistic-brief.md` is the brief it refers to.

---

knag has moved on since you last shaped it, and I want one view of the whole product rather
than four answers to four issues. The brief is **`docs/design/holistic-brief.md`** — you
have the repo, so §1 is a reading list rather than a restatement, and `public/index.html`
holds the entire interface with every token in two `:root` blocks.

**Start with §4.** There is a new organizing idea in there that came from using the thing
rather than from design, and I think it may be the most important thing in the brief.

The bar at the bottom is loved for being thin — and that same thinness is exactly why the
Settings sheet has become a junk drawer, with operations that are not rare sitting three
taps and a scroll away. The idea is a control that **expands the bar to a second tier on
demand**, pinnable, holding things that deserve to be reachable but not permanent. Two tiers
of reachability, and Settings goes back to being preferences rather than operations.

If that is right, it resolves two open issues on its own — where the whole-page wipe belongs
(#120) and what shape Settings should be (#132). **If it is wrong, I would rather hear that
now.** §4 states the tension I cannot see past: the bar's whole rationale is that it is thin
because it sits above the keyboard on a phone, and a pinned second tier eats vertical space
in exactly that situation.

§5 is the full inventory of what has to fit, frequency-ordered, including the things that do
not exist yet. The one I would draw your eye to: **once there is more than one document, the
document selector is plausibly the most-used control after the wipe** — and it is not only a
control, it is a status display. That may argue for the second tier or against it.

Then, in order:

**§3 — four decisions made in the build without you**, on one day, each individually
defensible. That is how a system drifts. The footer's touch target went from 28px to 44px on
an accessibility argument, and 44px is a floor rather than a design; nobody has looked at
that bar as a composition. Please do not be polite about any of it.

**§6 — the wipe.** The one moment the product is allowed to be expressive. Right now it is a
420ms fade and a 160ms collapse: correct, quiet, and it does not feel like anything. Options
to try on a phone rather than one answer. Two sound constraints are unusual enough to read
before designing — it has to be synthesised rather than shipped as a file, and the iOS
silent switch mutes it entirely, so the motion carries the moment alone.

**§7 — the three screens that do not exist yet**: history, the document selector, and the
multi-tenant login and profile. Each has a shape described as a starting point, and all
three are yours to disagree with. One flag: the credential model for multi-user is **not
decided**, so design the login surface and tell me what it needs rather than assuming.

**§8 — the positioning line.** My framing is "the approach here is a behavior — not an app,
not a task list, not a notepad." If that is the right line, shape it. If it is the right idea
in the wrong words, that is the work.

Four things about how this lands:

- 🔴 **Mobile-first throughout**, not responsive-down-from-desktop. A phone, keyboard up, a
  thumb reaching from the bottom edge. Everything else is the accommodation.
- **Tokens we can apply in an afternoon** — every colour and size already lives in those two
  `:root` blocks and nowhere else, enforced by a test.
- **§9 is a boundary, not a starting position.** Amber is the only colour, two boards and no
  third, two faces with two jobs, one animation, and the display never diverges from the
  document's bytes. Each has an ADR behind it. If a proposal needs one to give, say so
  explicitly and say why — worth discussing, bad to do by accident.
- **Say what you would build first.** Some of this is 1.0 and some is two releases out.

`docs/roadmap.md` has the release shape: 1.0 is one page finished, 1.1 is a handful of pages,
1.2 is multi-tenant. Aim past what is in front of us — the surfaces you shape now are the
ones those land in.

If the honest answer to any of it is "leave it alone", that is a real answer.
