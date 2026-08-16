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
import {
  type EditResult,
  applyShorthand,
  mergeBackward,
  neighbor,
  revertShorthand,
  splitAt,
} from "./edit.js";
import {
  type Theme,
  type ViewMode,
  linkify,
  move,
  readTheme,
  readView,
  removeAt,
  rows,
  themeColor,
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
const clearCountEl = document.querySelector<HTMLElement>("[data-clear-count]");
const rowsEl = document.querySelector<HTMLUListElement>("[data-rows]");
const clearButton = document.querySelector<HTMLButtonElement>("[data-clear]");
const wipeAllButton = document.querySelector<HTMLButtonElement>("[data-wipe-all]");
const restoreButton = document.querySelector<HTMLButtonElement>("[data-restore]");
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

/** Persisted, unlike the mode — this is a preference, not something you are doing. */
let theme: Theme = "system";

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

function setStatus(text: string): void {
  lastStatus = text;
  if (connectivity === "online" && statusEl) statusEl.textContent = text;
}

function paintConnectivity(): void {
  if (!statusEl) return;
  const offline = connectivityStatus({ connectivity, unsavedRows: dirty ? 1 : 0 });
  statusEl.textContent = offline ?? lastStatus;
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

  paintRows();
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
  setStatus("Saved");
}

// ── Rendering (spec §7) ──────────────────────────────────────────────────────

/** Draw whichever view is active from `body`. Never the other way round. */
function paint(): void {
  if (editor) editor.value = body;
  editor?.toggleAttribute("hidden", view !== "raw");
  rowsEl?.toggleAttribute("hidden", view !== "list");

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
  clearButton?.toggleAttribute("hidden", completed === 0 || view !== "list");
  // Only the count changes — rewriting the button's whole text would drop the icon.
  if (clearCountEl) clearCountEl.textContent = String(completed);
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
  // one, and the alternatives are contenteditable (rejected by ADR-003) or swapping
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
    if (first) setStatus("Update waiting — saving yours first");
    return;
  }

  if (disposition === "apply") {
    render(doc);
    setStatus("Updated from another device");
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

  setStatus("Updated from another device");
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
    // 🔴 `dirty` deliberately stays true. The edit is still in the page and still
    // unsaved, and it is what the footer counts — an edit that vanished from the
    // status while sitting unsaved on screen is the failure spec §9 is about. On
    // reconnect `noteConnectivity` retries it as an ordinary versioned write.
    setStatus("Not saved — retrying on the next edit");
    paintConnectivity();
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
  if (!restoreButton) return;

  restoreButton.toggleAttribute("hidden", memory === null);
  if (memory) restoreButton.textContent = `wiped ${memory.count} · bring back`;
}

async function requestWipe(scope: "completed" | "all"): Promise<void> {
  saveNow();
  setStatus(scope === "all" ? "Wiping…" : "Clearing…");

  // Captured before the request, because it is the only copy of the pre-wipe page this
  // device will have — the server keeps its own sealed snapshot, but reaching it would
  // need a route that does not exist.
  const preWipe = body;

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
      setStatus("Reloaded — it had changed elsewhere");
      return;
    }

    if (!res.ok) throw new Error(String(res.status));

    const { wiped_count: count } = (await res.json()) as { wiped_count: number };

    // Re-read rather than trusting a locally computed result. The server decided what
    // was removed and rewrote the document; this asks what it actually is.
    const doc = await load();
    if (doc) render(doc);

    if (count === 0) {
      setStatus(scope === "all" ? "Nothing to wipe" : "Nothing to clear");
    } else {
      setStatus(scope === "all" ? `Wiped ${count}` : `Cleared ${count}`);
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
    setStatus(scope === "all" ? "Not wiped — nothing was changed" : "Not cleared — nothing was changed");
  }
}

clearButton?.addEventListener("click", async () => {
  const completed = parse(body).filter(isCompleted).length;
  if (completed === 0) return;

  // Confirm only above the threshold. Prompting on every sweep trains the reflex that
  // makes the prompt useless on the one that matters (spec §7).
  if (completed > CONFIRM_CLEAR_ABOVE && !confirm(`Clear ${completed} completed items?`)) {
    return;
  }

  await requestWipe("completed");
});

/**
 * Wipe the whole page (#58).
 *
 * 🔴 Always confirms, unlike the sweep. Spec §7's argument for a threshold is that
 * prompting on every routine action trains the reflex that makes the prompt useless —
 * but this one is not routine and it takes work that was never finished, which is the
 * case the reflex would cost most. It also names the number, because "wipe the page"
 * and "throw away eleven things" land differently.
 */
wipeAllButton?.addEventListener("click", async () => {
  const rows = parse(body).length;
  if (body === "") {
    setStatus("Nothing to wipe");
    return;
  }

  if (!confirm(`Wipe all ${rows} lines? Everything goes, finished or not.`)) return;

  await requestWipe("all");
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
  saveNow();
  setStatus("Bringing back…");

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
      setStatus("Reloaded — it had changed elsewhere");
      return;
    }

    if (!res.ok) throw new Error(String(res.status));

    const doc = await load();
    if (doc) render(doc);

    forgetWipe();
    setStatus(`Brought back ${memory.count}`);
  } catch {
    setStatus("Not restored — nothing was changed");
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
  // 🔴 Both states are icons. The first version wrote the word "reorder" on the way
  // out, so the button silently changed shape the first time it was used and never
  // changed back — the markup said `⇅` and only the initial render agreed with it.
  if (reorderButton) {
    reorderButton.textContent = on ? "✓" : "⇅";
    reorderButton.title = on ? "done rearranging" : "rearrange, copy, delete";
  }
  sortable?.option("disabled", !on);

  // Leaving the mode flushes anything the drags queued, so the document is settled
  // before the caret goes anywhere near it again.
  if (!on) saveNow();
  paintRows();
}

/**
 * Apply the theme to the document, and to the iOS status bar.
 *
 * 🔴 The `theme-color` meta tag is what iOS paints the status bar from. Leaving it
 * dark under a light theme puts a black strip above a white app, which reads as a
 * rendering bug rather than a preference (spec §9).
 */
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
  if (!(target instanceof HTMLElement)) return;

  const chosenTheme = target.closest<HTMLElement>("[data-theme-set]")?.dataset.themeSet;
  if (chosenTheme) {
    theme = chosenTheme as Theme;
    writeTheme(globalThis.localStorage, theme);
    applyTheme();
    return;
  }

  const chosenView = target.closest<HTMLElement>("[data-view-set]")?.dataset.viewSet;
  if (chosenView && chosenView !== view) {
    // Flush first: switching views repaints from `body`, and an unsaved edit still
    // on the debounce would have its save race the repaint.
    saveNow();
    view = chosenView as ViewMode;
    writeView(globalThis.localStorage, view);
    paint();
    markChoices("[data-view-set]", "viewSet", view);
  }
});

settingsOpen?.addEventListener("click", () => {
  markChoices("[data-theme-set]", "themeSet", theme);
  markChoices("[data-view-set]", "viewSet", view);
  settingsDialog?.showModal();
});

// Following the system means following it as it changes, not as it was at boot.
globalThis
  .matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });

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
    if (loginError) loginError.textContent = "Wrong passphrase.";
  } catch {
    if (loginError) loginError.textContent = "Could not reach knag.";
  } finally {
    if (button) button.disabled = false;
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

// Before the first paint, so the app never flashes the wrong theme.
theme = readTheme(globalThis.localStorage);
applyTheme();

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
  if (info.environment !== "prod") {
    const badge = document.createElement("span");
    badge.className = "env";
    badge.textContent = info.environment;
    document.querySelector("footer")?.prepend(badge);
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
