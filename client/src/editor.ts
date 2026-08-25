/**
 * The editing surface: one CodeMirror document, checkboxes drawn over the bytes.
 *
 * 🔴 `app.ts` must not learn CodeMirror. Everything below is behind `EditorHandle`, which
 * speaks only in document bytes — `body()`, `setBody()`, `setReadOnly()`. The reason is
 * not tidiness: knag has replaced its editing surface once already, and the row model
 * leaked into `app.ts` through `editorIn`, `focusRow`, `captureCaret` and four arrow-key
 * branches, which is why replacing it is a project rather than a change.
 *
 * What this owns:
 *
 * - the line-ending wrapper, so no `\r` ever reaches the document (`eol.ts`)
 * - checkbox widgets over `- [ ] `, atomic, toggling exactly one byte
 * - the dim-and-strike on a checked line, which stays where it is (spec §7)
 * - fence lines: monospace, and spellcheck off (ADR-003 §6)
 * - the link affordance
 * - the theme, which must be a CodeMirror theme rather than CSS (see below)
 *
 * What it deliberately does not own: saving, polling, Arrange, and the `--` shorthand.
 * Those stay in `app.ts` where they already live.
 */

import {
  Annotation,
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type Command,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { applyShorthand, revertShorthand, splitLine } from "./edit.js";
import { inherit, joinEndings, remapEndings, splitEndings, type Endings } from "./eol.js";
import { GLYPH, glyph } from "./glyphs.js";
import { linkify } from "./view.js";

export type EditorHandle = {
  /** The document as bytes, line endings restored. */
  body(): string;
  /** Replace the whole document — first load, or a remote update. */
  setBody(body: string): void;
  /** Offline refuses edits without making the page unreadable (spec §9). */
  setReadOnly(readOnly: boolean): void;
  /**
   * Fade the given zero-based lines, then close the gap they leave (#119).
   *
   * 🔴 The one method here that is about presentation rather than bytes, and it is a
   * deliberate widening of [ADR-007]'s interface. The alternative is a CodeMirror import
   * outside this file, which is the rule that made the row model expensive to replace —
   * so the leak that was allowed is the smaller one, and the timing still lives in
   * `app.ts` so both surfaces run one sequence rather than two that drift.
   *
   * Resolves when the collapse has finished, **with the lines still hidden**. Decides
   * nothing about what is wiped.
   */
  animateWipe(lines: number[], timings: WipeTimings): Promise<void>;
  /**
   * Release the wipe's picture, putting any line it still covers back on screen.
   *
   * 🔴 Separate from `animateWipe` on purpose, and the separation is a bug fix (#149).
   * Clearing on resolve meant the wiped lines snapped back to full height and opacity
   * for however long the caller took to repaint — a single frame for the daily sweep,
   * and the whole 200ms of `--page-beat` for the page wipe, which is why the page
   * visibly came back before it went. The caller now clears in the same task as the
   * repaint, so nothing is painted in between.
   *
   * It must still be called: `setBody` computes a *minimal* change, so a line that
   * survived the wipe keeps its position and would keep a stale `cm-wiping` class with
   * it — rendering a line of the new document permanently invisible.
   */
  clearWipe(): void;
  focus(): void;
  destroy(): void;
};

/**
 * Durations read once from the stylesheet by `app.ts`, so the tokens stay the source.
 *
 * `page` selects the whole-page timing (#121, §6b): the same animation, a second set of
 * tokens, and the stagger runs **bottom-up** — the page leaves as one object rather than
 * as a list being processed from the top.
 */
export type WipeTimings = {
  duration: number;
  stagger: number;
  collapse: number;
  page?: boolean;
};

export type EditorOptions = {
  initial: string;
  /** Every local document change, with the new bytes. Not called for `setBody`. */
  onChange(body: string): void;
  /**
   * Focus entering or leaving the surface.
   *
   * Not cosmetic: spec §6 holds a remote update while the document is focused, because
   * applying one under a live caret is how a device jumps mid-keystroke. `app.ts` cannot
   * see focus inside a contenteditable it does not own, so the surface reports it.
   */
  onFocusChange(focused: boolean): void;
};

// ── Line endings ─────────────────────────────────────────────────────────────

/**
 * Endings for the breaks inside text this transaction inserts, per change, in the order
 * `iterChanges` reports them.
 *
 * Carried as an annotation because only the *inserting* code knows them: pasted text
 * brings its own endings, while a plain `Enter` has none and inherits. Without this the
 * two are indistinguishable by the time the field sees them.
 */
const InsertedEndings = Annotation.define<boolean[][]>();

/** Replaces the whole ending set — first load and remote updates. */
const SetEndings = Annotation.define<Endings>();

/**
 * The CRLF line set, carried beside the document and mapped across every edit.
 *
 * 🔴 Changes are processed **last to first**. `iterChanges` reports positions in the old
 * document, and applying a later change first leaves every earlier position still valid;
 * going forwards would invalidate them the moment the line count moved. knag configures
 * no multiple selections, so in practice there is one change and the order is moot — but
 * a rule that only holds for the common case is not a rule.
 */
const endingsField = StateField.define<Endings>({
  create: () => new Set<number>(),

  update(endings, tr) {
    const replacement = tr.annotation(SetEndings);
    if (replacement) return replacement;
    if (!tr.docChanged) return endings;

    const supplied = tr.annotation(InsertedEndings);
    const edits: { from: number; to: number; breaks: number; inserted: boolean[] | undefined }[] =
      [];
    let index = 0;
    tr.changes.iterChanges((fromA, toA, fromB, toB) => {
      const from = tr.startState.doc.lineAt(fromA).number - 1;
      const to = tr.startState.doc.lineAt(toA).number - 1;
      const breaks = tr.newDoc.lineAt(toB).number - tr.newDoc.lineAt(fromB).number;
      edits.push({ from, to, breaks, inserted: supplied?.[index] });
      index += 1;
    });

    let next = endings;
    for (const edit of edits.reverse()) {
      next = remapEndings(next, {
        from: edit.from,
        to: edit.to,
        // Text that knows its own endings uses them; a keystroke inherits from the line
        // it split, so pressing Enter in a CRLF document does not quietly make it mixed.
        inserted: edit.inserted ?? inherit(next, edit.to, edit.breaks),
      });
    }
    return next;
  },
});

// ── Checkbox widgets ─────────────────────────────────────────────────────────

/** knag's grammar, unchanged. `-[ ]` is not a checkbox and neither is `- []`. */
const CHECK = /^(\s*)([-*]) \[([ xX])\] /;
const FENCE = /^\s*(```|~~~)/;

class Box extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly at: number,
    readonly box: string,
  ) {
    super();
  }

  override eq(other: Box): boolean {
    return other.checked === this.checked && other.at === this.at && other.box === this.box;
  }

  override toDOM(view: EditorView): HTMLElement {
    // 🔴 The target is the span; the ink is the input (#193). An 18px box was the whole
    // hit area, in a product whose own rule is 44 — "a 44px target is 44px of touchable
    // area; it is not 44px of ink" — and on a phone it missed often enough to be a habit.
    // The span is sized in CSS to the target and hangs into the row padding with negative
    // margins, so neither the box nor the text after it moves.
    const hit = document.createElement("span");
    hit.className = "cm-box-hit";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-box";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "completed" : "not completed");
    hit.append(input);

    // 🔴 `pointerdown`, not `click`. With the editor focused and the keyboard up, iOS
    // routes the first touch to caret placement and the synthesized click never reaches
    // the widget — so the box goes dead exactly while you are typing, which is the one
    // moment ADR-003's premise depends on it. Found on a phone, not by a test.
    //
    // On the span rather than the input, so a touch anywhere in the target toggles; the
    // input's own pointerdown bubbles here.
    hit.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.readOnly) return;
      // Exactly one byte, between the brackets. `[X]` stays `[X]`.
      const next = this.checked ? " " : this.box === "X" ? "X" : "x";
      view.dispatch({ changes: { from: this.at, to: this.at + 1, insert: next } });
    });
    hit.addEventListener("click", (event) => event.preventDefault());
    return hit;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Opens a URL without handing the opened page a reference back (`window.opener`). */
class Open extends WidgetType {
  constructor(readonly url: string) {
    super();
  }

  override eq(other: Open): boolean {
    return other.url === this.url;
  }

  override toDOM(): HTMLElement {
    const anchor = document.createElement("a");
    anchor.className = "cm-open";
    anchor.href = this.url;
    anchor.title = this.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    // 🔴 Drawn, not typed. 0.5.0 replaced every unicode glyph in the interface with a
    // path for a reason, and a `↗` here would be the one place that decision leaked.
    anchor.append(glyph(GLYPH.open, 17));
    return anchor;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Which lines sit inside a fence.
 *
 * 🔴 Scans the whole document rather than the viewport, because fence state is
 * positional: whether line 400 is inside a fence depends on line 12. A viewport-only scan
 * reports a fence as prose the moment you scroll past its opening marker.
 *
 * It is a full scan per document change, **not** incremental — one regex per line, which
 * at the size of a page knag is meant to hold is not worth the machinery to avoid. If a
 * document ever gets big enough for this to show up, it becomes a `StateField` that maps
 * its own marker set; the honest note is that it is a full scan today.
 */
function fenceLines(state: EditorState): Set<number> {
  const inside = new Set<number>();
  let open = false;
  for (let n = 1; n <= state.doc.lines; n += 1) {
    const marker = FENCE.test(state.doc.line(n).text);
    if (marker || open) inside.add(n);
    if (marker) open = !open;
  }
  return inside;
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const fences = fenceLines(view.state);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const fenced = fences.has(line.number);

      if (fenced) {
        // 🔴 ADR-003 §6 wants autocorrect on for prose and off inside fences, and says
        // one element per block is what makes that possible. One surface has one
        // contenteditable, so the only route left is a per-line attribute.
        //
        // 🔴 **Unverified on iOS, and it used to say "confirmed".** What was actually
        // observed was `const` staying lowercase inside a fence — which is equally
        // consistent with the attribute working and with iOS never capitalising there.
        // The control test settled that in #114: autocapitalize does not fire in this
        // surface *at all*, so that observation was luck, not evidence.
        //
        // Kept anyway. It is the spec-correct expression of the intent, it costs three
        // attributes on a decoration that already exists, and the risk §6 named turns out
        // not to occur — autocapitalize is inert here and pasted text is never
        // autocorrected. What is untested is autocorrect suppression while hand-typing
        // into a fence, and it cannot be tested from a Mac.
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            class: "cm-fence",
            attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off" },
          }),
        );
      }

      const check = fenced ? null : CHECK.exec(line.text);
      if (check) {
        const indent = (check[1] ?? "").length;
        const box = check[3] ?? " ";
        const checked = box !== " ";
        if (checked) builder.add(line.from, line.from, Decoration.line({ class: "cm-done" }));
        // The indent stays outside the replacement, so leading whitespace remains literal
        // document text and renders as itself — which the row model could not do, because
        // it handed the field only the text after the marker.
        builder.add(
          line.from + indent,
          line.from + check[0].length,
          Decoration.replace({ widget: new Box(checked, line.from + indent + 3, box) }),
        );
      }

      if (!fenced) {
        // The affordance is a separate control rather than a clickable run of text: on
        // touch, tapping text must place the caret, and a link that steals that tap is
        // the row model's original reason for a button.
        let offset = 0;
        for (const segment of linkify(line.text)) {
          if (segment.link) {
            const end = line.from + offset + segment.value.length;
            builder.add(end, end, Decoration.widget({ widget: new Open(segment.value), side: 1 }));
          }
          offset += segment.value.length;
        }
      }

      pos = line.to + 1;
    }
  }
  return builder.finish();
}

// ── The wipe, in this surface (#119) ─────────────────────────────────────────
//
// 🔴 A StateField rather than an addition to the ViewPlugin below. That plugin
// recomputes from the document on every change, so a wipe mark placed in it would be
// erased by the first keystroke or remote update that arrived mid-animation. CodeMirror
// merges decoration sources, so the two coexist and this one survives until it is
// cleared on purpose.
//
// Lines rather than ranges: the classes act on `.cm-line`, which is what has a height to
// collapse. `--i` carries the stagger index so the CSS can use the same expression the
// row list already uses, from the same tokens.

type WipeMark = { lines: number[]; closing: boolean; page: boolean } | null;

const setWipe = StateEffect.define<WipeMark>();

const wipeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,

  update(current, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setWipe)) continue;
      const mark = effect.value;
      if (!mark) return Decoration.none;

      const builder = new RangeSetBuilder<Decoration>();
      // Sorted because RangeSetBuilder requires ascending positions, and the caller
      // derives these from a parse that could in principle hand them over unordered.
      const lines = [...mark.lines].sort((a, b) => a - b);

      const base = mark.page ? "cm-wiping cm-page" : "cm-wiping";

      for (const [order, line] of lines.entries()) {
        // 🔴 Guarded. A line number past the end throws inside `doc.line`, and these
        // arrive from a parse of `body` which can be a repaint behind the document if a
        // remote update landed between the tap and the dispatch.
        if (line < 0 || line >= tr.state.doc.lines) continue;
        const at = tr.state.doc.line(line + 1).from;
        // Bottom-up for the page, top-down for the daily sweep. The order is the only
        // difference; the CSS reads `--i` and does not know which wipe it is running.
        const i = mark.page ? lines.length - 1 - order : order;
        builder.add(
          at,
          at,
          Decoration.line({
            class: mark.closing ? `${base} cm-closing` : base,
            attributes: { style: `--i: ${i}` },
          }),
        );
      }
      return builder.finish();
    }

    // Mapped through document changes so a mark does not slide onto the wrong line if
    // anything edits mid-animation. It is cleared explicitly, never by a doc change.
    return current.map(tr.changes);
  },

  provide: (field) => EditorView.decorations.from(field),
});

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
    }
  },
  {
    decorations: (value) => value.decorations,
    // Without this the caret can be placed inside a marker that is not on screen, and the
    // arrow keys stall on six invisible characters.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);


// ── Typing (spec §7, ADR-003 §4) ─────────────────────────────────────────────
//
// 🔴 These are adapters, not rules. Every decision about what `Enter` and `--` do lives
// in `edit.ts` as `splitLine`, `applyShorthand` and `revertShorthand` — the same
// functions the row list calls — because two statements of the same behaviour agree
// right up until someone fixes one of them.

/** Set on the transaction that converted `-- ` to `- [ ] `, so Backspace can undo it. */
const Shorthanded = Annotation.define<boolean>();

/**
 * Whether the *previous* transaction was a shorthand conversion.
 *
 * 🔴 Cleared by anything else at all. An undo that stays available indefinitely stops
 * being an undo and becomes a rule nobody can predict — backspacing at the start of a
 * checkbox typed ten minutes ago should merge lines, not resurrect two dashes.
 */
const shorthandField = StateField.define<boolean>({
  create: () => false,
  update: (was, tr) => tr.annotation(Shorthanded) ?? (tr.docChanged || tr.selection ? false : was),
});

/** An ordinary newline: no marker continued, no indentation invented. */
function plainSplit(line: string, offset: number): { kind: "split"; head: string; tail: string; caret: number } {
  const at = Math.max(0, Math.min(offset, line.length));
  return { kind: "split", head: line.slice(0, at), tail: line.slice(at), caret: 0 };
}

/** A fence is code. Nothing in it continues a list, however much it looks like one. */
function inFence(state: EditorState, lineNumber: number): boolean {
  return fenceLines(state).has(lineNumber);
}

/**
 * `Enter` — split, continue a marker, or leave the list.
 *
 * Returns false for a non-empty selection so CodeMirror's own handling replaces it,
 * which is what every editor does and what the row model could not express at all.
 */
const enterCommand: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty || view.state.readOnly) return false;

  const line = view.state.doc.lineAt(range.head);

  // 🔴 Every Enter is handled here, including the ordinary ones, rather than handing a
  // plain line back to `standardKeymap`. Its binding is `insertNewlineAndIndent`, which
  // consults an indentation service — and knag has no language configured, so what that
  // inserts is a detail of somebody else's default rather than a decision. A page whose
  // whole premise is bytes in, bytes out cannot have leading whitespace arrive from a
  // library. This inserts exactly one `\n` and whatever the policy says.
  const split = inFence(view.state, line.number)
    ? // Inside a fence Enter is a newline and nothing else. A YAML list or a diff pasted
      // into a code block starts lines with `- `, and continuing it there would edit code.
      plainSplit(line.text, range.head - line.from)
    : splitLine(line.text, range.head - line.from);

  if (split.kind === "clear") {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    return true;
  }

  view.dispatch({
    changes: { from: line.from, to: line.to, insert: `${split.head}\n${split.tail}` },
    selection: { anchor: line.from + split.head.length + 1 + split.caret },
    scrollIntoView: true,
  });
  return true;
};

/**
 * The space that turns `--` into a checkbox.
 *
 * 🔴 Bound to the key rather than watched for afterwards, so the conversion and the
 * space are **one transaction** — which makes it one undo step. Two steps would mean
 * `⌘Z` gives you back `-- ` and leaves you to press it again, and the row model's
 * version has that flaw because it reacts to `input` after the fact.
 */
const spaceCommand: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty || view.state.readOnly) return false;

  const line = view.state.doc.lineAt(range.head);

  const caret = range.head - line.from;
  const typed = `${line.text.slice(0, caret)} ${line.text.slice(caret)}`;
  const converted = applyShorthand(typed, caret + 1);
  // 🔴 The cheap test first. Almost every space in the document is an ordinary space, and
  // `inFence` scans the whole document — running it before this made every keystroke pay
  // for a check that matters on roughly one of them.
  if (!converted) return false;
  if (inFence(view.state, line.number)) return false;

  view.dispatch({
    changes: { from: line.from, to: line.to, insert: converted.text },
    selection: { anchor: line.from + converted.caret },
    annotations: Shorthanded.of(true),
    scrollIntoView: true,
  });
  return true;
};

/** `Backspace` immediately after a conversion puts the two dashes back. */
const backspaceCommand: Command = (view) => {
  if (!view.state.field(shorthandField) || view.state.readOnly) return false;

  const range = view.state.selection.main;
  if (!range.empty) return false;

  const line = view.state.doc.lineAt(range.head);
  const reverted = revertShorthand(line.text, range.head - line.from);
  if (!reverted) return false;

  view.dispatch({
    changes: { from: line.from, to: line.to, insert: reverted.text },
    selection: { anchor: line.from + reverted.caret },
  });
  return true;
};

/**
 * 🔴 `Mod-a` selects the **document**, and that is a deliberate reversal.
 *
 * ADR-006 listed "⌘A keeps meaning this row" among its reasons for rejecting a single
 * surface. That requirement was a description of the row model rather than a product
 * decision — each row was its own field, so ⌘A could not mean anything else. With one
 * document, every text editor a person has ever used selects all of it, and selecting
 * the whole page is the thing they came here for. Left to `standardKeymap`.
 */
const knagKeymap = [
  { key: "Enter", run: enterCommand },
  { key: " ", run: spaceCommand },
  { key: "Backspace", run: backspaceCommand },
];

// ── Theme ────────────────────────────────────────────────────────────────────

/**
 * 🔴 A CodeMirror theme, not a stylesheet rule, and this is not a style preference.
 *
 * CodeMirror emits its base theme under a generated class — `.<hash> .cm-content` — which
 * is two classes, so every plain `.cm-content` rule in `index.html` loses the cascade no
 * matter where it sits. During the spike that made the caret compute to `rgb(0, 0, 0)`:
 * black, on a near-black board, reported as invisible twice and correct both times.
 *
 * Colours come from the palette in `index.html` via `var(--token)`, so the two boards
 * still own them and no colour is introduced here.
 *
 * 🔴 No `::selection` rule. Overriding it paints over the native highlight and makes the
 * selection *fainter* than the platform's own — and the native iOS selection is what
 * carries the drag handles, which is the entire reason this surface is worth having.
 */
const theme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-body)",
    // 🔴 The token, not a literal — this is the surface the reading preference acts on
    // (#92), and the row list reads the same one so switching views does not resize the
    // page. The floor stays at 16px and lives in the token: below it iOS zooms the
    // viewport when a field takes focus and never zooms back, which is what got reported
    // as "klunky" during the spike.
    fontSize: "var(--size-row)",
    lineHeight: "var(--leading-row)",
  },
  ".cm-content": { padding: "0", caretColor: "var(--caret)" },
  // The row geometry, so switching surfaces does not move the text.
  ".cm-line": {
    padding: "var(--row-pad-y) var(--row-pad-right) var(--row-pad-y) var(--row-pad-left)",
  },
  ".cm-fence": { fontFamily: "var(--font-mono)", lineHeight: "1.5" },
  ".cm-done": { color: "var(--dim)", textDecoration: "line-through" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--caret)" },
});

// ── Mount ────────────────────────────────────────────────────────────────────

export function mountEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const start = splitEndings(options.initial);

  // 🔴 A Compartment, so going offline reconfigures one facet instead of rebuilding the
  // state. Rebuilding would discard the undo history on every connectivity blip, which is
  // the sort of thing nobody notices until a tunnel.
  const editable = new Compartment();

  /**
   * 🔴 **Both** facets, and the second one is the point.
   *
   * `EditorState.readOnly` rejects changes but leaves `contenteditable="true"`, so iOS
   * raises the keyboard, accepts taps, and silently swallows every keystroke — which is
   * the "looks live, discards everything" failure #57 exists to prevent, wearing a
   * different hat. `EditorView.editable` is what actually tells the platform.
   *
   * Selection survives either way, which is the half that must not be lost: offline has
   * to leave the page readable and copyable, not merely uneditable (spec §9).
   */
  const editState = (readOnly: boolean) => [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ];

  /**
   * The smallest single replacement turning `a` into `b`, or null if they match.
   *
   * 🔴 Not a nicety. `setBody` used to replace the whole document, and CodeMirror maps
   * the selection through whatever change it is given — so a full replace collapsed the
   * caret to position 0 on **every remote update**, which is exactly the bug #62 was
   * about and the thing this surface was supposed to be better at. A remote append now
   * leaves every position before it untouched, so the caret does not move because it did
   * not need to.
   *
   * A common-prefix/common-suffix trim, not a real diff: knag's remote updates are
   * someone appending or editing a line, and one contiguous replacement describes that
   * exactly. A word-level diff would buy nothing a caret can feel.
   */
  function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
    if (a === b) return null;
    const shortest = Math.min(a.length, b.length);
    let start = 0;
    while (start < shortest && a[start] === b[start]) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA -= 1;
      endB -= 1;
    }
    return { from: start, to: endA, insert: b.slice(start, endB) };
  }

  function bodyOf(state: EditorState): string {
    return joinEndings(state.doc.toString(), state.field(endingsField));
  }

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: start.text,
      extensions: [
        // 🔴 Load-bearing. By default CodeMirror also splits on "\r\n" and "\r" and
        // rejoins with "\n", which silently drops carriage returns. Pinning it is not on
        // its own enough — see `eol.ts` — but without it the wrapper is bypassed.
        EditorState.lineSeparator.of("\n"),
        endingsField.init(() => start.endings),
        editable.of(editState(false)),
        history(),
        shorthandField,
        wipeField,
        // 🔴 Before `standardKeymap`, which binds Enter and Backspace itself. A keymap
        // registered later loses; these have to see the key first and hand it back by
        // returning false when they have nothing to say.
        keymap.of(knagKeymap),
        keymap.of([...standardKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        theme,
        decorations,

        // ADR-003 §6. CodeMirror sets `spellcheck="false"` by default, so without this
        // autocorrect never fires and the product silently loses a decided behaviour.
        //
        // 🔴 `autocapitalize` is **inert on iOS here** and is kept as a declaration of
        // intent rather than a working setting (#114). Measured on device: it does not
        // fire in this surface even in prose after an explicit sentence boundary. It is
        // left in because it is correct, costs nothing, and a future WebKit may honour it
        // — not because it does anything today. `autocorrect` does work, and is the one
        // that matters: it is what a person actually notices while typing.
        EditorView.contentAttributes.of({
          autocorrect: "on",
          autocapitalize: "sentences",
          spellcheck: "true",
        }),

        // `setBody` is a remote update or a first load, not something to save back.
        EditorView.updateListener.of((update) => {
          if (update.focusChanged) options.onFocusChange(update.view.hasFocus);
          if (!update.docChanged) return;
          if (update.transactions.some((tr) => tr.annotation(SetEndings) !== undefined)) return;
          options.onChange(bodyOf(update.state));
        }),

        EditorView.domEventHandlers({
          // 🔴 Intercepted so pasted CRLF text never enters the document. CodeMirror
          // splits pasted text on the configured separator only, so a Windows clipboard
          // would leave a `\r` at the end of every line — as content, in the middle of
          // the document, exactly the corruption `eol.ts` exists to prevent.
          paste(event, target) {
            const text = event.clipboardData?.getData("text/plain");
            if (text === undefined || text === "" || !text.includes("\r")) return false;
            event.preventDefault();
            const { text: clean, endings } = splitEndings(text);
            const breaks = clean.split("\n").length - 1;
            const inserted = Array.from({ length: breaks }, (_, i) => endings.has(i));
            const range = target.state.selection.main;
            target.dispatch({
              changes: { from: range.from, to: range.to, insert: clean },
              selection: { anchor: range.from + clean.length },
              annotations: InsertedEndings.of([inserted]),
            });
            return true;
          },
        }),
      ],
    }),
  });

  return {
    body: () => bodyOf(view.state),

    setBody(next: string): void {
      const { text, endings } = splitEndings(next);
      const change = minimalChange(view.state.doc.toString(), text);
      if (!change) {
        // Same text, possibly different endings. Dispatching a no-op change would clear
        // the selection for nothing.
        view.dispatch({ annotations: SetEndings.of(endings) });
        return;
      }
      // 🔴 The smallest change, not a fresh state and not a whole-document replace.
      // CodeMirror maps the live selection through whatever it is handed, so the size of
      // the change decides whether the caret survives a remote update.
      view.dispatch({ changes: change, annotations: SetEndings.of(endings) });
    },

    setReadOnly(next: boolean): void {
      if (next === view.state.readOnly) return;
      view.dispatch({ effects: editable.reconfigure(editState(next)) });
    },

    animateWipe(lines: number[], timings: WipeTimings): Promise<void> {
      if (lines.length === 0) return Promise.resolve();

      const page = timings.page === true;
      view.dispatch({ effects: setWipe.of({ lines, closing: false, page }) });

      return new Promise((resolve) => {
        // Two stages, and the separation is the point — the lines go transparent in
        // place holding their height, and only then does one collapse close the gap.
        // Doing both at once makes the page jump under the thumb that just tapped.
        setTimeout(
          () => {
            view.dispatch({ effects: setWipe.of({ lines, closing: true, page }) });
            // 🔴 Resolves with the marks still applied — the board is empty and stays
            // empty until the caller repaints. `clearWipe` is what releases them, and it
            // is the caller's job precisely so the release and the repaint land in one
            // task. See `clearWipe` above for what clearing early looked like.
            setTimeout(resolve, timings.collapse);
          },
          timings.duration + (lines.length - 1) * timings.stagger,
        );
      });
    },

    clearWipe(): void {
      // Cheap to call unconditionally: an effect-only transaction on an already-empty
      // field changes nothing, and the alternative is every caller knowing whether a
      // wipe ran.
      view.dispatch({ effects: setWipe.of(null) });
    },

    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
