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
import { type ViewMode, readView, rows, writeView } from "./view.js";

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

  if (view === "list") {
    paintRows();
    return;
  }
  // Raw view is the escape hatch for bulk edits; sweeping from it would act on a
  // document the reader is mid-way through rewriting by hand.
  clearButton?.toggleAttribute("hidden", true);
}

function paintRows(): void {
  if (!rowsEl) return;
  const blocks = parse(body);
  rowsEl.replaceChildren(...rows(blocks).map(rowElement));

  // Hidden rather than disabled when there is nothing to sweep: a permanently greyed
  // destructive button is clutter, and its absence is the clearer signal.
  const completed = blocks.filter(isCompleted).length;
  clearButton?.toggleAttribute("hidden", completed === 0);
  if (clearButton) clearButton.textContent = `clear ${completed} done`;
}

function rowElement(row: ReturnType<typeof rows>[number]): HTMLLIElement {
  const li = document.createElement("li");
  li.className = row.kind;
  li.dataset.index = String(row.index);

  if (row.kind === "blank") return li;

  if (row.kind === "fence") {
    const pre = document.createElement("pre");
    // 🔴 textContent, never innerHTML. The document is authored by a human *and* by
    // an agent, and one `<img onerror>` in a note would otherwise execute here.
    pre.textContent = row.text;
    li.append(pre);
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

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = row.text;
  if (row.editable) text.tabIndex = 0;
  li.append(text);
  return li;
}

/**
 * Replace a row's text with a single-line input.
 *
 * 🔴 Single-line, and that is the design, not a limitation. A general multi-line row
 * editor means handling backspace-merges-previous-row, arrow-up-at-boundary,
 * cross-row selection and paste-splitting — a day of fiddly work and the source of
 * every cursor bug in this class of app. Everything multi-line lives in raw view,
 * where a textarea already does it correctly (spec §7).
 */
function beginEdit(span: HTMLElement): void {
  const li = span.closest("li");
  const index = Number(li?.dataset.index);
  const block = parse(body)[index];
  if (!li || !Number.isInteger(index) || !block || block.kind === "fence") return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "text";
  input.value = span.textContent ?? "";
  // Same reasons as the raw textarea: no autocorrect rewriting the document, and
  // 16px so iOS does not zoom the viewport on focus and never zoom back.
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.setAttribute("autocorrect", "off");

  let settled = false;

  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    focused = false;

    if (!commit) {
      // Escape reverts by repainting from `body`, which was never touched.
      paintRows();
      return;
    }

    // Reparse rather than reusing the block captured above: a remote update could
    // have landed while the field was open, and editing a stale block would write
    // back a line from a document that no longer exists.
    const current = parse(body);
    const target = current[index];
    if (!target || target.kind === "fence") {
      paintRows();
      return;
    }

    const next = serialize(
      current.map((b: Block, i: number) => (i === index ? { ...b, raw: setText(b, input.value) } : b)),
    );
    if (next === body) {
      paintRows();
      return;
    }

    body = next;
    paintRows();
    dirty = true;
    lastActivityAt = Date.now();
    clearTimeout(saveTimer);
    void save();
    schedulePoll();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  span.replaceWith(input);
  // Focus counts for the dirty guard: a poll landing mid-edit would repaint the row
  // list and destroy the field under the cursor (spec §6).
  focused = true;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
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

// Delegated, so it survives every repaint. Only the text span opens an editor —
// tapping the row elsewhere must stay inert, because the grip and copy controls land
// in the same row in #11 and #13.
rowsEl?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.classList.contains("text") && target.tabIndex === 0) {
    beginEdit(target);
  }
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

if (buildEl) {
  const info = (await (await fetch("/health")).json()) as { version: string };
  buildEl.textContent = info.version;
}

// Caches the shell and never a document response — a stale body is worse than an
// offline error, and offline editing is explicitly out of scope (spec §9, §12).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // A failed registration costs the install prompt, not the app. Nothing to do.
  });
}

export {};
