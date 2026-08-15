/**
 * knag — the PWA.
 *
 * Login only. This is deliberately not the raw view (build-order step 3, issue #5):
 * no textarea, no debounce, no service worker. It exists because issue #4 has to get
 * a working login onto a phone to start the seven-day iOS cookie clock, and a login
 * endpoint with nothing able to call it starts no clock.
 *
 * 🔴 The reason this file is TypeScript and gets bundled at all: it will import
 * `worker/src/blocks.ts` — the same module the Worker uses for clear-completed. One
 * parser, not two. Two implementations of a byte-preservation contract is the most
 * likely path to a corrupted document, and each one's round-trip test passes while
 * they disagree with each other. See spec §2.
 */

const loginForm = document.querySelector<HTMLFormElement>("[data-login]");
const authedView = document.querySelector<HTMLElement>("[data-authed]");
const errorEl = document.querySelector<HTMLElement>("[data-error]");
const buildEl = document.querySelector<HTMLElement>("[data-build]");

/**
 * Ask the API who we are.
 *
 * `GET /api/doc` is the probe rather than a dedicated endpoint: 200 means the cookie
 * is live, 401 means it is not, and adding a `/api/me` would be a second answer to a
 * question one route already answers.
 */
async function isAuthenticated(): Promise<boolean> {
  const res = await fetch("/api/doc", { headers: { Accept: "application/json" } });
  return res.status === 200;
}

function show(authed: boolean): void {
  loginForm?.toggleAttribute("hidden", authed);
  authedView?.toggleAttribute("hidden", !authed);
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  const data = new FormData(loginForm);

  if (errorEl) errorEl.textContent = "";
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
      // The cookie is already set by the response — it is server-set, which is the
      // whole point (spec §4). Nothing here touches document.cookie, and nothing
      // here ever should: a client-set cookie dies after 7 days of Safari inactivity.
      loginForm.reset();
      show(true);
      return;
    }

    // The server returns one opaque 401 for every failure, so there is nothing more
    // specific to say and saying more would be inventing it.
    if (errorEl) errorEl.textContent = "Wrong passphrase.";
  } catch {
    if (errorEl) errorEl.textContent = "Could not reach knag.";
  } finally {
    if (button) button.disabled = false;
  }
});

show(await isAuthenticated());

if (buildEl) {
  const info = (await (await fetch("/health")).json()) as { version: string };
  buildEl.textContent = info.version;
}

export {};
