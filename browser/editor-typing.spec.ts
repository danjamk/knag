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
 * The typing model on the editing surface, end to end.
 *
 * The decisions themselves live in `edit.ts` as `splitLine`, `applyShorthand` and
 * `revertShorthand`, and are unit-tested there — the same functions the row list calls.
 * What only a browser can answer is whether the keymap reaches them with the caret where
 * the user left it.
 */

test.describe("typing (spec §7, ADR-003 §4)", () => {
  test("Enter continues a checkbox, unchecked", async ({ knag }) => {
    await knag.seed("- [ ] first\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.type("second");
    await knag.saved();
    expect(await knag.document()).toBe("- [ ] first\n- [ ] second\n");
  });

  test("Enter on a checked line still makes an unchecked one", async ({ knag }) => {
    await knag.seed("- [x] done\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.type("next");
    await knag.saved();
    // A line that has just been typed is not already done.
    expect(await knag.document()).toBe("- [x] done\n- [ ] next\n");
  });

  test("Enter on an empty checkbox leaves the list", async ({ knag }) => {
    await knag.seed("- [ ] first\n- [ ] \n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(2);
    await knag.page.keyboard.press("Enter");
    await knag.saved();
    // The marker goes; the line stays. Without this there is no way to stop making
    // checkboxes except reaching for raw view — the mode ADR-003 removed.
    expect(await knag.document()).toBe("- [ ] first\n\n");
  });

  test("Enter continues a bullet with the marker copied, never normalised", async ({ knag }) => {
    await knag.seed("* star\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.type("second");
    await knag.saved();
    // 🔴 `*` continues as `*`. Normalising it to `-` would be knag editing a line the
    // user did not touch.
    expect(await knag.document()).toBe("* star\n* second\n");
  });

  test("indentation carries across a continued checkbox", async ({ knag }) => {
    await knag.seed("  - [ ] nested\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.type("also");
    await knag.saved();
    expect(await knag.document()).toBe("  - [ ] nested\n  - [ ] also\n");
  });

  test("Enter inside a fence is an ordinary newline", async ({ knag }) => {
    // 🔴 A YAML list inside a code block starts lines with `- `. Continuing it there
    // would have knag editing code.
    await knag.seed("```yaml\n- one\n```\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(2);
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.type("- two");
    await knag.saved();
    expect(await knag.document()).toBe("```yaml\n- one\n- two\n```\n");
  });

  test("`--` and a space becomes a checkbox", async ({ knag }) => {
    await knag.seed("");
    await knag.useEditor();
    await knag.surface().click();
    await knag.page.keyboard.type("-- milk");
    await knag.saved();
    expect(await knag.document()).toBe("- [ ] milk");
  });

  test("Backspace straight after the conversion puts the dashes back", async ({ knag }) => {
    await knag.seed("");
    await knag.useEditor();
    await knag.surface().click();
    await knag.page.keyboard.type("-- ");
    await knag.page.keyboard.press("Backspace");
    await knag.saved();
    // 🔴 Without this a literal `--` is untypeable, and a shortcut that takes a
    // character away from you is worse than no shortcut.
    expect(await knag.document()).toBe("-- ");
  });

  test("the revert window closes after any other keystroke", async ({ knag }) => {
    await knag.seed("");
    await knag.useEditor();
    await knag.surface().click();
    await knag.page.keyboard.type("-- x");
    await knag.page.keyboard.press("Backspace");
    await knag.saved();
    // The `x` goes, not the conversion — an undo that stays available forever is a rule
    // nobody can predict.
    expect(await knag.document()).toBe("- [ ] ");
  });

  test("undo never strands a half-converted line", async ({ knag }) => {
    await knag.seed("");
    await knag.useEditor();
    await knag.surface().click();
    await knag.page.keyboard.type("-- ");
    await knag.page.keyboard.press("ControlOrMeta+z");
    await knag.saved();

    // 🔴 Asserted as an invariant, not as an exact document, and the first version of
    // this test got that wrong. CodeMirror groups a burst of typing into one history
    // event, so how far back a single undo goes depends on typing speed — pinning the
    // exact result would pass here and flake in CI.
    //
    // What must hold either way: no undo can leave the conversion stranded. You never
    // get `- [ ] ` back with no way to say what you meant, and never `-- ` still drawn
    // as a checkbox. That is what making the conversion and the space one transaction
    // buys; reacting to `input` after the fact would make them two and break it.
    expect(await knag.document()).not.toContain("- [ ]");
  });

  test("Enter splits a line mid-word without duplicating a marker", async ({ knag }) => {
    await knag.seed("- [ ] milk and eggs\n");
    await knag.useEditor();
    await knag.caretAtEndOfLine(1);
    for (let i = 0; i < 9; i += 1) await knag.page.keyboard.press("ArrowLeft");
    await knag.page.keyboard.press("Enter");
    await knag.saved();
    expect(await knag.document()).toBe("- [ ] milk\n- [ ]  and eggs\n");
  });
});

/**
 * Sync and offline, on the new surface.
 *
 * 🔴 `browser/sync.spec.ts` proves these for the **row list**, and none of it carries
 * over: the row model captured a row index and a caret offset by hand and restored them
 * after a repaint, while this maps the selection through a change. Different mechanism,
 * same promises, so the promises get asserted again rather than assumed.
 */

/** The active poll tier is 4s, so allow a couple of rounds before calling it broken. */
