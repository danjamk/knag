import { expect, test } from "./fixtures.js";

/**
 * Offline state (#57, spec §9).
 *
 * The only place this is testable at all. The unit suite owns the decisions —
 * `client/src/sync.ts` and its tests — and none of it can reach a real dropped
 * connection, a real `readOnly` textarea, or the moment the page comes back.
 *
 * 🔴 What is being pinned is that the app **stops pretending**. Before this, a dropped
 * connection produced a page that looked live, accepted typing, and silently discarded
 * every save. Offline editing stays out (spec §12); saying so out loud is the feature.
 */

const PAGE = "first line\n- [ ] second line\nthird line";

test.describe("going offline", () => {
  test("🔴 says so, instead of looking live", async ({ knag }) => {
    await knag.seed(PAGE);
    await knag.page.context().setOffline(true);

    await expect(knag.page.locator("[data-save-status]")).toHaveText("offline", {
      timeout: 15_000,
    });
  });

  test("refuses edits to rows that were not being typed into", async ({ knag }) => {
    await knag.seed(PAGE);
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await expect(knag.editor(0)).toHaveAttribute("readonly", "");
    await expect(knag.editor(2)).toHaveAttribute("readonly", "");
  });

  test("disables the checkbox, since ticking one is an edit too", async ({ knag }) => {
    await knag.seed(PAGE);
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await expect(knag.page.locator('[data-rows] input[type="checkbox"]')).toBeDisabled();
  });

  test("🔴 leaves the page readable and selectable", async ({ knag }) => {
    // `readOnly`, not `disabled`. A disabled textarea cannot be focused or selected, so
    // going offline would make the document unreadable as well as uneditable — and you
    // could not even copy a line out to somewhere that still works.
    await knag.seed(PAGE);
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await knag.editor(0).click();
    await expect(knag.editor(0)).toBeFocused();
    await expect(knag.editor(0)).toHaveValue("first line");
  });
});

test.describe("a browser claiming to be online when it is not", () => {
  // 🔴 The case this feature exists for. A captive portal and a dead uplink both leave
  // `navigator.onLine === true` while every request fails, and that is exactly when
  // someone needs to be told — so `onLine` saying "online" must count for nothing.
  //
  // Getting at it took two attempts, and the first one was worth recording. Aborting
  // requests with `page.route` looks like the obvious way to simulate a dead uplink and
  // **does not work here** — the polls sail straight through and return 200. So the
  // test passed for a reason unrelated to the app, which is worse than not having it.
  //
  // What is done instead: drop the connection for real, then tell the page it is back.
  // The app must not take the browser's word for it. That is the same property, tested
  // from the side that can actually be reached.

  test("🔴 stays offline when told it is online but nothing works", async ({ knag }) => {
    await knag.seed(PAGE);
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    // 🔴 Asserted on **which request the app makes**, not on how the page looks a
    // moment later. Trusting the event unfreezes the page and immediately polls
    // `/api/doc`; that poll then fails and re-freezes within a few hundred
    // milliseconds, so every timing-based check passes either way. The URL does not
    // lie: `/health` means the app went to find out, `/api/doc` means it assumed.
    const asked: string[] = [];
    knag.page.on("request", (request) => asked.push(new URL(request.url()).pathname));

    // The browser now claims connectivity. Everything is still dead.
    //
    // Passed as a string rather than a callback: `browser/tsconfig.json` has no DOM
    // lib, because `client/src` is the only place in the tree where DOM types exist,
    // and a callback naming `window` would not compile. Same constraint that shaped
    // `caretOffset` in fixtures.ts.
    await knag.page.evaluate('window.dispatchEvent(new Event("online"))');
    await knag.page.waitForTimeout(1_000);

    expect(asked).toContain("/health");
    expect(asked).not.toContain("/api/doc");

    // And it is still frozen, because nothing actually succeeded.
    expect(await knag.editor(0).getAttribute("readonly")).not.toBeNull();
    expect(await knag.page.locator("[data-save-status]").textContent()).toContain("offline");
  });

  test("comes back only once a real request succeeds", async ({ knag }) => {
    await knag.seed(PAGE);
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await knag.page.context().setOffline(false);

    // 🔴 The probe hits `/health` rather than `/api/doc`: it is unauthenticated, so a
    // flaky connection cannot bounce someone to the login screen while they wait.
    await expect(knag.editor(0)).not.toHaveAttribute("readonly", "", { timeout: 20_000 });
  });
});

test.describe("coming back", () => {
  test("recovers without a reload", async ({ knag }) => {
    await knag.seed(PAGE);
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await knag.page.context().setOffline(false);

    // Rows editable again, and the status is no longer claiming otherwise.
    await expect(knag.editor(0)).not.toHaveAttribute("readonly", "", { timeout: 15_000 });
    await expect(knag.page.locator("[data-save-status]")).not.toHaveText(/offline/);
  });

  test("🔴 saves an edit that was made while the connection was gone", async ({ knag }) => {
    // The row being typed into when the drop happened keeps working, which leaves
    // exactly one unsaved row in existence. This is the test that it does not evaporate:
    // on reconnect it goes as an ordinary versioned write.
    await knag.seed(PAGE);

    const row = knag.editor(0);
    await row.click();
    await row.press("End");

    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await row.pressSequentially(" edited");
    await expect(row).toHaveValue("first line edited");

    await knag.page.context().setOffline(false);

    await expect
      .poll(() => knag.document(), { timeout: 20_000 })
      .toBe("first line edited\n- [ ] second line\nthird line");
  });

  test("counts unsaved work rather than hiding it behind one word", async ({ knag }) => {
    await knag.seed(PAGE);

    const row = knag.editor(0);
    await row.click();
    await row.press("End");

    await knag.page.context().setOffline(true);
    await row.pressSequentially(" edited");

    await expect(knag.page.locator("[data-save-status]")).toHaveText("offline · 1 unsaved", {
      timeout: 20_000,
    });
  });
});
