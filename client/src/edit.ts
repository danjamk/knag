import { CHECKBOX, isCompleted, parse } from "../../worker/src/blocks.js";

/**
 * The typing rules the platform does not know, as pure functions.
 *
 * 🔴 Pure, and that is the point. This began as the work spec §7 declined —
 * "backspace-merges-previous-row, arrow-up-at-boundary… the source of every cursor
 * bug" — and the only defence available without a browser was to make every decision a
 * function that takes state and returns state. No DOM here.
 *
 * 🔴 Most of it is gone (#113). Splitting rows, merging them, and stepping a caret across
 * a boundary were all in service of making a *row* behave like a *line*. One document in
 * one editing surface has real lines, and CodeMirror owns them.
 *
 * What survives is the part no platform knows: that Enter on a checkbox line continues
 * the list, that `-- ` becomes a checkbox, and that the keystroke straight after can take
 * it back. Those are knag's rules rather than a text editor's.
 */

// 🔴 `EditResult`, `splitAt`, `mergeBackward` and `neighbor` were deleted with the row
// list (#113). All four existed to make row boundaries behave like line boundaries: a
// split that repaints and hands back where the caret should land, a merge that folds a
// row into its neighbour, and a step across a boundary the platform did not know was one.
//
// On one document those *are* line boundaries and CodeMirror owns them. `splitLine` below
// survives because the editing surface calls it for the one rule the platform does not
// know — that Enter on a checkbox line continues the list.
//
// #84 and #88 were both bugs in `neighbor`'s callers. Neither has an equivalent now.

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



// ── Checkbox shorthand (spec §7) ─────────────────────────────────────────────

/**
 * `--` then a space, at the start of a line, with only indentation before it.
 *
 * 🔴 **An en dash and an em dash count too, and that is not a nicety** (#242). Autocorrect
 * is on in the editing surface on purpose (ADR-003 §6, restored in #112), and Apple's
 * autocorrect includes *smart dashes*, which rewrite two hyphens into `–` or `—` while
 * you type. So on the two platforms this product is mostly used on, the space arrives
 * after the hyphens are already gone and a literal `--` never reaches here. The shortcut
 * was broken from 1.0.0 until this was noticed from use, seven months of releases later.
 *
 * The alternative — turning autocorrect off — is the decision #112 went out of its way to
 * make, and it would cost every substitution a person wants while typing sentences to buy
 * back one shortcut. Matching what the platform actually produces is cheaper and truer.
 *
 * 🔴 **No browser test can cover this and none should be written to.** Text substitution
 * happens in the OS input stack, above WebKit; Playwright types characters straight into
 * the page, so the WebKit suite types a literal `--` forever. `client/test/edit.test.ts`
 * covers all three dashes as *units*, which is where the coverage belongs.
 */
const SHORTHAND = /^(\s*)(?:--|–|—) /;
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
  // 🔴 The width of what matched, not a constant. `-- ` is three characters and `— ` is
  // two, so a hardcoded offset silently stops matching the moment autocorrect has been
  // through the line — which is the whole of #242, one layer down.
  const typed = match[0].length;

  // Only at the moment the space lands. Anywhere else and the user is editing text
  // that merely happens to begin with a dash.
  if (caret !== typed) return null;

  const rest = text.slice(typed);
  return { text: `${indent}- [ ] ${rest}`, caret: indent.length + 6 };
}

/**
 * Undo a conversion, on the `Backspace` immediately following it.
 *
 * 🔴 Without this, `--` at the start of a line is untypeable — and a shortcut that
 * takes a character away from you is worse than no shortcut. The caller is
 * responsible for only calling it when the previous keystroke was the conversion;
 * this just performs the inverse.
 *
 * 🔴 **It reverts to `-- ` whatever was typed** (#242), including when autocorrect had
 * already turned it into `— `. What is being undone is the *shortcut*, not the
 * keystrokes: the person wanted two dashes and a space, which is what they get, and it
 * is what they would have had without smart dashes in the way. Reverting to an em dash
 * would hand back a character they never chose and then let autocorrect keep it.
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
 * The line numbers a wipe of this scope is about to remove, zero-based (#119).
 *
 * 🔴 Lines, not block indices, and the difference is the whole reason this exists. One
 * block renders as one `<li>` in the row list, so there the two are interchangeable —
 * but a `fence` block's `raw` spans several lines, and in one editing surface those are
 * several lines. Animating by block index there would fade the first line of a fenced
 * block and leave the rest sitting there until the repaint.
 *
 * It does not bite for `completed`, where `isCompleted` is a checked checkbox and always
 * one line. It bites for the whole-page wipe, where every block leaves.
 *
 * Nothing here decides *what* gets wiped — the server owns that, and this runs against
 * the same predicate purely for the picture. If the two ever disagree, the repaint from
 * the server's answer is what lands, so the worst case is a line that faded and came
 * back rather than one that vanished from the page without leaving the document.
 */
export function leavingLines(body: string, scope: "completed" | "all"): number[] {
  const lines: number[] = [];
  let line = 0;

  for (const block of parse(body)) {
    // `raw` is a verbatim slice, so counting its newlines is the same arithmetic the
    // serializer does in reverse — a fence of four lines advances the counter by four.
    const height = block.raw.split("\n").length;
    if (scope === "all" || isCompleted(block)) {
      for (let n = 0; n < height; n++) lines.push(line + n);
    }
    line += height;
  }

  return lines;
}
