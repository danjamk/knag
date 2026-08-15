import type { Block } from "../../worker/src/blocks.js";

/**
 * List-view presentation: what to draw, and which view to draw.
 *
 * 🔴 Pure. No DOM, no localStorage reached directly — storage is injected so the
 * Safari failure mode below is testable. `app.ts` performs the effects.
 */

export type Row = {
  /**
   * 🔴 Index into the **block array**, and by construction identical to the row's
   * own position — see `rows()`. Everything downstream toggles, reorders and clears
   * by this number, so if it ever stopped meaning "block N" the app would edit a
   * different line than the one tapped.
   */
  index: number;
  kind: Block["kind"];
  /** What to display. Never assigned as HTML — see `renderRows` in app.ts. */
  text: string;
  /** Checkbox rows only. */
  checked?: boolean;
  /** Whether tapping the text opens an inline editor. False for fences and blanks. */
  editable: boolean;
};

/**
 * One row per block, in order, always.
 *
 * 🔴 The mapping is the identity function on purpose. Filtering blank blocks out —
 * the obvious "tidier" version — makes a row's position stop matching its block
 * index, and every later feature indexes by position: tap row 4, toggle block 4.
 * With blanks skipped those are different lines and the app silently edits the wrong
 * one. Blanks render as thin spacers instead, which also keeps them draggable so
 * spacing survives a reorder (spec §14.1).
 *
 * This is the same failure the parser exists to prevent, one layer up: rows are not
 * lines, and rendered rows are not a subset of blocks.
 */
export function rows(blocks: Block[]): Row[] {
  return blocks.map((block, index) => ({
    index,
    kind: block.kind,
    // Checkbox rows show the task text; everything else shows its source verbatim.
    // The trailing `\r` of a CRLF document is stripped for display only — it is
    // invisible in an input but would be edited by accident, and `setText` puts the
    // block's own line ending back on commit.
    text: stripCR(block.kind === "checkbox" ? (block.text ?? "") : block.raw),
    ...(block.kind === "checkbox" ? { checked: block.checked === true } : {}),
    // Fences span lines, so a single-line editor would flatten them; blanks have
    // nothing to edit. Raw view is where both belong (spec §7).
    editable: block.kind === "checkbox" || block.kind === "text",
  }));
}

function stripCR(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

// ── View preference ──────────────────────────────────────────────────────────

export type ViewMode = "list" | "raw";

/** UI state, not document state — per device, never synced (spec §8). */
export const VIEW_KEY = "knag.view";

/** Just enough of `Storage` to read and write one key. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/**
 * The saved view, defaulting to list.
 *
 * 🔴 Wrapped because **`localStorage` throws, it does not return null**, when Safari
 * blocks storage — private browsing, or a home-screen PWA whose storage has been
 * evicted. An uncaught throw here happens during boot and takes the whole app down,
 * turning a preference lookup into a blank screen.
 */
export function readView(storage: KeyValueStore | undefined): ViewMode {
  try {
    return storage?.getItem(VIEW_KEY) === "raw" ? "raw" : "list";
  } catch {
    return "list";
  }
}

/** Best effort. A preference that cannot be saved is not worth failing an app over. */
export function writeView(storage: KeyValueStore | undefined, view: ViewMode): void {
  try {
    storage?.setItem(VIEW_KEY, view);
  } catch {
    // Ignored, deliberately. See readView.
  }
}
