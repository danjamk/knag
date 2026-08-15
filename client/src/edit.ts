import { type Block, eolOf, lineFor, parse, serialize } from "../../worker/src/blocks.js";
import { displayText, stripCR } from "./view.js";

/**
 * Typing operations over the block array — split, merge, and where the caret lands.
 *
 * 🔴 Pure, and that is the point. This is the work spec §7 originally declined —
 * "backspace-merges-previous-row, arrow-up-at-boundary… the source of every cursor
 * bug" — and the only defence available without a browser is to make every decision
 * a function that takes state and returns state. `app.ts` reads the caret, calls one
 * of these, and puts the caret where it says. No DOM here.
 *
 * Offsets are indices into `displayText(block)`, never into `block.raw`. On a
 * checkbox those differ by the `- [ ] ` prefix (ADR-003, spec §7).
 */

export type EditResult = {
  /** The whole document after the edit. Serialize it; do not diff it. */
  body: string;
  /** Which row should hold focus afterwards. */
  focusIndex: number;
  /** Where the caret goes inside that row's editor. */
  focusOffset: number;
};

/** Nothing changed. Returned rather than throwing, so callers stay branch-free. */
function unchanged(blocks: Block[], index: number, offset: number): EditResult {
  return { body: serialize(blocks), focusIndex: index, focusOffset: offset };
}

/** A new checkbox line at the same indent and marker, unchecked and empty of text. */
function newCheckboxLine(from: Block, text: string): string {
  return `${from.indent}${from.marker} [ ] ${text}`;
}

/**
 * `Enter` — split the row at the caret.
 *
 * Splitting a checkbox produces **two checkboxes**, because that is what every list
 * app does and what the shorthand exists to make cheap. The new one is unchecked: a
 * line that has just been typed is not already done.
 *
 * 🔴 `Enter` on an **empty** checkbox exits the list instead, converting the row to
 * a plain empty line. Without it there is no way to stop making checkboxes except
 * reaching for raw view — the exact mode-switch ADR-003 removed.
 *
 * Fences are never split here: they are a `<textarea>`, and `Enter` inside one
 * inserts a newline natively, which is the correct behaviour for a code block.
 */
export function splitAt(body: string, index: number, offset: number): EditResult {
  const blocks = parse(body);
  const block = blocks[index];
  if (!block || block.kind === "fence") return unchanged(blocks, index, offset);

  const text = displayText(block);
  const at = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);

  // Enter on an empty checkbox: stop making checkboxes.
  if (block.kind === "checkbox" && text.length === 0) {
    const next = blocks.map((b, i) => (i === index ? { ...b, raw: b.eol ?? "" } : b));
    return { body: serialize(next), focusIndex: index, focusOffset: 0 };
  }

  // 🔴 The line ending moves to the *second* half. A split turns one line into two,
  // and the ending belonged to the end of the original — which is now the end of the
  // tail. Leaving it on the head produces `hello\r\n world`, a stray carriage return
  // mid-document that survives every round trip because `raw` is honoured verbatim.
  const eol = eolOf(block);
  const head = { ...block, raw: lineFor(block, before) };
  const tailRaw = (block.kind === "checkbox" ? newCheckboxLine(block, after) : after) + eol;

  const next = [
    ...blocks.slice(0, index),
    head,
    // startLine/endLine are stale on both halves until the reparse. Nothing reads
    // them between here and there — `serialize` only touches `raw`.
    { ...block, raw: tailRaw },
    ...blocks.slice(index + 1),
  ];

  return { body: serialize(next), focusIndex: index + 1, focusOffset: 0 };
}

/**
 * `Backspace` at offset 0 — demote, then merge.
 *
 * 🔴 A checkbox **demotes to plain text first**, and only a second backspace merges
 * it upward. One keystroke that both strips a checkbox and joins two lines destroys
 * more structure than the user asked for, and this is the behaviour every list app
 * has trained them to expect.
 *
 * Merging into a fence is refused. Text joined onto a closing ``` would land *inside*
 * the code block, which is never what backspace meant — reorder mode's delete is the
 * way to remove a row next to a fence.
 */
export function mergeBackward(body: string, index: number): EditResult {
  const blocks = parse(body);
  const block = blocks[index];
  if (!block) return unchanged(blocks, index, 0);

  // A fence's own textarea handles backspace natively; never merge one upward.
  if (block.kind === "fence") return unchanged(blocks, index, 0);

  if (block.kind === "checkbox") {
    const demoted = blocks.map((b, i) =>
      i === index ? { ...b, raw: `${displayText(b)}${b.eol ?? ""}` } : b,
    );
    return { body: serialize(demoted), focusIndex: index, focusOffset: 0 };
  }

  if (index === 0) return unchanged(blocks, index, 0);

  const previous = blocks[index - 1] as Block;
  if (previous.kind === "fence") return unchanged(blocks, index, 0);

  // The previous line's ending is dropped and this line's kept — the two become one
  // line, and a line has one ending.
  const head = stripCR(previous.kind === "checkbox" ? previous.raw : previous.raw);
  const joined = head + block.raw;

  const next = [
    ...blocks.slice(0, index - 1),
    { ...previous, raw: joined },
    ...blocks.slice(index + 1),
  ];

  // The caret lands at the join, expressed in the merged row's display text — which
  // is shorter than `joined` when the previous row was a checkbox, because its
  // prefix is not in the editor.
  const merged = parse(serialize(next))[index - 1];
  const mergedText = merged ? displayText(merged) : "";
  const offset = Math.max(0, mergedText.length - displayText(block).length);

  return { body: serialize(next), focusIndex: index - 1, focusOffset: offset };
}

/**
 * `↑` / `↓` — the row to move to, and where the caret sits in it.
 *
 * Every row is focusable, blanks included. A blank line is a place you can type, and
 * skipping it would make the arrow keys disagree with what is on screen.
 */
export function neighbor(body: string, index: number, direction: -1 | 1, offset: number): EditResult {
  const blocks = parse(body);
  const target = index + direction;
  if (target < 0 || target >= blocks.length) return unchanged(blocks, index, offset);

  const text = displayText(blocks[target] as Block);
  return {
    body: serialize(blocks),
    focusIndex: target,
    // Column is preserved where the line is long enough, clamped to its end where it
    // is not — the same thing every text editor does.
    focusOffset: Math.min(offset, text.length),
  };
}
