import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { TEST_BEARER, memberRowsSql } from "../playwright.config.js";

/**
 * Booting as somebody who is not the operator (#240).
 *
 * 🔴 **This is the coverage that was missing, and its absence is the whole bug.** Every
 * other spec logs in through the fixture, as the operator, whose default page genuinely
 * is the lowest id in the database — so the client's `DEFAULT_PAGE_ID = 1` fallback
 * agreed with the truth in all 244 of them and was wrong for every other person alive.
 * A member landed on a page they did not own, got a 404 the fallback had no handler for,
 * and saw a blank screen. Found on prod by opening an invite link, not by the suite.
 *
 * So: the bare Playwright `test`, not the fixture, and a session written straight into
 * the local D1 the way `devices.spec.ts` makes its second device. The one thing every
 * test here asserts is that the app renders *something* — a blank page is the failure.
 */

// Unique per run: the local D1 persists, and the seed clears members but a half-finished
// run could leave one behind.
const RUN = Math.random().toString(36).slice(2, 8);
const EMAIL = `member-${RUN}@knag.test`;
const TOKEN = `playwright-member-${RUN}`;

/** Structural types — `browser/tsconfig.json` has no DOM lib, on purpose. */
type Store = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
type WithStorage = { localStorage: Store };

const PAGE_KEY = "knag.page";

function makeMember(): void {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "knag-dev",
      "--local",
      "--config",
      "worker/wrangler.jsonc",
      "--command",
      memberRowsSql(EMAIL, TOKEN, `member-${RUN}`),
    ],
    { stdio: "ignore" },
  );
}

test.describe("a member, not the operator", () => {
  test.beforeAll(() => makeMember());

  test("🔴 lands on their own page when the browser remembers somebody else's", async ({
    page,
    context,
  }) => {
    // What the operator has, so we can prove the member never sees it.
    const secret = `operator-only-${RUN}`;
    const wrote = await page.request.put("http://localhost:8788/api/doc", {
      headers: { Authorization: `Bearer ${TEST_BEARER}`, "Content-Type": "application/json" },
      data: { body: `${secret}\n`, base_version: 0 },
    });
    // 409 is fine — it means the operator's page has a version we did not guess. Either
    // way the text below is the operator's, not the member's.
    expect([200, 409]).toContain(wrote.status());

    await context.addCookies([
      { name: "knag_session", value: TOKEN, domain: "localhost", path: "/" },
    ]);
    // 🔴 The exact prod failure: this browser's stored page belongs to the operator,
    // because the operator used it before the invite link swapped the session.
    await context.addInitScript(
      ([key, value]: string[]) => {
        try {
          (globalThis as unknown as WithStorage).localStorage.setItem(key as string, value as string);
        } catch {
          // Private mode. The boot then behaves as a browser with no memory, which the
          // test below covers anyway.
        }
      },
      [PAGE_KEY, "1"],
    );

    await page.goto("/");

    // The assertion that would have caught it: the app rendered.
    await expect(page.locator("[data-editor]")).toBeVisible();
    await expect(page.locator("[data-login]")).toBeHidden();

    // Their own empty `today`, healed into existence by `defaultPageFor` — never the
    // operator's document.
    await expect(page.locator("[data-page-label]")).toHaveText("today");
    await expect(page.locator("[data-surface]")).not.toContainText(secret);

    // And the borrowed hint was replaced by the server's answer, so the next boot on
    // this device asks for the right page directly.
    const stored = await page.evaluate(
      (key: string) => (globalThis as unknown as WithStorage).localStorage.getItem(key),
      PAGE_KEY,
    );
    expect(stored).not.toBe("1");
    expect(Number(stored)).toBeGreaterThan(1);
  });

  test("boots with an empty browser onto a page created for them", async ({ page, context }) => {
    await context.addCookies([
      { name: "knag_session", value: TOKEN, domain: "localhost", path: "/" },
    ]);
    await page.goto("/");

    await expect(page.locator("[data-editor]")).toBeVisible();
    await expect(page.locator("[data-page-label]")).toHaveText("today");

    // Typing works, which is the difference between "rendered" and "usable".
    await page.locator("[data-surface]").click();
    await page.keyboard.type("mine");
    await expect(page.locator("[data-surface]")).toContainText("mine");
  });

  test("sees no `hosting` group — that surface is the operator's", async ({ page, context }) => {
    await context.addCookies([
      { name: "knag_session", value: TOKEN, domain: "localhost", path: "/" },
    ]);
    await page.goto("/");
    await expect(page.locator("[data-editor]")).toBeVisible();

    // Settings is on the ledge (#139), so the ledge opens first — the fixture's
    // `openSettings` does this, and this file cannot use the fixture because the fixture
    // logs in as the operator, which is the one thing these tests must not be.
    await page.locator("[data-ledge-toggle]").click();
    await expect(page.locator("[data-ledge]")).toBeVisible();
    await page.locator("[data-settings-open]").click();
    await expect(page.locator("[data-settings]")).toBeVisible();

    // 🔴 Hidden as in *not on screen*, which is the assertion that means something. A
    // text assertion over `.group` reads hidden nodes too, so it would pass whether the
    // row were concealed or sitting there in plain sight. What keeps it off the screen is
    // `[hidden] { display: none !important }` beating `.pref { display: flex }` — an
    // author rule, because the UA one would lose to it.
    await expect(page.locator("[data-people-group]")).toBeHidden();
    await expect(page.locator("[data-people-open]")).toBeHidden();
  });
});
