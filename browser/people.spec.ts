import { type Knag, expect, test } from "./fixtures.js";

/**
 * The people pane, on a real page (#232, ADR-008 §11).
 *
 * 🔴 The worker suite proves the routes: the gate, the cap, the mail, the hard delete.
 * What only a browser can answer is whether the sheet reflects the server — that the
 * row appears for the operator at all (it is hidden until `/api/me` says so), that an
 * invite lands in the table, and that revoke and delete confirm by repetition rather
 * than by a dialog and then repaint from the server.
 *
 * Its own file, per the runner's one-server-per-file rule (#69, #107). Addresses are
 * unique per run: the local D1 persists between runs and a fixed address would be
 * "Already here" the second time.
 */

const who = (): string => `pat-${Math.random().toString(36).slice(2, 8)}@example.com`;

async function openPeople(knag: Knag): Promise<void> {
  await knag.openSettings();
  const row = knag.page.locator("[data-people-open]");
  await expect(row).toBeVisible();
  await row.click();
  await expect(knag.page.locator("[data-people-pane]")).toBeVisible();
}

test.describe("people", () => {
  test("the operator sees the row, the table, and themself in it", async ({ knag }) => {
    await openPeople(knag);
    const table = knag.page.locator("[data-people-table]");
    await expect(table.locator("tr[data-you]")).toHaveCount(1);
    await expect(table.locator("tr[data-you] td").last()).toHaveText("you");
    await expect(knag.page.locator("[data-people-cap]")).toHaveText(/^\d+ of 25$/);
    await expect(knag.page.locator("[data-people-totals] tr")).toHaveCount(1);
  });

  test("invite adds a row; revoke and delete confirm by repetition and repaint", async ({ knag }) => {
    await openPeople(knag);
    const email = who();
    await knag.page.locator('[data-invite] input[name="email"]').fill(email);
    await knag.page.locator("[data-invite-submit]").click();

    const row = knag.page.locator("[data-people-rows] tr", { hasText: email });
    await expect(row).toHaveCount(1);
    await expect(row.locator("td").nth(1)).toHaveText("never");
    await expect(knag.page.locator('[data-invite] input[name="email"]')).toHaveValue("");

    // One tap arms, and the label says what the next tap does; it disarms on its own.
    const revoke = row.locator("[data-revoke-person]");
    await revoke.click();
    await expect(revoke).toHaveText("again to confirm");
    await expect(row).toHaveCount(1);
    await expect(revoke).toHaveText("revoke", { timeout: 6_000 });

    await revoke.click();
    await revoke.click();
    await expect(row).toHaveAttribute("data-revoked", "");
    await expect(row.locator("td").nth(1)).toHaveText("revoked");

    const remove = row.locator("[data-delete-person]");
    await remove.click();
    await remove.click();
    await expect(row).toHaveCount(0);
  });

  test("a refusal is said in the pane, not swallowed", async ({ knag }) => {
    await openPeople(knag);
    const email = who();
    await knag.page.locator('[data-invite] input[name="email"]').fill(email);
    await knag.page.locator("[data-invite-submit]").click();
    await expect(knag.page.locator("[data-people-rows] tr", { hasText: email })).toHaveCount(1);

    await knag.page.locator('[data-invite] input[name="email"]').fill(email);
    await knag.page.locator("[data-invite-submit]").click();
    await expect(knag.page.locator("[data-people-error]")).toHaveText("Already here");
  });
});
