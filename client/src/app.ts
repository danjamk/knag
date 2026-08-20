/**
 * knag — the PWA.
 *
 * Raw view: one full-bleed textarea holding the entire document, saved on a debounce.
 * The list view (issue #9) renders blocks on top of the same document and the same
 * save path; raw view stays as the escape hatch for everything it cannot express —
 * sweeps, paste, bulk reordering, multi-line editing.
 *
 * 🔴 Byte-for-byte or it is broken. No trimming, no whitespace normalization, no
 * line-ending rewriting. `textarea.value` is handed to the API exactly as read and
 * written back exactly as received. This is principle 3 of the product, and a
 * textarea is the one place in the stack that will silently mangle input if you let
 * it — see `wrap="off"` in the shell and the absence of any `.trim()` here.
 *
 * 🔴 The reason this file is TypeScript and gets bundled: it will import
 * `worker/src/blocks.ts` — the same module the Worker uses for clear-completed. One
 * parser, not two. See spec §2.
 */

import {
  type Block,
  isCompleted,
  parse,
  serialize,
  setText,
  toggle,
} from "../../worker/src/blocks.js";
import { caretX, offsetNearestX, visualEdge } from "./caret.js";
import { safeNext } from "./nav.js";
import { offerExpiresAt, restoredBody } from "./restore.js";
import {
  type Connectivity,
  type EditableState,
  RECONNECT_PROBE_MS,
  connectivityAfter,
  connectivityStatus,
  dispositionFor,
  initialConnectivity,
  pollInterval,
  rowIsEditable,
} from "./sync.js";
import Sortable from "sortablejs";
import { GLYPH, glyph } from "./glyphs.js";
import { type EditorHandle, mountEditor } from "./editor.js";
import {
  type EditResult,
  applyShorthand,
  leavingLines,
  mergeBackward,
  neighbor,
  revertShorthand,
  splitAt,
} from "./edit.js";
import {
  type FontSize,
  type Theme,
  type ViewMode,
  linkify,
  move,
  readFontSize,
  readTheme,
  readView,
  removeMany,
  rows,
  themeColor,
  writeFontSize,
  writeTheme,
  writeView,
} from "./view.js";

type Doc = { body: string; version: number; updated_at: string };

const SAVE_DEBOUNCE_MS = 800;

const loginForm = document.querySelector<HTMLFormElement>("[data-login]");
const loginError = document.querySelector<HTMLElement>("[data-error]");
const editorView = document.querySelector<HTMLElement>("[data-editor]");
const editor = document.querySelector<HTMLTextAreaElement>("[data-body]");
const statusEl = document.querySelector<HTMLElement>("[data-save-status]");
const settingsDialog = document.querySelector<HTMLDialogElement>("[data-settings]");
const settingsOpen = document.querySelector<HTMLButtonElement>("[data-settings-open]");
const copyPageButton = document.querySelector<HTMLButtonElement>("[data-copy-page]");
const footerEl = document.querySelector<HTMLElement>("footer");
const ledgeEl = document.querySelector<HTMLElement>("[data-ledge]");
const ledgeToggle = document.querySelector<HTMLButtonElement>("[data-ledge-toggle]");
const sessionsList = document.querySelector<HTMLUListElement>("[data-sessions]");
const logoutButton = document.querySelector<HTMLButtonElement>("[data-logout]");
const revokeOthersButton = document.querySelector<HTMLButtonElement>("[data-revoke-others]");
const clearCountEl = document.querySelector<HTMLElement>("[data-clear-count]");
const rowsEl = document.querySelector<HTMLUListElement>("[data-rows]");
const surfaceEl = document.querySelector<HTMLElement>("[data-surface]");
const clearButton = document.querySelector<HTMLButtonElement>("[data-clear]");
const wipeAllButton = document.querySelector<HTMLButtonElement>("[data-wipe-all]");
const restoreButton = document.querySelector<HTMLButtonElement>("[data-restore]");
const reorderButton = document.querySelector<HTMLButtonElement>("[data-reorder]");
const recoveryLine = document.querySelector<HTMLElement>("[data-recovery]");
const recoveryCountEl = document.querySelector<HTMLElement>("[data-recovery-count]");
const envBadge = document.querySelector<HTMLElement>("[data-env]");

/** Which rows a wipe takes. Mirrors `WipeScope` in the Worker's store. */
type WipeScope = "completed" | "all";

/**
 * The current document body, as bytes.
 *
 * 🔴 The single source of truth for both views. The textarea holds it in raw view and
 * the row list is derived from it in list view — but neither is authoritative, or the
 * two would drift and a view switch would save whichever one happened to be stale.
 */
let body = "";
let view: ViewMode = "list";

/**
 * Typing or rearranging. **Never persisted** — unlike the view preference, this is
 * something you are doing right now, not something you prefer. Landing in reorder
 * mode after a reload would be the mode problem ADR-003 removed, reintroduced.
 */
let reordering = false;

/**
 * Rows picked in Arrange, by block index.
 *
 * 🔴 UI state, never document state, and never persisted — the same rule as the mode
 * itself (ADR-003 §5). It is cleared entering and leaving Arrange, and on any edit that
 * moves indices, because a picked index means nothing once the rows underneath it have
 * shifted. `paintRows` prunes out-of-range as a backstop for a remote change arriving
 * mid-selection.
 *
 * Called `picked` rather than `selected` on purpose: `--selection` and `::selection`
 * already mean the text selection inside a row, which is a different thing entirely and
 * the thing ADR-006 decided not to build.
 */
const picked = new Set<number>();

/** The display text of every picked row, in document order. */
function pickedText(): string {
  return rows(parse(body))
    .filter((row) => picked.has(row.index))
    .map((row) => row.text)
    .join("\n");
}

/** Persisted, unlike the mode — this is a preference, not something you are doing. */
let theme: Theme = "system";

/** Reading size for the page text only, per device (#92). Never part of the document. */
let fontSize: FontSize = 16;

/** The version we believe we are editing. Every write carries it (spec §6). */
let baseVersion = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** True between an edit and its save landing. Half of the dirty guard. */
let dirty = false;
/** The other half. Focus alone blocks a remote update — see `mayApplyRemote`. */
let focused = false;

let pollTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Last local activity: an edit, a load, or the window regaining focus.
 *
 * 🔴 Initialised to "now" at boot rather than to -Infinity. Opening the document is
 * an act of attention, and a freshly loaded tab with no edits would otherwise land in
 * the 60s tier and look broken next to a device you *are* typing on.
 */
let lastActivityAt = Date.now();

/**
 * A remote update that arrived while the editor was dirty or focused.
 *
 * 🔴 Held, not dropped and not applied. Dropping it means the device silently stops
 * converging; applying it means the caret jumps mid-keystroke (spec §6).
 */
let pendingRemote: Doc | null = null;

// ── Connectivity (#57, spec §9) ───────────────────────────────────────────────

let connectivity: Connectivity = initialConnectivity(navigator.onLine);

/**
 * The row that had focus when the network went away, so it can finish the sentence it
 * was mid-way through. Cleared on reconnect, and on blur.
 */
let typingInto: number | null = null;

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function editableState(): EditableState {
  return { connectivity, typingInto };
}

/**
 * The last status the app wanted to show, so it can be put back on reconnect rather
 * than leaving `offline` on screen after the connection returns.
 */
let lastStatus = "—";

/**
 * Paint the machine slot.
 *
 * 🔴 Lowercase, deadpan, no terminal punctuation — `saved`, not `Saved ✓`. The status
 * line is the machine speaking, and the two-voice rule says the machine speaks in DM
 * Mono and amber while everything the *human* wrote stays chalk. `saved` is the one
 * resting state and sits back in `--dim`; anything else is the machine having
 * something to say, and says it in amber.
 *
 * That includes `not saved`, which used to be red. There is no red: amber is the only
 * colour in the interface and a third one means something went wrong.
 */
function showStatus(text: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.toggleAttribute("data-rest", text === "saved");
}

function setStatus(text: string): void {
  lastStatus = text;
  if (connectivity === "online") showStatus(text);
}

function paintConnectivity(): void {
  const offline = connectivityStatus({ connectivity, unsavedRows: dirty ? 1 : 0 });
  showStatus(offline ?? lastStatus);
}

/**
 * Record what a request told us about the network, and react when it changes.
 *
 * 🔴 Called with `responded: true` for **any** HTTP status. A 401 or a 409 travelled;
 * treating them as disconnection would refuse edits to someone on a working connection
 * whose session merely expired.
 */
function noteConnectivity(responded: boolean): void {
  const next = connectivityAfter({ responded });
  if (next === connectivity) return;

  connectivity = next;

  if (next === "offline") {
    // Whatever row is being typed into keeps working; everything else freezes. Read
    // from the DOM rather than tracked separately, so it is the truth at the moment
    // the drop was noticed rather than a stale guess.
    typingInto = focusedRowIndex();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void probeConnection(), RECONNECT_PROBE_MS);
  } else {
    typingInto = null;
    clearTimeout(reconnectTimer);
    // Back to a live page with no reload: repaint so rows become editable again, and
    // pick the poll back up from wherever the tier logic says.
    void pollNow();
    schedulePoll();
    if (dirty) void save();
  }

  // 🔴 `paint`, not `paintRows`. This repainted the row list and nothing else, so the
  // editing surface never learned the connection had dropped and went on accepting
  // typing that could not be saved — which is precisely the "looks live, discards
  // everything" failure #57 exists to prevent, reintroduced on a new surface.
  paint();
  paintConnectivity();
}

/**
 * Ask whether the network is back.
 *
 * `/health` rather than `/api/doc`: it is unauthenticated, so a flaky connection cannot
 * bounce someone to the login screen, and it says nothing about the document.
 */
async function probeConnection(): Promise<void> {
  try {
    await fetch("/health", { cache: "no-store" });
    noteConnectivity(true);
  } catch {
    reconnectTimer = setTimeout(() => void probeConnection(), RECONNECT_PROBE_MS);
  }
}

/** The `data-index` of the row holding focus, or null. */
function focusedRowIndex(): number | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const li = active.closest<HTMLElement>("li[data-index]");
  return li ? Number(li.dataset.index) : null;
}

function showEditor(authed: boolean): void {
  loginForm?.toggleAttribute("hidden", authed);
  editorView?.toggleAttribute("hidden", !authed);
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Returns null when unauthenticated, so the caller shows the login screen. */
async function load(): Promise<Doc | null> {
  let res: Response;
  try {
    res = await fetch("/api/doc", { headers: { Accept: "application/json" } });
  } catch (error) {
    // A thrown fetch is the network, not the server. Recorded before rethrowing so the
    // caller's own error path still runs.
    noteConnectivity(false);
    throw error;
  }
  noteConnectivity(true);

  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return (await res.json()) as Doc;
}

function render(doc: Doc): void {
  // Assigned verbatim. An empty body is a valid document and renders as an empty
  // editor — never an error, never a placeholder that could be saved back over it
  // (spec §14.5).
  body = doc.body;
  baseVersion = doc.version;
  dirty = false;
  pendingRemote = null;
  paint();
  setStatus("saved");
}

// ── Rendering (spec §7) ──────────────────────────────────────────────────────

/** Draw whichever view is active from `body`. Never the other way round. */
/**
 * The CodeMirror surface, mounted only while it is the active view (#110).
 *
 * 🔴 Mounted and destroyed rather than hidden, and Arrange destroys it too. Two live
 * editing surfaces over one document is the failure this whole design exists to avoid,
 * and "hidden" is not "not editing" — a hidden contenteditable still holds a selection
 * and still answers `beforeinput`.
 */
let surface: EditorHandle | null = null;

function mountSurface(): void {
  if (surface || !surfaceEl) return;
  surface = mountEditor(surfaceEl, {
    initial: body,
    onChange(next) {
      // The same three lines `syncFromRow` runs, for the same reason: the surface
      // already shows what was typed, so nothing repaints and the caret stays put.
      if (next === body) return;
      body = next;
      refreshClearButton();
      scheduleSave();
    },
    onFocusChange(next) {
      focused = next;
      // Blur is where a held remote update gets applied, exactly as the row path does.
      if (!next && pendingRemote) {
        const doc = pendingRemote;
        pendingRemote = null;
        render(doc);
        setStatus("updated elsewhere");
      }
    },
  });
}

function unmountSurface(): void {
  surface?.destroy();
  surface = null;
  surfaceEl?.replaceChildren();
  // Focus left with the element. A stale `true` here blocks every future remote update,
  // which is the bug `applyRemote` exists to fix.
  focused = false;
}

function paint(): void {
  if (editor) editor.value = body;

  // 🔴 Arrange always renders as rows, whichever surface you came from. That is the whole
  // reason the editor replacement does not cost the sort mode: the two renderings never
  // share an element, each builds itself from the document string and hands one back
  // (#110). In Arrange the editor is destroyed, not hidden.
  const arranging = reordering && view !== "raw";
  const rowsVisible = arranging || view === "list";

  editor?.toggleAttribute("hidden", view !== "raw");
  rowsEl?.toggleAttribute("hidden", !rowsVisible);
  surfaceEl?.toggleAttribute("hidden", !(view === "editor" && !arranging));

  // Rearranging is a whole-row operation, so it is offered from both editing surfaces
  // and from neither raw view nor a page nobody can edit.
  reorderButton?.toggleAttribute("hidden", view === "raw");

  if (view === "editor" && !arranging) {
    // 🔴 Cleared, not left hidden. Stale rows in a hidden list are invisible to a person
    // and perfectly visible to `querySelectorAll` — which made a test assert "Arrange
    // rendered 7 rows" while Arrange had not run at all.
    rowsEl?.replaceChildren();
    mountSurface();
    surface?.setBody(body);
    // 🔴 Not `rowIsEditable`. Offline, the row model keeps editable exactly the row you
    // were mid-sentence in and freezes the rest; one surface cannot make that
    // distinction, so offline freezes all of it. `readOnly`, never `disabled` — the page
    // stays readable, scrollable and copyable while it refuses edits (spec §9).
    surface?.setReadOnly(connectivity !== "online");
    refreshClearButton();
    return;
  }

  unmountSurface();

  if (rowsVisible) {
    paintRows();
    return;
  }

  // Raw view is the escape hatch for bulk edits; sweeping or rearranging from it
  // would act on a document the reader is mid-way through rewriting by hand.
  clearButton?.toggleAttribute("hidden", true);
  if (reordering) setReordering(false);
}

function paintRows(): void {
  if (!rowsEl) return;
  const blocks = parse(body);
  // A row that no longer exists cannot stay picked. This is the backstop for a remote
  // change arriving mid-selection; the mode and every structural edit clear the set.
  for (const index of picked) if (index >= blocks.length) picked.delete(index);
  rowsEl.replaceChildren(...rows(blocks).map(rowElement));

  // After they are in the document: `scrollHeight` is 0 on a detached element, so
  // sizing at construction time silently collapses every row to one line.
  for (const area of rowsEl.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    autoGrow(area);
  }

  refreshClearButton();
}

/**
 * Size a row to its wrapped content.
 *
 * The two-step — reset to `auto`, then read `scrollHeight` — is what lets a row
 * *shrink* again. Reading `scrollHeight` against the current height only ever grows,
 * so deleting a wrapped line would leave the row permanently tall.
 *
 * 🔴 A **hidden** element reports `scrollHeight: 0`, and writing that back clips the
 * row to nothing — which looks exactly like the text failing to render rather than
 * like a sizing bug. Being *in* the document is not the same as being *rendered*,
 * and the first version of this only guarded the former.
 *
 * The callers now paint into a visible container, so this guard is the second line
 * of defence: if a future path ever paints while hidden, rows fall back to one line
 * instead of vanishing.
 */
function autoGrow(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  if (area.scrollHeight > 0) area.style.height = `${area.scrollHeight}px`;
}

/**
 * Hidden rather than disabled when there is nothing to sweep: a permanently greyed
 * destructive button is clutter, and its absence is the clearer signal.
 *
 * Separate from `paintRows` so typing can update the count without rebuilding rows
 * and resetting the caret.
 */
function refreshClearButton(): void {
  const completed = parse(body).filter(isCompleted).length;
  // 🔴 `view === "raw"`, not `view !== "list"` (#119). Raw view is the escape hatch for a
  // bulk paste and sweeping from it would act on a document being rewritten by hand — but
  // the editing surface is an editing surface, and this condition predates it, so the
  // control was simply absent there. The reorder button below was updated for #110 and
  // this was missed, which is why the wipe appeared not to animate in the new surface:
  // the only way to reach one was the whole-page control in Settings.
  clearButton?.toggleAttribute("hidden", completed === 0 || view === "raw");
  // Only the count changes — rewriting the button's whole text would drop the label.
  if (clearCountEl) clearCountEl.textContent = String(completed);

  // The empty page says nothing at all: no hint, no illustration, no "add your first
  // item". A blank board is the feature, and the only thing on it is the cursor —
  // which is drawn by CSS off this attribute, and goes the moment the row takes focus.
  rowsEl?.toggleAttribute("data-empty", body === "" && view === "list");

  // The whole-page control carries its own count and sits behind a dialog that may
  // already be open while the page changes underneath it.
  paintWipeAll();
}

/**
 * `⠿`, the drag initiator — **only rendered in reorder mode**.
 *
 * 🔴 It used to be always visible. With every row now a live input, a permanent drag
 * handle competes for the same touch as a text field, which is worse than competing
 * with a tap target (ADR-003 §5).
 */
function gripElement(): HTMLSpanElement {
  const grip = document.createElement("span");
  grip.className = "grip";
  grip.append(glyph(GLYPH.grip, 20));
  return grip;
}

// ── Glyphs ───────────────────────────────────────────────────────────────────

/**
 * One family: a 16-unit grid, 1.5 stroke, square caps, no curves except the checkbox
 * radii. Rectangles and straight lines, because the only drawn shape this brand owns
 * is a rectangle.
 *
 * 🔴 **Inline SVG, not unicode.** These used to be `⠿ ⧉ × ↗` set in DM Mono — and DM
 * Mono has a codepoint for none of them. Every one was already rendering from a
 * platform fallback: a different face per OS, at a different optical weight, inside a
 * system with exactly two typefaces in it. Drawing them is what makes the one-family
 * rule true rather than merely stated.
 *
 * The drawings sit larger than the targets holding them — 17px inside a 28px row
 * control, 20px for the Arrange grip. No target changed, so the four-targets-at-380px
 * geometry is untouched; the glyph inside it stopped being timid.
 */

/**
 * Delete a whole block. Reorder mode only.
 *
 * 🔴 Lives here rather than in the editor because with live inputs `Backspace`
 * already handles *joining* lines, while nothing offers a gesture for removing a
 * whole fence or a blank.
 *
 * **No confirm.** The revision log is the undo — principle 4 finally paying for
 * itself, and the reason #7 had to land before this could.
 */
function removeElement(index: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "remove";
  // Dim, not red. Amber is the only colour in the interface, and this control is not
  // the machine speaking \u2014 a second destructive colour would be the third colour that
  // means something has gone wrong.
  button.append(glyph(GLYPH.remove, 17));
  button.title = "delete this line";
  button.dataset.remove = String(index);
  return button;
}

/**
 * Always visible, never on hover — there is no hover on touch (spec §7).
 *
 * Copies what the row displays: a checkbox row without its `- [ ] ` prefix, a fenced
 * block whole. That is `row.text` in both cases, because `rows()` already made that
 * distinction for rendering.
 */
function copyElement(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.append(glyph(GLYPH.copy, 17));
  button.title = "copy";
  button.dataset.copy = text;
  return button;
}

function rowElement(row: ReturnType<typeof rows>[number]): HTMLLIElement {
  const li = document.createElement("li");
  li.className = row.kind;
  li.dataset.index = String(row.index);
  if (reordering && picked.has(row.index)) li.classList.add("picked");

  if (reordering) li.append(gripElement());

  // 🔴 A fence is a textarea, not a <pre>. It is one block and inherently
  // multi-line, so it gets the element that is natively multi-line — and that is
  // what removes the last thing raw view was *required* for (ADR-003 §2).
  if (row.kind === "fence") {
    const area = document.createElement("textarea");
    area.className = "fence";
    area.value = row.text;
    area.rows = Math.min(row.text.split("\n").length, 20);
    // Off inside a fence, always. Autocapitalize turning `const` into `Const` is the
    // one real risk the MVP's blanket "off everywhere" was guarding against.
    area.spellcheck = false;
    area.autocapitalize = "off";
    area.setAttribute("autocorrect", "off");
    area.readOnly = !rowIsEditable(row.index, editableState());
    li.append(area);
    if (reordering) li.append(copyElement(row.text), removeElement(row.index));
    return li;
  }

  if (row.kind === "checkbox") {
    if (row.checked) li.classList.add("checked");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = row.checked === true;
    // Ticking a box is an edit like any other, so it is refused offline too — and
    // `disabled` rather than `readOnly`, which a checkbox does not honour.
    box.disabled = !rowIsEditable(row.index, editableState());
    // Checked items stay where they are. No auto-sink (spec §7).
    li.append(box);
  }

  // 🔴 A live editor, not a span you tap to activate. This is the whole point of
  // ADR-003: the editor is where you land, and typing is the primary interaction.
  //
  // 🔴 A `<textarea>`, not an `<input>`. An input is single-line by construction and
  // cannot wrap at any price, so a long note truncated to `buy milk and also…` with
  // no way to read it. One row still means one block — Enter is intercepted and
  // splits (see the keydown handler); only a *fence* textarea takes a literal
  // newline. The textarea is here purely so the text can wrap.
  const input = document.createElement("textarea");
  input.rows = 1;
  input.className = "text";
  input.value = row.text;
  // On for prose, off inside fences above. Autocorrect is the user typing, mediated
  // by their keyboard — not knag rewriting bytes (ADR-003 §6).
  input.spellcheck = true;
  input.autocapitalize = "sentences";
  input.setAttribute("autocorrect", "on");
  // 🔴 `readOnly`, not `disabled`. A disabled textarea cannot be focused, scrolled or
  // selected — so going offline would make the document unreadable as well as
  // uneditable, and you could not even copy a line out of it to somewhere that works.
  input.readOnly = !rowIsEditable(row.index, editableState());
  li.append(input);

  // 🔴 A link affordance rather than an inline anchor. An <input> cannot contain
  // one, and the alternatives are contenteditable (which the row model does not use —
  // the editing surface does, per ADR-007) or swapping
  // the element on focus (the tap-to-activate step this issue removes). So a row
  // holding a URL gets a button that opens it, and the URL stays editable text.
  const [first] = linkify(row.text).filter((segment) => segment.link);
  if (first) li.append(openElement(first.value));

  // 🔴 Copy lives in row mode now, not on every row forever. It is a whole-row
  // operation like reorder and delete, and a 28px control on every line is what made
  // the list feel dense on a phone. The ad-hoc case is already covered — iOS
  // long-press → Select All → Copy works in any text field. What the button adds is
  // copying a whole fenced block and stripping the `- [ ] ` prefix.
  //
  // A blank row has nothing to copy, so it gets no button even in the mode.
  if (reordering && row.text.length > 0) li.append(copyElement(row.text));
  if (reordering) li.append(removeElement(row.index));
  return li;
}

/** Opens the row's first URL. Only rendered when there is one. */
function openElement(url: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "open";
  anchor.href = url;
  anchor.append(glyph(GLYPH.open, 17));
  anchor.title = url;
  anchor.target = "_blank";
  // Without noopener the opened page gets a handle on this one via window.opener.
  anchor.rel = "noopener noreferrer";
  return anchor;
}

/** The editor element inside a row — the text input, or a fence's textarea. */
function editorIn(index: number): HTMLInputElement | HTMLTextAreaElement | null {
  return (
    rowsEl?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `li[data-index="${index}"] .text, li[data-index="${index}"] .fence`,
    ) ?? null
  );
}

/**
 * Put the caret in a row after a repaint.
 *
 * 🔴 Every structural edit repaints, and a repaint destroys focus. Restoring it is
 * not polish — without it, pressing Enter drops you out of the document entirely and
 * the next keystroke goes nowhere.
 */
function focusRow(index: number, offset: number): void {
  const editor = editorIn(index);
  if (!editor) return;
  focused = true;
  editor.focus();
  const at = Math.max(0, Math.min(offset, editor.value.length));
  editor.setSelectionRange(at, at);
}

/**
 * Apply a structural edit: new document, repaint, caret where the model said.
 *
 * Saves immediately rather than on the debounce. A split, a merge or a demotion is a
 * complete intent, the same as a toggle or a drop (spec §6).
 */
function applyEdit(result: EditResult): void {
  if (result.body !== body) {
    body = result.body;
    paintRows();
    dirty = true;
    lastActivityAt = Date.now();
    clearTimeout(saveTimer);
    void save();
    schedulePoll();
  } else {
    paintRows();
  }
  focusRow(result.focusIndex, result.focusOffset);
}

/**
 * Typing inside a row.
 *
 * 🔴 Deliberately does **not** repaint. The row already shows what was typed, and
 * rebuilding it would reset the caret to the end on every keystroke — the single
 * most common way this class of editor gets it wrong.
 */
function syncFromRow(index: number, value: string): void {
  const blocks = parse(body);
  const block = blocks[index];
  if (!block) return;

  const next = serialize(
    blocks.map((b: Block, i: number) =>
      i === index ? { ...b, raw: block.kind === "fence" ? value : setText(b, value) } : b,
    ),
  );
  if (next === body) return;

  body = next;
  refreshClearButton();
  scheduleSave();
}

// ── Polling (spec §6, §14.4) ─────────────────────────────────────────────────

/**
 * Fetch and either apply or queue.
 *
 * `If-None-Match` carries the version we are holding, so an unchanged document costs
 * a 304 with no body and the dirty-guard path is never reached at all — which is
 * what keeps a day-long tab inside the free tier (spec §14.4).
 */
async function poll(): Promise<void> {
  try {
    const res = await fetch("/api/doc", {
      headers: { Accept: "application/json", "If-None-Match": `"${baseVersion}"` },
    });
    // 🔴 The poll is the app's heartbeat and usually the first thing to notice a drop,
    // because it runs whether or not anyone is typing.
    noteConnectivity(true);

    if (res.status === 304) return;
    if (res.status === 401) {
      stopPolling();
      showEditor(false);
      return;
    }
    if (!res.ok) return;

    const doc = (await res.json()) as Doc;
    if (doc.version === baseVersion) return;

    applyRemote(doc);
  } catch {
    // A failed poll no longer disappears. It is the app's heartbeat, so its failure is
    // the earliest honest evidence that the network has gone — and the page looking
    // live while it is not was the whole bug (#57, spec §9).
    noteConnectivity(false);
  }
}

/** Where the caret is, in terms that survive a repaint. */
type Caret = { index: number; offset: number };

/**
 * The focused row and caret offset, or null if the caret is not in a row.
 *
 * Read from `document.activeElement` rather than from the `focused` flag, because the
 * flag can outlive the element it describes — and a null here is what corrects it.
 */
function captureCaret(): Caret | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    return null;
  }

  const row = active.closest("li[data-index]");
  if (!row) return null;

  const index = Number(row.getAttribute("data-index"));
  if (!Number.isInteger(index)) return null;

  return { index, offset: active.selectionStart ?? 0 };
}

/**
 * Take a freshly fetched document, respecting whatever the user is in the middle of.
 *
 * 🔴 Focus alone no longer withholds the update (#62). It used to, and because a browser
 * restores focus to the last-focused element when you return to a window, that meant the
 * page went stale precisely when you came back to a device — silently, until you clicked
 * somewhere outside the rows.
 *
 * The caret is still protected, just by putting it back rather than by refusing.
 */
function applyRemote(doc: Doc): void {
  const disposition = dispositionFor({ dirty, focused });

  if (disposition === "hold") {
    // Applied on blur, or subsumed by the 409 the pending local save is about to get —
    // either way the device converges. Announced rather than queued in silence: an
    // update held with no signal is what made #62 look like a broken sync instead of a
    // deliberate wait.
    const first = pendingRemote === null;
    pendingRemote = doc;
    if (first) setStatus("update waiting");
    return;
  }

  if (disposition === "apply") {
    render(doc);
    setStatus("updated elsewhere");
    return;
  }

  // 🔴 The editing surface needs none of what follows. It maps its own selection through
  // the change, and `captureCaret` queries `[data-rows]` — so in the editor view it finds
  // nothing, concludes focus was lost, and sets `focused = false` while CodeMirror still
  // has it. A stale `false` there lets the *next* remote update apply mid-keystroke,
  // which is the bug this whole function exists to prevent, reintroduced sideways.
  if (surface) {
    render(doc);
    setStatus("updated elsewhere");
    return;
  }

  // Focused but clean. Repaint under the caret and put it back where it was.
  const caret = captureCaret();
  render(doc);

  if (caret && editorIn(caret.index)) {
    focusRow(caret.index, caret.offset);
  } else {
    // The row the caret was in did not survive the repaint, so focus is now wherever
    // the browser put it. Correct the flag: a stale `true` here would block every
    // future update, which is the bug this function exists to fix.
    focused = false;
  }

  setStatus("updated elsewhere");
}

function stopPolling(): void {
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

/**
 * Reschedule from the current state. Called after every poll and on every event that
 * could change the tier, so the interval always reflects now rather than whenever the
 * timer was last set.
 */
function schedulePoll(): void {
  stopPolling();

  const interval = pollInterval({
    visible: document.visibilityState === "visible",
    msSinceActivity: Date.now() - lastActivityAt,
  });
  if (interval === null) return;

  pollTimer = setTimeout(async () => {
    await poll();
    schedulePoll();
  }, interval);
}

/**
 * Poll now, then resume the normal cadence. What makes device-switching feel live.
 *
 * Counts as activity: coming back to a window is attention, and the tab should be in
 * the fast tier while you are looking at it rather than on the 60s tier it backed off
 * to while you were elsewhere.
 */
async function pollNow(): Promise<void> {
  lastActivityAt = Date.now();
  stopPolling();
  await poll();
  schedulePoll();
}

// ── Saving ───────────────────────────────────────────────────────────────────

/**
 * The save currently in flight, and whether another was asked for while it ran.
 *
 * 🔴 **Writes are serialised, and that is a correctness fix rather than an
 * optimisation (#83).** Every structural edit saves immediately rather than on the
 * debounce — a split or a merge is a complete intent (spec §6) — and nothing used to
 * stop two of them being in flight at once. Both then carried the same
 * `base_version`, because the first had not returned to update it:
 *
 *     Enter #1 → PUT body=B1, base_version=V0   ┐ both in flight
 *     Enter #2 → PUT body=B2, base_version=V0   ┘
 *                server: #1 commits as V1, #2 arrives stale → 409
 *
 * The 409 is then resolved the only way a 409 can be — by loading the server's copy
 * over the local one — so **the losing write's keystrokes are discarded**, and the
 * status line calls it a reload rather than a loss. With one operator and one device
 * the "elsewhere" was your own previous keystroke.
 *
 * One follow-up is queued, never a chain of them: the follow-up reads `body` and
 * `baseVersion` when it runs, so it already carries the newest of both and a queue of
 * two would send the same document twice.
 */
let inFlight: Promise<void> | null = null;
let queuedSave = false;

function save(): Promise<void> {
  if (inFlight) {
    queuedSave = true;
    return inFlight;
  }

  inFlight = writeDocument().finally(() => {
    inFlight = null;
    if (!queuedSave) return;
    queuedSave = false;
    // Only if something is still unsaved. `writeDocument` clears `dirty` when the body
    // it sent is still the current one, so a follow-up whose work the first save
    // already covered would be an empty round trip.
    if (dirty) void save();
  });

  return inFlight;
}

/**
 * Write the editor's exact contents.
 *
 * 🔴 Never retry with the stale body. On 409 the server's copy wins and is loaded —
 * a retry carrying what we already had is the one catastrophic data-loss path in
 * this project, and the 409 carries the current body precisely so that a second
 * round trip is unnecessary (spec §5, §6).
 *
 * 🔴 A 409 still means what it always meant. Serialising local writes removes the
 * *self*-inflicted conflicts; a genuine one from another device must still reload and
 * still say so. Nothing here swallows a conflict.
 *
 * A 409 also subsumes anything sitting in `pendingRemote`: the server's copy is by
 * definition at least as new as whatever the poll saw, so `render` clears the queue.
 *
 * Call `save()`, never this directly — it is the unserialised half.
 */
async function writeDocument(): Promise<void> {
  // Sent from `body`, not from the textarea. In list view the textarea is hidden and
  // its value is whatever was last painted into it; reading from the element would
  // save the wrong document the moment a checkbox is toggled.
  const sent = body;
  setStatus("saving");

  try {
    let res: Response;
    try {
      res = await fetch("/api/doc", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: sent, base_version: baseVersion }),
      });
    } catch (error) {
      noteConnectivity(false);
      throw error;
    }
    noteConnectivity(true);

    if (res.status === 401) {
      showEditor(false);
      return;
    }

    if (res.status === 409) {
      render((await res.json()) as Doc);
      setStatus("reloaded · it changed elsewhere");
      return;
    }

    if (!res.ok) throw new Error(String(res.status));

    const { version } = (await res.json()) as { version: number };
    baseVersion = version;

    // Only clear the flag if nothing changed while the request was in flight.
    if (body === sent) {
      dirty = false;
      setStatus("saved");
    }
  } catch {
    // 🔴 `dirty` deliberately stays true. The edit is still in the page and still
    // unsaved, and it is what the footer counts — an edit that vanished from the
    // status while sitting unsaved on screen is the failure spec §9 is about. On
    // reconnect `noteConnectivity` retries it as an ordinary versioned write.
    setStatus("not saved");
    paintConnectivity();
  }
}

function scheduleSave(): void {
  dirty = true;
  lastActivityAt = Date.now();
  setStatus("editing");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  // An edit moves us into the fast tier, and the running timer was scheduled under
  // the old one.
  schedulePoll();
}

// ── Wiring ───────────────────────────────────────────────────────────────────

editor?.addEventListener("input", () => {
  if (editor) body = editor.value;
  scheduleSave();
});
editor?.addEventListener("focus", () => {
  focused = true;
});

editor?.addEventListener("blur", () => {
  focused = false;

  // Order matters. A dirty save goes first: if the document moved on underneath us
  // its 409 carries the newer copy, which is at least as new as anything queued, so
  // the queue would be stale. Only when there is nothing to save does the queued
  // update get applied directly.
  if (dirty) {
    void saveNow();
    return;
  }
  applyPendingRemote();
});

/**
 * Flush the debounce.
 *
 * 🔴 **Returns the promise, and callers that are about to send a versioned request
 * must await it (#83).** `requestWipe` and the restore handler both flush first so
 * that `body` and `baseVersion` describe the same page the server holds — but a flush
 * that is not awaited has not landed, so `baseVersion` is still the pre-save one and
 * the request that follows is stale by construction. That produced a 409 on a wipe
 * taken straight after typing, and a 409 on a wipe is not a cosmetic failure.
 *
 * Also resolves when there was nothing to flush, so an await is always safe.
 */
function saveNow(): Promise<void> {
  if (!dirty) return inFlight ?? Promise.resolve();
  clearTimeout(saveTimer);
  return save();
}

function applyPendingRemote(): void {
  if (!pendingRemote) return;
  render(pendingRemote);
  setStatus("updated elsewhere");
}

// ── The typing model (ADR-003, spec §7) ──────────────────────────────────────

// Delegated so it survives every repaint, and so the row count can change freely.
/**
 * The row a `--` conversion just happened in, so the next `Backspace` can undo it.
 *
 * 🔴 Cleared by any other keystroke. An undo that stays available indefinitely stops
 * being an undo and becomes a rule nobody can predict — backspacing at the start of
 * a checkbox you made an hour ago must demote it, not resurrect two dashes.
 */
let shorthandAt: { index: number } | null = null;

rowsEl?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
  if (target.type === "checkbox") return;

  const index = Number(target.closest("li")?.dataset.index);
  if (!Number.isInteger(index)) return;

  // `-- ` → `- [ ] `, on the space. The row becomes a checkbox, so unlike ordinary
  // typing this one does have to repaint — and therefore has to put the caret back.
  if (!target.classList.contains("fence")) {
    const converted = applyShorthand(target.value, target.selectionStart ?? 0);
    if (converted) {
      syncFromRow(index, converted.text);
      paintRows();
      focusRow(index, converted.caret);
      shorthandAt = { index };
      return;
    }
  }

  shorthandAt = null;
  if (target instanceof HTMLTextAreaElement) autoGrow(target);
  syncFromRow(index, target.value);
});

rowsEl?.addEventListener("focusin", (event) => {
  // Focus alone blocks a remote update from repainting under the caret — the other
  // half of the dirty guard (spec §6).
  if ((event.target as HTMLElement).closest(".text, .fence")) focused = true;
});

rowsEl?.addEventListener("focusout", (event) => {
  // Moving between rows fires focusout before focusin, so settle on the next tick
  // rather than tearing down state a keystroke is about to need.
  const leaving = event.target as HTMLElement;
  if (!leaving.closest(".text, .fence")) return;
  setTimeout(() => {
    if (rowsEl?.contains(document.activeElement) && document.activeElement !== document.body) return;
    focused = false;
    if (dirty) {
      void saveNow();
      return;
    }
    applyPendingRemote();
  }, 0);
});

rowsEl?.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
  if (target.type === "checkbox") return;

  const index = Number(target.closest("li")?.dataset.index);
  if (!Number.isInteger(index)) return;

  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const isFence = target.classList.contains("fence");

  // A fence's textarea owns Enter and Backspace — newlines inside a code block are
  // the point, and merging one into its neighbour is never what backspace meant.
  if (isFence && (event.key === "Enter" || event.key === "Backspace")) return;

  // Any keystroke that is not the undo closes the window on it.
  if (event.key !== "Backspace") shorthandAt = null;

  if (event.key === "Enter") {
    event.preventDefault();
    // The live value, not `body`: an `input` event may not have landed yet on some
    // IME and autocorrect paths, and splitting a stale line drops the last word.
    syncFromRow(index, target.value);
    applyEdit(splitAt(body, index, start));
    return;
  }

  // Undo the shorthand, but only on the keystroke straight after it. Otherwise
  // `--` at the start of a line would be untypeable, and a shortcut that takes a
  // character away from you is worse than no shortcut (ADR-003 §4).
  if (event.key === "Backspace" && shorthandAt?.index === index) {
    const reverted = revertShorthand(target.value, start);
    if (reverted) {
      event.preventDefault();
      shorthandAt = null;
      syncFromRow(index, reverted.text);
      paintRows();
      focusRow(index, reverted.caret);
      return;
    }
  }

  if (event.key === "Backspace" && start === 0 && end === 0) {
    event.preventDefault();
    syncFromRow(index, target.value);
    applyEdit(mergeBackward(body, index));
    return;
  }

  // 🔴 Arrows cross a row boundary only when the caret is already **at** one, and only
  // when nothing is selected. Anywhere else they belong to the field — a row is a
  // textarea that can be several visual lines tall, and intercepting inside it would
  // make a long wrapped line unnavigable.
  //
  // A live selection is not a caret: every editor collapses it on an arrow rather than
  // moving somewhere, so a boundary jump would eat the gesture. That holds for all four
  // arrows.
  //
  // 🔴 "At a boundary" means two different things for the two pairs, and conflating
  // them was #88. For `←`/`→` it is an **offset**: the first or last character. For
  // `↑`/`↓` it is a **visual line**, which an offset cannot express — see caret.ts.
  const collapsed = start === end;
  const atStart = collapsed && start === 0;
  const atEnd = collapsed && end === target.value.length;

  /**
   * Step to the neighbouring row, or leave the keystroke to the browser.
   *
   * 🔴 The guard is **"did the row actually change"**, not "is the index in range".
   * `neighbor` reports nowhere-to-go by returning the row it was given, along with the
   * offset it was handed — so acting on it unconditionally moves the caret to that
   * offset *within the current row*. That is how `ArrowRight` at the end of the last
   * line threw the caret back to the start of it, which is worse than doing nothing.
   *
   * Not calling `preventDefault` on the no-move path leaves the browser to do what it
   * already does correctly at a document boundary: nothing.
   */
  const step = (direction: -1 | 1, landing: "start" | "end"): boolean => {
    const result = neighbor(body, index, direction, 0);
    if (result.focusIndex === index) return false;
    event.preventDefault();
    const offset = landing === "end" ? (editorIn(result.focusIndex)?.value.length ?? 0) : 0;
    focusRow(result.focusIndex, offset);
    return true;
  };

  /**
   * `↑` / `↓` — move to the neighbouring row and keep the column (#88).
   *
   * 🔴 Gated on the caret's **visual** line, not its offset. The old gate was
   * `start === 0` / `end === value.length`, which meant a `↓` from the middle of a row
   * was never intercepted — so the browser handled it, and what a browser does with
   * `↓` in a one-line textarea is move the caret to the end of the text. Changing rows
   * cost two presses and the first one threw the caret somewhere nobody asked for.
   *
   * A wrapped row is still navigable because `visualEdge` is false in its interior,
   * which is the case an offset comparison could not distinguish from a boundary.
   *
   * 🔴 The column is the caret's **x in pixels**, carried across and resolved against
   * the target row's own glyphs. `neighbor`'s `Math.min(offset, length)` is a character
   * count, and a character count is not a column in a proportional face — row `iiii`
   * and row `WWWW` put offset 4 nowhere near each other on screen. `neighbor` is still
   * what decides *whether* there is a row to move to; only the landing differs.
   */
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (!collapsed) return;

    const direction = event.key === "ArrowUp" ? -1 : 1;
    const edge = visualEdge(target, start);
    // The interior of a wrapped row belongs to the field — this is the whole reason the
    // gate has to be visual.
    if (direction === -1 ? !edge.first : !edge.last) return;

    // 🔴 `preventDefault` here, before knowing whether there is a row to move to. At a
    // visual edge the keystroke is ours either way: handing it back at the first or last
    // row lets the browser do what it does in a one-line textarea — slam the caret to
    // the start or end of the text — which is the same "press nobody asked for" this
    // issue is about, just at the ends of the document. `↑` on the first row now does
    // nothing, which is what a text editor does.
    const column = caretX(target, start);
    event.preventDefault();

    const result = neighbor(body, index, direction, 0);
    if (result.focusIndex === index) return;

    const landing = editorIn(result.focusIndex);
    if (!landing) return;

    // Coming up, land on the row above's **last** visual line; going down, its first.
    focusRow(result.focusIndex, offsetNearestX(landing, column, direction === -1 ? "last" : "first"));
    return;
  }

  // Left at the start and right at the end (#84) — the horizontal pair of the same
  // boundary rule, which was simply never written. The caret hit the end of a row and
  // stopped dead, so moving through the page by keyboard meant reaching for the down
  // arrow and then Home.
  //
  // Nothing is skipped: a blank row is a place you can type, and stepping over one
  // would make the arrows disagree with what is on screen.
  if (event.key === "ArrowLeft" && atStart) {
    step(-1, "end");
    return;
  }

  if (event.key === "ArrowRight" && atEnd) {
    step(1, "start");
  }
});

/**
 * Toggle a checkbox, delegated from the row list.
 *
 * 🔴 Reparses `body` and edits **only the block the row points at**, then serializes.
 * `data-index` is the block index — `rows()` guarantees it equals the row's position,
 * which is the whole reason blank blocks are rendered rather than filtered.
 *
 * Everything not targeted is written back from its untouched `raw`, so indentation,
 * `*` vs `-`, trailing whitespace and CRLF all survive a toggle (spec §14.2).
 */
rowsEl?.addEventListener("change", (event) => {
  const box = event.target;
  if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;

  const index = Number(box.closest("li")?.dataset.index);
  const blocks = parse(body);
  const target = blocks[index];
  if (!Number.isInteger(index) || target?.kind !== "checkbox") {
    // Repaint rather than guess: the checkbox has already flipped visually, and
    // leaving it flipped would show a state the document does not have.
    paintRows();
    return;
  }

  body = serialize(blocks.map((b: Block, i: number) => (i === index ? toggle(b) : b)));
  paintRows();

  // Immediately, not on the debounce — a toggle is a complete intent, and spec §6
  // lists it alongside reorder and clear as a save trigger.
  dirty = true;
  lastActivityAt = Date.now();
  clearTimeout(saveTimer);
  void save();
  schedulePoll();
});

/**
 * Sweep the checked items.
 *
 * The server does the work — it owns the ordering and the done-record — so this only
 * asks, and never computes the post-clear body itself. Two implementations of "what
 * counts as completed" is the same mistake as two parsers.
 */
/**
 * What a wipe left behind, so it can be undone (#59).
 *
 * 🔴 Held on this device, not on the server, and that is the decision rather than the
 * shortcut. The regret is on the device where the wipe happened — an undo offered on
 * the laptop for something wiped on the phone is an invitation to undo work someone
 * else already moved on from. It also needs no schema change and no new route, because
 * the client already holds both sides: the body it had, and the body it re-reads after.
 *
 * Expires at the next local midnight, which is the brand's "rest of the day" and the
 * device's own day. `/api/history` reasons about days in `KNAG_TZ` because it reports
 * on the past; this is about the person holding the phone right now.
 */
type WipeMemory = { preWipe: string; postWipe: string; count: number; expiresAt: number };

const WIPE_MEMORY_KEY = "knag:last-wipe";

function rememberWipe(memory: WipeMemory): void {
  try {
    globalThis.localStorage?.setItem(WIPE_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Private mode, or a full quota. The wipe still happened and is still in history;
    // only the one-tap undo is lost, which is not worth failing the wipe over.
  }
  paintRestore();
}

function forgetWipe(): void {
  try {
    globalThis.localStorage?.removeItem(WIPE_MEMORY_KEY);
  } catch {
    // Nothing to do — `readWipe` treats anything unparseable as absent.
  }
  paintRestore();
}

function readWipe(): WipeMemory | null {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(WIPE_MEMORY_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const memory = JSON.parse(raw) as WipeMemory;
    if (typeof memory?.preWipe !== "string" || typeof memory.expiresAt !== "number") return null;
    if (Date.now() >= memory.expiresAt) return null;
    return memory;
  } catch {
    return null;
  }
}

/** The offer, or nothing. Deadpan, and it names the number so it is not a mystery. */
function paintRestore(): void {
  const memory = readWipe();
  if (!recoveryLine) return;

  recoveryLine.toggleAttribute("hidden", memory === null);
  if (memory && recoveryCountEl) recoveryCountEl.textContent = `wiped ${memory.count}`;
}

// ── The wipe animation (the only animation in the product) ───────────────────

/**
 * Read a duration token back out of the stylesheet.
 *
 * 🔴 The CSS is the single source of truth for these, which is what makes
 * `prefers-reduced-motion` free: the media query in the shell already rewrites the
 * tokens to 1ms, so this reads 1ms and the whole sequence collapses without a second
 * `matchMedia` check here that could disagree with the stylesheet.
 */
function motionMs(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** A pause, in the sequence's own units. Zero is honoured as zero rather than a frame. */
function hold(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The block indices a wipe of this scope is about to remove. */
function leavingRows(scope: WipeScope): number[] {
  const blocks = parse(body);
  const indices: number[] = [];
  blocks.forEach((block, index) => {
    if (scope === "all" || isCompleted(block)) indices.push(index);
  });
  return indices;
}

/**
 * Fade the leaving rows, then close the gap they left.
 *
 * 🔴 **Two stages, and the separation is the whole point.** The rows go transparent in
 * place, holding their height, and only then does one collapse close the gap. Fading
 * and collapsing at once makes the list jump under the thumb that just tapped, and the
 * release stops feeling like a release and starts feeling like a mis-tap.
 *
 * Nothing here decides what gets wiped — the server owns that, and this runs against
 * the same predicate purely for the picture. If the two ever disagree the repaint from
 * the server's answer is what lands, so the worst case is a row that faded and came
 * back, never a row that vanished from the page without leaving the document.
 */
function animateWipe(scope: WipeScope): Promise<void> {
  // 🔴 Two timings, one animation (#121, §6b). Wiping completed lines is many small
  // removals; wiping the page is one removal of one thing, and the same motion at
  // greater length says "that was thirty lines" when it should say "that was the page".
  // Everything that differs is a token — length, direction, order — which is what keeps
  // this a second timing rather than a second animation.
  const page = scope === "all";
  const timings = page
    ? {
        duration: motionMs("--page-duration", 380),
        stagger: motionMs("--page-stagger", 16),
        collapse: motionMs("--page-collapse", 200),
        page: true,
      }
    : {
        duration: motionMs("--wipe-duration", 260),
        stagger: motionMs("--wipe-stagger", 14),
        collapse: motionMs("--wipe-collapse", 130),
      };

  // 🔴 The surface takes it when there is one, and it takes *lines* rather than block
  // indices. One block is one <li> here, so the two were interchangeable — but a fence
  // is one block and several lines, and animating by index there would fade the opening
  // ``` and leave the rest of the fence until the repaint (#119).
  if (surface) return surface.animateWipe(leavingLines(body, scope), timings);

  const indices = leavingRows(scope);
  if (!rowsEl || indices.length === 0) return Promise.resolve();

  const leaving = indices
    .map((index) => rowsEl.querySelector<HTMLElement>(`li[data-index="${index}"]`))
    .filter((el): el is HTMLElement => el !== null);
  if (leaving.length === 0) return Promise.resolve();

  const { duration, stagger, collapse } = timings;

  leaving.forEach((el, order) => {
    // Bottom-up for the page, top-down for the daily sweep — the page leaves as one
    // object rather than as a list being processed from the top.
    el.style.setProperty("--i", String(page ? leaving.length - 1 - order : order));
    el.classList.add("wiping");
    if (page) el.classList.add("page");
  });

  return new Promise((resolve) => {
    setTimeout(
      () => {
        // One height read per row, written back before the class lands, so the
        // transition has somewhere to go from — `max-height: auto` does not animate.
        for (const el of leaving) el.style.maxHeight = `${el.offsetHeight}px`;
        // Force the style to settle before the collapsing value is applied, or the
        // browser coalesces both writes and the row snaps shut with no transition.
        void rowsEl.offsetHeight;
        for (const el of leaving) el.classList.add("closing");
        setTimeout(resolve, collapse);
      },
      duration + (leaving.length - 1) * stagger,
    );
  });
}

async function requestWipe(scope: WipeScope): Promise<void> {
  // 🔴 Awaited (#83). An un-awaited flush has not landed, so `baseVersion` below is
  // still the pre-save one and the wipe is stale by construction — a 409 on a wipe
  // taken straight after typing.
  await saveNow();
  setStatus("wiping");

  // Captured before the request, because it is the only copy of the pre-wipe page this
  // device will have — the server keeps its own sealed snapshot, but reaching it would
  // need a route that does not exist.
  const preWipe = body;

  // Started before the request and awaited after it, so the network round trip happens
  // *inside* the animation rather than after it. The rows are already leaving by the
  // time the server answers, which is what makes the tap feel immediate on a phone.
  const leaving = animateWipe(scope);

  try {
    const res = await fetch("/api/doc/clear-completed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: baseVersion, scope }),
    });

    if (res.status === 401) {
      showEditor(false);
      return;
    }

    if (res.status === 409) {
      render((await res.json()) as Doc);
      setStatus("reloaded · it changed elsewhere");
      return;
    }

    if (!res.ok) throw new Error(String(res.status));

    const { wiped_count: count } = (await res.json()) as { wiped_count: number };

    // Re-read rather than trusting a locally computed result. The server decided what
    // was removed and rewrote the document; this asks what it actually is.
    const doc = await load();

    // 🔴 Held until the rows have finished leaving. `render` repaints, and a repaint
    // replaces every <li> — so painting the new document mid-animation deletes the
    // elements that are animating and the wipe simply does not happen on a fast
    // connection, which is every connection the author develops on.
    await leaving;

    // 🔴 Then the beat, and only for the page (§6b). The collapse has finished, so what
    // is on screen is the board with nothing on it — and **the empty board is part of
    // the animation** rather than what is left when it stops. Holding it is where the
    // drama is available honestly: no confetti, no flourish, nothing new on screen, the
    // same board given a moment of silence. It is also what stops the fall reading as a
    // deletion, because the record speaks right after it.
    //
    // A daily sweep gets none of this. It has nothing to hold *for* — what follows is
    // the rest of your list, which never left.
    if (scope === "all") await hold(motionMs("--page-beat", 200));

    if (doc) render(doc);

    if (count === 0) {
      setStatus("nothing to wipe");
    } else {
      setStatus(`wiped ${count}`);
      // The post-wipe body comes from the re-read, not from a local guess: the server
      // decided what "completed" meant, and the undo has to reverse what it actually
      // did rather than what this device thought it would do.
      if (doc) {
        rememberWipe({
          preWipe,
          postWipe: doc.body,
          count,
          expiresAt: offerExpiresAt(new Date()),
        });
      }
    }
  } catch {
    setStatus("not wiped");
    // 🔴 Put the faded lines back. Nothing was removed, and lines left mid-animation are
    // transparent and collapsed to zero height — so the failure would *look* exactly
    // like the successful wipe it is telling you did not happen.
    //
    // Awaited first, and `paint` rather than `paintRows`: repainting while the sequence
    // is still running restores the document and then lets the pending collapse land on
    // it, so the page a failed wipe left alone would fold up anyway. Both surfaces clear
    // themselves once it has finished.
    await leaving;
    paint();
  }
}

/**
 * Sweep the checked rows.
 *
 * 🔴 **No confirm, at any count.** There used to be one above ten, on the argument
 * that a big sweep deserves a pause. Two things retired it. The count now sits *inside*
 * the control — you read `wipe 11` before you tap it, so the size of the action is
 * already in front of you — and the recovery line below the rows makes taking it back
 * one tap. A browser `confirm()` was also the loudest, least knag-shaped thing in the
 * app: a grey OS dialog with a title bar, in a product whose entire voice is quiet.
 *
 * The whole-page wipe still confirms, because it takes work that was never finished.
 * It does it by repetition rather than by dialog — see below.
 */
clearButton?.addEventListener("click", async () => {
  const completed = parse(body).filter(isCompleted).length;
  if (completed === 0) return;

  await requestWipe("completed");
});

/**
 * Wipe the whole page (#58).
 *
 * 🔴 **Always confirms, and confirms by repetition.** Unlike the sweep, this one takes
 * work that was never finished, so it does not go on one tap. But the confirmation is a
 * second tap on the same control within a few seconds — the label changes to
 * `again to confirm` and reverts on its own — rather than a browser dialog.
 *
 * A `confirm()` was what shipped first and it was wrong twice over. It is an OS-styled
 * grey box with a title bar in a product whose whole voice is quiet, and it moves the
 * decision to a different surface than the one you were looking at. Confirming in place
 * keeps your eyes on the control that is about to do the thing.
 *
 * The revert is what makes it safe to be this quiet: an armed control that stayed armed
 * would be a trap for the next person who opened settings for an unrelated reason.
 */
const WIPE_ARM_MS = 4_000;
let wipeArmTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The label, carrying its own count, or the armed prompt.
 *
 * The count is on the control for the same reason it is on the footer's: `wipe the
 * page 41` and "wipe the page" land differently, and the number is what stops a
 * mistake. It is hidden while armed, because at that moment the only thing worth
 * reading is what the next tap does.
 */
function paintWipeAll(): void {
  const armed = wipeAllButton?.hasAttribute("data-armed") === true;
  const label = document.querySelector<HTMLElement>("[data-wipe-all-label]");
  const count = document.querySelector<HTMLElement>("[data-wipe-all-count]");

  if (label) label.textContent = armed ? "again to confirm" : "wipe page";
  if (count) {
    count.textContent = String(parse(body).length);
    count.toggleAttribute("hidden", armed);
  }
}

function disarmWipeAll(): void {
  clearTimeout(wipeArmTimer);
  wipeArmTimer = undefined;
  wipeAllButton?.removeAttribute("data-armed");
  paintWipeAll();
}

wipeAllButton?.addEventListener("click", async () => {
  if (body === "") {
    setStatus("nothing to wipe");
    return;
  }

  if (!wipeAllButton.hasAttribute("data-armed")) {
    wipeAllButton.setAttribute("data-armed", "");
    paintWipeAll();
    wipeArmTimer = setTimeout(disarmWipeAll, WIPE_ARM_MS);
    return;
  }

  disarmWipeAll();
  await requestWipe("all");
  paintWipeAll();
});

/**
 * Bring the wiped lines back (#59).
 *
 * 🔴 An ordinary versioned write. The restored body is computed against the page **as
 * it is now** and sent with a `base_version` like any other save, so a 409 reloads and
 * the undo is simply offered again rather than retried blind. Undo is not a special
 * path, and it does not get to skip the concurrency rules that protect the document.
 */
restoreButton?.addEventListener("click", async () => {
  const memory = readWipe();
  if (!memory) return;

  // Flush anything unsaved first, so `body` and `baseVersion` describe the same page
  // the server holds — otherwise the restore races the user's own last keystroke.
  // 🔴 Awaited (#83): an un-awaited flush is exactly the race it is meant to close.
  await saveNow();
  setStatus("bringing back");

  const restored = restoredBody({
    preWipe: memory.preWipe,
    postWipe: memory.postWipe,
    current: body,
  });

  try {
    const res = await fetch("/api/doc", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: restored, base_version: baseVersion }),
    });

    if (res.status === 401) {
      showEditor(false);
      return;
    }

    if (res.status === 409) {
      // Re-read and leave the offer standing. The wiped lines are still absent from
      // whatever arrived, so the next tap recomputes against it and works.
      render((await res.json()) as Doc);
      setStatus("reloaded · it changed elsewhere");
      return;
    }

    if (!res.ok) throw new Error(String(res.status));

    const doc = await load();
    if (doc) render(doc);

    forgetWipe();
    setStatus(`brought back ${memory.count}`);
  } catch {
    setStatus("not restored");
  }
});

// Delegated, so it survives every repaint.
rowsEl?.addEventListener("click", (event) => {
  const target = event.target;
  // 🔴 `Element`, not `HTMLElement`. Every control in here is a button wrapping an
  // **SVG glyph**, and an SVG element is not an HTMLElement — so a tap that landed on
  // the drawing rather than the padding around it failed this guard and was dropped
  // silently. The controls are 36px holding a 17px glyph, which means copy and delete
  // in Arrange worked only if you hit the edge and did nothing if you hit the middle.
  // `closest()` is defined on Element, so nothing downstream changes.
  if (!(target instanceof Element)) return;

  // A link is a link. Tapping one navigates rather than opening the editor — which
  // does mean a row that is nothing but a URL can only be edited from raw view, and
  // that is the right trade: a bare URL row is a bookmark, not prose.
  if (target.closest("a")) return;

  const copy = target.closest<HTMLElement>("[data-copy]");
  if (copy) {
    // 🔴 Copying a picked row copies the whole selection, not that one row. The rule is
    // the same for delete below: a control on a picked row acts on the selection, a
    // control on any other row acts on itself. Nothing new appears on screen to say so —
    // the picked rows are already tinted, which is what makes the size of the action
    // readable before it is taken (the same argument as the count inside `wipe 3`).
    const index = Number(copy.closest<HTMLElement>("li")?.dataset.index);
    const text = picked.has(index) ? pickedText() : (copy.dataset.copy ?? "");
    void copyToClipboard(text, copy);
    return;
  }

  // 🔴 Tapping a row's body picks it. The gesture is free: drag is grip-only
  // (`handle: ".grip"`) and Arrange sets `pointer-events: none` on the row's textarea,
  // so a tap here reaches the `li` and nothing else wanted it. Outside Arrange the row
  // is a live input and a tap belongs to the caret.
  if (!reordering) return;
  // The controls are not the row. Without this, deleting a row would also pick it on the
  // way past, and the grip would toggle a selection every time a drag failed to start.
  if (target.closest(".grip, [data-copy], [data-remove], a, button")) return;

  const li = target.closest<HTMLElement>("li[data-index]");
  if (!li) return;
  const rowIndex = Number(li.dataset.index);
  if (!Number.isInteger(rowIndex)) return;

  if (picked.has(rowIndex)) picked.delete(rowIndex);
  else picked.add(rowIndex);
  paintRows();
});

/**
 * Copy, with the result shown on the button itself.
 *
 * `navigator.clipboard` rejects when the page is not a secure context or the gesture
 * is not trusted, and a copy that silently does nothing is worse than one that says
 * so — you find out when you paste.
 */
async function copyToClipboard(text: string, button: HTMLElement): Promise<void> {
  let mark: string = GLYPH.done;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    mark = GLYPH.failed;
  }
  // Swapped rather than written over: the control is an SVG now, and assigning
  // `textContent` would delete the drawing and leave an empty 28px square behind.
  button.replaceChildren(glyph(mark, 17));
  setTimeout(() => {
    button.replaceChildren(glyph(GLYPH.copy, 17));
  }, 1200);
}

/**
 * Drag to reorder, over blocks.
 *
 * 🔴 `handle: ".grip"` — the grip is the *only* drag initiator. Whole-row dragging
 * conflicts with tap-to-edit and produces accidental reorders every time a tap drifts
 * a few pixels, which on a phone is most taps (spec §7).
 *
 * Bound once to the container rather than per row, so it survives every repaint.
 */
let sortable: Sortable | null = null;

if (rowsEl) {
  sortable = Sortable.create(rowsEl, {
    handle: ".grip",
    // Off until the mode is entered. A drag that can start at any moment is the
    // thing live inputs made unworkable (ADR-003 §5).
    disabled: true,
    animation: 120,
    // Touch needs a moment to distinguish a drag from a scroll; a mouse does not.
    delay: 120,
    delayOnTouchOnly: true,
    ghostClass: "dragging",

    onEnd: (event) => {
      const from = event.oldIndex;
      const to = event.newIndex;
      if (from === undefined || to === undefined || from === to) return;

      // 🔴 Reparse and reorder the *block* array, then repaint from the result. The
      // DOM has already been rearranged by the library, and trusting that as the new
      // truth would mean the document was defined by whatever the drag left behind.
      const next = serialize(move(parse(body), from, to));
      if (next === body) {
        paintRows();
        return;
      }

      body = next;
      // The drag moved rows out from under every picked index.
      picked.clear();
      paintRows();

      // Immediately, like a toggle and a clear — a drop is a complete intent (spec §6).
      dirty = true;
      lastActivityAt = Date.now();
      clearTimeout(saveTimer);
      void save();
      schedulePoll();
    },
  });
}

/**
 * Enter or leave reorder mode.
 *
 * Rows go read-only, grips appear at a size worth aiming at, and each row gains a
 * delete. Leaving returns to typing. **Not persisted** — a reload lands you in the
 * editor, always (ADR-003 §5).
 */
function setReordering(on: boolean): void {
  reordering = on;
  // Both directions. Leaving with rows still picked would put the selection back the
  // next time the mode opened, which is state the page gives no way to see or undo.
  picked.clear();
  rowsEl?.classList.toggle("reorder", on);
  // 🔴 The glyph never changes — only its state does. An earlier version swapped the
  // drawing for a tick on the way in, which is how the control silently changed shape
  // the first time it was used and never changed back.
  //
  // `aria-pressed` is both the accessible answer and the styling hook: the CSS gives a
  // pressed control the 10% ink tint for as long as the mode is on, because the mode
  // has to be legible from the bar. In Arrange the page looks like a page you cannot
  // type in, which is exactly what it is.
  if (reorderButton) {
    reorderButton.setAttribute("aria-pressed", String(on));
    reorderButton.title = on ? "done arranging" : "arrange";
  }
  sortable?.option("disabled", !on);

  // Leaving the mode flushes anything the drags queued, so the document is settled
  // before the caret goes anywhere near it again.
  if (!on) void saveNow();
  // 🔴 `paint`, not `paintRows`. In the editor view, entering Arrange destroys the
  // surface and leaving it builds a new one from the reordered document — which is the
  // swap the spike measured, and the check that mattered there was that a trip through
  // with no drag returns the identical bytes.
  paint();
}

/**
 * Apply the theme to the document, and to the iOS status bar.
 *
 * 🔴 The `theme-color` meta tag is what iOS paints the status bar from. Leaving it
 * dark under a light theme puts a black strip above a white app, which reads as a
 * rendering bug rather than a preference (spec §9).
 */
/**
 * The reading size, as a `--size-row` override on `:root` (#92).
 *
 * 🔴 A token override and nothing else, so no rule outside the `:root` block names a
 * size. Both editing surfaces and raw view already read `--size-row`, so one property
 * moves all three and switching views cannot resize the page underneath you.
 *
 * 16 is removed rather than set, so the default state is the stylesheet's own value and
 * the floor lives in exactly one place.
 */
function applyFontSize(): void {
  const root = document.documentElement;
  if (fontSize === 16) root.style.removeProperty("--size-row");
  else root.style.setProperty("--size-row", `${fontSize}px`);
}

function applyTheme(): void {
  const root = document.documentElement;
  // `system` sets no attribute at all, so the CSS media query decides — rather than
  // this having to re-read the OS preference on every change.
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;

  const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor(theme, prefersDark));

  markChoices("[data-theme-set]", "themeSet", theme);
}

/** Show which option in a group is active, via `aria-pressed`. */
function markChoices(selector: string, key: string, active: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(selector)) {
    button.setAttribute("aria-pressed", String(button.dataset[key] === active));
  }
}

settingsDialog?.addEventListener("click", (event) => {
  const target = event.target;
  // Same reason as the row handlers: any control in here that carries a glyph would
  // otherwise ignore a tap on the glyph itself.
  if (!(target instanceof Element)) return;

  const chosenTheme = target.closest<HTMLElement>("[data-theme-set]")?.dataset.themeSet;
  if (chosenTheme) {
    theme = chosenTheme as Theme;
    writeTheme(globalThis.localStorage, theme);
    applyTheme();
    return;
  }

  const chosenSize = target.closest<HTMLElement>("[data-font-size]")?.dataset.fontSize;
  if (chosenSize) {
    // Validated through the same reader the boot path uses rather than cast: the value
    // comes off a DOM attribute, and a typo in the markup must not put `--size-row`
    // below the floor that keeps iOS from zooming.
    fontSize = readFontSize({ getItem: () => chosenSize, setItem: () => {} });
    writeFontSize(globalThis.localStorage, fontSize);
    applyFontSize();
    markChoices("[data-font-size]", "fontSize", String(fontSize));
    return;
  }

  const chosenView = target.closest<HTMLElement>("[data-view-set]")?.dataset.viewSet;
  if (chosenView && chosenView !== view) {
    // Flush first: switching views repaints from `body`, and an unsaved edit still
    // on the debounce would have its save race the repaint.
    void saveNow();
    view = chosenView as ViewMode;
    writeView(globalThis.localStorage, view);
    paint();
    markChoices("[data-view-set]", "viewSet", view);
  }
});

// ── Devices (#125) ───────────────────────────────────────────────────────────
//
// 🔴 Fetched when the sheet opens, never cached. A device list that is stale is worse
// than no device list: the whole point is answering "what still has access", and an
// answer from ten minutes ago is exactly the answer you cannot act on.

type SessionRow = {
  id: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  is_current: boolean;
};

/** A date the way the rest of the machine voice says them — short, local, no time. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sessionRow(session: SessionRow): HTMLLIElement {
  const row = document.createElement("li");
  if (session.is_current) row.setAttribute("data-current", "");

  const label = document.createElement("span");
  label.className = "label";
  // An unlabelled session is still a session with access, so it gets a row and a name
  // rather than being hidden for want of a label.
  label.textContent = session.label || "unnamed";

  const since = document.createElement("span");
  since.textContent = shortDate(session.created_at);

  row.append(label, since);

  // 🔴 No revoke control on your own row. Logging out is the button below, and it also
  // clears the cookie — a revoke here would work but would leave the sheet open over a
  // page the browser can no longer load.
  if (!session.is_current) {
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.textContent = "revoke";
    revoke.dataset.revoke = session.id;
    row.append(revoke);
  } else {
    const current = document.createElement("span");
    current.textContent = "this device";
    row.append(current);
  }

  return row;
}

function paintSessions(sessions: SessionRow[] | null): void {
  if (!sessionsList) return;

  if (!sessions) {
    sessionsList.replaceChildren(machineLine("could not read devices"));
    return;
  }
  if (sessions.length === 0) {
    sessionsList.replaceChildren(machineLine("no live sessions"));
    return;
  }
  sessionsList.replaceChildren(...sessions.map(sessionRow));
}

function machineLine(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "note";
  item.textContent = text;
  return item;
}

async function loadSessions(): Promise<void> {
  sessionsList?.replaceChildren(machineLine("…"));

  try {
    const res = await fetch("/api/sessions", { credentials: "same-origin" });
    if (!res.ok) {
      paintSessions(null);
      return;
    }
    const body = (await res.json()) as { sessions: SessionRow[] };
    paintSessions(body.sessions);
  } catch {
    // Offline is a normal state here (spec §9), not an error worth a dialog.
    paintSessions(null);
  }
}

/**
 * Everything here ends at the login screen or with a shorter list, so a failure must
 * not look like a success. On anything other than the expected status the list is
 * re-read rather than patched locally — the server is the only thing that knows what
 * is still live.
 */
async function revoke(path: string, method: string): Promise<void> {
  try {
    const res = await fetch(path, { method, credentials: "same-origin" });

    // 401 means this device's own session went with it. Reloading lands on the login
    // screen, which is the honest outcome rather than a page that quietly 401s
    // everything from here on.
    if (res.status === 401) {
      globalThis.location.reload();
      return;
    }
    if (!res.ok) {
      setStatus("could not revoke");
      return;
    }
  } catch {
    setStatus("offline");
    return;
  }

  await loadSessions();
}

/**
 * Copy the whole page (#118).
 *
 * 🔴 `body` verbatim — no header, no metadata, no front matter. Anything knag adds is a
 * byte the user did not type, and the round trip back through raw view (spec §8) only
 * holds because there is nothing to strip on the way in.
 *
 * This capability already existed: in the editing surface `⌘A` then copy returns the page
 * byte-exact, and has since v0.8.0. What this replaces is four gestures and two menu waits
 * on a phone, where the selection callout is fiddly on a long page.
 *
 * 🔴 The result goes to the save-status line, and it did not used to. While this lived
 * in the sheet the label had to carry it, because a modal covers the footer and a
 * confirmation the reader cannot see is not one. On the ledge the footer is what they
 * are looking at, the machine slot is where the app already speaks about itself, and
 * swapping a 4-character label for a 10-character one reflowed the whole ledge.
 */
copyPageButton?.addEventListener("click", () => {
  void (async () => {
    let said = "copied";
    try {
      // Not the document from the last poll: `body` is what the surface holds, which is
      // what the reader is looking at.
      await navigator.clipboard.writeText(body);
    } catch {
      // Rejects outside a secure context or on an untrusted gesture. A copy that silently
      // does nothing is worse than one that says so — you find out when you paste.
      said = "not copied";
    }

    setStatus(said);
  })();
});

logoutButton?.addEventListener("click", () => {
  // Flush first, for the same reason switching views does: an edit still on the
  // debounce would otherwise be saved by a request whose cookie has just been deleted.
  void saveNow().then(() => {
    void fetch("/api/logout", { method: "POST", credentials: "same-origin" }).finally(() => {
      globalThis.location.reload();
    });
  });
});

revokeOthersButton?.addEventListener("click", () => {
  void revoke("/api/sessions", "DELETE");
});

sessionsList?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const id = target.closest<HTMLElement>("[data-revoke]")?.dataset.revoke;
  if (id) void revoke(`/api/sessions/${encodeURIComponent(id)}`, "DELETE");
});

/**
 * The ledge — tier 2 of the bar (#139).
 *
 * 🔴 **It cannot be open while the keyboard is up**, and that single rule is what makes
 * a second tier cost nothing. The bar is thin because it sits above the keyboard on a
 * phone; a tier that persisted there would spend exactly the height the thinness was
 * protecting. So it does not persist: anything that takes focus outside the bar closes
 * it, and typing is the commonest way that happens.
 *
 * The consequence worth knowing before touching this: a ledge control must not
 * `preventDefault` its own mousedown. That is the usual toolbar reflex for keeping an
 * editor focused, and here it would be keeping focus in the document — which is the
 * one thing that closes the ledge under the reader.
 *
 * Pin is deliberately not built. It only means anything with the keyboard down, which
 * on a phone is the situation the tension does not exist in, so it is one boolean and a
 * setting nobody has asked for yet.
 */
function setLedge(open: boolean): void {
  if (!ledgeEl || open === ledgeEl.hasAttribute("data-open")) return;

  ledgeEl.toggleAttribute("data-open", open);
  // Both, always. `data-open` drives the 90ms height; `inert` is what keeps a
  // zero-height button out of the tab order and out of hit-testing.
  ledgeEl.toggleAttribute("inert", !open);
  ledgeToggle?.setAttribute("aria-expanded", String(open));
  // The glyph never changes — it turns over, and the title says which way. Same rule the
  // Arrange control follows: only the state changes, never the drawing.
  if (ledgeToggle) ledgeToggle.title = open ? "close the ledge" : "open the ledge";

  // 🔴 Closing disarms the whole-page wipe. Reaching for the ledge later and finding a
  // control still armed would mean one tap wipes the page, having forgotten the tap that
  // armed it — the trap the arming timeout exists to avoid, arriving by another route.
  // This replaced the settings dialog's `close` listener when the control moved.
  if (!open) disarmWipeAll();
}

ledgeToggle?.addEventListener("click", () => {
  setLedge(!ledgeEl?.hasAttribute("data-open"));
});

// 🔴 `focusin` rather than a keyboard-visibility guess. There is no keyboard API, and
// every proxy for one — a `visualViewport` height delta, a user-agent test — is a guess
// that is wrong on a tablet with a hardware keyboard or a phone in landscape. Focus is
// the thing actually being asked about: the reader is either operating the bar or in
// the document, and being in the document is what raises the keyboard.
document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (target instanceof Node && footerEl?.contains(target)) return;
  setLedge(false);
});

settingsOpen?.addEventListener("click", () => {
  markChoices("[data-theme-set]", "themeSet", theme);
  markChoices("[data-view-set]", "viewSet", view);
  markChoices("[data-font-size]", "fontSize", String(fontSize));
  settingsDialog?.showModal();
  void loadSessions();
});

// Following the system means following it as it changes, not as it was at boot.
globalThis
  .matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });

reorderButton?.addEventListener("click", () => {
  // Raw view has no rows to drag, so the mode does not exist there. It exists from both
  // editing surfaces, because rearranging is a whole-row operation and Arrange renders
  // its own rows whichever surface you came from (#110).
  if (view === "raw") return;
  setReordering(!reordering);
});

rowsEl?.addEventListener("click", (event) => {
  const target = event.target;
  // See the note on the handler above: the glyph is an SVG, and an SVG is not an
  // HTMLElement. This is the handler where that dropped a **delete**.
  if (!(target instanceof Element)) return;

  const remove = target.closest<HTMLElement>("[data-remove]");
  if (!remove) return;

  const index = Number(remove.dataset.remove);
  const blocks = parse(body);
  if (!Number.isInteger(index) || index >= blocks.length) {
    paintRows();
    return;
  }

  // 🔴 No confirm, at any count. The revision log is the undo — principle 4 finally
  // paying for itself, and the reason #7 had to land before this could. A bulk delete
  // inherits that rather than growing a dialog, for the same reason wiping completed
  // stopped asking: the count is already legible from the page.
  //
  // One edit for the whole set, so it is one save and one revision entry. Deleting a
  // picked row deletes the selection; deleting any other row deletes only itself.
  const doomed = picked.has(index) ? [...picked] : [index];
  picked.clear();
  body = serialize(removeMany(blocks, doomed));
  paintRows();
  dirty = true;
  lastActivityAt = Date.now();
  clearTimeout(saveTimer);
  void save();
  schedulePoll();
});

// iOS does not reliably fire blur when the app is backgrounded or swiped away, so
// this is the handler that actually catches "left mid-sentence" on the device this
// product is built for. Polling stops while hidden and resumes with an immediate
// fetch, which is what makes picking up another device feel live.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    void saveNow();
    stopPolling();
    return;
  }
  void pollNow();
});

window.addEventListener("focus", () => void pollNow());

// 🔴 An accelerator, never the authority. `offline` is reliable — the OS knows there is
// no interface — so it is acted on immediately rather than waiting up to a poll tier.
// `online` only means an interface appeared, which is also what a captive portal
// reports, so it triggers a probe and lets a real request decide.
window.addEventListener("offline", () => noteConnectivity(false));
window.addEventListener("online", () => void probeConnection());

/** The consent hand-off, if this page was reached from one. See `safeNext`. */
const readNext = (): string | null => safeNext(location.search);

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  const data = new FormData(loginForm);

  if (loginError) loginError.textContent = "";
  if (button) button.disabled = true;

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        passphrase: data.get("passphrase"),
        device_label: data.get("device_label") || undefined,
      }),
    });

    if (res.ok) {
      // The cookie arrives on this response — server-set, which is the whole point
      // (spec §4). Nothing here touches document.cookie, and nothing ever should: a
      // client-set cookie dies after 7 days of Safari inactivity.
      loginForm.reset();

      // Straight back to consent when that is why we are here — no flash of the
      // editor in between, and no document fetched only to be navigated away from.
      const next = readNext();
      if (next) {
        location.assign(next);
        return;
      }

      const authedDoc = await load();
      if (authedDoc) {
        // 🔴 Before `render`, not after. Rows size themselves from `scrollHeight`,
        // and a hidden element reports 0 — painting into a hidden container clips
        // every row to nothing. See `autoGrow`.
        showEditor(true);
        render(authedDoc);
        schedulePoll();
      }
      return;
    }

    // One opaque 401 for every failure, so there is nothing more specific to say and
    // saying more would be inventing it.
    if (loginError) loginError.textContent = "wrong passphrase";
  } catch {
    if (loginError) loginError.textContent = "could not reach knag";
  } finally {
    if (button) button.disabled = false;
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

// Before the first paint, so the app never flashes the wrong theme.
theme = readTheme(globalThis.localStorage);
applyTheme();

// Same reason as the theme: applied before the first paint, or the page renders at 16px
// and jumps to the reader's size a frame later.
fontSize = readFontSize(globalThis.localStorage);
applyFontSize();

view = readView(globalThis.localStorage);

const doc = await load();
if (doc) {
  // Already logged in and sent here by the consent screen anyway — a session that was
  // absent when `/oauth/authorize` looked and present a moment later. Rare, and cheap
  // to handle: go back rather than stranding the visitor in the editor wondering what
  // happened to the thing they were authorizing.
  const pending = readNext();
  if (pending) {
    location.assign(pending);
  } else {
    // 🔴 Before `render`, not after — see the login path above and `autoGrow`.
    showEditor(true);
    render(doc);
    schedulePoll();
    // The offer survives a reload, which is most of what "rest of the day" means in
    // practice — a phone discards the page constantly and would otherwise forget the
    // wipe within seconds of you switching apps.
    paintRestore();
  }
} else {
  showEditor(false);
}

/**
 * Build info, into the settings panel.
 *
 * 🔴 "Is my change live?" cost a round trip before this existed, and "which
 * environment am I looking at" was not answerable at all — a deploy that looks right
 * and went to the wrong environment is indistinguishable from one that failed.
 *
 * It left the footer to make room, but it is **one tap away, not buried**. The
 * timestamp renders in **local** time: a UTC string is a second conversion the
 * reader has to do in their head, at the moment they are least inclined to.
 */
{
  const info = (await (await fetch("/health")).json()) as {
    version: string;
    deployed_at: string;
    environment: string;
  };

  // `0.1.5+abc1234-dirty` — the version is what a human reads, the commit is what
  // pins it to exact code. Shown apart rather than as one unreadable string.
  const [version, commit] = info.version.split("+");

  const deployed = info.deployed_at ? new Date(info.deployed_at) : null;
  const when =
    deployed && !Number.isNaN(deployed.getTime())
      ? deployed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : "not recorded";

  const set = (selector: string, value: string): void => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.textContent = value;
  };
  set("[data-build-version]", version ?? "unknown");
  set("[data-build-commit]", commit ?? "not recorded");
  set("[data-build-when]", when);
  set("[data-build-env]", info.environment);

  // Dev holds test content only and sits behind no rate-limit rule, so it stays
  // visible on the bar rather than hiding in settings — you should never have to
  // check which one you are typing into (ADR-002).
  //
  // 🔴 It fills a slot that ships `hidden` rather than being prepended to the footer.
  // Prepending put it ahead of the wordmark, which is the one element on the bar whose
  // position is the brand's rather than the app's.
  if (info.environment !== "prod" && envBadge) {
    envBadge.textContent = info.environment;
    envBadge.removeAttribute("hidden");
  }
}

// Caches the shell and never a document response — a stale body is worse than an
// offline error, and offline editing is explicitly out of scope (spec §9, §12).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // A failed registration costs the install prompt, not the app. Nothing to do.
  });
}

export {};
