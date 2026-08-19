# ADR-003: One editing mode, not two

**Status:** Accepted — **mechanism amended by [ADR-007](ADR-007-one-editing-surface.md)**
**Date:** 2026-08-15
**Supersedes:** spec §7 "Why single-line inputs", and the peer relationship
between list and raw view in §8

> 🔴 **Read this with [ADR-007](ADR-007-one-editing-surface.md).** Everything below about
> *intent* stands and is confirmed by use: one mode, typing is primary, the editor is
> where you land. What no longer holds is the **mechanism** — decision 1's "every block is
> a row holding a live input". A DOM selection cannot span two form controls, so one input
> per row is what made selecting across lines impossible, and the *Revisit when* at the
> bottom of this document named that exact outcome and has now fired. Decision 6
> (autocorrect per row kind) survives only provisionally; ADR-007 says how.

## Context

The MVP shipped two co-equal views with a toggle between them:

- **List view** — blocks as rows, tap a row's text to open a single-line input,
  commit on Enter or blur.
- **Raw view** — the whole document in one `<textarea>`.

That split was a deliberate hedge. Spec §7 said so plainly:

> A general multi-line row editor means handling backspace-merges-previous-row,
> arrow-up-at-boundary, cross-row selection, and paste-splitting. That is a day
> of fiddly work and the source of every cursor bug.

Raw view was what made ducking that acceptable: anything the list could not
express, the textarea could.

**Used for real, the hedge costs more than the work it avoided.** The report, after
the UI was complete:

> my first big issue is raw vs. list. I really think we need something that is
> seamless and easy. one mode primarily. I am thinking that we have the core mode
> as typing. i want to be in checkbox mode all the time, but still being able to
> edit.

The failure is not that either view is bad. It is that **the product is a legal
pad**, and a legal pad does not have modes. Deciding which view you are in is a
decision the paper never asked for, and it is asked every single time knag is
opened.

## Decision

### 1. One editing surface. Typing is the primary interaction.

Every block is a row, and every text and checkbox row holds a **live input** —
always editable, no tap-to-activate step. Checkboxes stay visible and tappable
while typing, which is the "checkbox mode all the time" the report asks for.

Row boundaries behave like line boundaries:

| Key | Behavior |
|---|---|
| `Enter` at end of row | new empty row below, focused |
| `Enter` mid-row | split the block in two |
| `Backspace` at position 0 | merge into the previous row, caret at the join |
| `↑` / `↓` at the boundary | move focus between rows |

This is exactly the work §7 declined to do. It is accepted now because the
alternative — a mode toggle — has been measured against real use and lost.

### 2. Fenced blocks become an inline `<textarea>`

A fence is one block and inherently multi-line, so it gets an element that is
natively multi-line. This is what removes the last thing raw view was *required*
for, and it costs almost nothing: a textarea holding one block's `raw`.

### 3. Raw view is demoted to an escape hatch, not deleted

It stays reachable for a bulk paste or a sweep, and it stays the answer for
anything the row model cannot express. What changes is that it is no longer a
peer you choose between — the editor is where you land, always.

Deleting it outright was considered and rejected: it is already built, already
tested, and it is the honest fallback the day the row model meets something
awkward.

### 4. `--` is the checkbox shorthand, converting on space

Typing `--` then a space rewrites the line prefix to `- [ ] `. `Backspace`
immediately afterwards reverts it, which is the standard autoformat contract and
the reason on-space is safe rather than merely fast.

**A single `- ` stays a literal dash.** Rendering it as a bullet was considered
and rejected: it would be the first place in knag where the display differs from
the bytes, and principle 3 has held absolutely so far. The gain is cosmetic; the
precedent is not.

### 5. Reorder moves behind an explicit mode, and gains delete

The always-visible grip from #13 conflicts with live inputs — a drag handle
competing for the same touch as a text field is worse when the field is always
live. A **reorder button** swaps rows into a drag mode: inputs go read-only,
grips get large, and each row also gets a **delete** control on the right.

Delete belongs there rather than in the editor, because with live inputs
`Backspace` already handles *joining* lines while nothing offers a clean gesture
for removing a whole fence or a blank.

**Delete does not confirm.** The revision log is the undo, which is what it was
built for — principle 4, deletion is not loss.

### 6. Spellcheck and autocorrect are enabled, per row kind

The MVP set `spellcheck`, `autocorrect` and `autocapitalize` to **off**
everywhere, for byte preservation. That was over-cautious.

**Autocorrect is the user typing, mediated by their keyboard. It is not knag
rewriting bytes.** Principle 3 forbids *knag* normalizing the document; it does
not forbid the OS keyboard from doing what the user expects it to do.

The genuine risk was always narrower: autocapitalize turning `const` into `Const`
inside a code fence, or "fixing" a deliberate lowercase.

**This decision is only available because of decision 1.** With one textarea
holding the whole document there is no way to distinguish prose from a code
fence, so the only safe setting was off everywhere. With one element per block,
it is on for text and checkbox rows and off inside fences. The redesign is what
makes this possible rather than a risk it introduces.

## Consequences

**This is the highest-risk UI work in the project**, and none of it is covered by
the test suite. Focus management, caret position, and the iOS keyboard are where
it goes wrong, and no unit test in this repo runs a browser. Expect the two-device
and on-device checks to matter more here than anywhere else so far.

**The foundation holds.** Rows already map 1:1 to blocks (#9), edits already go
through `setText` (#10), and reorder already operates on the block array (#13).
Split and merge are block-array operations of the same shape as `move`. The
round-trip property in `blocks.test.ts` keeps covering all of it, which is the
payoff for having built the parser first.

**#11's always-visible grip becomes wrong** and is removed. That is a deletion,
not a rewrite — the row layout it established (fixed-width controls, flexing text)
is unchanged.

**Truncation is unresolved and gets decided by use.** Rows currently truncate
with an ellipsis rather than wrapping (spec §7). With a live input in every row
that question changes shape, and it is deliberately left open here rather than
guessed at twice.

## Alternatives considered

**`contenteditable` over the whole document, with live rendering.** The Bear /
Obsidian approach. Rejected: it makes undo, IME, and paste the project's problem
in every browser, and iOS Safari is the one target that must not be the one that
breaks. The row model keeps the browser's own text editing intact inside each row.

**Keep both views and improve the toggle.** Rejected. The complaint is not that
the toggle is awkward, it is that a mode exists at all.

**Delete raw view entirely.** Rejected, per decision 3.

## Revisit when

**The row model meets something it cannot express.** Multi-row selection is the
likeliest candidate — selecting across rows to delete a section is natural on
paper and awkward here, and raw view is the current answer. If that answer starts
being used daily rather than rarely, the row model is the wrong shape and this
decision should be reopened rather than patched.
