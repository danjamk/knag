# ADR-004: The display never diverges from the bytes

**Status:** Accepted
**Date:** 2026-08-15
**Names the rule behind:** ADR-003 §4 (`- ` stays a literal dash), the brand
system's "section headers get no special styling", and spec §12's `rich
formatting` entry — each of which was decided separately and for the same reason

## Context

Principle 3 is stated in `CLAUDE.md` as a rule about round-tripping:

> **Nothing is normalized.** Bytes in, bytes out. Indentation, blank lines,
> trailing whitespace, CRLF, and `*` vs `-` markers all survive a round trip.

That has been enforced from day one by a property test over generated documents,
and it has held absolutely. But it is a rule about the **write** path, and it has
been quietly doing double duty as a rule about the **read** path — three separate
decisions have now been made by appeal to it:

1. **ADR-003 §4.** A single `- ` renders as a literal dash rather than a bullet.
   *"It would be the first place in knag where the display differs from the
   bytes."*
2. **The brand system, §10.** Section headers get no special styling. *"They are
   plain text lines and the bytes do not know they are headers. Resisting this
   is what keeps principle 3 intact."*
3. **Spec §12** lists `rich formatting` as out, with no reasoning attached.

Three instances, one rule, never written down. The prompt for writing it down now
is a feature request:

> we might add a bit more formatting at some point — simple. bold, underline,
> maybe indentation.

That is a reasonable thing to want, it will be wanted again, and it deserves a
better answer than "it's on the Out list."

## Decision

**What knag displays is what the file contains. The rendering of a line is a
function of its bytes and nothing else, and no styling implies structure the
bytes do not carry.**

This is principle 3's read-path counterpart, and it is a product decision rather
than an implementation constraint.

### What this permits, today, unchanged

**Indentation already works and always has.** It is bytes — leading whitespace on
a line survives the round trip, blocks carry it as `indent`, and a nested
checkbox is already a first-class thing that `clear-completed` handles at any
depth. Nothing needs building; the feature request is already satisfied.

**Checkbox rows are not an exception.** A checkbox row renders as a control plus
its text, which looks like a divergence and is not: the row is a *lossless
projection* of `- [ ] text`, every byte is recoverable from what is on screen,
and toggling it rewrites exactly the four characters between the brackets. The
test is not "does it look like the file" but "can the file be reconstructed from
what is displayed, byte for byte." Checkboxes pass. Rendered bold does not.

**Linkification passes the same test** for the same reason — the URL text is
still there, in full, and is still what gets saved.

**Fenced code blocks pass** — the fence markers stay visible in the row.

### What this forbids

Rendered bold, italic, underline, or strikethrough from markdown syntax. Styled
headings from `#`. Rendered bullets from `-` or `*`. Anything where the syntax
disappears and only its effect remains.

### If it is ever built, only one shape is acceptable

**Live preview with the syntax visible and editable on the focused row** — the
Obsidian and Bear approach, where `**bold**` renders bold everywhere except the
line the cursor is on, which shows the asterisks. Byte-truth survives because the
syntax is never hidden from the person editing it.

This is recorded so the option is not lost, not because it is planned. It is
substantially harder than it sounds: it needs per-row focus-dependent rendering,
and it collides with the auto-growing textarea model, since a textarea cannot
render styled ranges at all. It would mean `contenteditable` for unfocused rows —
which ADR-003 rejected for the whole document and would be reintroducing at
smaller scale.

> 🔴 **That cost argument expired with [ADR-007](ADR-007-one-editing-surface.md), and
> the decision above did not.** The editing surface is now one CodeMirror document, and
> focus-dependent rendering over ranges is exactly what its decorations do — the
> machinery this paragraph called prohibitive is already in the bundle.
>
> Nothing about that makes rendered markdown a better idea. **This ADR's reasons were
> never about cost.** They are the agent contract (an agent editing a line has to model
> the transform to predict the result), the parser staying small, and knag being a bad
> Bear on purpose. Read "it would be cheap now" as an argument and you have answered a
> question this document never asked.

## Consequences

**The feature request is answered, and mostly already delivered.** Indentation
works. Bold and underline do not, deliberately.

**The parser stays the size it is.** `blocks.ts` classifies four kinds and is
imported by both the Worker and the client. Every rendered construct added to it
is another thing the round-trip property has to hold across, and another thing
`clear-completed` has to reason about on the server.

**The agent contract stays simple.** An agent writing to the page writes plain
text and knows exactly what it will look like. The moment the display is a
transform of the bytes, an agent editing a line has to model the transform to
predict the result — and spec §10's whole-document write becomes meaningfully
more dangerous.

**This is what makes knag a bad Bear on purpose.** The product is not competing on
formatting and would lose if it tried. It competes on the page being plain text
that anything can read and write — which is the same property, stated as a
benefit instead of a limitation.

## Alternatives considered

**Add bold and italic as rendered markdown.** Rejected, per above.

**Add a formatting toolbar.** Rejected twice over: it needs a mode, which
ADR-003 removed on evidence and the brand system explicitly kills, and it implies
the document has structure it does not have.

**Say nothing and keep declining the request ad hoc.** Rejected. It has been
declined three times already on three different pages with three different
phrasings, and a rule nobody can find is a rule that erodes.

## Revisit when

**A formatting request survives the loop being good.** The honest read is that
asking for bold in a list app is often a symptom — the page is not doing its job
and formatting looks like the fix. If the nag → wipe loop is excellent and bold
is *still* wanted, that is real evidence rather than a proxy, and this decision
should be reopened via the live-preview shape above.

**Or the page stops being the interchange format.** This decision's cost is paid
in features and its return is that any tool, any agent, any `curl` sees the same
bytes. If knag ever grows an export or a second representation, the calculation
changes and this should be re-argued rather than inherited.
