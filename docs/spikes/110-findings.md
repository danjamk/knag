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
| `110-codemirror-probe.html` | Standalone, everything inlined. Open in a **browser** — see the delivery note below. |
| `scripts/serve-spike.sh` | Serves it over the LAN so the phone can reach it. **This, not AirDrop.** |
| `110-headless.mjs` | Drives it in WebKit and grades 20 checks. `node docs/spikes/110-headless.mjs` |
| `cm-only.ts` | Imports exactly the CodeMirror surface a real integration needs, so the size number is honest. |
| `scripts/build-spike-110.sh` | Typecheck → bundle → measure → inline. |

The document under test carries every hazard knag's property test covers: a blank line, a
nested checkbox, a `*` marker that must never become `-`, a tab indent, trailing spaces, a
**CRLF line in an otherwise LF document**, a closed fence, an unclosed fence, and a final
newline.

🔴 **The instrument produced false reds three times before it was right**, twice in the
headless harness and once on the page itself — where following the drills as written
("delete four lines") turned the integrity checks red for doing exactly what was asked.
ADR-006 recorded the opposite failure: a check that agreed with an incomplete read and
reported false green. Both are the same defect — *a check that cannot distinguish the
drill from the editor* — and a red that means nothing is how a real one gets ignored.

The fix is a third state. Every check now carries an **anchor** identifying its line,
separate from the **test** asserting its bytes:

| | |
|---|---|
| anchor present, test passes | ✅ green — bytes intact |
| anchor present, test fails | 🔴 **red** — the line is still here and was rewritten |
| anchor absent | ⚪ grey — you deleted it; not a defect |

Only red is sticky. There is also a **reset** control, because one destructive drill
otherwise poisons the panel for every drill after it and the only recovery was a reload,
which threw away the capability results just earned.

## 🔴 Autocorrect is off by default, and that is a real finding

The first phone run reported nothing about autocorrect, and it was not a testing mistake:
**CodeMirror sets `spellcheck="false"` on its content by default**, so autocorrect never
fired. The drill aimed at the single largest risk in #110 was silently testing an editor
with the feature disabled — the exact shape of failure ADR-006 warned about, one layer up.

Fixed with `EditorView.contentAttributes`, which now matches what
[ADR-003](../adr/ADR-003-single-mode-editor.md) §6 specifies for the product:
`autocorrect="on"`, `autocapitalize="sentences"`, `spellcheck="true"`.

**But §6's other half does not survive the change of mechanism, and this is the finding
that matters.** ADR-003 turns autocorrect *on* for prose and *off* inside fences, and says
plainly why that is possible:

> **This decision is only available because of decision 1.** With one textarea holding the
> whole document there is no way to distinguish prose from a code fence, so the only safe
> setting was off everywhere. With one element per block, it is on for text and checkbox
> rows and off inside fences.

One editing surface has **one** contenteditable, so the document-level attribute cannot
vary by line. The only route left is a per-line attribute on a child element, which the
probe now sets on every fence line — and **whether iOS honours a nested `autocorrect="off"`
is unknown and untestable from a Mac.**

So the risk ADR-003 §6 named is live again in its original form: autocapitalize turning
`const` into `Const` inside a code fence. If the phone does that, §6 has to be re-decided
rather than inherited — most likely as "off everywhere," which is where the MVP started.

## Delivery: AirDrop does not work

The probe reached the phone and rendered its static markup with **no script running at
all** — empty editor, empty panels. It lands in the Files app, which previews HTML rather
than executing it, and an ES module will not run from a `file://` origin regardless.

Two changes: the bundle is now an **IIFE rather than ESM**, and the page carries a visible
*"the script did not run"* placeholder that the script removes on boot. A probe that cannot
tell you it is dead is worse than no probe — the blank version looked like a CSS bug.

**Use `bash scripts/serve-spike.sh`** and open the printed URL in Safari on the phone.

## First real iPhone run — 2026-08-18

**The three things ADR-003 rejected this path over all worked.**

| Drill | Result |
|---|---|
| **Dictation** | ✅ worked — this was flagged 🔴 as the likeliest killer |
| **Autocorrect** | ✅ worked, once the probe stopped disabling it |
| **Undo** | ✅ worked |
| Touch selection | ✅ selects, and the iOS callout menu appears |
| Copy from the callout | ✅ copied (the panel failing to show it was a probe defect) |

That is the decision-grade result. The remaining feedback was about feel, and it sorted
almost entirely into defects in this probe rather than in CodeMirror:

| Reported | Cause | Status |
|---|---|---|
| Selection hard to see in dark mode | Probe CSS: `#3a4a2e`, a dark olive on a dark ground | fixed — amber at 32% |
| Cursor invisible | Probe CSS: a hairline caret | fixed — brighter, and the product draws its own |
| "Takes multiple tries to select" | Probe CSS: `max-height: 44vh` made a **nested scroller**, so long-press-drag competed with scrolling | fixed — removed; the page scrolls, the editor does not |
| Copy never appeared in the panel | Probe bug: the panel repaints on document or selection change, and a copy is neither | fixed |
| "Overall klunky" | Probe used 14px monospace with tight leading. **16px is also a floor** — iOS zooms the viewport for anything smaller, and that zoom is felt as klunk | fixed — 16px sans for prose, mono for fences |
| 🔴 **Checkbox dead while the keyboard is up** | **Real.** With the editor focused, iOS routes the first touch to caret placement and the synthesized `click` never reaches the widget | fixed — `pointerdown` instead of `mousedown`+`click` |

The last one is the only entry that would have shipped as a product defect, and it is the
one that matters most: ADR-003's whole premise is that **checkboxes stay tappable while
typing**. A checkbox that goes dead exactly when the keyboard is up fails that premise at
the moment it is being relied on. Worth keeping as a browser test if this ships.

None of these is evidence against CodeMirror. All of them are evidence that a probe styled
as a diagnostic reads as a bad product, which is worth remembering before the next one is
used to judge feel.

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
- 🔴 **whether a per-line `autocorrect="off"` is honoured inside a fence** — see above; if
  it is not, ADR-003 §6 has to be re-decided

Run `bash scripts/serve-spike.sh` and open the printed URL in Safari on the phone. The
drills are listed on the page and the verdict panel is live.

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
