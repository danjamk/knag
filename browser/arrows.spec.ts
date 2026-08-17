import { expect, test } from "./fixtures.js";

/**
 * Moving the caret between rows with the four arrow keys (#84, #88).
 *
 * 🔴 None of this is reachable from `client/test/`. Every assertion depends on where a
 * glyph actually landed — which visual line the caret is on, and how wide the characters
 * either side of a row boundary are. `edit.ts` is pure by contract and cannot know; what
 * it decides is *whether* there is a row to move to, never where the caret lands on it.
 *
 * Split out of `editing.spec.ts` rather than added to it. `scripts/browser-tests.sh`
 * gives each spec file its own dev server because `wrangler dev` dies on cumulative
 * traffic, and records that a file past roughly fifteen tests starts flaking again —
 * with the instruction to split rather than raise a timeout. Adding the vertical pair to
 * `editing.spec.ts` would have taken it to eighteen.
 */

const DOC = "first line\nsecond line\nthird line";

test.describe("horizontal arrows across a row boundary", () => {
  test("🔴 right at the end of a line moves to the next", async ({ knag }) => {
    // Every other editor does this, and its absence is felt immediately: the caret hits
    // the end of a row and simply stops, so moving through the page by keyboard means
    // reaching for the down arrow and then Home.
    await knag.seed(DOC);

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    await knag.page.keyboard.press("ArrowRight");

    expect(await knag.focusedRowIndex()).toBe(1);
    expect(await knag.caretOffset()).toBe(0);
  });

  test("🔴 left at the start of a line moves to the end of the previous", async ({ knag }) => {
    await knag.seed(DOC);

    await knag.placeCaret(1, 0);
    await knag.page.keyboard.press("ArrowLeft");

    expect(await knag.focusedRowIndex()).toBe(0);
    expect(await knag.caretOffset()).toBe("first line".length);
  });

  test("stays put at the very start and the very end of the page", async ({ knag }) => {
    // Nothing to move to. The keystroke is a no-op rather than an error, and the caret
    // does not jump somewhere arbitrary.
    await knag.seed(DOC);

    await knag.placeCaret(0, 0);
    await knag.page.keyboard.press("ArrowLeft");
    expect(await knag.focusedRowIndex()).toBe(0);
    expect(await knag.caretOffset()).toBe(0);

    const last = knag.editor(2);
    await last.click();
    await last.press("End");
    await knag.page.keyboard.press("ArrowRight");
    expect(await knag.focusedRowIndex()).toBe(2);
    expect(await knag.caretOffset()).toBe("third line".length);
  });

  test("leaves the arrows alone inside a line", async ({ knag }) => {
    // The boundary is the only place these are intercepted. Anywhere else they belong
    // to the field, which is what makes a long wrapped row navigable at all.
    await knag.seed(DOC);

    const row = knag.editor(1);
    await row.click();
    await row.press("End");
    await knag.page.keyboard.press("ArrowLeft");

    expect(await knag.focusedRowIndex()).toBe(1);
    expect(await knag.caretOffset()).toBe("second line".length - 1);
  });
});

/**
 * The vertical pair (#88), which shipped in #84 untested and wrong in two ways.
 *
 * Rows of one repeated character appear on purpose wherever a movement is asserted: with
 * uniform glyph widths a pixel column and a character offset coincide, so the test can
 * state an exact offset instead of a tolerance. The proportional case gets its own test,
 * because that is precisely what a character offset gets wrong.
 */
test.describe("vertical arrows", () => {
  const UNIFORM = "mmmmmmmmmm\nmmmmmmmmmm\nmmmmmmmmmm";

  test("🔴 one press changes rows", async ({ knag }) => {
    // The reported bug: `↓` from the middle of a row moved the caret to the end of that
    // row instead, so changing rows cost two presses and the first one went somewhere
    // nobody asked for. The old gate only fired with the caret already at
    // `value.length`, so mid-row the browser handled it — and what a browser does with
    // `↓` in a one-line textarea is jump to the end of the text.
    await knag.seed(UNIFORM);

    await knag.placeCaret(1, 6);
    await knag.page.keyboard.press("ArrowDown");

    expect(await knag.focusedRowIndex()).toBe(2);
    expect(await knag.caretOffset()).toBe(6);
  });

  test("🔴 up keeps the column instead of jumping to the end", async ({ knag }) => {
    // #84 deliberately landed `↑` at the **end** of the row above, reading it as "back
    // one line". That is `←` semantics. `↑` keeps the column, and "back one line ends at
    // its end" belongs to the horizontal pair.
    await knag.seed(UNIFORM);

    await knag.placeCaret(1, 4);
    await knag.page.keyboard.press("ArrowUp");

    expect(await knag.focusedRowIndex()).toBe(0);
    expect(await knag.caretOffset()).toBe(4);
    expect(await knag.caretOffset()).not.toBe("mmmmmmmmmm".length);
  });

  test("🔴 the column is pixels, not characters", async ({ knag }) => {
    // The decision in #88, made visible. `neighbor`'s `Math.min(offset, length)` would
    // put the caret at offset 8 of the wide row, which is nowhere near where the caret
    // visually was — eight narrow glyphs are about two wide ones. Any landing at or past
    // 8 means the column travelled as a character count.
    await knag.seed("iiiiiiiiiiii\nWWWWWWWWWWWW");

    await knag.placeCaret(0, 8);
    await knag.page.keyboard.press("ArrowDown");

    expect(await knag.focusedRowIndex()).toBe(1);
    expect(await knag.caretOffset()).toBeLessThan(8);
  });

  test("🔴 stays inside a row that wraps", async ({ knag }) => {
    // The reason the gate has to be visual rather than an offset comparison. A `.text`
    // row is a `<textarea rows="1">` so long notes wrap, and intercepting `↑`
    // unconditionally would make every visual line after the first unreachable.
    await knag.seed(`short\n${"word ".repeat(80).trim()}\nshort`);

    await knag.placeCaret(1, 200);
    await knag.page.keyboard.press("ArrowUp");

    // Still in the long row, having moved up one visual line within it.
    expect(await knag.focusedRowIndex()).toBe(1);
    const offset = await knag.caretOffset();
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(200);
  });

  test("visits a blank row rather than skipping it", async ({ knag }) => {
    // A blank row is a place you can type, so stepping over one would make the arrows
    // disagree with what is on screen.
    await knag.seed("first\n\nthird");

    await knag.placeCaret(0, 0);
    await knag.page.keyboard.press("ArrowDown");
    expect(await knag.focusedRowIndex()).toBe(1);

    await knag.page.keyboard.press("ArrowDown");
    expect(await knag.focusedRowIndex()).toBe(2);
  });

  test("collapses a selection rather than crossing a boundary", async ({ knag }) => {
    // Doctrine already in the handler for the horizontal pair, now extended: a live
    // selection is not a caret, and every editor collapses it on an arrow rather than
    // moving somewhere. Crossing here would eat the gesture.
    await knag.seed(UNIFORM);

    const row = knag.editor(0);
    await row.click();
    await row.evaluate((el: { setSelectionRange: (a: number, b: number) => void }) =>
      el.setSelectionRange(2, 7),
    );
    await knag.page.keyboard.press("ArrowDown");

    expect(await knag.focusedRowIndex()).toBe(0);
  });

  test("does nothing at the top and bottom of the page", async ({ knag }) => {
    // 🔴 The caret holds its place. Handing the keystroke back to the browser here —
    // which is what a bounds check alone does — lets a one-line textarea slam the caret
    // to the start or end of its text, the same unasked-for jump this issue is about,
    // just at the ends of the document.
    await knag.seed(UNIFORM);

    await knag.placeCaret(0, 5);
    await knag.page.keyboard.press("ArrowUp");
    expect(await knag.focusedRowIndex()).toBe(0);
    expect(await knag.caretOffset()).toBe(5);

    await knag.placeCaret(2, 5);
    await knag.page.keyboard.press("ArrowDown");
    expect(await knag.focusedRowIndex()).toBe(2);
    expect(await knag.caretOffset()).toBe(5);
  });
});
