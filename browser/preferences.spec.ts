import { expect, test } from "./fixtures.js";

/**
 * Settings, once the operations left (#132).
 *
 * 🔴 The rule this file exists to defend is a *test*, not a layout: **a preference has a
 * current value.** If a proposed row does something, it is not a preference and it does
 * not live here; if its length is not knowable, it is a screen. That rule is what stops
 * the sheet filling up again, and nothing enforces it except the assertions below and
 * somebody remembering.
 *
 * The sheet became a junk drawer because it was the place anything without a home went,
 * and the reason it could was that it scrolled. **A sheet that scrolls is a junk drawer
 * with a lid.** So the length is asserted at phone size, where it matters.
 */

const DAY = ["Thursday", "- [ ] call the accountant", "- [x] pay the invoice", ""].join("\n");

/** A phone, because that is the size the "no scroll" constraint is about. */
const PHONE = { width: 393, height: 852 };

/** Computed style, via `ownerDocument.defaultView` — browser/tsconfig has no DOM lib. */
type Styled = { ownerDocument: { defaultView: unknown } };
type View = { getComputedStyle: (e: unknown) => { getPropertyValue: (p: string) => string } };

async function css(
  locator: import("@playwright/test").Locator,
  property: string,
): Promise<string> {
  return locator.evaluate(
    (el: Styled, prop: string) =>
      (el.ownerDocument.defaultView as View).getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

test.describe("the shape of the sheet", () => {
  test("🔴 does not scroll at phone size, which is the whole constraint", async ({ knag }) => {
    await knag.page.setViewportSize(PHONE);
    await knag.seed(DAY);
    await knag.openSettings();

    const overflow = await knag.page
      .locator("[data-settings]")
      .evaluate((el: { scrollHeight: number; clientHeight: number }) => ({
        scroll: el.scrollHeight,
        client: el.clientHeight,
      }));

    // 🔴 Not "fits nicely" — *does not scroll*. The moment it does, the length stops
    // being knowable and the next thing without a home lands here, which is exactly how
    // it got to five sections and a variable-length list. If this fails, the fix is to
    // take a row out rather than to let it scroll.
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  });

  test("holds one boundary and six rows", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // 🔴 One label, not two (#149). The boundary is still in the same place and still
    // the whole information architecture â but `the page` sat under a head that says
    // `settings`, above four rows that are visibly about the page, and named nothing the
    // reader could not already see. `you` earns its line because what follows it *is* a
    // change of subject, and it keeps the slot the account rows arrive above in 1.2.
    await expect(knag.page.locator("[data-settings] .group")).toHaveText(["you"]);
    await expect(knag.page.locator("[data-settings] .pref")).toHaveCount(6);
  });

  test("🔴 the head says what this is and how to leave, legibly", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // 🔴 `--ink`, not `--dim`, on both (#149). Dim on the board is about 3.9:1 â under
    // AA at any size â which is correct for a value at rest beside a label and wrong for
    // the only two things on the row that say what the surface is and how to get out.
    // "I was looking for a close button and it took a while."
    const ink = await css(knag.page.locator("[data-editor]"), "color");
    const head = knag.page.locator("[data-settings-pane] .sheet-head");
    expect(await css(head.locator("span"), "color")).toBe(ink);
    expect(await css(head.locator(".sheet-close"), "color")).toBe(ink);

    // And it is a drawn glyph like every other control, rather than the text character Ã
    // at whatever weight the mono face gives a multiplication sign.
    await expect(head.locator(".sheet-close svg")).toHaveCount(1);
  });

  test("🔴 the build line is readable, at the size its own token names", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // `--size-machine` is documented in the token block as "save status, recovery line,
    // build info". This was set to `--size-micro`, whose comment names the env badge and
    // the ledge labels â 11px `--dim`, which put "is my change live" back to being a
    // round trip (#149).
    const machine = await css(knag.page.locator("[data-save-status]"), "font-size");
    expect(await css(knag.page.locator("[data-settings] .build"), "font-size")).toBe(machine);
  });

  test("🔴 every choice shows its current value without being touched", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // No toggles, no disclosure rows that make you tap to find out what a setting is
    // currently set to. A switch tells you a state; a pair of buttons tells you the state
    // *and* the alternative in the same glance, and it costs the same height.
    for (const group of ["[data-theme-set]", "[data-view-set]", "[data-font-size]", "[data-sound]"]) {
      const pressed = knag.page.locator(`[data-settings] ${group}[aria-pressed="true"]`);
      await expect(pressed, group).toHaveCount(1);

      // Three or fewer per row, so they fit on one line at 380px.
      const offered = await knag.page.locator(`[data-settings] ${group}`).count();
      expect(offered, group).toBeLessThanOrEqual(3);
    }
  });

  test("🔴 devices is the only destination, and the only chevron", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // The one row that is a destination rather than a choice, and it is marked as one.
    // A second chevron would mean a second unbounded thing had been let in.
    await expect(knag.page.locator("[data-settings] .chev")).toHaveCount(1);
    await expect(knag.page.locator("[data-devices-open] .chev")).toHaveCount(1);
    await expect(knag.page.locator("[data-devices-count]")).not.toHaveText("—");
  });

  test("says how far back the record goes", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // 🔴 The one fact in here that is not markup, and it comes from `/api/carbon` rather
    // than `/health` — the age of your document is a fact about your document, and
    // `/health` is the one route that answers to anybody.
    await expect(knag.page.locator("[data-carbon]")).toHaveText(/carbon · \d+ days?/);
  });

  test("🔴 keeps the operations out, now that they have somewhere else to be", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // Everything with a verb left for the ledge in #139. This is the assertion that
    // notices one coming back — which is the actual failure mode, since every addition
    // to this sheet was individually reasonable.
    // 🔴 Scoped to the settings pane rather than to the dialog (#149). The device list
    // is a second pane of the same dialog now, so `[data-settings]` would sweep in the
    // controls that legitimately live over there and this would stop meaning anything.
    const sheet = knag.page.locator("[data-settings-pane]");
    await expect(sheet.locator("[data-copy-page]")).toHaveCount(0);
    await expect(sheet.locator("[data-wipe-all]")).toHaveCount(0);
    await expect(sheet.locator("[data-reorder]")).toHaveCount(0);

    // Two exceptions, both deliberate and both marked: `log out` is a verb that sits next
    // to the identity it acts on, and `devices` is a destination.
    await expect(sheet.locator("button[data-logout]")).toHaveCount(1);
  });
});

test.describe("devices, as a second pane", () => {
  test("🔴 stays in the dialog — the settings pane goes, the dialog does not", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    await knag.page.locator("[data-devices-open]").click();

    await expect(knag.page.locator("[data-devices-pane]")).toBeVisible();
    // 🔴 The inversion of what this test used to assert (#149). Devices used to close
    // the dialog and open a full-bleed screen, on the argument that a modal has no
    // navigation and no scroll that means anything. A pane with a back control is
    // navigation, and the scroll below is real — so what the full bleed was actually
    // costing was the reader's place, for nothing.
    await expect(knag.page.locator("[data-settings]")).toBeVisible();
    await expect(knag.page.locator("[data-settings-pane]")).not.toBeVisible();
  });

  test("comes back to where you came from", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator("[data-devices-open]").click();
    await expect(knag.page.locator("[data-devices-pane]")).toBeVisible();

    await knag.page.locator("[data-devices-back]").click();

    // A place you go, look around in, and **come back from** — which is the difference
    // between it and a section, and the reason back lands on the settings rows rather
    // than dismissing the whole dialog.
    await expect(knag.page.locator("[data-devices-pane]")).not.toBeVisible();
    await expect(knag.page.locator("[data-settings-pane]")).toBeVisible();
  });

  test("🔴 reopening settings never lands you back on the device list", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator("[data-devices-open]").click();
    await expect(knag.page.locator("[data-devices-pane]")).toBeVisible();

    // Out through Escape rather than back, which is the route that leaves the panes
    // swapped: the platform closes the dialog and tells nobody which pane was showing.
    await knag.page.keyboard.press("Escape");
    await expect(knag.page.locator("[data-settings]")).not.toBeVisible();

    await knag.openSettings();
    await expect(knag.page.locator("[data-settings-pane]")).toBeVisible();
    await expect(knag.page.locator("[data-devices-pane]")).not.toBeVisible();
  });

  test("🔴 is the surface allowed to scroll, which is why the list moved here", async ({
    knag,
  }) => {
    await knag.page.setViewportSize(PHONE);
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator("[data-devices-open]").click();

    const body = knag.page.locator("[data-devices-pane] .pane-body");
    await expect(body).toBeVisible();

    // The settings pane cannot hold something whose length nobody controls; this can.
    // Asserted as a capability rather than as a measurement — the list is two rows in a
    // test and fifteen on a real account, and it is the fifteen that this exists for.
    expect(await body.evaluate((el: { scrollHeight: number }) => el.scrollHeight)).toBeGreaterThan(
      0,
    );
    // browser/tsconfig has no DOM lib — `client/src` is the only place DOM types exist —
    // so the view is reached through the element and typed structurally.
    type Styled = { ownerDocument: { defaultView: unknown } };
    type View = { getComputedStyle: (e: unknown) => { overflowY: string } };
    const overflow = await body.evaluate(
      (el: Styled) => (el.ownerDocument.defaultView as View).getComputedStyle(el).overflowY,
    );
    expect(overflow).toBe("auto");
  });

  test("🔴 the pane is capped, so a long list cannot push the way back off screen", async ({
    knag,
  }) => {
    await knag.page.setViewportSize(PHONE);
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator("[data-devices-open]").click();

    const pane = knag.page.locator("[data-devices-pane]");
    const height = (await pane.boundingBox())?.height ?? 0;
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThanOrEqual(PHONE.height);

    // The one thing the cap exists for: back is reachable no matter how many devices
    // there are. A pane that grew past the viewport would put it above the top edge.
    const back = (await knag.page.locator("[data-devices-back]").boundingBox())?.y ?? -1;
    expect(back).toBeGreaterThanOrEqual(0);
  });

  test("keeps the rare verb with the list it acts on", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator("[data-devices-open]").click();

    // `sign out everywhere else` is about the other devices, so it belongs where they
    // are rather than among rows that are about the page and about you.
    await expect(knag.page.locator("[data-devices-pane] [data-revoke-others]")).toHaveCount(1);
    await expect(knag.page.locator("[data-settings-pane] [data-revoke-others]")).toHaveCount(0);
  });
});
