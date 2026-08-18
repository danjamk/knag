/**
 * Spike probe: can CodeMirror 6 be knag's editing surface?
 *
 * Three questions, and only three. Selection working is NOT one of them - it is one
 * editing surface, so it works, and ADR-006 already recorded that a spike proving only
 * the easy half proves nothing.
 *
 *   1. Does the document round-trip byte-for-byte? (principle 3)
 *   2. Can `- [ ] ` render as a tappable control without the display diverging from
 *      the bytes? (ADR-004)
 *   3. What does it cost in bundle size?
 *
 * 🔴 Built to fail, per the lesson in ADR-006. Every integrity check starts green and
 * is STICKY RED once it fails - because the failure this is hunting is one that renders
 * correctly and only appears on save. Every capability check starts at "not exercised"
 * and can only be turned green by actually doing the thing, so an untouched probe
 * reports nothing rather than reporting success.
 *
 * 🔴 This file is pure ASCII on purpose. The previous probe was read as Latin-1 by one
 * toolchain, which silently turned a one-character constant into two and left a check
 * that could never fire. Every hazard below is written as an escape.
 */

import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

// ── The awkward document ─────────────────────────────────────────────────────
//
// Every line here is a hazard knag's property test already covers. Assembled from
// escapes and joined with "\n", which is exactly how `blocks.ts` serializes: a CRLF
// line carries its own "\r" at the end of its `raw`, and the joiner is always "\n".

const LINES = [
  "Thursday",
  "",
  "- [ ] call the accountant",
  "- [x] renew the domain",
  "  - [ ] and update the DNS record",
  "* star bullet",
  "\ttab indented line",
  "trailing spaces here   ",
  "CRLF line\r",
  "```js",
  "const x = 1;",
  "```",
  "text after the fence",
  "~~~",
  "inside an unclosed fence",
];

const SOURCE = LINES.join("\n") + "\n";

// ── Question 1, answered before any view exists ──────────────────────────────
//
// A pure state test, no DOM. CodeMirror splits on "\n", "\r\n" and "\r" by default and
// rejoins with "\n", which would silently drop the "\r" from a CRLF line. The
// `lineSeparator` facet is the documented way to stop that; whether it actually holds
// is the single most important thing on this page.

function roundTrips(extensions: readonly unknown[]): boolean {
  const state = EditorState.create({
    doc: SOURCE,
    extensions: extensions as never,
  });
  return state.doc.toString() === SOURCE;
}

const RT_DEFAULT = roundTrips([]);
const RT_PINNED = roundTrips([EditorState.lineSeparator.of("\n")]);

/** First index where two strings differ, or -1. For reporting, not for deciding. */
function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ── Question 2: the checkbox as a widget ─────────────────────────────────────
//
// knag's grammar, unchanged: `worker/src/blocks.ts`. `-[ ]` is not a checkbox and
// neither is `- []`.

const CHECK = /^(\s*)([-*]) \[([ xX])\] /;

/**
 * Replaces the `- [ ] ` marker with a real checkbox input.
 *
 * 🔴 The indent is deliberately NOT inside the replaced range, so leading whitespace
 * stays literal document text and renders as itself. That is a byte-truth improvement
 * over the row model, where indentation is a CSS property derived from bytes the
 * editor never shows.
 *
 * Toggling rewrites exactly one character - the one between the brackets - which is
 * the same minimal edit `toggle()` makes today. `[X]` stays `[X]`.
 */
class Box extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly boxPos: number,
    readonly boxChar: string,
  ) {
    super();
  }

  override eq(other: Box): boolean {
    return other.checked === this.checked && other.boxPos === this.boxPos;
  }

  override toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "box";
    input.checked = this.checked;
    // Without this the editor takes focus and the caret jumps into the line on tap.
    input.addEventListener("mousedown", (event) => event.preventDefault());
    input.addEventListener("click", (event) => {
      event.preventDefault();
      const next = this.checked ? " " : this.boxChar === "X" ? "X" : "x";
      view.dispatch({
        changes: { from: this.boxPos, to: this.boxPos + 1, insert: next },
      });
      report();
    });
    return input;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const FENCE = /^\s*(```|~~~)/;

/**
 * 🔴 Walks the WHOLE document, not just the viewport, because fence state is
 * positional - whether line 40 is inside a fence depends on line 12. A viewport-only
 * scan reports a fence as prose the moment you scroll past its opening marker. Fine at
 * this document's size; a real integration needs this in a StateField that updates
 * incrementally, and that is a known piece of work rather than a surprise.
 */
function fenceLines(view: EditorView): Set<number> {
  const inside = new Set<number>();
  let open = false;
  for (let n = 1; n <= view.state.doc.lines; n += 1) {
    const line = view.state.doc.line(n);
    const marker = FENCE.test(line.text);
    if (marker || open) inside.add(n);
    if (marker) open = !open;
  }
  return inside;
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const fences = fenceLines(view);
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      // 🔴 ADR-003 §6 turns autocorrect ON for prose and OFF inside fences, and says
      // plainly that one element per block is *what makes the distinction possible*.
      // One editing surface has one contenteditable, so the document-level attribute
      // cannot vary — the only route left is a per-line attribute on a child element,
      // which is set here and which iOS may simply ignore. That is a drill, not a
      // claim: if the phone autocapitalizes `const` into `Const`, ADR-003 §6 does not
      // survive the change of mechanism and has to be re-decided.
      if (fences.has(line.number)) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off" },
          }),
        );
      }
      const match = CHECK.exec(line.text);
      if (match) {
        const indent = (match[1] ?? "").length;
        const boxChar = match[3] ?? " ";
        const checked = boxChar !== " ";
        if (checked) {
          builder.add(line.from, line.from, Decoration.line({ class: "done" }));
        }
        builder.add(
          line.from + indent,
          line.from + match[0].length,
          Decoration.replace({
            widget: new Box(checked, line.from + indent + 3, boxChar),
          }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const boxes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = decorate(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
    // Without this the caret can be placed inside a marker that is not on screen, and
    // arrow keys stall on an invisible six characters.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

// ── Integrity checks ─────────────────────────────────────────────────────────
//
// Each one names a hazard and asserts the bytes for it are still present, verbatim.
// The drills below are all meant to leave every one of these lines untouched, so any
// red here is the editor rewriting something nobody asked it to.

/**
 * 🔴 Every check has an `anchor` as well as a `test`, and that is the whole design.
 *
 * The drills on this page tell you to select four lines and delete them. Doing what the
 * page asks then turned the hazard checks red, which is the instrument reporting on the
 * drill rather than on the editor - and a red that means nothing is exactly how a real
 * one gets ignored. ADR-006 recorded the mirror-image failure: a check that agreed with
 * an incomplete read and reported false green.
 *
 * So there are three states, not two:
 *
 *   anchor present, test passes  ->  green   the bytes are intact
 *   anchor present, test fails   ->  RED     the line is still here and was rewritten
 *   anchor absent                ->  grey    you deleted it; not a defect
 *
 * Only RED is sticky.
 */
type Check = { id: string; label: string; anchor: string | null; test: (doc: string) => boolean };

const CHECKS: Check[] = [
  {
    id: "crlf",
    label: "CRLF line keeps its carriage return",
    anchor: "CRLF line",
    test: (doc) => doc.includes("CRLF line\r\n"),
  },
  {
    id: "trailing",
    label: "trailing spaces survive",
    anchor: "trailing spaces here",
    test: (doc) => doc.includes("trailing spaces here   \n"),
  },
  {
    id: "tab",
    label: "tab indent stays a tab",
    anchor: "tab indented line",
    test: (doc) => doc.includes("\ttab indented line"),
  },
  {
    id: "star",
    label: "* marker is never normalized to -",
    anchor: "star bullet",
    test: (doc) => doc.includes("\n* star bullet\n") && !doc.includes("\n- star bullet\n"),
  },
  {
    id: "indent",
    label: "nested checkbox keeps its two spaces",
    anchor: "and update the DNS record",
    test: (doc) => doc.includes("\n  - [ ] and update the DNS record"),
  },
  {
    id: "fence",
    label: "fenced block is untouched",
    anchor: "const x = 1;",
    test: (doc) => doc.includes("```js\nconst x = 1;\n```"),
  },
  {
    id: "unterminated",
    label: "unclosed fence is untouched",
    anchor: "inside an unclosed fence",
    test: (doc) => doc.includes("~~~\ninside an unclosed fence"),
  },
  {
    id: "finalnl",
    label: "trailing newline survives",
    anchor: null,
    test: (doc) => doc.endsWith("\n"),
  },
  {
    id: "nohtml",
    label: "no markup leaked into the document",
    anchor: null,
    test: (doc) => !/<\/?[a-z][\s>]/i.test(doc) && !doc.includes("font-family"),
  },
];

/** Sticky. Once RED it stays RED, with the document that broke it. */
const failed = new Map<string, string>();

/** null = the line is gone, so the check does not apply. */
function stateOf(check: Check, doc: string): boolean | null {
  if (failed.has(check.id)) return false;
  if (check.anchor !== null && !doc.includes(check.anchor)) return null;
  return check.test(doc);
}

// ── Capability observations ──────────────────────────────────────────────────
//
// The opposite polarity: these start at "not exercised" and can only be turned green
// by the drill actually happening. An untouched probe reports nothing.

const seen = {
  multilineSelection: false,
  crossRowCopyText: "",
  undo: false,
  redo: false,
  paste: false,
  composition: false,
};

let view: EditorView;

function report(): void {
  const doc = view.state.doc.toString();
  for (const check of CHECKS) {
    if (stateOf(check, doc) === false) failed.set(check.id, doc);
  }
  paint();
}

// ── The page ─────────────────────────────────────────────────────────────────

function row(ok: boolean | null, label: string, note = ""): string {
  const mark = ok === null ? "&middot;" : ok ? "&#10003;" : "&#10007;";
  const cls = ok === null ? "idle" : ok ? "ok" : "bad";
  return `<li class="${cls}"><span class="mark">${mark}</span><span>${label}</span>${
    note ? `<span class="note">${note}</span>` : ""
  }</li>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Visible form of the bytes, so a lost "\r" is something you can see. */
function visible(text: string): string {
  return escapeHtml(text)
    .replace(/\r/g, '<i class="ctl">CR</i>')
    .replace(/\t/g, '<i class="ctl">TAB</i>')
    .replace(/ +$/gm, (run) => `<i class="ctl">SP&times;${run.length}</i>`);
}

function paint(): void {
  const panel = document.querySelector("[data-verdicts]");
  const dump = document.querySelector("[data-dump]");
  if (!panel || !dump) return;

  const sel = view.state.selection.main;
  const selLines =
    view.state.doc.lineAt(sel.to).number - view.state.doc.lineAt(sel.from).number + 1;

  const doc = view.state.doc.toString();

  panel.innerHTML = [
    "<h3>1. Round trip, at load &mdash; this is a finding, not a fault</h3><ul>",
    row(RT_DEFAULT, "default config keeps the CR", RT_DEFAULT ? "" : "expected red: it drops it"),
    row(RT_PINNED, "lineSeparator pinned to \\n", RT_PINNED ? "byte-exact" : "still lossy"),
    "</ul>",

    "<h3>2. Integrity &mdash; red only if a line is still here and changed</h3><ul>",
    ...CHECKS.map((c) => {
      const state = stateOf(c, doc);
      return row(state, c.label, state === null ? "line removed" : "");
    }),
    "</ul>",

    "<h3>3. Capabilities &mdash; not exercised until you do it</h3><ul>",
    row(
      seen.multilineSelection ? true : null,
      "selection spans more than one line",
      selLines > 1 ? `now: ${selLines} lines` : "",
    ),
    row(
      seen.crossRowCopyText ? true : null,
      "copied text across lines",
      seen.crossRowCopyText ? `${seen.crossRowCopyText.length} chars` : "",
    ),
    row(seen.undo ? true : null, "undo reverted a change"),
    row(seen.redo ? true : null, "redo replayed it"),
    row(seen.paste ? true : null, "paste applied"),
    row(seen.composition ? true : null, "IME / autocorrect composition seen"),
    "</ul>",
  ].join("");

  dump.innerHTML = visible(view.state.doc.toString());

  const copied = document.querySelector("[data-copied]");
  if (copied) {
    copied.innerHTML = seen.crossRowCopyText
      ? visible(seen.crossRowCopyText)
      : '<span class="idle">nothing copied yet</span>';
  }
}

// ── Wire it up ───────────────────────────────────────────────────────────────

const parent = document.querySelector("[data-editor]");
if (!parent) throw new Error("no editor mount");
// Clears the "the script did not run" placeholder. Reaching this line is the proof.
parent.innerHTML = "";

view = new EditorView({
  parent,
  state: EditorState.create({
    doc: SOURCE,
    extensions: [
      // The finding from question 1 applied. If RT_PINNED is false this is theatre and
      // the page says so at the top.
      EditorState.lineSeparator.of("\n"),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,

      // 🔴 Not optional, and its absence made the first run of this probe report
      // nothing. CodeMirror sets `spellcheck="false"` on its content by default, so
      // autocorrect never fires and the drill that is supposed to exercise the single
      // largest risk in #110 silently tests nothing. ADR-003 §6 turns these ON for
      // prose; the probe has to match the product or it is measuring a different
      // editor.
      EditorView.contentAttributes.of({
        autocorrect: "on",
        autocapitalize: "sentences",
        spellcheck: "true",
      }),

      boxes,
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) {
          const sel = update.state.selection.main;
          if (!sel.empty) {
            const lines =
              update.state.doc.lineAt(sel.to).number - update.state.doc.lineAt(sel.from).number;
            if (lines > 0) seen.multilineSelection = true;
          }
          report();
        }
      }),
      EditorView.domEventHandlers({
        copy: () => {
          const sel = view.state.selection.main;
          if (!sel.empty) seen.crossRowCopyText = view.state.sliceDoc(sel.from, sel.to);
          return false;
        },
        paste: () => {
          seen.paste = true;
          return false;
        },
        compositionstart: () => {
          seen.composition = true;
          return false;
        },
      }),
    ],
  }),
});

// Undo and redo are observed by watching the document actually move, not by trusting
// that a keystroke was handled.
let beforeUndo = "";
document.addEventListener(
  "keydown",
  (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta || event.key.toLowerCase() !== "z") return;
    beforeUndo = view.state.doc.toString();
    const redo = event.shiftKey;
    setTimeout(() => {
      if (view.state.doc.toString() !== beforeUndo) {
        if (redo) seen.redo = true;
        else seen.undo = true;
        report();
      }
    }, 0);
  },
  true,
);

// Back to a known document, and clear the sticky reds with it. Without this a single
// destructive drill leaves the panel useless for every drill after it, and the only
// recovery is reloading the page - which also throws away the capability results you
// just earned.
document.querySelector("[data-reset]")?.addEventListener("click", () => {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: SOURCE } });
  failed.clear();
  report();
});

report();

// ── Exposed for the headless run ─────────────────────────────────────────────

declare global {
  interface Window {
    __probe: unknown;
  }
}

window.__probe = {
  source: SOURCE,
  roundTripDefault: RT_DEFAULT,
  roundTripPinned: RT_PINNED,
  doc: () => view.state.doc.toString(),
  matchesSource: () => view.state.doc.toString() === SOURCE,
  firstDiff: () => firstDiff(view.state.doc.toString(), SOURCE),
  failures: () => [...failed.keys()],
  seen: () => ({ ...seen }),
  /** Drives a selection from the harness. Offsets are absolute document positions. */
  select: (from: number, to: number) => {
    view.dispatch({ selection: { anchor: from, head: to } });
    view.focus();
  },
  boxCount: () => parent.querySelectorAll("input.box").length,
  /**
   * Clears the sticky failures and re-evaluates against the document as it stands.
   *
   * 🔴 Only for the headless harness, and only after a drill that *deliberately*
   * deleted a hazard line. Sticky is the right default - the failure being hunted
   * renders correctly and only shows up on save - but a drill that removes the very
   * bytes a check asserts produces a red that means nothing, and a red that means
   * nothing is how a real one gets ignored. The page itself never calls this.
   */
  reset: () => {
    failed.clear();
    report();
    return [...failed.keys()];
  },
  toggleFirstBox: () => {
    const box = parent.querySelector<HTMLInputElement>("input.box");
    box?.click();
  },
};
