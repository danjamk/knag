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
/** True between an edit and its save landing. The dirty guard in #6 builds on this. */
let dirty = false;

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
  setStatus("Saved");
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
 * Losing the local edit on conflict is deliberate for now and only survivable
 * because this is a single user on a debounce: #6 adds the dirty guard that stops a
 * remote update landing mid-keystroke.
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
  setStatus("Editing…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
}

function saveNow(): void {
  if (!dirty) return;
  clearTimeout(saveTimer);
  void save();
}

// ── Wiring ───────────────────────────────────────────────────────────────────

editor?.addEventListener("input", scheduleSave);
editor?.addEventListener("blur", saveNow);

// iOS does not reliably fire blur when the app is backgrounded or swiped away, so
// this is the handler that actually catches "left mid-sentence" on the device this
// product is built for.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow();
});

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
