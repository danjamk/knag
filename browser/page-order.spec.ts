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

    // `:not(.sortable-fallback)` — in pointer-fallback mode SortableJS appends a clone of
    // the dragged row to the list to follow the pointer, and a reader that counts it sees
    // four rows mid-drag. The clone is the drag image, not a page.
    const rows = knag.page.locator("[data-manage-list] li:not(.sortable-fallback)");
    await expect(rows).toHaveCount(3);
    type Field = { value: string };
    const names = () =>
      rows.locator("input").evaluateAll((els: Field[]) => els.map((el) => el.value));
    await expect.poll(names).toEqual(["today", "work", "reading"]);

    // The last row's grip to the first row, one row at a time, each swap awaited before
    // the pointer moves on. SortableJS ignores a dragover on a row that is still
    // animating (120ms), so a pointer that crosses two midpoints inside that window
    // lands one swap and not two — which is `today · reading · work`, a real order and
    // a wrong one. It did exactly that on the serial gate in front of the first prod
    // deploy of 1.5.0, after passing three times over locally with a fixed pause. So
    // there is no pause: the DOM is what says the swap happened, and the next move waits
    // for it. A thumb does the same thing, slower.
    const [first, middle, last] = await Promise.all([
      rows.nth(0).boundingBox(),
      rows.nth(1).boundingBox(),
      rows.nth(2).locator(".grip").boundingBox(),
    ]);
    if (!first || !middle || !last) throw new Error("rows did not lay out");
    const x = last.x + last.width / 2;
    await knag.page.mouse.move(x, last.y + last.height / 2);
    await knag.page.mouse.down();
    await knag.page.mouse.move(x, middle.y + middle.height / 2 - 4, { steps: 8 });
    await expect.poll(names).toEqual(["today", "reading", "work"]);
    await knag.page.mouse.move(x, first.y + first.height / 2 - 4, { steps: 8 });
    await expect.poll(names).toEqual(["reading", "today", "work"]);
    await knag.page.mouse.up();

    // The drop commits through the route and the list is re-read from the server — so
    // the order holding after a repaint is the server agreeing, not the DOM remembering.
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
