# ADR-007: One editing surface, owned by CodeMirror

**Status:** Accepted
**Date:** 2026-08-18
**Amends:** [ADR-003](ADR-003-single-mode-editor.md) — its intent is upheld and its
mechanism is replaced
**Supersedes:** [ADR-006](ADR-006-cross-row-selection.md) decision 1
**Does not touch:** [ADR-004](ADR-004-display-matches-the-bytes.md), which is unchanged
and still decides every rendering question

## Context

ADR-003 set its own trigger for reopening, and named the thing that would fire it:

> **The row model meets something it cannot express.** Multi-row selection is the
> likeliest candidate — selecting across rows to delete a section is natural on paper and
> awkward here, and raw view is the current answer. If that answer starts being used
> daily rather than rarely, the row model is the wrong shape and this decision should be
> reopened **rather than patched**.

It fired. The report, from real use:

> the whole thing acted like a note pad everyone is used to... you type, edit, etc. like a
> normal text editor... But otherwise, a normal text editor — select, cut, paste

[#96](https://github.com/danjamk/knag/issues/96) was the patch: multi-select in Arrange.
It is genuinely useful and it is not the thing — different mode, coarser granularity, and
the ask was for the foundational surface.

### Why the row model cannot do it

Not a defect in a handler. A chain of individually correct decisions:

```
  Checkboxes must be real controls, tappable while typing
      ↓
  Each line needs its own DOM structure: a control plus its text
      ↓
  Text must be editable in place, with no tap-to-activate step (ADR-003)
      ↓
  Each line's text is therefore its own form control
      ↓
  A DOM selection cannot span two form controls — a platform rule
      ↓
  No selection can cross a line boundary
```

Sweep and drag-reorder push the same way: both are per-block operations, so both want
blocks to be addressable DOM units. **The three features that make knag good all want the
document decomposed; plain-text editing wants it contiguous.** Every product that solves
both — Bear, Obsidian, Notion, Slack's composer — resolves it the same way: one
contenteditable, an intercepted input layer, and a model that owns the truth.

### What was measured

ADR-006 spiked a raw `contenteditable` and found it corrupts on edit — one Backspace
across three rows produced stray spans, a span outside the model, and inlined font styles,
all of it rendering perfectly. Its conclusion stands and is not overturned here. What it
also said, in *Consequences*, is the door this walks through:

> So the open question is not "rewrite the editor". It is *"is it worth intercepting every
> `beforeinput` to get native selection?"* — a smaller and better-understood job.

The answer is that a maintained library already did it. `spike/110-codemirror` measured
CodeMirror 6 against the same instrument, on a real iPhone
([`docs/spikes/110-findings.md`](https://github.com/danjamk/knag/blob/spike/110-codemirror/docs/spikes/110-findings.md), which lives on that branch and not on `main`):

| | |
|---|---|
| Backspace across a 3-row selection | exactly source-minus-range, byte for byte |
| Dictation, autocorrect, undo | all worked — the three ADR-003 rejected this over |
| Composition adjacent to a checkbox widget | held |
| Rich-text paste | plain text only, no markup, no inline styles |
| Cross-row selection | native, with the iOS long-press handles |

## Decision

### 1. One editing surface, and CodeMirror owns it

The document is one CodeMirror 6 document. Checkboxes are widget decorations over the
bytes, atomic, toggling exactly the character between the brackets.

🔴 **ADR-003's intent is upheld, not reversed.** "One mode, typing is primary" was correct
and is confirmed by two years of use. What is replaced is its *mechanism* — one form
control per row — which was an implementation detail that became the product's ceiling.
A single surface serves that intent better than the row model did, because it removes the
last thing raw view was reached for.

### 2. `app.ts` does not learn CodeMirror

Everything is behind `EditorHandle`, which speaks only in document bytes. The row model
leaked into `app.ts` through `editorIn`, `focusRow`, `captureCaret` and four arrow-key
branches, and that leak is precisely why replacing it is a project rather than a change.
Not repeating it is the whole reason for the interface.

🔴 **Amended 2026-08-19 (#119): "only document bytes" is no longer strictly true, and the
exception is recorded rather than left to be discovered.** `animateWipe(lines, timings)`
is about presentation, not bytes.

The wipe is the only animation in the product, and it worked by finding `<li>` elements —
so it did not happen in this surface at all. Restoring it needs line decorations, which
means CodeMirror. The two ways to get there were a CodeMirror import in `app.ts` or one
presentational method on the handle, and **the second is the smaller leak**: the rule that
made the row model expensive to replace was CodeMirror knowledge spreading through
`app.ts`, not the handle having a method that is not a byte accessor.

What keeps it contained: it is one method, `app.ts` still owns the *timing* (read once
from the CSS tokens and passed in, so both surfaces run one sequence rather than two that
drift), and it decides nothing about what gets wiped. If a second presentational method is
ever wanted, that is the signal this boundary was drawn in the wrong place — reopen it
rather than adding a third.

### 3. Line endings live outside the editor

CodeMirror's document is LF-only. Pinning `EditorState.lineSeparator` makes a *pristine*
document round-trip and is **not** the fix: a lone `\r` becomes ordinary line content the
caret can sit past, so typing at what looks like the end of a CRLF line strands the
carriage return mid-line — renders perfectly, corrupts on save.

`client/src/eol.ts` splits the document into LF-only text plus the set of lines whose break
was CRLF, maps that set across every edit, and rejoins on the way out. Held to the bar
`blocks.test.ts` sets: round-trip over 2,000 **arbitrary binary** strings.

### 4. Arrange keeps its own rendering, and the two never coexist

The sort mode does not have to be traded away, and this is structural rather than lucky:
Arrange was already a separate mode with its own rendering. Each mode builds itself from
the document string and hands one back —

```
text --parse--> blocks --drag--> blocks --serialize--> text --> CodeMirror
```

— so per-row drag keeps working at whole-block granularity while the editor gets native
selection. Entering Arrange **destroys** the editor rather than hiding it. Two live
editing surfaces over one document is the failure this shape exists to avoid, and hidden
is not the same as not editing.

🔴 The check that matters is not that dragging works. It is that a trip through Arrange
**with no drag** returns the identical bytes. Two renderings quietly disagreeing about the
document is the failure worth fearing.

### 5. "No framework" gets a scoped carve-out

The stack rule is *prefer the boring tool*. Text editing on iOS Safari — composition,
selection, undo, mobile carets — is the one domain in this project where hand-rolling is
the *un*-boring choice, and "no framework" was adopted by a project that did not yet know
it was building an editor.

**The carve-out is the editing surface and nothing else.** The Worker, the store, the
shell, the parser and the sync layer stay framework-free.

### 6. `⌘A` selects the document

ADR-006 listed keeping the per-row meaning among its reasons to reject a single surface.
That was a *description of the row model*, not a decision — each row was its own field, so
`⌘A` could not have meant anything else. With one document, every editor a person has used
selects all of it.

### 7. It ships beside the row list, and that is temporary

Settings → View → **editor**, with **list** still there. Every defect this project has
shipped was found by a person on a phone rather than by the suite, so the replacement gets
used against the real page before the row list is deleted.

When the row list goes, so does the Settings control, and the product is back to one
editing surface with raw as the escape hatch.

## Consequences

**The bundle is the price, and it is large.** The client goes from **21.6 KB to ~107 KB
gzipped** — the largest dependency knag has taken by a wide margin.
[#110](https://github.com/danjamk/knag/issues/110) projected 74 KB by dropping
`standardKeymap` on the grounds that knag replaces it; that was wrong. knag replaces three
of its bindings and needs the rest for `Home`, `End`, `⌘A` and word-wise deletion. It is
service-worker cached, so the cost is per release rather than per load.

**A large amount of client code dies with the row list**, and none of it before then:
`client/src/caret.ts` entire — 205 lines of hidden-mirror caret geometry, visual-line
detection and pixel-column preservation — plus `neighbor()` and the four arrow-key
branches in `app.ts`. #84 and #88 were both bugs in that code. The net complexity delta is
much smaller than the bundle delta.

**The split policy is stated once.** `splitAt` is now an adapter over `splitLine`, which
both surfaces call. Two expressions of the same rules agree right up until someone fixes
one of them — the argument `blocks.ts` already settles for parsing.

**ADR-003 §6 was re-argued and settled on device, 2026-08-20 (#114).** The control test
this paragraph called for — typing `const` at the start of a prose line on a real iPhone —
was run, **and it was not capitalised**. By the criterion stated here, that put §6 undecided
rather than merely unproven.

Three measurements settled it, and the third is the one that mattered:

| | Result |
|---|---|
| `autocapitalize` in prose, after an explicit sentence boundary | did not fire |
| `autocorrect` in prose | fired, behaving as in any other app |
| **`autocorrect` on pasted text** | **did not fire — `teh` survived a paste intact** |

🔴 **§6's risk does not materialise, on two independent grounds.** §6 names the risk as
autocapitalize turning `const` into `Const` inside a fence, and #114 framed it as *knag
silently editing code the user pasted*. Autocapitalize is inert in this surface, so the
first cannot happen; paste is never autocorrected, so the second cannot either. What
remains is narrower than the ADR assumed: someone hand-typing code into a fence on a touch
keyboard.

**The per-line attributes stay, and stop claiming to be confirmed.** Whether iOS honours
`autocorrect="off"` on a `.cm-line` inside one contenteditable is **still unverified** — the
fence half of the autocorrect drill was not run, and there is no way to run it from a Mac.
They are kept because they are the spec-correct expression of the intent, they cost three
attributes on a decoration that already exists, and removing them would mean re-adding them
later with no new information. What changed is the comment in `editor.ts`, which claimed a
confirmation the evidence never supported.

Turning autocorrect **off everywhere** — the MVP position §6 called over-cautious — was
considered and rejected. It would cost working, expected behaviour in prose, which the
device test confirmed is good, to guard a residual risk nobody has demonstrated.

**Cross-row copy and Arrange's copy disagree.** A selection copy takes document text, so it
carries `- [ ] `; Arrange's per-row copy strips it. Both behaviours are pinned by tests so
the disagreement is visible. One of them has to change and this ADR does not decide which.

> 🔴 **Resolved 2026-08-20 (#115): neither changes.** "One of them has to change" was
> the wrong frame. They are different gestures — a whole-row **verb**, which copies what
> the row displays (spec §7), and a **selection**, which copies document text because that
> is what a selection is. Each is already right for its own gesture, and the two options
> that would unify them each pay something real: making the editor strip costs byte-truth
> and makes the clipboard stop matching the selection; making Arrange carry costs the
> thing the copy button is for.
>
> The question was never which is right in the abstract but whether a person would notice.
> Both paths were used against a real page and nobody did. Ruled now rather than left
> parked because it is a **single-document** question and #123 is next — once there are
> several pages, copy acquires a cross-page paste and this gets designed twice.

**Raw view's purpose evaporates.** Under one surface the editor *is* the bytes with
decorations over them. Keep it through the transition — it is exactly the escape hatch it
was designed to be — and remove it once the new surface has survived a month of real use.
Its absence is what would finally pay ADR-003 off.

**Indentation is now literal document text** rather than a CSS property derived from bytes
the field never showed. That is strictly *more* byte-true than the row model, not less.

## Alternatives considered

**Hand-build the intercepted input layer.** Map every `beforeinput` to a model operation,
build model-offset ↔ DOM-Range mapping in both directions, then pay for undo, composition
and paste. Priced at one to three weeks with an unbounded tail, gated on a probe of iOS
composition. Rejected once the library was measured: the tail *is* what the library sells.

**The roving editor.** Unfocused rows as plain non-editable elements — native selection
spans those freely — with exactly one live `<textarea>` at a time, copy reconstructed from
the block model. Raised in outside review, and genuinely the option ADR-006 never
measured. Rejected as the lead because it solves selection **only**: undo stays exactly as
broken as it is today, and its focus-swap cost on the iOS keyboard is unproven. It remains
the fallback if the surface fails on a platform question.

**ProseMirror or Lexical.** Both solve the right problems for a document shape knag does
not have: a schema'd rich-text tree, where knag's document is a string of lines.
CodeMirror's document model *is* knag's model, which is why `blocks.ts` stays the single
parser and decorations are computed from its output.

**Make raw view frictionless instead.** One gesture, non-sticky, auto-returning — hours
rather than weeks. Rejected on the owner's reasoning, which is the same as ADR-003's:
*"ADR-003 did not conclude that the toggle was clumsy — it concluded that a mode existing
at all was the defect."* Buying a cheaper version of the identified problem is a nicer
symptom, not a partial fix.

**Status quo.** Arrange multi-select as the answer, raw as the escape hatch. Rejected: the
friction is in the most-used interaction in the product.

## Revisit when

**A platform question the library cannot answer.** Composition next to a widget held on
one device on one iOS version. If it stops holding, the roving editor above is the
fallback and it gets the same instrument.

**The bundle stops being affordable.** 107 KB gzipped is a design input under spec §14.4,
not a fixed cost — if the free tier or a cold start on a phone starts to hurt, the first
move is dropping `standardKeymap` for a hand-written binding set, which is measured at
about 10 KB.

**The row list has not been deleted six months from now.** Keeping both surfaces was
justified as a transition. A transition that does not end is two things to maintain and a
mode question in Settings, which is what ADR-003 removed on evidence.

## References

The deliberation behind this decision is kept rather than summarised, because the
reasoning is why the decision is shaped the way it is:

- [reviews/state-of-play.md](../reviews/state-of-play.md) — the standalone brief written
  for outside review, including the causal chain arguing the row model could not do
  cross-row selection.
- [reviews/state-of-play-response.md](../reviews/state-of-play-response.md) — the review
  that came back. It named CodeMirror 6, set the probe's kill criteria, and identified
  the iOS autocorrect risk the brief had missed — still open as
  [#114](https://github.com/danjamk/knag/issues/114).
