import { expect, test } from "./fixtures.js";

/**
 * 🔴 Split out of `editor.spec.ts` for #107, not for tidiness.
 *
 * Every dead-server failure in CI has landed in whichever spec file was the slowest at the
 * time — `sync.spec.ts` twice while it was the slowest of seven and of eight, then
 * `editor.spec.ts` twice at 33 tests and 71–124 seconds against a single `wrangler dev`.
 * The runner gives each file its own server precisely because one server dies under
 * cumulative traffic, and one file was asking three times more of its server than any
 * other.
 *
 * So the unit that matters is **how long a file runs**, not how many tests it holds. Keep
 * these under a minute each; if one grows past that, split it again rather than waiting
 * for it to start flaking.
 */

/**
 * Remote changes and offline, on the editing surface.
 *
 * 🔴 The slowest describes in the original file, and most of the reason it ran to 71
 * seconds: these wait on real poll cycles rather than on a repaint. Grouped so the waiting
 * is concentrated in one server rather than spread through a file that also does fast work.
 */

const SYNC_TIMEOUT = 15_000;

test.describe("a remote change, on the editing surface", () => {
  test("appears on a page nobody is touching", async ({ knag }) => {
    await knag.seed("alpha\n");
    await knag.useEditor();

    await knag.writeExternally("alpha\nbravo\n");

    await expect(knag.surface()).toContainText("bravo", { timeout: SYNC_TIMEOUT });
  });

  test("🔴 arrives while the surface has focus without moving the caret", async ({ knag }) => {
    await knag.seed("alpha\nbravo\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);

    await knag.writeExternally("alpha\nbravo\ncharlie\n");
    await expect(knag.surface()).toContainText("charlie", { timeout: SYNC_TIMEOUT });

    // 🔴 The caret is still at the end of "alpha". CodeMirror maps the selection through
    // the change, which is why this is a stronger promise than the row model's — there,
    // a repaint destroyed focus and the caret was put back by hand from a captured
    // index, and lost entirely whenever the row did not survive.
    const offset = await knag.page.evaluate(() => {
      const host = globalThis as { getSelection?: () => { anchorOffset: number } | null };
      return host.getSelection?.()?.anchorOffset ?? -1;
    });
    expect(offset).toBe(5);
  });

  test("does not clobber what is being typed", async ({ knag }) => {
    await knag.seed("alpha\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);
    await knag.page.keyboard.type(" local");

    await knag.writeExternally("remote\n");

    // Held, not applied: spec §6. Applying it under a live caret is how a device jumps
    // mid-keystroke, and dropping it is how one silently stops converging.
    await expect(knag.page.locator("[data-save-status]")).toHaveText(
      /update waiting|editing|saved|reloaded/,
      { timeout: SYNC_TIMEOUT },
    );
    await expect(knag.surface()).toContainText("local");
  });
});

test.describe("offline, on the editing surface", () => {
  test("says so instead of looking live", async ({ knag }) => {
    await knag.seed("alpha\n");
    await knag.useEditor();
    await knag.page.context().setOffline(true);

    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });
  });

  test("refuses edits but stays readable and selectable", async ({ knag }) => {
    await knag.seed("alpha\nbravo\n");
    await knag.useEditor();
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await knag.surface().click();
    await knag.page.keyboard.press("ControlOrMeta+Home");
    await knag.page.keyboard.type("XXX");

    // 🔴 `readOnly`, never `disabled`. Going offline must not make the page unreadable
    // as well as uneditable — you have to still be able to select a line and copy it
    // somewhere that works (spec §9).
    await expect(knag.surface()).toContainText("alpha");
    await expect(knag.surface()).not.toContainText("XXX");
    await expect(knag.page.locator("[data-surface] .cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  test("a checkbox refuses too, since ticking one is an edit", async ({ knag }) => {
    await knag.seed("- [ ] milk\n");
    await knag.useEditor();
    await knag.page.context().setOffline(true);
    await expect(knag.page.locator("[data-save-status]")).toHaveText(/offline/, {
      timeout: 15_000,
    });

    await knag.boxes().first().click({ force: true });
    expect(await knag.document()).toBe("- [ ] milk\n");
  });
});

test.describe("a remote change, twice over", () => {
  test("🔴 a second update still does not move the caret", async ({ knag }) => {
    // The first update alone would pass even with the focus flag mis-set. It is the
    // second that catches it: a stale `focused = false` lets the next one apply under a
    // live caret, which is the failure #62 was reported for.
    await knag.seed("alpha\nbravo\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);

    await knag.writeExternally("alpha\nbravo\ncharlie\n");
    await expect(knag.surface()).toContainText("charlie", { timeout: SYNC_TIMEOUT });

    await knag.writeExternally("alpha\nbravo\ncharlie\ndelta\n");
    await expect(knag.surface()).toContainText("delta", { timeout: SYNC_TIMEOUT });

    const offset = await knag.page.evaluate(() => {
      const host = globalThis as { getSelection?: () => { anchorOffset: number } | null };
      return host.getSelection?.()?.anchorOffset ?? -1;
    });
    expect(offset).toBe(5);
  });
});
