import type { Locator } from "@playwright/test";
import { TEST_PASSPHRASE } from "../playwright.config.js";
import { request } from "@playwright/test";
import { type Knag, expect, test } from "./fixtures.js";

/**
 * Log out and device revocation, on a real page (#125).
 *
 * 🔴 The worker suite already proves the endpoints: a revoked cookie 401s on its next
 * request, the token hash never reaches a body, a bearer is told it has no session
 * rather than rejected. None of that is repeated here. What only a browser can answer
 * is whether the sheet **reflects the server** — a device list that renders stale, or
 * renders a revoke control on the row that must not have one, is a correct API behind
 * a control that misleads the person holding the phone.
 *
 * Its own spec file rather than an addition to `design.spec.ts`, per the runner's
 * one-server-per-file rule (#69, #107): `design.spec.ts` is already at fourteen.
 */

const PAGE = ["Thursday", "- [ ] call the accountant"].join("\n");

/**
 * Computed style, reached through `el.ownerDocument.defaultView` rather than a bare
 * `window` — `browser/tsconfig.json` has no DOM lib, so a callback naming `window`
 * would not compile. Same shape as the helper in design.spec.ts.
 */
type Styled = { ownerDocument: { defaultView: unknown } };
type View = {
  getComputedStyle: (e: unknown) => { getPropertyValue: (p: string) => string };
};

async function css(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (el: Styled, prop: string) =>
      (el.ownerDocument.defaultView as View).getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

/**
 * Log in a *second* device without disturbing this one.
 *
 * 🔴 Not `page.request`, which shares the page's cookie jar — logging in through it
 * replaces the browser's own session, so the new device silently becomes the current
 * one. Two tests here passed for that wrong reason before this existed: the row was
 * present, but it was the caller's own row, which is precisely the row that must not
 * offer a revoke control.
 */
async function loginElsewhere(baseURL: string, label: string): Promise<string> {
  // 🔴 Unique per call. Sessions last a year and the fixture logs in for every test, so
  // the table accumulates across the whole file — a fixed label matched seven rows by
  // the last test and the click failed on a strict-mode violation. Uniqueness is what
  // makes each assertion about *this* test's device rather than about a shared table.
  const unique = `${label}-${++elsewhere}`;
  const context = await request.newContext({ baseURL });
  await context.post("/api/login", { data: { passphrase: TEST_PASSPHRASE, device_label: unique } });
  await context.dispose();
  return unique;
}

let elsewhere = 0;

/** Open Settings and wait for the device list to have resolved past its placeholder. */
async function openDevices(knag: Knag) {
  // 🔴 Two steps now, and the second one is the feature (#132). The list left the sheet
  // for a screen because a modal cannot hold something whose length nobody controls —
  // it renders fine at two rows and *is* the sheet at fifteen.
  await knag.openSettings();
  await knag.page.locator("[data-devices-open]").click();
  await expect(knag.page.locator("[data-devices-screen]")).toBeVisible();
  const list = knag.page.locator("[data-sessions]");
  await expect(list.locator("li")).not.toHaveText(["…"]);
  return list;
}

test.describe("the device list", () => {
  test("🔴 marks exactly one row as this device, and it is the only one without revoke", async ({
    knag,
  }) => {
    await knag.seed(PAGE);
    const list = await openDevices(knag);

    // One session exists — this browser's. The invariant that matters is not the count
    // but that current-ness is unambiguous: a list where two rows claim to be you, or
    // none does, is a list you cannot safely act on.
    await expect(list.locator("li[data-current]")).toHaveCount(1);

    const current = list.locator("li[data-current]");
    await expect(current.locator("button[data-revoke]")).toHaveCount(0);
    await expect(current).toContainText("this device");
  });

  test("🔴 speaks in the machine voice, like everything else the app says about itself", async ({
    knag,
  }) => {
    await knag.seed(PAGE);
    const list = await openDevices(knag);

    // Two faces, two speakers. Nothing in this list was typed by the user, so none of
    // it is in the human face.
    expect(await css(list.locator("li").first(), "font-family")).toContain("DM Mono");
  });

  test("🔴 the current device is visibly distinguished, not just data-attribute different", async ({
    knag,
    baseURL,
  }) => {
    await knag.seed(PAGE);
    await loginElsewhere(baseURL ?? "", "ipad");

    const list = await openDevices(knag);

    // Two rows now, so this is a real comparison rather than a row against itself.
    const mine = await css(list.locator("li[data-current] .label"), "color");
    const theirs = await css(list.locator("li:not([data-current]) .label").first(), "color");

    // 🔴 Computed colour, never a class name. A rule that stops applying — a selector
    // typo, a specificity change, a token that does not resolve — leaves the attribute
    // in place and the distinction gone, which is exactly the failure that matters:
    // revoking the wrong row is irreversible from the device you are holding.
    expect(mine).not.toBe(theirs);
  });

  test("re-reads the list every time the sheet opens, rather than caching it", async ({
    knag,
    baseURL,
  }) => {
    await knag.seed(PAGE);

    await openDevices(knag);
    // Back to the sheet, then out. A screen is a place you come back *from*, and the
    // route out of the product goes through where you came in.
    await knag.page.locator("[data-devices-back]").click();
    await knag.page.locator("[data-settings] .sheet-close").click();

    // A second device appears while the sheet is closed. Nothing in the page knows.
    const other = await loginElsewhere(baseURL ?? "", "ipad");

    const list = await openDevices(knag);

    // 🔴 The point of the whole feature is answering "what still has access". An answer
    // from the last time the sheet happened to be open is the one answer that is worse
    // than none, because it is acted on.
    await expect(list).toContainText(other);
  });

  test("🔴 revoking another device removes its row without logging this one out", async ({
    knag,
    baseURL,
  }) => {
    await knag.seed(PAGE);

    const other = await loginElsewhere(baseURL ?? "", "ipad");

    const list = await openDevices(knag);
    await expect(list).toContainText(other);

    await list.locator("li", { hasText: other }).locator("button[data-revoke]").click();

    await expect(list).not.toContainText(other);
    // Still logged in, still holding the document — the row that went was not this one.
    await knag.page.locator("[data-devices-back]").click();
    await knag.page.locator("[data-settings] .sheet-close").click();
    expect(await knag.document()).toBe(PAGE);
  });

  test("🔴 log out ends the session and lands on the login form", async ({ knag }) => {
    await knag.seed(PAGE);

    // 🔴 In the sheet, not on the screen. `log out` acts on *this* device, so it sits
    // next to the identity it ends rather than in the list of the others (#132, §7e).
    await knag.openSettings();

    await knag.page.locator("[data-logout]").click();

    // The reload is the honest outcome: the cookie is gone, so a page that stayed put
    // would 401 every poll from here on and look broken rather than logged out.
    await expect(knag.page.locator("[data-login]")).toBeVisible({ timeout: 10_000 });
  });
});
