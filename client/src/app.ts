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
import { mayApplyRemote, pollInterval } from "./sync.js";
import Sortable from "sortablejs";
import {
  type EditResult,
  applyShorthand,
  mergeBackward,
  neighbor,
  revertShorthand,
  splitAt,
} from "./edit.js";
import { type ViewMode, linkify, move, readView, removeAt, rows, writeView } from "./view.js";

type Doc = { body: string; version: number; updated_at: string };

const SAVE_DEBOUNCE_MS = 800;

const loginForm = document.querySelector<HTMLFormElement>("[data-login]");
const loginError = document.querySelector<HTMLElement>("[data-error]");
const editorView = document.querySelector<HTMLElement>("[data-editor]");
const editor = document.querySelector<HTMLTextAreaElement>("[data-body]");
const statusEl = document.querySelector<HTMLElement>("[data-save-status]");
const buildEl = document.querySelector<HTMLElement>("[data-build]");
const rowsEl = document.querySelector<HTMLUListElement>("[data-rows]");
const toggleViewButton = document.querySelector<HTMLButtonElement>("[data-toggle-view]");
const clearButton = document.querySelector<HTMLButtonElement>("[data-clear]");
const reorderButton = document.querySelector<HTMLButtonElement>("[data-reorder]");

/** Above this many, a sweep gets a confirm. Below it, undo-by-history is enough. */
const CONFIRM_CLEAR_ABOVE = 10;

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

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function showEditor(authed: boolean): void {
  loginForm?.toggleAttribute("hidden", authed);
  editorView?.toggleAttribute("hidden", !authed);
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Returns null when unauthenticated, so the caller shows the login screen. */
async function load(): Promise<Doc | null> {
  const res = await fetch("/api/doc", { headers: { Accept: "application/json" } });
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
  setStatus("Saved");
}

// ── Rendering (spec §7) ──────────────────────────────────────────────────────

/** Draw whichever view is active from `body`. Never the other way round. */
function paint(): void {
  if (editor) editor.value = body;
  editor?.toggleAttribute("hidden", view !== "raw");
  rowsEl?.toggleAttribute("hidden", view !== "list");
  if (toggleViewButton) toggleViewButton.textContent = view === "list" ? "raw" : "list";

  reorderButton?.toggleAttribute("hidden", view !== "list");

  if (view === "list") {
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
  rowsEl.replaceChildren(...rows(blocks).map(rowElement));

  refreshClearButton();
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
  clearButton?.toggleAttribute("hidden", completed === 0 || view !== "list");
  if (clearButton) clearButton.textContent = `clear ${completed} done`;
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
  grip.textContent = "⠿";
  grip.setAttribute("aria-hidden", "true");
  return grip;
}

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
  button.textContent = "\u00d7";
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
  button.textContent = "⧉";
  button.title = "copy";
  button.dataset.copy = text;
  return button;
}

function rowElement(row: ReturnType<typeof rows>[number]): HTMLLIElement {
  const li = document.createElement("li");
  li.className = row.kind;
  li.dataset.index = String(row.index);

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
    li.append(area, copyElement(row.text));
    if (reordering) li.append(removeElement(row.index));
    return li;
  }

  if (row.kind === "checkbox") {
    if (row.checked) li.classList.add("checked");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = row.checked === true;
    // Checked items stay where they are. No auto-sink (spec §7).
    li.append(box);
  }

  // 🔴 A live input, not a span you tap to activate. This is the whole point of
  // ADR-003: the editor is where you land, and typing is the primary interaction.
  const input = document.createElement("input");
  input.type = "text";
  input.className = "text";
  input.value = row.text;
  // On for prose, off inside fences above. Autocorrect is the user typing, mediated
  // by their keyboard — not knag rewriting bytes (ADR-003 §6).
  input.spellcheck = true;
  input.autocapitalize = "sentences";
  input.setAttribute("autocorrect", "on");
  li.append(input);

  // 🔴 A link affordance rather than an inline anchor. An <input> cannot contain
  // one, and the alternatives are contenteditable (rejected by ADR-003) or swapping
  // the element on focus (the tap-to-activate step this issue removes). So a row
  // holding a URL gets a button that opens it, and the URL stays editable text.
  const [first] = linkify(row.text).filter((segment) => segment.link);
  if (first) li.append(openElement(first.value));

  li.append(copyElement(row.text));
  if (reordering) li.append(removeElement(row.index));
  return li;
}

/** Opens the row's first URL. Only rendered when there is one. */
function openElement(url: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "open";
  anchor.href = url;
  anchor.textContent = "\u2197";
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

    if (res.status === 304) return;
    if (res.status === 401) {
      stopPolling();
      showEditor(false);
      return;
    }
    if (!res.ok) return;

    const doc = (await res.json()) as Doc;
    if (doc.version === baseVersion) return;

    if (mayApplyRemote({ dirty, focused })) {
      render(doc);
      setStatus("Updated from another device");
    } else {
      // Queued. Applied on blur, or subsumed by the 409 the pending local save is
      // about to get — either way the device converges without the caret moving.
      pendingRemote = doc;
    }
  } catch {
    // A failed poll is not worth surfacing; the next one is seconds away and the
    // save path reports its own failures.
  }
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
 * Write the editor's exact contents.
 *
 * 🔴 Never retry with the stale body. On 409 the server's copy wins and is loaded —
 * a retry carrying what we already had is the one catastrophic data-loss path in
 * this project, and the 409 carries the current body precisely so that a second
 * round trip is unnecessary (spec §5, §6).
 *
 * A 409 also subsumes anything sitting in `pendingRemote`: the server's copy is by
 * definition at least as new as whatever the poll saw, so `render` clears the queue.
 */
async function save(): Promise<void> {
  // Sent from `body`, not from the textarea. In list view the textarea is hidden and
  // its value is whatever was last painted into it; reading from the element would
  // save the wrong document the moment a checkbox is toggled.
  const sent = body;
  setStatus("Saving…");

  try {
    const res = await fetch("/api/doc", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: sent, base_version: baseVersion }),
    });

    if (res.status === 401) {
      showEditor(false);
      return;
    }

    if (res.status === 409) {
      render((await res.json()) as Doc);
      setStatus("Reloaded — it had changed elsewhere");
      return;
    }

    if (!res.ok) throw new Error(String(res.status));

    const { version } = (await res.json()) as { version: number };
    baseVersion = version;

    // Only clear the flag if nothing changed while the request was in flight.
    if (body === sent) {
      dirty = false;
      setStatus("Saved");
    }
  } catch {
    setStatus("Not saved — retrying on the next edit");
  }
}

function scheduleSave(): void {
  dirty = true;
  lastActivityAt = Date.now();
  setStatus("Editing…");
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
    saveNow();
    return;
  }
  applyPendingRemote();
});

function saveNow(): void {
  if (!dirty) return;
  clearTimeout(saveTimer);
  void save();
}

function applyPendingRemote(): void {
  if (!pendingRemote) return;
  render(pendingRemote);
  setStatus("Updated from another device");
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
      saveNow();
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

  // Arrows only cross a row boundary when the caret is already at one — otherwise
  // they belong to the field, which is what makes long lines navigable.
  if (event.key === "ArrowUp" && start === 0) {
    event.preventDefault();
    const result = neighbor(body, index, -1, start);
    focusRow(result.focusIndex, editorIn(result.focusIndex)?.value.length ?? 0);
    return;
  }

  if (event.key === "ArrowDown" && end === target.value.length) {
    event.preventDefault();
    const result = neighbor(body, index, 1, end);
    focusRow(result.focusIndex, result.focusOffset);
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
clearButton?.addEventListener("click", async () => {
  const completed = parse(body).filter(isCompleted).length;
  if (completed === 0) return;

  // Confirm only above the threshold. Prompting on every sweep trains the reflex that
  // makes the prompt useless on the one that matters (spec §7).
  if (completed > CONFIRM_CLEAR_ABOVE && !confirm(`Clear ${completed} completed items?`)) {
    return;
  }

  saveNow();
  setStatus("Clearing…");

  try {
    const res = await fetch("/api/doc/clear-completed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: baseVersion }),
    });

    if (res.status === 401) {
      showEditor(false);
      return;
    }

    if (res.status === 409) {
      render((await res.json()) as Doc);
      setStatus("Reloaded — it had changed elsewhere");
      return;
    }

    if (!res.ok) throw new Error(String(res.status));

    const { cleared_count: count } = (await res.json()) as { cleared_count: number };

    // Re-read rather than trusting a locally computed result. The server decided what
    // "completed" meant and rewrote the document; this asks what it actually is.
    const doc = await load();
    if (doc) render(doc);
    setStatus(count === 0 ? "Nothing to clear" : `Cleared ${count}`);
  } catch {
    setStatus("Not cleared — nothing was changed");
  }
});

// Delegated, so it survives every repaint.
rowsEl?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  // A link is a link. Tapping one navigates rather than opening the editor — which
  // does mean a row that is nothing but a URL can only be edited from raw view, and
  // that is the right trade: a bare URL row is a bookmark, not prose.
  if (target.closest("a")) return;

  const copy = target.closest<HTMLElement>("[data-copy]");
  if (copy) {
    void copyToClipboard(copy.dataset.copy ?? "", copy);
    return;
  }

});

/**
 * Copy, with the result shown on the button itself.
 *
 * `navigator.clipboard` rejects when the page is not a secure context or the gesture
 * is not trusted, and a copy that silently does nothing is worse than one that says
 * so — you find out when you paste.
 */
async function copyToClipboard(text: string, button: HTMLElement): Promise<void> {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "✓";
  } catch {
    button.textContent = "✗";
  }
  setTimeout(() => {
    button.textContent = original;
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
  rowsEl?.classList.toggle("reorder", on);
  reorderButton?.classList.toggle("on", on);
  if (reorderButton) reorderButton.textContent = on ? "done" : "reorder";
  sortable?.option("disabled", !on);

  // Leaving the mode flushes anything the drags queued, so the document is settled
  // before the caret goes anywhere near it again.
  if (!on) saveNow();
  paintRows();
}

reorderButton?.addEventListener("click", () => {
  // Switching to raw view while reordering would leave the mode on with nothing to
  // drag, so the mode belongs to the list view only.
  if (view !== "list") return;
  setReordering(!reordering);
});

rowsEl?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const remove = target.closest<HTMLElement>("[data-remove]");
  if (!remove) return;

  const index = Number(remove.dataset.remove);
  const blocks = parse(body);
  if (!Number.isInteger(index) || index >= blocks.length) {
    paintRows();
    return;
  }

  // 🔴 No confirm. The revision log is the undo — principle 4 finally paying for
  // itself, and the reason #7 had to land before this could.
  body = serialize(removeAt(blocks, index));
  paintRows();
  dirty = true;
  lastActivityAt = Date.now();
  clearTimeout(saveTimer);
  void save();
  schedulePoll();
});

toggleViewButton?.addEventListener("click", () => {
  // Flush first. Switching views repaints the textarea from `body`, and an unsaved
  // edit still sitting on the debounce would be preserved but its save would race
  // the repaint.
  saveNow();
  view = view === "list" ? "raw" : "list";
  writeView(globalThis.localStorage, view);
  paint();
});

// iOS does not reliably fire blur when the app is backgrounded or swiped away, so
// this is the handler that actually catches "left mid-sentence" on the device this
// product is built for. Polling stops while hidden and resumes with an immediate
// fetch, which is what makes picking up another device feel live.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveNow();
    stopPolling();
    return;
  }
  void pollNow();
});

window.addEventListener("focus", () => void pollNow());

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
      const authedDoc = await load();
      if (authedDoc) {
        render(authedDoc);
        showEditor(true);
        schedulePoll();
      }
      return;
    }

    // One opaque 401 for every failure, so there is nothing more specific to say and
    // saying more would be inventing it.
    if (loginError) loginError.textContent = "Wrong passphrase.";
  } catch {
    if (loginError) loginError.textContent = "Could not reach knag.";
  } finally {
    if (button) button.disabled = false;
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

view = readView(globalThis.localStorage);

const doc = await load();
if (doc) {
  render(doc);
  showEditor(true);
  schedulePoll();
} else {
  showEditor(false);
}

/**
 * The build id, with everything else on hover.
 *
 * 🔴 "Is my change live?" cost a round trip before this existed, and "which
 * environment am I looking at" was not answerable at all. A deploy that looks right
 * and went to the wrong environment is indistinguishable from one that failed.
 *
 * The timestamp renders in **local** time. A UTC string in a tooltip is a second
 * conversion the reader has to do in their head, at the moment they are least
 * inclined to.
 */
if (buildEl) {
  const info = (await (await fetch("/health")).json()) as {
    version: string;
    deployed_at: string;
    environment: string;
  };

  buildEl.textContent = info.version;
  buildEl.dataset.env = info.environment;

  const deployed = info.deployed_at ? new Date(info.deployed_at) : null;
  const when =
    deployed && !Number.isNaN(deployed.getTime())
      ? deployed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : "not recorded";

  buildEl.title = [
    `build     ${info.version}`,
    `deployed  ${when}`,
    `env       ${info.environment}`,
  ].join("\n");

  // Dev holds test content only and sits behind no rate-limit rule. It should look
  // like somewhere you would not paste anything real (ADR-002).
  if (info.environment !== "prod") {
    const badge = document.createElement("span");
    badge.className = "env";
    badge.textContent = info.environment;
    buildEl.before(badge);
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
