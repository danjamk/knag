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

import { mayApplyRemote, pollInterval } from "./sync.js";

type Doc = { body: string; version: number; updated_at: string };

const SAVE_DEBOUNCE_MS = 800;

const loginForm = document.querySelector<HTMLFormElement>("[data-login]");
const loginError = document.querySelector<HTMLElement>("[data-error]");
const editorView = document.querySelector<HTMLElement>("[data-editor]");
const editor = document.querySelector<HTMLTextAreaElement>("[data-body]");
const statusEl = document.querySelector<HTMLElement>("[data-save-status]");
const buildEl = document.querySelector<HTMLElement>("[data-build]");

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
  if (!editor) return;
  // Assigned verbatim. An empty body is a valid document and renders as an empty
  // editor — never an error, never a placeholder that could be saved back over it
  // (spec §14.5).
  editor.value = doc.body;
  baseVersion = doc.version;
  dirty = false;
  pendingRemote = null;
  setStatus("Saved");
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
  if (!editor) return;

  const body = editor.value;
  setStatus("Saving…");

  try {
    const res = await fetch("/api/doc", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, base_version: baseVersion }),
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

    // Only clear the flag if nothing was typed while the request was in flight.
    if (editor.value === body) {
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

editor?.addEventListener("input", scheduleSave);
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
