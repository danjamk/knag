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
    text: displayText(block),
    ...(block.kind === "checkbox" ? { checked: block.checked === true } : {}),
    // Fences span lines, so a single-line editor would flatten them; blanks have
    // nothing to edit. Raw view is where both belong (spec §7).
    editable: block.kind === "checkbox" || block.kind === "text",
  }));
}

export function stripCR(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * What a row's editor contains — the task text for a checkbox, the source line for
 * anything else, minus the display-only carriage return.
 *
 * 🔴 Every caret offset in `edit.ts` is an index into *this* string, not into
 * `block.raw`. On a checkbox those differ by the length of the `- [ ] ` prefix, and
 * confusing them puts the caret six characters from where the user left it.
 */
export function displayText(block: Block): string {
  return stripCR(block.kind === "checkbox" ? (block.text ?? "") : block.raw);
}

// ── Reorder ──────────────────────────────────────────────────────────────────

/**
 * Move one block from `from` to `to`, returning a new array.
 *
 * 🔴 Operates on **blocks**, which is the whole point (spec §7). A fenced block is
 * one element here and moves as one unit; the line-array version of this scrambles a
 * code block on its first drag, splitting its opening fence from its body. Blank
 * blocks move too, so spacing goes where you put it rather than collapsing.
 *
 * Out-of-range indices return the array unchanged rather than throwing: the caller is
 * a drag library reporting DOM positions, and a repaint racing a drop should be a
 * no-op, not an exception in an event handler.
 */
export function move<T>(items: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return items;
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  if (from === to) return items;

  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/**
 * Drop one block, returning a new array.
 *
 * 🔴 Removes a **whole block**, so a fence goes with its body and its closing marker
 * rather than leaving an orphaned ``` behind. Same reason `move` works on blocks.
 *
 * Out-of-range is a no-op for the same reason as `move`: the caller is reacting to a
 * click on a row that a repaint may already have replaced.
 */
export function removeAt<T>(items: T[], index: number): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return items;
  return items.filter((_, i) => i !== index);
}

/**
 * Remove several blocks in one pass.
 *
 * 🔴 One pass, not a loop over `removeAt`. Removing index 2 and then index 5 removes
 * the wrong second row, because the first removal shifted everything after it — the
 * classic way a bulk delete eats a line nobody selected. Filtering against the whole
 * set reads every index against the original array.
 *
 * Out-of-range indices are ignored rather than throwing, for the same reason as
 * `removeAt`: the caller is reacting to a click on rows a repaint may already have
 * replaced. Returns the input untouched when nothing is in range, so a caller can
 * compare by identity.
 */
export function removeMany<T>(items: T[], indices: Iterable<number>): T[] {
  const drop = new Set<number>();
  for (const index of indices) {
    if (Number.isInteger(index) && index >= 0 && index < items.length) drop.add(index);
  }
  if (drop.size === 0) return items;
  return items.filter((_, i) => !drop.has(i));
}

// ── Linkify ──────────────────────────────────────────────────────────────────

export type Segment = { link: boolean; value: string };

/** `http`/`https` only. A bare `www.` or a `javascript:` URL is text, not a link. */
const URL_PATTERN = /https?:\/\/\S+/g;

/**
 * Trailing characters that are almost always sentence punctuation rather than part
 * of the address. Closing brackets are handled separately — they *can* be part of a
 * URL, so they only come off when nothing opened them.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/**
 * Split text into plain and link segments.
 *
 * 🔴 Returns data, never markup. The obvious implementation replaces matches with an
 * `<a>` string and assigns `innerHTML` — which makes every note an injection vector,
 * and this document is written by an agent as well as by a human. The caller builds
 * real nodes and sets `textContent` on each.
 *
 * 🔴 The segments must concatenate back to the input exactly. A linkifier that eats
 * a character, or trims one, corrupts what the row displays relative to what the
 * document holds. Asserted as a property over arbitrary text.
 */
export function linkify(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    let url = match[0];

    // "see https://example.com." — the period ends the sentence, not the address.
    url = url.replace(TRAILING_PUNCTUATION, "");
    // "(https://example.com)" — but keep the paren in a Wikipedia-style URL that
    // opened one itself.
    while (url.length > 0) {
      const last = url[url.length - 1] as string;
      const opener = last === ")" ? "(" : last === "]" ? "[" : null;
      if (!opener || url.includes(opener)) break;
      url = url.slice(0, -1);
    }

    if (url.length === 0) continue;

    if (start > cursor) segments.push({ link: false, value: text.slice(cursor, start) });
    segments.push({ link: true, value: url });
    cursor = start + url.length;
  }

  if (cursor < text.length) segments.push({ link: false, value: text.slice(cursor) });
  return segments;
}

// ── View preference ──────────────────────────────────────────────────────────

/**
 * 🔴 **`list` is gone (#113).** The row list was shipped *beside* the CodeMirror surface
 * rather than instead of it, because every defect this project has shipped was found by a
 * person on a phone rather than by the suite — so the replacement got used against the
 * real page first. It earned it, and a transition that does not end is two things to
 * maintain plus a mode question in Settings, which is what ADR-003 removed on evidence.
 *
 * 🔴 A value stored by an older build still says `list`, on any device that has not
 * opened knag since. `readView` resolves anything it does not recognise to `editor`, so
 * that migration is silent and needs no code of its own — which is why the check below is
 * against the list rather than a cast.
 *
 * `raw` survives for now as the escape hatch for a bulk paste. ADR-007's Consequences
 * argue it should go too, once one surface has settled; that is its own change.
 */
export type ViewMode = "editor" | "raw";

/** Everything a stored preference is allowed to be. Anything else falls back to editor. */
const VIEWS: readonly ViewMode[] = ["editor", "raw"];

/** UI state, not document state — per device, never synced (spec §8). */
export const VIEW_KEY = "knag.view";

/**
 * Reading size, in px, as a per-device preference (#92).
 *
 * 🔴 **Steps, and they start at 16.** 16px is a hard floor on anything editable: below it
 * iOS Safari zooms the viewport when a field takes focus and never zooms back. So this
 * scales *up* and cannot offer smaller — anyone wanting smaller text wants a smaller
 * device. Steps rather than a slider because a slider is a decision where a preference
 * will do.
 *
 * It moves `--size-row` only. The machine voice and every control hold at
 * `--size-control`, because someone raising this wants more room for the page, not a
 * louder footer.
 */
export type FontSize = 16 | 18 | 20;

/** Everything a stored preference is allowed to be. Anything else falls back to 16. */
const FONT_SIZES: readonly FontSize[] = [16, 18, 20];

/** UI state, not document state — per device, never synced (spec §8). */
export const FONT_SIZE_KEY = "knag.fontSize";

/** Just enough of `Storage` to read and write one key. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/**
 * The saved view, defaulting to the editing surface.
 *
 * 🔴 Wrapped because **`localStorage` throws, it does not return null**, when Safari
 * blocks storage — private browsing, or a home-screen PWA whose storage has been
 * evicted. An uncaught throw here happens during boot and takes the whole app down,
 * turning a preference lookup into a blank screen.
 */
export function readView(storage: KeyValueStore | undefined): ViewMode {
  try {
    const stored = storage?.getItem(VIEW_KEY);
    // 🔴 Checked against the list rather than trusted. A value written by a newer build
    // and read by an older one is a real case on a device that has been offline, and
    // `as ViewMode` would let it through to a `paint()` that has no branch for it.
    // 🔴 This is also the `list` migration. A device that last opened knag before #113
    // has `knag.view: "list"` in storage; it is not in the list any more, so it resolves
    // here to `editor` and the reader lands on the one surface without noticing.
    return VIEWS.find((view) => view === stored) ?? "editor";
  } catch {
    return "editor";
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

// ── Board (spec §9) ──────────────────────────────────────────────────────────

/**
 * The two surfaces, plus following the OS.
 *
 * 🔴 **`slate` and `whiteboard`, not `dark` and `light`.** They are not themes — they
 * are the two boards the product already had, finally told what they are: chalk on a
 * blackboard, and marker on dry-erase. A board does not ask you what kind of board it
 * is, which is also why there is no third one.
 *
 * Three options rather than a two-way switch: the MVP hard-coded dark, which is the
 * right *default* and the wrong *only* option — knag gets opened outdoors and in
 * meetings, unreadable in the first and conspicuous in the second.
 */
export type Theme = "system" | "whiteboard" | "slate";

export const THEME_KEY = "knag.theme";

const THEMES: Theme[] = ["system", "whiteboard", "slate"];

/**
 * What the key used to hold, before the boards were named.
 *
 * 🔴 Without this, everyone who had ever chosen a board gets silently reset to
 * `system` on the release that renames them — and on a device whose OS is set the
 * other way, that reads as the app changing colour by itself.
 */
const RENAMED: Record<string, Theme> = { light: "whiteboard", dark: "slate" };

/** Same catch as `readView` — Safari *throws* when storage is blocked. */
export function readTheme(storage: KeyValueStore | undefined): Theme {
  try {
    const saved = storage?.getItem(THEME_KEY) ?? "";
    if (THEMES.includes(saved as Theme)) return saved as Theme;
    return RENAMED[saved] ?? "system";
  } catch {
    return "system";
  }
}

export function writeTheme(storage: KeyValueStore | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    // Ignored, deliberately. See readView.
  }
}

/** Cycles system → whiteboard → slate → system, so one control covers all three. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] as Theme;
}

/**
 * The board actually in effect, for the `theme-color` meta tag.
 *
 * 🔴 iOS paints the status bar from that tag. Leaving it slate under whiteboard puts
 * a black strip above a pale app, which reads as a rendering bug rather than a
 * preference.
 *
 * The two values are `--board` on each side, and they are the one place a token is
 * duplicated outside the stylesheet — a `<meta>` tag cannot read a custom property.
 * Pinned by a test that reads the hexes back out of the shell.
 */
export const BOARD_SLATE = "#11150F";
export const BOARD_WHITEBOARD = "#EDF1F3";

export function themeColor(theme: Theme, systemPrefersDark: boolean): string {
  const slate = theme === "slate" || (theme === "system" && systemPrefersDark);
  return slate ? BOARD_SLATE : BOARD_WHITEBOARD;
}


/**
 * The saved reading size, defaulting to the 16px floor.
 *
 * Validated against the list rather than parsed and trusted: a number from a newer build,
 * or anything at all from a corrupted value, must not become a `--size-row` below the
 * floor. Same `try`/`catch` as `readView` — Safari **throws** rather than returning null
 * when storage is blocked, and this runs during boot.
 */
export function readFontSize(storage: KeyValueStore | undefined): FontSize {
  try {
    const stored = Number(storage?.getItem(FONT_SIZE_KEY));
    return FONT_SIZES.find((size) => size === stored) ?? 16;
  } catch {
    return 16;
  }
}

/** Best effort. A preference that cannot be saved is not worth failing an app over. */
export function writeFontSize(storage: KeyValueStore | undefined, size: FontSize): void {
  try {
    storage?.setItem(FONT_SIZE_KEY, String(size));
  } catch {
    // Ignored, deliberately. See readFontSize.
  }
}

/** UI state, not document state — per device, never synced (spec §8). */
export const SOUND_KEY = "knag.sound";

/**
 * Whether the wipe makes a sound.
 *
 * 🔴 **Off unless the answer is exactly `on`.** Every other preference here falls back to
 * a sensible default; this one falls back to silence, and the asymmetry is deliberate. A
 * corrupt value, a half-written key or a storage that throws should never be the reason a
 * phone makes a noise in a meeting. Opting in has to be something the person did.
 */
export function readSound(storage: KeyValueStore | undefined): boolean {
  try {
    return storage?.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

/** Best effort. A preference that cannot be saved is not worth failing an app over. */
export function writeSound(storage: KeyValueStore | undefined, on: boolean): void {
  try {
    storage?.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    // Ignored, deliberately. See readSound.
  }
}

/**
 * Which page this device is looking at (#154).
 *
 * 🔴 **Device state, never document state, and that is the whole reason `launch opens the
 * last page you were on` is implementable at all.** The server has no current page — it is
 * one of the two things the MCP `page` parameter exists to avoid (#153) — so the answer
 * lives here, per device, and the phone and the laptop can sit on different pages without
 * either being wrong.
 *
 * Returns `null` for anything unparseable, and the caller falls back to the default page.
 * A stored id is a *hint*: the page may have been deleted from another device since, so
 * nothing downstream may treat this as proof the page exists.
 */
export const PAGE_KEY = "knag.page";

export function readPageId(storage: KeyValueStore | undefined): number | null {
  try {
    const raw = storage?.getItem(PAGE_KEY);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isInteger(id) && id >= 1 ? id : null;
  } catch {
    return null;
  }
}

/** Best effort. A device that cannot remember its page opens the default one. */
export function writePageId(storage: KeyValueStore | undefined, id: number): void {
  try {
    storage?.setItem(PAGE_KEY, String(id));
  } catch {
    // Ignored, deliberately. See readPageId.
  }
}
