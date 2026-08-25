import { expect, test } from "./fixtures.js";

/**
 * The wipe, in the editing surface (#119).
 *
 * 🔴 It did not happen there at all. `animateWipe` resolved `li[data-index]` inside
 * `[data-rows]`, and `paint()` empties that list in editor view — so the function
 * returned on its first guard and the checked lines simply vanished on the repaint.
 * The wipe is the only animation in the product and the moment the whole nag → wipe
 * loop is built around, and the surface replacing the row list did not have it.
 *
 * Nothing caught it because `wipe.spec.ts` runs entirely in the row list. These are the
 * assertions that only exist in the other surface, in their own spec file per the
 * runner's one-server-per-file rule (#69, #107).
 */

const DAY = [
  "Thursday",
  "- [x] renew the domain",
  "- [ ] call the accountant",
  "- [x] pay the invoice",
  "",
].join("\n");

test.describe("wiping from the editing surface", () => {
  test("🔴 marks the leaving lines, which it did not do at all before", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.useEditor();

    // Not awaited — the assertion has to land while the sequence is running, which is
    // the entire difference between this passing and the bug being present.
    void knag.page.locator("[data-clear]").click();

    const wiping = knag.page.locator("[data-surface] .cm-line.cm-wiping");
    await expect(wiping).toHaveCount(2, { timeout: 2000 });
  });

  test("🔴 fades in place before it collapses, never both at once", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.useEditor();

    // 🔴 Sampled inside the page at the instant the class lands (#201), not from out
    // here on the runner's clock. The fade is 260ms; polled from outside, the first
    // sample landed after the collapse had begun on a loaded runner, and this went red
    // twice in one day — the second time in front of a production deploy.
    await knag.armWipeSampler();
    await knag.page.locator("[data-clear]").click();
    const first = await knag.wipeSample();

    // The two stages are the design decision, not an implementation detail: fading and
    // collapsing together makes the page jump under the thumb that just tapped, and the
    // release stops feeling like a release. So the first stage must not be collapsing.
    expect(first.maxHeight).not.toBe("0px");
    expect(Number.parseFloat(first.opacity)).toBeGreaterThan(0);
  });

  test("🔴 leaves the document byte-exact, and no line stranded invisible", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.useEditor();

    await knag.page.locator("[data-clear]").click();
    await expect(knag.page.locator("[data-surface] .cm-line.cm-wiping")).toHaveCount(0, {
      timeout: 5000,
    });

    // 🔴 The failure this guards is specific and nasty: `setBody` computes a *minimal*
    // change, so a surviving line keeps its position — and would keep a stale
    // `cm-wiping` class with it, leaving a line of the new document permanently
    // invisible. The class count above is that check; the bytes are the product.
    expect(await knag.document()).toBe(["Thursday", "- [ ] call the accountant", ""].join("\n"));
  });

  test("🔴 takes every line of a fence, not just the one it starts on", async ({ knag }) => {
    // A block is one <li> in the row list, so block indices and lines were the same
    // thing there. A fence is one block and several lines.
    const fenced = ["```js", "const x = 1;", "```", "- [ ] after", ""].join("\n");
    await knag.seed(fenced);
    await knag.useEditor();

    await knag.openLedge();
    void knag.page.locator("[data-wipe-all]").click();
    void knag.page.locator("[data-wipe-all]").click();

    const wiping = knag.page.locator("[data-surface] .cm-line.cm-wiping");
    // Five lines: three of fence, the checkbox, and the trailing empty line.
    await expect(wiping).toHaveCount(5, { timeout: 3000 });
  });

  test("🔴 the wipe control exists here at all, which it did not", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.useEditor();

    // The condition was `view !== "list"`, written before this surface existed, so the
    // only wipe reachable from the editor was the whole-page one in Settings. That is
    // most of why the animation looked missing: there was nothing to press.
    await expect(knag.page.locator("[data-clear]")).toBeVisible();
    await expect(knag.page.locator("[data-clear-count]")).toHaveText("2");
  });

  test("and still does not exist in raw view, which is the deliberate half", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openSettings();
    await knag.page.locator('[data-view-set="raw"]').click();
    await knag.page.keyboard.press("Escape");

    // Raw is the escape hatch for a bulk paste; sweeping from it would act on a document
    // the reader is halfway through rewriting by hand. Fixing the editor case must not
    // quietly turn this one on too.
    await expect(knag.page.locator("[data-clear]")).toBeHidden();
  });

  test("🔴 the collapse does not move the page under the reader", async ({ knag }) => {
    // The risk in animating a line's height inside CodeMirror: it measures and caches
    // line heights, so a transition it does not know about can leave the scroller
    // pointing somewhere else. A wipe that scrolls the page is worse than one that does
    // not animate, because the reader loses their place rather than a flourish.
    const long = [
      ...Array.from({ length: 60 }, (_, i) => `line ${i}`),
      "- [x] renew the domain",
      "",
    ].join("\n");
    await knag.seed(long);
    await knag.useEditor();

    const scroller = knag.page.locator("[data-surface] .cm-scroller");
    await scroller.evaluate((el: { scrollTop: number }) => {
      el.scrollTop = 200;
    });
    const before = await scroller.evaluate((el: { scrollTop: number }) => el.scrollTop);

    await knag.page.locator("[data-clear]").click();
    await expect(knag.page.locator("[data-surface] .cm-line.cm-wiping")).toHaveCount(0, {
      timeout: 5000,
    });

    const after = await scroller.evaluate((el: { scrollTop: number }) => el.scrollTop);
    // One line left the document, so some movement is honest. A jump is not.
    expect(Math.abs(after - before)).toBeLessThan(60);
  });

  test("a wipe that takes nothing animates nothing", async ({ knag }) => {
    await knag.seed(["Thursday", "- [ ] call the accountant", ""].join("\n"));
    await knag.useEditor();

    // The control is absent at zero rather than disabled, so there is nothing to tap —
    // asserted here because an empty animation that still ran would blank the page for
    // 632ms for no reason.
    await expect(knag.page.locator("[data-clear]")).toBeHidden();
  });

  test("reduced motion collapses the sequence rather than skipping it", async ({ knag }) => {
    await knag.page.emulateMedia({ reducedMotion: "reduce" });
    await knag.seed(DAY);
    await knag.useEditor();

    await knag.page.locator("[data-clear]").click();

    // 🔴 The tokens are rewritten to 1ms by a media query in the shell, and both surfaces
    // read the same ones — so this is free rather than a second code path that could
    // disagree with the stylesheet. What matters is that the document still ends right.
    await expect
      .poll(() => knag.document(), { timeout: 5000 })
      .toBe(["Thursday", "- [ ] call the accountant", ""].join("\n"));
  });
});
