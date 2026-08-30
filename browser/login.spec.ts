import { expect, test } from "@playwright/test";
import { TEST_OPERATOR_EMAIL } from "../playwright.config.js";

/**
 * The login form's two states, on WebKit (#231, ADR-008 §2).
 *
 * What only a browser can answer: that the form moves from the email step to the code
 * step, that a wrong code says so and leaves you on the code step, that "different
 * email" takes you back, and that a spent link's landing (`?login=expired`) is
 * explained. The mail itself is out of reach — under `wrangler dev` it goes to the
 * server's stdout — so this stops where the mail begins; the worker suite proves what a
 * code does when typed.
 *
 * Uses the bare Playwright `test`, not the fixture: the fixture logs in, and this is the
 * one file that must not.
 */

test.describe("the login form", () => {
  test("asks for an email, then for the code, and says so", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("[data-login]");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("data-step", "email");
    await expect(form.locator('input[name="code"]')).toBeHidden();

    await form.locator('input[name="email"]').fill(TEST_OPERATOR_EMAIL);
    await form.locator('input[name="device_label"]').fill("webkit");
    await form.locator("[data-login-submit]").click();

    await expect(form).toHaveAttribute("data-step", "code");
    await expect(form.locator("[data-login-sent]")).toBeVisible();
    await expect(form.locator('input[name="email"]')).toBeHidden();
    await expect(form.locator('input[name="code"]')).toBeFocused();
    await expect(form.locator("[data-login-submit]")).toHaveText("Log in");
  });

  test("a wrong code says so and stays on the code step", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("[data-login]");
    await form.locator('input[name="email"]').fill(TEST_OPERATOR_EMAIL);
    await form.locator("[data-login-submit]").click();
    await expect(form).toHaveAttribute("data-step", "code");

    // The throttle means the mail above may or may not have gone; the code step is
    // reached either way, and a wrong code is wrong either way.
    await form.locator('input[name="code"]').fill("000 000");
    await form.locator("[data-login-submit]").click();

    await expect(form.locator("[data-error]")).toContainText("wrong code");
    await expect(form).toHaveAttribute("data-step", "code");
    await expect(page.locator("[data-editor]")).toBeHidden();

    await form.locator("[data-login-restart]").click();
    await expect(form).toHaveAttribute("data-step", "email");
    await expect(form.locator("[data-error]")).toHaveText("");
  });

  test("a spent link lands on the form with a reason", async ({ page }) => {
    await page.goto("/?login=expired");
    const form = page.locator("[data-login]");
    await expect(form).toBeVisible();
    await expect(form.locator("[data-error]")).toContainText("expired");
    // Said once: the URL is cleaned so a reload does not say it again.
    await expect(page).toHaveURL(/\/$/);
  });
});
