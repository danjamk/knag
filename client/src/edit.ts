import { CHECKBOX, type Block, eolOf, parse, serialize } from "../../worker/src/blocks.js";
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

/**
 * A plain hyphen or asterisk bullet: indentation, one marker, one space.
 *
 * 🔴 This is a **text** block, not a parsed kind. `blocks.ts` has no bullet — and it
 * must not gain one. A bullet is a line that happens to start with `- `, and the
 * moment the parser knows better than that, the display stops matching the bytes
 * (ADR-004) and `*` starts wanting to be normalised to `-`.
 *
 * Deliberately not `1. ` or any other ordered form. Continuing a numbered list means
 * *renumbering* one, which is the first edit knag would make to a line the user did
 * not touch, and there is no version of that which preserves bytes.
 */
const BULLET = /^(\s*)([-*]) (?!\[[ xX]\] )/;

/**
 * `Enter` on a bullet continues it (#85).
 *
 * 🔴 This does not reopen ADR-003 §4, which says a bare `- ` is **not** a shorthand
 * trigger and stays a literal dash. That argument is about *rendering* — drawing a
 * bullet where the file says `-` would be the first place the display diverges from
 * the bytes, and it still would be.
 *
 * Continuing the list inserts two literal characters into the document. The file
 * really does gain `- `, it is visible in raw view, and backspace removes it like any
 * other text. It is the same thing checkbox continuation has always done.
 *
 * The marker is **copied, never normalised**: a `*` bullet continues as `*`, and the
 * indentation is carried across verbatim. Returns null for anything that is not a
 * bullet, including a checkbox — whose own prefix would otherwise match `- `.
 */
function bulletPrefix(text: string): string | null {
  const match = BULLET.exec(text);
  if (!match) return null;
  return `${match[1] ?? ""}${match[2] as string} `;
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
/**
 * What `Enter` does to one line, expressed on the raw line and nothing else.
 *
 * 🔴 **The single statement of the split policy.** `splitAt` adapts it for the row
 * model and the CodeMirror surface calls it directly, because the alternative is two
 * expressions of the same rules that agree until the day they do not — which is the
 * argument `blocks.ts` already settles for parsing, and it applies here for the same
 * reason.
 *
 * Offsets are into the **raw** line, marker included. That is the natural unit for one
 * editing surface, and the row model converts on the way in and out.
 */
export type LineSplit =
  /** One line becomes two. `caret` is an offset into `tail`. */
  | { kind: "split"; head: string; tail: string; caret: number }
  /** Enter on an empty marker: the line survives, the marker does not. */
  | { kind: "clear" };

/**
 * The `- [ ] ` a line starts with, or "" — the caret may never sit inside it.
 *
 * 🔴 Derived from what the grammar captured as *text*, never assumed to be six
 * characters. `CHECKBOX` separates with `\s`, so a tab is legal in both positions and
 * `indent.length + 6` is wrong for a line nobody would think to test.
 */
function checkPrefix(line: string): string {
  const match = CHECKBOX.exec(line);
  if (!match) return "";
  return line.slice(0, line.length - (match[4] ?? "").length);
}

export function splitLine(line: string, offset: number): LineSplit {
  const check = CHECKBOX.exec(line);

  if (check) {
    const prefix = checkPrefix(line);
    // Splitting a checkbox produces two checkboxes, unchecked: a line that has just
    // been typed is not already done.
    if (line.length === prefix.length) return { kind: "clear" };
    // 🔴 Clamped past the marker. The marker is an atomic widget, so the caret can sit
    // at the very start of the line — before the indent — and splitting *inside* six
    // characters that are drawn as one control is not a thing anyone asked for. At the
    // start you get an empty checkbox above and your text below, which is what the row
    // model did and what every list app does.
    const at = Math.max(offset, prefix.length);
    const indent = check[1] ?? "";
    const marker = check[2] ?? "-";
    const fresh = `${indent}${marker} [ ] `;
    return {
      kind: "split",
      head: line.slice(0, at),
      tail: fresh + line.slice(at),
      caret: fresh.length,
    };
  }

  const bullet = bulletPrefix(line);
  if (bullet !== null) {
    if (line === bullet) return { kind: "clear" };
    const at = Math.max(0, Math.min(offset, line.length));
    return {
      kind: "split",
      head: line.slice(0, at),
      // 🔴 The tail keeps what came after the caret **minus the prefix it is about to
      // be given again** — otherwise splitting `- milk and eggs` mid-line produces `- `
      // followed by ` and eggs` with the marker duplicated on a line that has one.
      tail: bullet + line.slice(at).replace(BULLET, ""),
      caret: bullet.length,
    };
  }

  const at = Math.max(0, Math.min(offset, line.length));
  return { kind: "split", head: line.slice(0, at), tail: line.slice(at), caret: 0 };
}

export function splitAt(body: string, index: number, offset: number): EditResult {
  const blocks = parse(body);
  const block = blocks[index];
  if (!block || block.kind === "fence") return unchanged(blocks, index, offset);

  // 🔴 The adapter, and all this function is now. Offsets in the row model are into
  // `displayText` — which strips a checkbox's marker — while the policy speaks in raw
  // lines. Converting here is what lets both surfaces share one statement of the rules.
  const raw = stripCR(block.raw);
  const prefix = raw.length - displayText(block).length;
  const split = splitLine(raw, Math.max(0, Math.min(offset, displayText(block).length)) + prefix);
  const eol = eolOf(block);

  if (split.kind === "clear") {
    // The line survives and the marker does not, so the caret has nowhere to go but 0.
    const next = blocks.map((b, i) => (i === index ? { ...b, raw: eol } : b));
    return { body: serialize(next), focusIndex: index, focusOffset: 0 };
  }

  const next = [
    ...blocks.slice(0, index),
    // 🔴 The line ending moves to the *second* half. A split turns one line into two and
    // the ending belonged to the end of the original, which is now the end of the tail.
    // Leaving it on the head produces `hello\r\n world` — a stray carriage return
    // mid-document that survives every round trip, because `raw` is honoured verbatim.
    { ...block, raw: split.head },
    // startLine/endLine are stale on both halves until the reparse. Nothing reads them
    // between here and there — `serialize` only touches `raw`.
    { ...block, raw: split.tail + eol },
    ...blocks.slice(index + 1),
  ];

  return {
    body: serialize(next),
    focusIndex: index + 1,
    // Back into `displayText` terms: past a checkbox's marker is offset 0, while a
    // bullet's marker is ordinary text and the caret really does sit after it.
    focusOffset: split.caret - checkPrefix(split.tail).length,
  };
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

// ── Checkbox shorthand (spec §7) ─────────────────────────────────────────────

/** `--` then a space, at the start of a line, with only indentation before it. */
const SHORTHAND = /^(\s*)-- /;
/** What that becomes, and what a revert has to recognise. */
const CONVERTED = /^(\s*)- \[ \] /;

export type Shorthand = { text: string; caret: number } | null;

/**
 * `--` + space becomes `- [ ] `.
 *
 * Converts **on the space**, which is what makes it feel like a shortcut rather than
 * a delayed transformation. That is only safe because `revertShorthand` undoes it on
 * an immediate `Backspace` — the standard autoformat contract, and the reason a
 * literal `--` is still typeable.
 *
 * Fires whether or not the line already has text after it, so an existing line can
 * be marked as a task by putting the caret at the start and typing `-- `. Returns
 * `null` when the caret is anywhere but immediately after that space, so typing `--`
 * mid-sentence is left alone.
 *
 * A single `- ` is deliberately not a trigger. It stays a literal dash — rendering
 * it as a bullet would be the first place the display differs from the bytes, and
 * principle 3 has held absolutely (ADR-003 §4).
 */
export function applyShorthand(text: string, caret: number): Shorthand {
  const match = SHORTHAND.exec(text);
  if (!match) return null;

  const indent = match[1] ?? "";
  // Only at the moment the space lands. Anywhere else and the user is editing text
  // that merely happens to begin with two dashes.
  if (caret !== indent.length + 3) return null;

  const rest = text.slice(indent.length + 3);
  return { text: `${indent}- [ ] ${rest}`, caret: indent.length + 6 };
}

/**
 * Undo a conversion, on the `Backspace` immediately following it.
 *
 * 🔴 Without this, `--` at the start of a line is untypeable — and a shortcut that
 * takes a character away from you is worse than no shortcut. The caller is
 * responsible for only calling it when the previous keystroke was the conversion;
 * this just performs the inverse.
 */
export function revertShorthand(text: string, caret: number): Shorthand {
  const match = CONVERTED.exec(text);
  if (!match) return null;

  const indent = match[1] ?? "";
  if (caret !== indent.length + 6) return null;

  const rest = text.slice(indent.length + 6);
  return { text: `${indent}-- ${rest}`, caret: indent.length + 3 };
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
