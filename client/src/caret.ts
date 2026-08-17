/**
 * Where the caret actually is on screen, in pixels.
 *
 * 🔴 The only module in the client that measures rendered text, and it exists for one
 * reason: **a row wraps.** A `.text` row is a `<textarea rows="1">` precisely so a long
 * note can flow onto a second visual line (see `rowElement`), and a `.fence` holds
 * literal newlines as well. So "is the caret on the last line of this row" is a
 * question about layout, and no comparison of `selectionStart` against `value.length`
 * can answer it. Getting that wrong in either direction is visible:
 *
 *   too eager  → `↓` inside a wrapped row jumps to the next row, and a long line
 *                becomes unnavigable
 *   too shy    → `↓` is eaten by the browser, which moves the caret to the end of the
 *                text because a one-line textarea has nowhere below to go (#88)
 *
 * The same measurement answers the other half of #88: a preserved column across a
 * proportional face is a **pixel** x, not a character offset. `Math.min(offset,
 * length)` drifts on any two rows whose characters differ in width, and every
 * character in Familjen Grotesk differs in width.
 *
 * This is deliberately **not** in `edit.ts`, which is pure by contract. The split is
 * the same one ADR-003 relies on: decisions are functions of state, and the DOM is
 * read here and nowhere near them.
 */

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * Every computed property that decides where a glyph lands. A missing one does not
 * fail loudly — it silently shifts the mirror's wrap points away from the real
 * field's, and the caret lands a word early on long rows only.
 */
const MIRRORED = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
  "overflowWrap",
  "wordBreak",
] as const;

/**
 * One hidden node, reused. Creating it per measurement would be a style recalculation
 * and an insertion on every arrow press, and there is never more than one caret.
 */
let mirror: HTMLDivElement | null = null;

function mirrorFor(field: Field): HTMLDivElement {
  if (!mirror) {
    mirror = document.createElement("div");
    // Off-screen rather than `display: none` — a node with no box has no layout, and
    // layout is the entire output of this module.
    mirror.style.position = "absolute";
    mirror.style.top = "0";
    mirror.style.left = "-9999px";
    mirror.style.visibility = "hidden";
    mirror.setAttribute("aria-hidden", "true");
    document.body.append(mirror);
  }

  const computed = getComputedStyle(field);
  for (const property of MIRRORED) mirror.style[property] = computed[property];
  // A textarea wraps and honours newlines; an input does neither.
  mirror.style.whiteSpace = field instanceof HTMLTextAreaElement ? "pre-wrap" : "pre";
  return mirror;
}

/**
 * The caret's position within the field's box, in CSS pixels.
 *
 * 🔴 The text *after* the caret goes into the marker span rather than being dropped.
 * Wrapping depends on it: a word that does not fit moves to the next line whole, so
 * measuring `slice(0, offset)` alone reports a caret at the end of a line that the
 * real field has already broken.
 */
function pointAt(field: Field, offset: number): { x: number; y: number } {
  const box = mirrorFor(field);
  const value = field.value;

  box.textContent = value.slice(0, offset);
  const marker = document.createElement("span");
  // A span with no content has no box to read. The filler is never rendered anywhere
  // visible, and one character cannot change a wrap point that has already happened.
  marker.textContent = value.slice(offset) || ".";
  box.append(marker);

  return { x: marker.offsetLeft, y: marker.offsetTop };
}

/** The row's line box height, for deciding whether two carets share a visual line. */
function lineHeightOf(field: Field): number {
  const computed = getComputedStyle(field);
  const declared = Number.parseFloat(computed.lineHeight);
  // `line-height: normal` computes to the string "normal", not a length.
  if (Number.isFinite(declared)) return declared;
  return Number.parseFloat(computed.fontSize) * 1.2;
}

/** The caret's x, for carrying a column across a row boundary. */
export function caretX(field: Field, offset: number): number {
  return pointAt(field, offset).x;
}

/**
 * Whether the caret sits on the first and/or last **visual** line of the field.
 *
 * Both are true for a single-line row, which is the common case and the right answer:
 * one line is simultaneously the first and the last, so either arrow leaves the row.
 */
export function visualEdge(field: Field, offset: number): { first: boolean; last: boolean } {
  if (!(field instanceof HTMLTextAreaElement)) return { first: true, last: true };

  // Half a line, so a caret is compared against the band it is in rather than an
  // exact top that sub-pixel layout will not reproduce.
  const tolerance = lineHeightOf(field) / 2;
  const y = pointAt(field, offset).y;
  const top = pointAt(field, 0).y;
  const bottom = pointAt(field, field.value.length).y;

  return { first: y - top < tolerance, last: bottom - y < tolerance };
}

/**
 * The offset on `line` whose caret sits nearest `x`.
 *
 * 🔴 Bisected, not scanned. Both `y` and — within one visual line — `x` grow
 * monotonically with the offset, so each bound is reachable in log₂(n) measurements.
 * A linear scan would force a layout flush per character on every arrow press.
 */
export function offsetNearestX(field: Field, x: number, line: "first" | "last"): number {
  const length = field.value.length;
  if (length === 0) return 0;

  if (!(field instanceof HTMLTextAreaElement)) return nearestX(field, x, 0, length);

  const tolerance = lineHeightOf(field) / 2;
  const targetY = line === "first" ? pointAt(field, 0).y : pointAt(field, length).y;

  const low = line === "first" ? 0 : bandStart(field, targetY, tolerance, length);
  const high = line === "first" ? bandEnd(field, targetY, tolerance, length) : length;

  return nearestX(field, x, low, high);
}

/** Smallest offset whose caret has reached `targetY`'s band. */
function bandStart(field: Field, targetY: number, tolerance: number, length: number): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (pointAt(field, mid).y < targetY - tolerance) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Largest offset whose caret has not yet left `targetY`'s band. */
function bandEnd(field: Field, targetY: number, tolerance: number, length: number): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (pointAt(field, mid).y > targetY + tolerance) high = mid - 1;
    else low = mid;
  }
  return low;
}

/** The offset in `[low, high]` whose caret x is closest to `x`. */
function nearestX(field: Field, x: number, low: number, high: number): number {
  let lo = low;
  let hi = high;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pointAt(field, mid).x < x) lo = mid + 1;
    else hi = mid;
  }

  // `lo` is the first offset at or past `x`; the one before it can be closer, and on a
  // wide glyph usually is.
  if (lo > low) {
    const after = Math.abs(pointAt(field, lo).x - x);
    const before = Math.abs(pointAt(field, lo - 1).x - x);
    if (before <= after) return lo - 1;
  }
  return lo;
}
