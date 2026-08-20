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

  /**
   * The caret offset inside whatever row is focused, or -1 if none is.
   *
   * The callback is typed structurally rather than as an `HTMLTextAreaElement` on
   * purpose: `browser/tsconfig.json` has no DOM lib, because `client/src` is the only
   * place in the tree where DOM types exist. Asking for the one property this needs
   * keeps that true.
   */
  async caretOffset(): Promise<number> {
    const focused = this.page.locator("[data-rows] .text:focus, [data-rows] .fence:focus");
    if ((await focused.count()) === 0) return -1;

    return focused.evaluate((el: { selectionStart: number | null }) => el.selectionStart ?? -1);
  }

  /**
   * Put the caret at an exact offset in a row.
   *
   * 🔴 Exists because **`Home` does not move the caret in WebKit** — it scrolls. A test
   * that pressed it looked like it was starting at the beginning of a line and was
   * really starting wherever the last click left the caret, so a `Backspace` meant to
   * merge two rows quietly deleted a character instead. The test still passed or failed;
   * it just was not testing the thing it named. Verified by probing `selectionStart`
   * before and after the keypress.
   *
   * `End` is fine and is used directly. Nothing else here should reach for `Home`.
   */
  async placeCaret(index: number, offset: number): Promise<void> {
    const field = this.editor(index);
    await field.click();
    await field.evaluate(
      (el: { focus: () => void; setSelectionRange: (a: number, b: number) => void }, at: number) => {
        el.focus();
        el.setSelectionRange(at, at);
      },
      offset,
    );
  }

  /** The `data-index` of the row holding focus, or -1. */
  async focusedRowIndex(): Promise<number> {
    const row = this.page.locator("[data-rows] li:focus-within");
    if ((await row.count()) === 0) return -1;

    return Number(await row.getAttribute("data-index"));
  }

  /** What the server actually holds — the only source of truth worth asserting on. */
  async document(): Promise<string> {
    const res = await this.page.request.get("/api/doc", {
      headers: { Authorization: `Bearer ${TEST_BEARER}` },
    });
    return ((await res.json()) as { body: string }).body;
  }

  rows() {
    return this.page.locator("[data-rows] li");
  }

  /** The editable element in row `index` — a text row or a fence. */
  editor(index: number) {
    return this.page.locator(`[data-rows] li[data-index="${index}"] .text, [data-rows] li[data-index="${index}"] .fence`);
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
