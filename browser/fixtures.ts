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
    await expect(this.page.locator("[data-save-status]")).toHaveText(/Saved|Cleared/, {
      timeout: 5_000,
    });
  }
}
