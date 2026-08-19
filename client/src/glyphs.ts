/**
 * The drawn glyphs.
 *
 * 🔴 Drawn, never typed. These used to be unicode characters set in DM Mono — `⠿ ⧉ × ⇅
 * ⚙ ↗` — and 0.5.0 replaced every one of them, because a glyph borrowed from a text face
 * is at the mercy of whatever the platform substitutes and does not match a design
 * bundle's line weight on any of them.
 *
 * Extracted from `app.ts` so the editing surface can use the same marks. Two copies of an
 * icon path is how two things that should look identical stop doing so.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export const GLYPH = {
  grip: '<circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/>',
  copy: '<rect x="6" y="2.75" width="7.25" height="9" rx="1.5"/><rect x="2.75" y="4.75" width="7.25" height="9" rx="1.5"/>',
  remove: '<path d="M4.2 4.2 L11.8 11.8"/><path d="M11.8 4.2 L4.2 11.8"/>',
  /** The tick, reused from the checkbox — copy confirms in the same mark that ticks. */
  done: '<path d="M3.6 8.4 L6.6 11.4 L12.4 4.8"/>',
  /** Copy failed. The same cross the delete control uses, which is the honest sign. */
  failed: '<path d="M4.2 4.2 L11.8 11.8"/><path d="M11.8 4.2 L4.2 11.8"/>',
  /**
   * Open a link — the one glyph the design bundle did not ship, drawn to the same
   * rules: an arrow leaving a corner, straight lines and nothing else.
   */
  open: '<path d="M5 11 L11 5"/><path d="M6.75 4.6 H11.4 V9.25"/>',
} as const;

/**
 * Build one.
 *
 * `innerHTML` is safe here and only here: every argument is a module constant above,
 * never a row's text. Row text is set with `textContent` and always will be — see
 * `linkify` in view.ts, which returns data rather than markup for the same reason.
 */
export function glyph(paths: string, size: number): SVGSVGElement {
  const filled = paths === GLYPH.grip;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", filled ? "none" : "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "square");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}
