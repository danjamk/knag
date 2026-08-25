import { expect, test } from "./fixtures.js";

/**
 * Pages in the order you put them (#195) — the drag half.
 *
 * The server half shipped in 1.4.0 and `api-pages-order.test.ts` pins it: `position` on
 * `pages`, `PUT /api/pages/order` taking the whole live set, a 409 with the current list
 * for anything else. What only a rendered page can answer is whether the grip is there,
 * whether it is Arrange's, and whether a drop actually reaches the route and comes back
 * as the switcher's order.
 *
 * Its own file rather than an addition to `pages.spec.ts`, which is at twenty tests and
 * already past the size where wrangler #69 starts to bite.
 */

async function openManage(knag: import("./fixtures.js").Knag): Promise<void> {
  await knag.page.locator("[data-page-name]").click();
  await knag.page.locator("[data-manage-open]").click();
  await expect(knag.page.locator("[data-manage-pane]")).toBeVisible();
}

test.describe("the grip in manage pages", () => {
  test.afterEach(async ({ knag }) => {
    await knag.resetPages();
  });

  test("🔴 every row carries Arrange's grip, at Arrange's size", async ({ knag }) => {
    await knag.resetPages();
    await knag.newPage("work");
    await knag.newPage("reading");
    await openManage(knag);

    const grips = knag.page.locator("[data-manage-list] li .grip");
    await expect(grips).toHaveCount(3);

    // 36px — `--target-arrange`, the size the grip has in the mode where it is the only
    // thing you are aiming at. The same glyph and the same size, because it is the same
    // verb on a different list; a second glyph would imply a second kind of reordering.
    for (const grip of await grips.all()) {
      const box = await grip.boundingBox();
      expect(box?.width).toBe(36);
      expect(box?.height).toBe(36);
    }
    // And the name still has room: the field is the widest thing on the row.
    const field = await knag.page.locator("[data-manage-list] input").first().boundingBox();
    expect(field?.width ?? 0).toBeGreaterThan(120);
  });

  test("🔴 a drop commits through the route and the switcher follows", async ({ knag }) => {
    await knag.resetPages();
    await knag.newPage("work");
    await knag.newPage("reading");
    await openManage(knag);

    const rows = knag.page.locator("[data-manage-list] li");
    await expect(rows).toHaveCount(3);
    type Field = { value: string };
    const names = () =>
      rows.locator("input").evaluateAll((els: Field[]) => els.map((el) => el.value));
    await expect.poll(names).toEqual(["today", "work", "reading"]);

    // The last row's grip to the first row. SortableJS listens for pointer events on the
    // handle and moves the row under it; the drop is what commits, through the route,
    // and the list is then re-read from the server rather than trusted from the DOM.
    const from = await rows.nth(2).locator(".grip").boundingBox();
    const to = await rows.nth(0).boundingBox();
    if (!from || !to) throw new Error("rows did not lay out");
    // 🔴 Two swaps, with a pause between. The rows animate for 120ms when one passes
    // another, and a pointer that crosses both midpoints inside that window lands one
    // swap, not two — the drop then reads as `today · reading · work`, which is a real
    // order and a wrong one. A thumb does not move that fast; this waits like one.
    await knag.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await knag.page.mouse.down();
    await knag.page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
    await knag.page.waitForTimeout(200);
    await knag.page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 6 });
    await knag.page.waitForTimeout(200);
    await knag.page.mouse.up();

    await expect.poll(names).toEqual(["reading", "today", "work"]);

    // The order is the server's: the switcher, painted from the same read, agrees, and a
    // reload shows the same thing — nothing here lives in the DOM alone.
    await knag.page.reload();
    await expect(knag.page.locator("[data-editor]")).toBeVisible();
    await knag.page.locator("[data-page-name]").click();
    await expect(knag.page.locator("[data-switcher-list] button")).toHaveText([
      "reading",
      "today",
      "work",
    ]);
  });
});
