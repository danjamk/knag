# Response to state-of-play — an outside review

> 🔴 **This review was accepted, and it was right about the thing that mattered.**
> Its central call — CodeMirror 6, probed against CM6 itself rather than against a
> hand-rolled `contenteditable` — is what happened, and §2's *kill criterion #1* (iOS
> spellcheck and autocorrect versus programmatic DOM changes) is **still open** as
> [#114](https://github.com/danjamk/knag/issues/114). The decision it produced is
> [ADR-007](../adr/ADR-007-one-editing-surface.md).
>
> **Where it was wrong: the bundle.** §2 projected 35–50 KB gzipped added and set
> "more than ~75 KB added means the scoping was wrong" as its own threshold. The real
> number was about 85 KB — the client went from 21.6 KB to 107 KB gzipped. The scoping
> was not wrong so much as the estimate was: knag replaces three bindings and needs the
> rest of `standardKeymap` for Home/End/⌘A/word-delete. ADR-007 accepted the cost with
> that reasoning on the record, and names dropping `standardKeymap` (~10 KB) as the first
> move if the bundle ever stops being affordable.

**Written 2026-08-18** by a reviewer with repo access, the brief
([state-of-play.md](state-of-play.md)), and independent research. The brief's
claims were verified against the code before anything below was written; they
are honest. Where this document contradicts the brief, that is the job it was
given.

**TL;DR:** The causal chain is correct but it is not an impossibility proof —
its fatal link is an implementation choice, not a platform rule, and there are
two ways out that keep tappable checkbox controls. CodeMirror 6 is the right
first candidate, for stronger reasons than the brief gives and with one risk
the brief missed, which becomes the probe's first kill criterion. The probe is
one day and it should be run against CM6 itself, not against a hand-rolled
contenteditable. Undo, not selection, should carry the most weight in the
final decision, because it is the thing only one option fixes structurally.

---

## 1. The causal chain (§12 Q1)

Correct, and incomplete. The chain's fatal step is:

> Text must be editable in place → each line's text is therefore its own form
> control

That step conflates *a tappable control* with *a sibling form control in a
per-line DOM structure*. The platform rule is only that a selection cannot
span two form controls. It says nothing about a selection flowing *around* a
form control embedded as a non-editable island inside one editable surface —
which selections do, natively, on every platform. Two architectures exploit
this:

**a. Widget islands inside one intercepted surface.** A real
`<input type="checkbox">` lives inside one contenteditable as a non-editable
widget; the library owns every mutation; selection crosses lines and flows
around the widgets. This is not exotic — it is literally CodeMirror 6's
official decoration example (a checkbox widget toggling boolean literals),
with `EditorView.atomicRanges` handling caret behavior around the island. The
existence proof at product scale is Obsidian, phone app included: CM6,
proportional face, checkbox widgets, autocorrect on.

**b. The roving editor.** Unfocused rows render as plain, non-editable
elements — native selection spans those freely, iOS long-press handles
included, and the browser cannot corrupt what it cannot edit. Exactly one row
at a time is a live `<textarea>`: the one being typed in. Copy is intercepted
and reconstructed from the block model (the per-line row structure makes
range→block mapping nearly free); delete-across-rows maps the selection to
block indices and applies the pure ops `edit.ts` already has. This is the
option ADR-006 never measured. Its option 2 was rejected because *synthetic*
selection is a desktop-only hand-build — but selection over static rows is
native, so nothing synthetic is needed. Its option 3 was rejected on four
grounds that mostly dissolve on inspection: `⌘A` is a keymap, not an
architecture; Arrange already re-renders its own row DOM and keeps it; the
link affordance is a per-row overlay either way; only per-row `readOnly` is
genuinely lost, and `sync.ts` gates editability by state, not by attribute.

So §5's chain proves the *current* mechanism cannot do selection. It does not
prove the constraint stack forbids it. ADR-003's intent survives both escapes.

The honest asymmetry between the two: (a) also solves undo, composition and
paste, because a maintained library is the accumulated fix for all of them;
(b) solves selection only, leaves undo exactly as broken as today, and its
focus-swap cost on the iOS keyboard is unproven. That asymmetry is why (a) is
the lead and (b) is the fallback, not the reverse — see §5.

## 2. The component (§12 Q2)

**CodeMirror 6, and it is not pattern-matching on "plain text."** The brief's
instinct is right for reasons it does not list:

- **The document model is your model.** CM6's document is a string of lines —
  not a schema'd rich-text tree (ProseMirror), not a node hierarchy with a
  plain-text *mode* (Lexical). `blocks.ts` stays the single parser; the CM6
  doc is just `body`; decorations are computed *from* the parse. Nothing about
  the agent contract or the Worker changes.
- **`@codemirror/state` is DOM-free.** The round-trip property test — the
  enforcement of principle 3 — runs headlessly in vitest against real CM6
  transactions, in the same suite, before a browser ever opens. That fits the
  house rule about testing the real thing rather than a mock.
- **It deletes the hardest code in the client rather than sitting on top of
  it.** `caret.ts` (205 lines of hidden-mirror geometry), the
  Enter/Backspace/arrow interception layer in `app.ts`, and the
  column-preserving vertical motion all exist to make row boundaries imitate
  line boundaries. In CM6 they *are* line boundaries. The dependency is
  large, but the net complexity delta is much smaller than the bundle delta.
- **ADR-004 already assumes this machinery.** Its recorded
  only-acceptable-shape for future formatting — "live preview with the syntax
  visible and editable on the focused row" — is the CM6/Obsidian pattern,
  named after the products built on it. Adopting CM6 for selection is also
  buying the platform ADR-004's future already stands on.
- **Checkboxes pass ADR-004 unchanged.** A replacing decoration hides
  `- [ ] ` behind a real checkbox control; the bytes are untouched in the
  doc; toggling dispatches a one-character change between the brackets; and a
  copy that spans the line yields the *actual bytes*, prefix included —
  byte-honesty native selection has never had here.

**The risk the brief missed — kill criterion #1.** The CM6 maintainer has
stated that on iOS, OS-level spellcheck stays off when the editable DOM is
changed programmatically — which decorations do — and that no userland
workaround exists ([discuss thread](https://discuss.codemirror.net/t/os-level-spellcheck-is-disabled-on-ios-even-after-adding-contentattribute/4128)).
Squiggle spellcheck and keyboard autocorrect are different iOS systems, and
Obsidian's phone app suggests autocorrect survives — but knag turned
autocorrect on *deliberately* (ADR-003 §6), so this is the first thing the
probe must answer on a real device, ahead of composition. Related and second:
a known issue where IME composition adjacent to a widget can break because
`cm-widgetBuffer` nodes are reconstructed mid-composition
([discuss thread](https://discuss.codemirror.net/t/ime-input-may-break-when-cursor-is-adjacent-to-widget-due-to-cm-widgetbuffer-reconstruction/9799))
— and knag's widgets sit at the head of the most-edited lines.

**Byte-exactness is configurable, not free.** CM6's `Text` is
line-ending-agnostic; by default it would normalize. With
`EditorState.lineSeparator.of("\n")` the split is exact and a `\r` survives as
line content — the same shape as the `stripCR` display convention `view.ts`
already has. The headless property test settles this in an afternoon, over
the same generated corpus as `blocks.test.ts`.

**Bundle.** The `codemirror` basic-setup package is ~93 KB gzipped
([codemirror/dev#760](https://github.com/codemirror/dev/issues/760)) — that
is the ceiling, and it includes highlighting, autocompletion and gutters knag
will never ship. The minimal set (`@codemirror/state`, `@codemirror/view`,
`@codemirror/commands`, keymap) should land near 35–50 KB gzipped against a
61 KB (minified, pre-gzip) client. The probe's build prints the real number;
more than ~75 KB gzipped added means the scoping was wrong.

**On the others, the brief's table is right.** Lexical is plausible but
heavier in concept than the problem, and its center of gravity is React.
ProseMirror solves the right problems for a document shape knag does not
have. Slate and the markdown-WYSIWYG wrappers are out for the reasons given.
Monaco and Ace fail on mobile. There is no hidden better candidate; CM6 is
where a plain-text, line-based, phone-first document lands.

**On §9's inversion argument: it is correct, and it should be adopted as
stated.** Text editing on iOS Safari — composition, selection, undo, mobile
carets — is the one domain in this project where hand-rolling is the
*un*-boring choice. "No framework" was adopted by a CRUD app that did not yet
know it was building an editor. The carve-out is scoped: the editing surface
only. The Worker, the store, the shell, and the parser stay framework-free.

## 3. Sequencing (§12 Q3)

The ~1 day probe is the right gate, with two corrections:

**Probe the component, not the technique.** Issue #110's P0 extends the
spike/89 contenteditable page — an artifact that would be thrown away even on
success, because success leads to CM6, not to hand-rolling. Point the same
day at a minimal CM6 page instead. Same question, same phone, and a pass
leaves a working skeleton instead of a proof about an artifact nobody ships.

**Order the kill criteria by cost of falsification:**

1. **Autocorrect, autocapitalize, dictation** in prose lines, decorations
   active, on iOS Safari. Two hours to a verdict once the page loads on a
   phone. If this fails, stop; nothing else matters.
2. **Composition adjacent to the checkbox widget** — type at the head of a
   checkbox line, through autocorrect replacement. The `cm-widgetBuffer`
   issue is where this dies if it dies.
3. **Byte round-trip, headlessly** — the property corpus through
   `EditorState` transactions with the `\n` separator. Automatable the same
   afternoon; no device needed.
4. **Measured bundle delta** — mechanical, printed by the build.

The estimate discipline holds: the probe is a day. Adoption after a green
probe is the real project — P1–P5 of #110 collapse to roughly "wire CM6 in,
move the interception into extensions, keep Arrange's rendering" — smaller
than #110's hand-rolled 1–3 weeks, but still a deliberate choice, made as an
ADR-007 with the probe's numbers in it.

## 4. Option B, the frictionless raw view (§12 Q4)

**Undervalued as a bridge, overvalued as a destination.** The brief prices it
at hours and that is right; if the probe or the adoption drags, a one-gesture
non-sticky raw view is a fine painkiller and nothing about it is wasted work.

But name what it gives up: it re-institutionalizes the mode ADR-003 removed
on evidence — the product's one proven UX defect, back as a feature. It does
nothing for undo. And ADR-003 itself designated reaching-for-raw as the
*diagnostic* that the row model is the wrong shape; making the diagnostic
comfortable treats the thermometer. It is a bridge worth building only if the
real fix is delayed, not a reason to delay it.

Worth recording alongside: the Arrange patch is better than the brief knew —
the invisible-picked-row defect it describes shipped fixed in #109, so
row-granularity multi-select now actually exists perceptibly. And the "two
meanings of selected" smell (§11.3) resolves rather than compounds: text
selection is for *partial-line, editing-shaped* operations; Arrange's pick is
for *whole-row verbs* — drag, bulk copy, bulk delete — with fat touch
targets. Different verbs, different granularity, both earned. Keep both.

## 5. What you are not seeing (§12 Q5)

**a. Undo is the decision-weight error.** The brief calls it "possibly a
bigger daily friction" and then files it under the editor rewrite. Weight it
properly and it reorders the options: the status quo cannot fix it (per-row
browser stacks, destroyed on every re-render), the roving hybrid does not fix
it, option B does not fix it, and CM6 fixes it as a side effect
(`@codemirror/commands` history, composition-aware, `historyUndo`
interception included). Selection is the loud complaint; undo is the
structural one. The option that fixes both for one probe is not the same bet
as the options that fix one.

**b. Two platform facts moved recently.**
`contenteditable="plaintext-only"` went Baseline in March 2025 — Safari 18.4
([caniuse](https://caniuse.com/mdn-html_global_attributes_contenteditable_plaintext-only)) —
which removes the style-inlining corruption class from the spike/89 findings
if hand-rolling is ever revisited (the *structural* corruption remains; the
spike's conclusion stands). And `document.execCommand("insertText")`,
deprecated but universally shipped, applies a programmatic edit to a textarea
*through* the browser's undo stack — relevant today for raw view's
sync-applies, and to any future textarea-shaped surface.

**c. The wrong turn, and how far back.** Recent, and small. It is not
ADR-003 — the row model was the right call at the time and it produced the
assets that make the fix cheap now: a pure model, pure edit ops, and a DOM
that is already a projection. The wrong turn is inside ADR-006: option 4 got
a spike while option 3 got an argument, and the option list stopped one entry
short of the roving hybrid — so the decision was made between one measured
failure and three unmeasured rejections. The correction is not to unwind
anything; it is to give the missing candidates the same instrument the
contenteditable got. That is what the probe is.

**d. After adoption, delete raw view.** The brief's §11.4 is right and can be
said more strongly: under CM6 the editor *is* the bytes with decorations over
them, and raw view's remaining purpose evaporates. Keep it through the
transition as the escape hatch it was designed to be; when the new surface
has survived a month of real use, remove it, and let its absence be the
proof ADR-003 was finally paid off.

---

## Disposition

Run the probe (#110 P0, pointed at CM6): `spike/110-codemirror` carries a
standalone probe page, a headless round-trip property test, and a measured
bundle report, with the four kill criteria above in order. A green probe goes
to ADR-007 and a scoped carve-out of the no-framework rule; a red criterion 1
or 2 falls back to the roving hybrid, which gets the same instrument next.

## Sources

- [CM6 decoration example — the checkbox widget](https://codemirror.net/examples/decoration/)
- [iOS OS-level spellcheck under programmatic DOM change — maintainer statement](https://discuss.codemirror.net/t/os-level-spellcheck-is-disabled-on-ios-even-after-adding-contentattribute/4128)
- [IME breakage adjacent to widgets (`cm-widgetBuffer`)](https://discuss.codemirror.net/t/ime-input-may-break-when-cursor-is-adjacent-to-widget-due-to-cm-widgetbuffer-reconstruction/9799)
- [CM6 bundle size discussion](https://github.com/codemirror/dev/issues/760)
- [CM6 line separators / CRLF handling](https://discuss.codemirror.net/t/does-codemirror-normalize-crlf-endings/3449)
- [`contenteditable="plaintext-only"` browser support](https://caniuse.com/mdn-html_global_attributes_contenteditable_plaintext-only)
- [Native undo for programmatic edits via `execCommand`](https://dev.to/chromiumdev/-native-undo--redo-for-the-web-3fl3)
