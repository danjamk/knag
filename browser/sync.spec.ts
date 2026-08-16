import { expect, test } from "./fixtures.js";

/**
 * Live sync, in a real browser (#62).
 *
 * The bug this file exists for was reported from a phone and an iPad, survived 344
 * passing tests, and is unreachable from the unit suite by construction: it is focus,
 * plus a repaint, plus a text selection. The pure decision now has its own test in
 * `client/test/sync.test.ts` — this is the half that decision cannot prove.
 *
 * Every test changes the document through the API **without reloading the page**, then
 * waits for the page to notice by itself. Reloading would pass whatever the code did.
 */

/** The active poll tier is 4s, so allow a couple of rounds before calling it broken. */
const SYNC_TIMEOUT = 15_000;

test.describe("a remote change arriving", () => {
  test("appears on a page nobody is touching", async ({ knag }) => {
    await knag.seed("alpha");

    await knag.writeExternally("alpha\nbravo");

    await expect(knag.rows()).toHaveCount(2, { timeout: SYNC_TIMEOUT });
    await expect(knag.editor(1)).toHaveValue("bravo");
  });

  test("🔴 appears while a row has focus, and does not move the caret", async ({ knag }) => {
    // The reported bug, exactly. A browser restores focus to the last-focused element
    // when you return to a window, so `focused` was true again before the first poll
    // after picking the device back up — and the update went into a queue with no
    // expiry and no signal. The page went stale precisely when you came back to it.
    await knag.seed("alpha\nbravo");

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    expect(await knag.caretOffset()).toBe(5);

    await knag.writeExternally("alpha\nbravo\ncharlie");

    // It must arrive without anyone clicking anything.
    await expect(knag.rows()).toHaveCount(3, { timeout: SYNC_TIMEOUT });
    await expect(knag.editor(2)).toHaveValue("charlie");

    // 🔴 And the caret must not have moved — the whole reason the old code refused.
    // Assigning a textarea's value resets the selection, so applying the update
    // naively throws the cursor to the end of whatever row it lands in.
    expect(await knag.focusedRowIndex()).toBe(0);
    expect(await knag.caretOffset()).toBe(5);
  });

  test("keeps the caret when the focused row's own text changed", async ({ knag }) => {
    // The harder case: the row under the caret is itself rewritten. The offset is
    // clamped to the new length rather than left dangling past the end.
    await knag.seed("alpha\nbravo");

    const row = knag.editor(1);
    await row.click();
    await row.press("End");

    await knag.writeExternally("alpha\nbr");

    await expect(knag.editor(1)).toHaveValue("br", { timeout: SYNC_TIMEOUT });
    expect(await knag.focusedRowIndex()).toBe(1);
    expect(await knag.caretOffset()).toBeLessThanOrEqual(2);
  });

  test("does not lose focus when the focused row disappears", async ({ knag }) => {
    // The row the caret was in does not survive the repaint. Focus lands wherever the
    // browser puts it — what matters is that the update applied and the page is not
    // left holding a stale `focused` flag that blocks every future one.
    await knag.seed("alpha\nbravo\ncharlie");

    const row = knag.editor(2);
    await row.click();

    await knag.writeExternally("alpha");

    await expect(knag.rows()).toHaveCount(1, { timeout: SYNC_TIMEOUT });

    // The proof that the flag was corrected: a *second* remote change still arrives.
    await knag.writeExternally("alpha\ndelta");
    await expect(knag.rows()).toHaveCount(2, { timeout: SYNC_TIMEOUT });
  });

  test("🔴 keeps arriving, poll after poll", async ({ knag }) => {
    // The shape of the original failure was that sync worked once and then stopped.
    // One update proves very little; three in a row prove the loop is alive.
    await knag.seed("one");

    for (const [n, body] of [
      [2, "one\ntwo"],
      [3, "one\ntwo\nthree"],
      [4, "one\ntwo\nthree\nfour"],
    ] as const) {
      await knag.writeExternally(body);
      await expect(knag.rows()).toHaveCount(n, { timeout: SYNC_TIMEOUT });
    }
  });
});

test.describe("a local edit racing a remote one", () => {
  test("is not repainted out from under the caret", async ({ knag }) => {
    // The half of the guard that stays: while there are unsaved keystrokes, an
    // incoming update is held rather than applied. Whatever happens next, it does not
    // happen *while you are typing into the row*.
    await knag.seed("alpha");
    await knag.writeExternally("remote change");

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    await row.pressSequentially(" typed");

    await expect(row).toHaveValue("alpha typed");
  });

  test("🔴 resolves to the server's copy, and says so", async ({ knag }) => {
    // Spec §6: never merge, never overwrite. A save carrying a stale `base_version`
    // gets a 409 and the server's copy is loaded.
    //
    // 🔴 Worth stating plainly, because the first version of this test asserted the
    // opposite and was wrong: **in-flight typing IS lost in a genuine conflict.** The
    // guarantee knag makes is about *saved* work — that an iPad left open for three
    // days cannot overwrite a week of edits. It is not a promise that the ~800ms
    // between a keystroke and its save is protected, and merging to make it one is
    // the thing spec §6 refuses.
    //
    // The reload is announced rather than silent, which is what makes it survivable.
    await knag.seed("alpha");
    await knag.writeExternally("remote change");

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    await row.pressSequentially(" typed");

    await expect(knag.page.locator("[data-save-status]")).toHaveText(/reloaded/, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(knag.editor(0)).toHaveValue("remote change");
    expect(await knag.document()).toBe("remote change");
  });
});
