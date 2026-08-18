# Spike 110 — CodeMirror 6 as knag's editing surface

**Branch:** `spike/110-codemirror` · **Date:** 2026-08-18 · **Status:** complete on desktop
WebKit, **iOS drills outstanding**

Ran against the three questions [ADR-006](../adr/ADR-006-cross-row-selection.md) and
[#110](https://github.com/danjamk/knag/issues/110) left open. Not a recommendation — the
finding, and what it costs.

## What was built

| | |
|---|---|
| `110-codemirror-probe.ts` | The probe. One CodeMirror 6 editor over a deliberately awkward document, with `- [ ] ` rendered as a real checkbox widget. |
| `110-codemirror-probe.html` | Standalone, everything inlined. **Open it on the phone — no server, no deploy.** |
| `110-headless.mjs` | Drives it in WebKit and grades 20 checks. `node docs/spikes/110-headless.mjs` |
| `cm-only.ts` | Imports exactly the CodeMirror surface a real integration needs, so the size number is honest. |
| `scripts/build-spike-110.sh` | Typecheck → bundle → measure → inline. |

The document under test carries every hazard knag's property test covers: a blank line, a
nested checkbox, a `*` marker that must never become `-`, a tab indent, trailing spaces, a
**CRLF line in an otherwise LF document**, a closed fence, an unclosed fence, and a final
newline.

🔴 **The instrument produced two false reds before it was right**, both because a drill
deleted or edited the very bytes the next check asserted were intact. ADR-006 recorded the
opposite failure — a check that agreed with an incomplete read and reported false green.
Both are the same defect: *a check that cannot distinguish the drill from the editor*.
Fixed by asserting `source minus the selected range` as an exact identity rather than
grading the hazard list during a destructive drill.

## Results — 18 of 20 in WebKit

### ✅ Cross-row selection, and everything that hangs off it

The whole reason for the exercise. One surface, so selection spans lines natively. But the
question ADR-006 actually left open was never selection — it was **whether an edit applied
across a selection corrupts the document.**

> One Backspace over a selection spanning three rows, in WebKit: the row holds two `.t`
> spans, a third span sits outside the model entirely, WebKit inlined computed font
> styles, and content from an indented line is now inside a checkbox row. **The editor
> renders all of it correctly.**
> — ADR-006, on the raw `contenteditable` spike

Same drill, CodeMirror: the result is **exactly `source.slice(0, from) + source.slice(to)`**
— byte-for-byte, no stray spans, no inlined styles, no markup. Undo restores the source
byte-exactly. Paste of `<b style="font-family: Comic Sans">` inserts the plain-text form
and nothing else.

That is the finding. **The failure that killed the previous approach does not occur here**,
because CodeMirror never lets the browser mutate the DOM — it owns the document and
re-renders, which is the same architecture `edit.ts` and `applyEdit` already use.

### ✅ Checkboxes as widgets, without the display diverging from the bytes

`- [ ] ` renders as a real `<input type="checkbox">` via a replace-decoration, with
`atomicRanges` so the caret cannot land inside the hidden marker. Toggling rewrites
**exactly one character** — verified by counting diffs — and `[X]` stays `[X]`.

This passes [ADR-004](../adr/ADR-004-display-matches-the-bytes.md)'s test on the same
grounds the current row model does: the file is reconstructable byte-for-byte from what is
on screen.

**It is also strictly more byte-true than today.** In the row model, `displayText()` hands
the editor only the text *after* the marker, so a nested checkbox's leading whitespace is
never in the field — indentation is a CSS property derived from bytes the editor does not
show. Here the indent stays literal document text and renders as itself.

### 🔴 CRLF: the real finding, and it is not what it first looks like

Two separate results, and the second one is the one that matters.

| | |
|---|---|
| Default configuration | **Fails.** CodeMirror splits on `\n`, `\r\n` and `\r` and rejoins with `\n`, silently dropping the carriage return. |
| `EditorState.lineSeparator.of("\n")` | **Round-trips a pristine document byte-exactly.** Looks like the fix. |

It is not the fix. With `\n` as the only separator, a `\r` becomes an **ordinary character
at the end of the line's content**, so the caret can be placed after it. Typing at what
looks like the end of that line gives:

```
CRLF line\rXYZ\n
```

The carriage return is now **mid-line**, and the document is malformed in a way nothing on
screen shows. That is the same species of defect as the `contenteditable` spike — renders
fine, corrupts on save — arrived at by a different route.

**It is not a blocker, and the fix already exists in the codebase.** `blocks.ts` strips the
trailing `\r` and carries it per-block as `eol`, reattaching it on serialize, precisely
because *"`.` does not match `\r` in JavaScript, so a raw CRLF line fails both grammars
outright"* (spec §14.2). The same wrapper applies: **hand CodeMirror LF-only text and
reattach line endings on the way out.** The editor never sees a `\r`.

What it costs is that CodeMirror's document is *not* knag's document — there is a
normalize/denormalize layer between them, and it has to be the only path. Cheap, but it
must be explicit, and the round-trip property test must run across it.

### 💰 Size — the largest single cost

```
                                       min      gzip
public/app.js (today)                62,601    21,581
CodeMirror only                     267,811    86,979
```

**+87 KB gzipped, roughly 5× the current client.** That is the number to argue about.

Context, not excuses: the client is service-worker cached, so it is a one-time cost per
release rather than per load; spec §14.4 makes the free tier a design input, and the last
time the bundle grew like this it was noted at 7% of a limit. But this is the largest
dependency the project would have taken by a wide margin, against a stated rule of *prefer
the boring tool*.

## What is still unanswered

🔴 **Everything about iOS.** The probe runs headless WebKit on a Mac, which is the same
engine and **not the same input stack**. Untested, and each one is on #110's list as a
reason this could still fail:

- typing with **autocorrect** on, and accepting a correction
- **dictation**
- an **IME** keyboard
- **touch selection** — long-press, drag handles, the magnifier
- **shake-to-undo** and the iOS undo affordances
- what the on-screen keyboard does to an editor that owns its own scroller

`docs/spikes/110-codemirror-probe.html` is standalone for exactly this. AirDrop it and run
the drills listed on the page; the verdict panel is live and sticky.

Also undecided, and a product question rather than a defect: **a cross-row copy carries the
`- [ ] ` prefixes**, because it copies document text. knag's per-row copy strips them. The
two would disagree, and one of them has to change.

## Where this leaves the decision

Against #110's phases, which were written for option C — hand-building the input layer:

- **P0 (probe whether iOS composition can be intercepted)** — largely dissolves. Composition
  handling is the library's problem, not ours. What replaces it is *verifying* it on a real
  iPhone, which is an afternoon of drills against a page that now exists rather than a day
  of building an instrument.
- **P1 (map every `beforeinput` to a model operation)** — gone.
- **P2 (model offset ↔ DOM Range mapping)** — gone. This was flagged as *"where every cursor
  bug will live."*
- **P4 (undo, composition, paste — the unbounded tail)** — gone. Demonstrated working.
- **What remains** is the CRLF wrapper, the checkbox and checked-line decorations (both
  built here), wiring sync and Arrange to the new surface, and the browser suite.

The unbounded tail was the whole risk in option C. It is what a library buys, and this is
what buying it looks like: **+87 KB gzipped and a normalization layer.**
