import type { Locator } from "@playwright/test";
import { TEST_BEARER } from "../playwright.config.js";
import { type Knag, expect, test } from "./fixtures.js";

/**
 * Text size, and the bar's targets (#92, #132).
 *
 * 🔴 `view.test.ts` already proves the preference *validates* — the floor holds against a
 * hostile stored value, storage throwing does not take the app down. None of that is
 * repeated here. What only a rendered page can answer is whether the token override
 * actually reaches the text, whether it survives a reload, and whether it leaves the
 * chrome alone — which is the decision this feature turns on.
 */

const DAY = ["Thursday", "- [ ] call the accountant", ""].join("\n");

/** Computed style, via `ownerDocument.defaultView` — browser/tsconfig has no DOM lib. */
type Styled = { ownerDocument: { defaultView: unknown } };
type View = { getComputedStyle: (e: unknown) => { getPropertyValue: (p: string) => string } };

async function css(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (el: Styled, prop: string) =>
      (el.ownerDocument.defaultView as View).getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

const px = (value: string) => Number.parseFloat(value);

async function setSize(knag: Knag, size: number) {
  await knag.openSettings();
  await knag.page.locator(`[data-font-size="${size}"]`).click();
  await knag.page.keyboard.press("Escape");
}

test.describe("text size", () => {
  test("🔴 moves the page text, and only the page text", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.useEditor();

    const line = knag.page.locator("[data-surface] .cm-line").first();
    const status = knag.page.locator("[data-save-status]");

    const pageBefore = px(await css(line, "font-size"));
    const chromeBefore = px(await css(status, "font-size"));

    await setSize(knag, 20);

    // 🔴 The whole decision this feature turns on. Someone raising the reading size wants
    // more room for the document, not a louder footer — so the machine voice must not
    // move with it. Asserted on computed pixels rather than on a class or a token name,
    // because a rule that stopped applying would leave both intact and neither working.
    expect(px(await css(line, "font-size"))).toBeGreaterThan(pageBefore);
    expect(px(await css(status, "font-size"))).toBe(chromeBefore);
  });

  test("🔴 moves Arrange's rows too, so entering the mode does not resize the page",
    async ({ knag }) => {
    // 🔴 Rewritten for one surface (#113). This used to compare the *row list* against the
    // editing surface, because switching views must not resize the document under the
    // reader. There is no view to switch to — but Arrange still renders its own rows, and
    // entering the mode is the same hazard wearing different clothes.
    //
    // Both read `--size-row`. If either kept a literal, the page would jump.
    await knag.seed(DAY);
    await setSize(knag, 20);

    const inSurface = px(
      await css(knag.page.locator("[data-surface] .cm-line").first(), "font-size"),
    );
    expect(inSurface).toBe(20);

    await knag.arrange();
    const inArrange = px(await css(knag.page.locator("[data-rows] textarea").first(), "font-size"));

    expect(inArrange).toBe(inSurface);
  });

  test("🔴 never goes below 16px, because iOS zooms on focus and never returns", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // The control offers no step below the floor. It scales up from 16 or not at all —
    // anyone wanting smaller text wants a smaller device.
    const offered = await knag.page.locator("[data-font-size]").allTextContents();
    expect(offered).toEqual(["16", "18", "20"]);

    // And a stored value below it does not reach the page even if one gets written.
    await knag.page.evaluate(() => localStorage.setItem("knag.fontSize", "11"));
    await knag.page.reload();
    await expect(knag.page.locator("[data-editor]")).toBeVisible();

    expect(px(await css(knag.page.locator("[data-surface] .cm-line").first(), "font-size"))).toBe(
      16,
    );
  });

  test("survives a reload, like the board does", async ({ knag }) => {
    await knag.seed(DAY);
    await setSize(knag, 18);

    await knag.page.reload();
    await expect(knag.page.locator("[data-editor]")).toBeVisible();

    expect(px(await css(knag.page.locator("[data-surface] .cm-line").first(), "font-size"))).toBe(
      18,
    );
    // And the control shows which one is active when the sheet is reopened.
    await knag.openSettings();
    await expect(knag.page.locator('[data-font-size="18"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("the bar, after the bump and the diet", () => {
  test("🔴 hits the 44px touch target, which is what 'too small' meant", async ({ knag }) => {
    await knag.seed(DAY);

    // It was 28px. Apple's HIG minimum for a touch target is 44pt, and the complaint that
    // the icons were too small on every device was a hit-target problem wearing a visual
    // complaint's clothes — so this is asserted against the standard, not against taste.
    //
    // 🔴 The controls this named moved to the ledge (#139) and the assertion moved with
    // them rather than being deleted, because the ledge is where a mis-tap is now most
    // expensive: `wipe page` is on it.
    await knag.openLedge();

    for (const control of ["[data-ledge-toggle]", "[data-reorder]", "[data-settings-open]", "[data-copy-page]", "[data-wipe-all]"]) {
      const box = await knag.page.locator(control).boundingBox();
      expect(box?.width ?? 0, control).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0, control).toBeGreaterThanOrEqual(44);
    }
  });

  test("🔴 got shorter without giving up a pixel of target", async ({ knag }) => {
    await knag.seed(DAY);

    // The other half of §3a. The first pass paid for the 44px target with bar height —
    // 44 to 52 — and with four type tokens that had nothing to do with hit targets. The
    // type went back and the targets now fill the bar instead of sitting inside its
    // padding, so it is 46px and still legal. Asserted together, because either one
    // alone is satisfiable by giving up the other.
    const bar = await knag.page.locator(".bar").boundingBox();
    expect(bar?.height).toBe(46);

    const toggle = await knag.page.locator("[data-ledge-toggle]").boundingBox();
    expect(toggle?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("does not follow the reading preference", async ({ knag }) => {
    await knag.seed(DAY);
    const bar = knag.page.locator(".bar");
    const before = await bar.boundingBox();

    await setSize(knag, 20);

    expect((await bar.boundingBox())?.height).toBe(before?.height);
  });
});

test.describe("what About left behind", () => {
  test("🔴 keeps one path back to the source, on the build line", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // 🔴 About was deleted in #132. §7e's list of what never goes in this sheet names an
    // about page directly, and the rule that removes it — a preference has a current
    // value — is the rule that keeps the sheet from filling up again.
    //
    // The link survives, because a public MIT project should not lose its only path back
    // to the source over a layout decision. It moved onto the build line, which is
    // already the machine speaking about itself.
    const build = knag.page.locator("[data-settings] .build");
    await expect(build.locator("a")).toHaveAttribute("href", "https://github.com/danjamk/knag");

    // 🔴 `rel` alongside `target="_blank"`, or the opened page gets a handle on this one
    // through `window.opener` — on a page that holds a live session.
    await expect(build.locator("a")).toHaveAttribute("rel", /noopener/);

    // And the prose is gone rather than relocated. A sheet that explains itself is a
    // sheet whose controls do not.
    await expect(knag.page.locator("[data-settings]")).not.toContainText("MIT");
  });
});

test.describe("the sheet says what is per device (#194)", () => {
  test("labels the preferences `this device`, above `you`", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    // Board, view, text size and sound are localStorage: set on the phone, the iPad
    // does not follow. The sheet did not say so and the question came up after a few
    // days of use. #149 cut the first group label because `the page` named nothing the
    // reader could not see; this one names the one thing they cannot, and the two labels
    // are the whole information architecture — the order is the boundary.
    const groups = knag.page.locator("[data-settings-pane] .group");
    await expect(groups).toHaveText(["this device", "you"]);

    // The preferences sit between the two labels, not above the first one.
    const pane = knag.page.locator("[data-settings-pane]");
    const first = await pane.locator(".group, .pref").first().textContent();
    expect(first?.trim()).toBe("this device");
  });
});

test.describe("the agent's instructions (#190)", () => {
  const route = "/api/settings/agent-instructions";
  const headers = { Authorization: `Bearer ${TEST_BEARER}`, "Content-Type": "application/json" };

  async function clear(knag: Knag): Promise<void> {
    await knag.page.request.put(route, { headers, data: { text: "" } });
  }
  async function held(knag: Knag): Promise<string> {
    const res = await knag.page.request.get(route, { headers });
    return ((await res.json()) as { text: string }).text;
  }

  test.afterEach(async ({ knag }) => {
    await clear(knag);
  });

  test("is a second destination in `you`, showing its value like every other row", async ({
    knag,
  }) => {
    await clear(knag);
    await knag.seed(DAY);
    await knag.openSettings();

    // A row, not a textarea in the sheet: a preference has a current value, and `set`
    // or `not set` is as much of 4000 characters as a row can honestly hold. Under
    // `you`, on the far side of the `this device` boundary #194 drew — the server holds
    // this, and a pane about pages would have read as per-page.
    const row = knag.page.locator("[data-settings-pane] [data-agent-open]");
    await expect(row).toBeVisible();
    await expect(row.locator("[data-agent-state]")).toHaveText("not set");
    const you = knag.page.locator("[data-settings-pane] .group", { hasText: "you" });
    expect((await you.boundingBox())?.y ?? 0).toBeLessThan((await row.boundingBox())?.y ?? 0);
  });

  test("🔴 saves on back with no button, and the row says so", async ({ knag }) => {
    await clear(knag);
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator("[data-agent-open]").click();

    const pane = knag.page.locator("[data-agent-pane]");
    await expect(pane).toBeVisible();
    // The textarea is the first thing under the head, so a keyboard never covers it —
    // and it is the body face, because a person wrote it.
    const text = pane.locator("[data-agent-text]");
    await expect(text).toBeVisible();
    await text.fill("work is the standing page — never wipe it without asking.");
    await pane.locator("[data-agent-back]").click();

    await expect(knag.page.locator("[data-agent-state]")).toHaveText("set");
    await expect
      .poll(() => held(knag))
      .toBe("work is the standing page — never wipe it without asking.");

    // And it comes back on the next visit, from the server, not from the DOM.
    await knag.page.keyboard.press("Escape");
    await knag.openSettings();
    await knag.page.locator("[data-agent-open]").click();
    await expect(text).toHaveValue("work is the standing page — never wipe it without asking.");
  });

  test("🔴 counts down from 3600 and refuses past 4000, keeping what was saved", async ({
    knag,
  }) => {
    await clear(knag);
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator("[data-agent-open]").click();

    const pane = knag.page.locator("[data-agent-pane]");
    const text = pane.locator("[data-agent-text]");
    const count = pane.locator("[data-agent-count]");

    // No counter on an empty field — that is the app asking to be filled.
    await expect(count).toBeHidden();
    await text.fill("x".repeat(3700));
    await expect(count).toHaveText("300 left");

    await text.fill("y".repeat(4001));
    await expect(pane.locator("[data-agent-status]")).toHaveText("too long · 4000");
    await pane.locator("[data-agent-back]").click();
    // Refused on the way out, not truncated: the server never saw it.
    expect(await held(knag)).toBe("");
    await expect(knag.page.locator("[data-agent-state]")).toHaveText("not set");
  });
});
