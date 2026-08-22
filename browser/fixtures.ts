import { type Page, expect, test as base } from "@playwright/test";
import { TEST_BEARER, TEST_PASSPHRASE } from "../playwright.config.js";

/**
 * Shared setup: a logged-in page holding a known document.
 *
 * 🔴 The document is seeded through the **API with the bearer token**, not by typing
 * it in. Typing it would make every test depend on the editor being correct, which is
 * the thing under test — a broken editor would produce a broken fixture and then
 * agree with itself.
 */

export const test = base.extend<{ knag: Knag }>({
  knag: async ({ page, request }, use) => {
    const knag = new Knag(page);
    await knag.login();
    await use(knag);
    void request;
  },
});

export { expect };

export class Knag {
  constructor(readonly page: Page) {}

  /**
   * Log in through the real form, since that is also the first thing to break.
   *
   * 🔴 Waits for the boot to settle before deciding. **Both** the login form and the
   * editor start `hidden` in the markup, and the boot decides which appears — so
   * calling `isVisible()` straight after `goto()` races it, finds neither, skips the
   * login, and then waits five seconds for an editor that will never come.
   *
   * It passed locally every time and failed in CI, where the cold start is slower.
   * A browser suite that is flaky is worse than none, because the next real failure
   * gets re-run instead of read.
   */
  async login(): Promise<void> {
    await this.page.goto("/");
    const form = this.page.locator("[data-login]");
    const editor = this.page.locator("[data-editor]");

    await expect(form.or(editor).first()).toBeVisible();
    if (await form.isVisible()) {
      await form.locator('input[name="passphrase"]').fill(TEST_PASSPHRASE);
      await form.locator('input[name="device_label"]').fill("playwright");
      await form.locator("button[type=submit]").click();
    }
    await expect(editor).toBeVisible();
  }

  /** Replace the document via the API, then reload so the page renders it fresh. */
  async seed(body: string): Promise<void> {
    const headers = { Authorization: `Bearer ${TEST_BEARER}`, "Content-Type": "application/json" };
    const current = await this.page.request.get("/api/doc", { headers });
    const { version } = (await current.json()) as { version: number };

    const wrote = await this.page.request.put("/api/doc", {
      headers,
      data: { body, base_version: version },
    });
    expect(wrote.ok()).toBe(true);

    await this.page.reload();
    await expect(this.page.locator("[data-editor]")).toBeVisible();
  }

  /**
   * Change the page from outside this browser tab, **without reloading it**.
   *
   * What `seed` cannot do: `seed` reloads, which is how you set up a fixture and also
   * how you paper over a sync bug. This simulates the other device, and leaves the page
   * to notice on its own — which is the thing under test.
   */
  async writeExternally(body: string): Promise<void> {
    const headers = { Authorization: `Bearer ${TEST_BEARER}`, "Content-Type": "application/json" };
    const current = await this.page.request.get("/api/doc", { headers });
    const { version } = (await current.json()) as { version: number };

    const wrote = await this.page.request.put("/api/doc", {
      headers,
      data: { body, base_version: version },
    });
    expect(wrote.ok()).toBe(true);
  }

  // 🔴 `caretOffset` and `placeCaret` were deleted with the row list (#113). Both read
  // and wrote a `<textarea>`'s `selectionStart`, which no row has because no row exists.
  //
  // `placeCaret` is worth one line of epitaph: it existed because **`Home` does not move
  // the caret in WebKit** — it scrolls — so a test that pressed it looked like it was
  // starting at the beginning of a line and was really starting wherever the last click
  // left it. That trap belongs to the platform, not to the row model, and
  // `caretAtEndOfLine` below avoids it the same way, by never pressing `Home`.

  /**
   * What the server holds for the **default page** — the source of truth worth asserting
   * on, for that page.
   *
   * 🔴 It reads `/api/doc` with no `page`, which is the default page by definition and
   * **not the page the browser is showing**. That is right for asserting the seeded
   * document was left alone, which is what every caller wants it for; it is wrong, and
   * quietly wrong, for asserting what a *second* page holds. Use `documentOn` for that.
   *
   * The name predates pages and the trap is the name: "the document" stopped being a thing
   * in 1.1.0.
   */
  async document(): Promise<string> {
    const res = await this.page.request.get("/api/doc", {
      headers: { Authorization: `Bearer ${TEST_BEARER}` },
    });
    return ((await res.json()) as { body: string }).body;
  }

  /** What the server holds for a **named** page. */
  async documentOn(name: string): Promise<string> {
    const res = await this.page.request.get(`/api/doc?page=${await this.pageId(name)}`, {
      headers: { Authorization: `Bearer ${TEST_BEARER}` },
    });
    return ((await res.json()) as { body: string }).body;
  }

  /**
   * Arrange's rows.
   *
   * 🔴 `[data-rows]` holds **only Arrange** now (#113). Outside the mode it is empty, so
   * a test that means "the lines of the document" wants `lines()` below — the two were
   * the same thing while the row list was the editing surface, and reading `rows()` as
   * "the document" is how several tests quietly stopped asserting anything.
   */
  rows() {
    return this.page.locator("[data-rows] li");
  }

  /** The lines of the document, as the editing surface renders them. */
  lines() {
    return this.page.locator("[data-surface] .cm-line");
  }

  /**
   * Line `index` of the editing surface, zero-based.
   *
   * 🔴 This used to be row `index`'s `<textarea>` (#113). The row list is gone, so it now
   * points at a `.cm-line` — which is a `div`, not a form control. `toHaveValue` and
   * `fill` do not work on it; use `toHaveText` and the keyboard. Clicking it still focuses
   * the surface at that line, which is what most callers wanted.
   *
   * Arrange's rows are reached with `rows()`, which is unchanged — that rendering
   * survived, and it is the only thing `[data-rows]` holds now.
   */
  editor(index: number) {
    return this.page.locator("[data-surface] .cm-line").nth(index);
  }

  /** Wait for the save to land, so document() is not read mid-flight. */
  async saved(): Promise<void> {
    // Lowercase since the machine voice landed: `saved`, never `Saved ✓`.
    //
    // 🔴 `wiped` is accepted because a sweep is a save and leaves that on the status
    // line — which also makes this **useless immediately after a wipe**: the status
    // already matches, so it returns without waiting for the edit you just made. If a
    // test types after a wipe and then depends on the save having landed, poll
    // `document()` for the text instead. One test learned this in CI.
    await expect(this.page.locator("[data-save-status]")).toHaveText(/saved|wiped/, {
      timeout: 5_000,
    });
  }

  /**
   * Retire every page but the default one.
   *
   * 🔴 The browser suite runs against one live database and nothing resets it between
   * tests — `seed` replaces the *document*, which was the whole state until pages existed
   * (#154). Without this, a page created in one test is still there in the next, and the
   * second test to ask for a page called `shopping` fails on a duplicate name with an
   * error that says nothing about the real cause.
   */
  async resetPages(): Promise<void> {
    const headers = { Authorization: `Bearer ${TEST_BEARER}` };
    const res = await this.page.request.get("/api/pages", { headers });
    const { pages } = (await res.json()) as { pages: Array<{ id: number }> };

    for (const entry of pages) {
      if (entry.id === 1) continue;
      await this.page.request.delete(`/api/pages/${entry.id}`, { headers });
    }

    // 🔴 And clear the default page's template. Deleting the *pages* is not enough:
    // a template saved by an earlier run makes every new page start from that body, so a
    // test asserting a fresh page is empty fails with the previous test's document in it.
    // Membership is not the whole of a page's state.
    await this.page.request.patch("/api/pages/1", {
      headers: { ...headers, "Content-Type": "application/json" },
      data: { template: "clear" },
    });
  }

  /**
   * Save the page's current body as its template (#165), the way manage-pages does.
   *
   * 🔴 Whatever saves one **must** clear it. The browser suite runs against one live
   * database, and a template left on page 1 changes what every later whole-page wipe
   * does — the wipe stops emptying the page and starts resetting it, so an unrelated
   * test fails with the previous test's groceries in it. `resetPages` clears it; call it
   * in an `afterEach`.
   */
  async saveTemplate(name = "today"): Promise<void> {
    const res = await this.page.request.patch(`/api/pages/${await this.pageId(name)}`, {
      headers: { Authorization: `Bearer ${TEST_BEARER}`, "Content-Type": "application/json" },
      data: { template: "save" },
    });
    expect(res.ok()).toBe(true);
  }

  /**
   * A page's id, by name.
   *
   * 🔴 Never a literal. Page ids autoincrement and `resetPages` **retires** rather than
   * removes, so the second page of the third run is id 7 — a test that hardcodes `2` passes
   * on a fresh database and fails on a real one, which is the same trap the backfill
   * assertion in `pages-migration.test.ts` was built to avoid.
   */
  async pageId(name: string): Promise<number> {
    const res = await this.page.request.get("/api/pages", {
      headers: { Authorization: `Bearer ${TEST_BEARER}` },
    });
    const { pages } = (await res.json()) as { pages: Array<{ id: number; name: string }> };
    const found = pages.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    expect(found, `no page called ${name}`).toBeTruthy();
    return found?.id ?? 1;
  }

  /**
   * Replace a **named page's** document through the API, without reloading.
   *
   * 🔴 `seed` cannot do this: it PUTs `/api/doc` with no `page`, which is the *default*
   * page by definition, and it reloads. Setting up a second page's body needs the id and
   * needs the tab to stay where it is.
   */
  async setPage(name: string, body: string): Promise<void> {
    const headers = { Authorization: `Bearer ${TEST_BEARER}`, "Content-Type": "application/json" };
    const pageId = await this.pageId(name);
    const current = await this.page.request.get(`/api/doc?page=${pageId}`, { headers });
    const { version } = (await current.json()) as { version: number };

    const wrote = await this.page.request.put(`/api/doc?page=${pageId}`, {
      headers,
      data: { body, base_version: version, page: pageId },
    });
    expect(wrote.ok()).toBe(true);

    await this.page.reload();
    await expect(this.page.locator("[data-editor]")).toBeVisible();
  }

  /**
   * Make a page through the switcher, the way a person does, and land on it.
   *
   * 🔴 Waits for the surface to hold focus, not just for the label (#177). The submit
   * handler closes the dialog, awaits `openPage` — which sets the label — and only then
   * focuses the surface. Returning on the label leaves that focus in flight, and when it
   * lands it closes the switcher under whatever the caller opened next.
   */
  async newPage(name: string): Promise<void> {
    await this.page.locator("[data-page-name]").click();
    await this.page.locator("[data-manage-open]").click();
    await expect(this.page.locator("[data-manage-pane]")).toBeVisible();
    await this.page.locator('[data-new-page] input[name="name"]').fill(name);
    await this.page.locator("[data-new-page-submit]").click();
    await expect(this.page.locator("[data-page-label]")).toHaveText(name);
    await expect(this.surface()).toBeFocused();
  }

  /** Tier 2 of the bar (#139). */
  ledge() {
    return this.page.locator("[data-ledge]");
  }

  /**
   * Open the ledge the way a person does.
   *
   * 🔴 Not by setting `data-open` by hand. The opening *is* the code path — the ledge
   * closes on any focus outside the bar, so a test that forced the attribute would keep
   * passing after the toggle stopped working, and would never notice that the thing
   * under it had closed the ledge again.
   *
   * Idempotent, because Arrange leaves it open and Settings does not: a modal moves
   * focus into itself, which is exactly the condition that closes it.
   */
  async openLedge(): Promise<void> {
    if ((await this.ledge().getAttribute("data-open")) === null) {
      await this.page.locator("[data-ledge-toggle]").click();
    }
    await expect(this.ledge()).toBeVisible();

    // 🔴 Then wait for it to finish opening. It becomes *visible* the moment the height
    // leaves zero and takes 90ms to arrive, so anything that reads a bounding box right
    // after this reads a partly-open ledge — which is how a "does the bar grow by 56px"
    // assertion measured 18. `click` waits for stability on its own; a measurement does
    // not, so it settles here once rather than in every test that measures.
    let previous = -1;
    await expect
      .poll(async () => {
        const height = (await this.ledge().boundingBox())?.height ?? 0;
        const settled = height > 0 && height === previous;
        previous = height;
        return settled;
      })
      .toBe(true);
  }

  /** Settings, which is on the ledge now — one rung out, not three taps deep. */
  async openSettings(): Promise<void> {
    await this.openLedge();
    await this.page.locator("[data-settings-open]").click();
    await expect(this.page.locator("[data-settings]")).toBeVisible();
  }

  /** Toggle Arrange, which is on the ledge now. Toggles, so it also leaves the mode. */
  async arrange(): Promise<void> {
    await this.openLedge();
    await this.page.locator("[data-reorder]").click();
  }

  /**
   * Switch to the CodeMirror surface the way a person does — through Settings.
   *
   * 🔴 Not by writing localStorage and reloading. The preference and the mount are two
   * different things and a test that sets the former proves nothing about the latter;
   * the switch itself is a code path (`paint`) that has to destroy one surface and build
   * another without losing the document.
   */
  async useEditor(): Promise<void> {
    // 🔴 The editing surface is the default now (#113) — the row list is gone. This used
    // to be the only way to reach it and is kept because dozens of tests say it, and
    // because it still exercises the real path when something else has switched away.
    if (await this.surface().isVisible()) return;

    await this.openSettings();
    await this.page.locator('[data-view-set="editor"]').click();
    await this.page.keyboard.press("Escape");
    await expect(this.surface()).toBeVisible();
  }

  /** The contenteditable CodeMirror owns. */
  surface() {
    return this.page.locator("[data-surface] .cm-content");
  }

  /** Every checkbox control drawn over the bytes. */
  boxes() {
    return this.page.locator("[data-surface] input.cm-box");
  }

  /**
   * Put the caret at the end of line `n`, one-based.
   *
   * 🔴 Not `ControlOrMeta+End`. Every seeded document here ends with a newline, so the
   * document ends on an *empty* line — and eight tests asserted checkbox continuation
   * while the caret sat on a blank line below it, then reported the feature broken.
   */
  async caretAtEndOfLine(n: number): Promise<void> {
    await this.surface().click();
    await this.page.keyboard.press("ControlOrMeta+Home");
    for (let i = 1; i < n; i += 1) await this.page.keyboard.press("ArrowDown");
    await this.page.keyboard.press("End");
  }

  /** What the browser reports as selected — the only honest answer to "does it span". */
  async selection(): Promise<string> {
    // Structurally typed: this tsconfig has no DOM lib on purpose, and adding one to
    // reach `getSelection` would put `document` in scope for every test file.
    return this.page.evaluate(() => {
      const host = globalThis as { getSelection?: () => { toString(): string } | null };
      return host.getSelection?.()?.toString() ?? "";
    });
  }

  /** The post-wipe recovery line, as one string: `wiped 3 · bring back`. */
  recovery() {
    return this.page.locator("[data-recovery]");
  }
}
