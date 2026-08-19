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

import { Annotation, Compartment, EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
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
  focus(): void;
  destroy(): void;
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
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-box";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "completed" : "not completed");

    // 🔴 `pointerdown`, not `click`. With the editor focused and the keyboard up, iOS
    // routes the first touch to caret placement and the synthesized click never reaches
    // the widget — so the box goes dead exactly while you are typing, which is the one
    // moment ADR-003's premise depends on it. Found on a phone, not by a test.
    input.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.readOnly) return;
      // Exactly one byte, between the brackets. `[X]` stays `[X]`.
      const next = this.checked ? " " : this.box === "X" ? "X" : "x";
      view.dispatch({ changes: { from: this.at, to: this.at + 1, insert: next } });
    });
    input.addEventListener("click", (event) => event.preventDefault());
    return input;
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
        // contenteditable, so the only route left is a per-line attribute. Confirmed
        // working on iOS: `const` typed inside a fence is not capitalised.
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
    // 🔴 16px literal, matching `textarea.text`, and not a token: below 16px iOS zooms
    // the viewport when a field takes focus and never zooms back. That zoom is what got
    // reported as "klunky" during the spike.
    fontSize: "16px",
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
        editable.of(EditorState.readOnly.of(false)),
        history(),
        keymap.of([...standardKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        theme,
        decorations,

        // ADR-003 §6. CodeMirror sets `spellcheck="false"` by default, so without this
        // autocorrect never fires and the product silently loses a decided behaviour.
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
      if (text === view.state.doc.toString()) {
        // Same text, possibly different endings. Dispatching a no-op change would clear
        // the selection for nothing.
        view.dispatch({ annotations: SetEndings.of(endings) });
        return;
      }
      // 🔴 A change rather than a fresh state: CodeMirror maps the live selection through
      // it, so a remote update arriving while the caret is in the document leaves the
      // caret where the text moved to. The row model had to capture an index and an
      // offset by hand and lost the caret whenever the row did not survive the repaint.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: SetEndings.of(endings),
      });
    },

    setReadOnly(next: boolean): void {
      view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(next)) });
    },

    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
