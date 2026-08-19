import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * The design system, where it can only be checked on a rendered page (#70, #71).
 *
 * 🔴 Everything here is invisible to the unit suite by construction. A token that never
 * resolves, a face that silently falls back, a pseudo-element that a browser declines to
 * render on a replaced element, a colour defined only inside one board's block — none of
 * those fail a build, throw an error, or change a single byte of the document. They just
 * look wrong, on a device, later.
 *
 * Its own file rather than an addition to `render.spec.ts`: the runner gives each spec
 * file its own dev server, and a file past roughly fifteen tests starts tripping the
 * wrangler defect #69 documents. `render.spec.ts` is already at thirteen.
 */

const DAY = [
  "Thursday",
  "- [x] renew passport photo",
  "- [ ] pick up the 4mm drill bit",
  "",
  "```sh",
  "make deploy",
  "```",
].join("\n");

/**
 * Computed style for one property, as the browser actually resolved it.
 *
 * 🔴 Reached through `el.ownerDocument.defaultView` rather than a bare `window`.
 * `browser/tsconfig.json` has no DOM lib — `client/src` is the only place in the tree
 * where DOM types exist — so a callback naming `window` would not compile. Same
 * constraint that shaped `caretOffset` in fixtures.ts.
 */
type Styled = { ownerDocument: { defaultView: unknown } };
type View = {
  getComputedStyle: (e: unknown, pseudo?: string) => { getPropertyValue: (p: string) => string };
};

async function css(locator: Locator, property: string, pseudo = ""): Promise<string> {
  return locator.evaluate(
    (el: Styled, args: { property: string; pseudo: string }) =>
      (el.ownerDocument.defaultView as View)
        .getComputedStyle(el, args.pseudo || undefined)
        .getPropertyValue(args.property),
    { property, pseudo },
  );
}

test.describe("the two voices", () => {
  test("🔴 the page is the human voice and the footer is the machine", async ({ knag }) => {
    // The most important rule in the system, and the one a refactor would quietly undo.
    // Rows are Familjen Grotesk — everything you wrote. Save status, the wordmark and
    // the counts are DM Mono — everything the app says about itself.
    await knag.seed(DAY);

    expect(await css(knag.editor(0), "font-family")).toContain("Familjen Grotesk");
    expect(await css(knag.page.locator("[data-save-status]"), "font-family")).toContain("DM Mono");
    expect(await css(knag.page.locator("footer .wordmark"), "font-family")).toContain("DM Mono");
  });

  test("🔴 a fence and raw view stay mono, and stay untracked", async ({ knag }) => {
    // Tracking undermines the column alignment that makes monospace read as code. This
    // is ADR-004 from the other direction: what is displayed must not diverge from the
    // bytes, and a fence whose columns no longer line up is displaying something the
    // file does not say.
    await knag.seed(DAY);

    const fence = knag.editor(4);
    expect(await css(fence, "font-family")).toContain("DM Mono");
    expect(await css(fence, "letter-spacing")).toBe("normal");
  });

  test("the faces actually loaded, rather than falling back", async ({ knag }) => {
    // `font-display: swap` means a face that 404s renders in the fallback and looks
    // merely a bit off — no error, no failed request anyone sees. Asked of the document
    // rather than inferred from the CSS, which would agree with itself.
    await knag.seed(DAY);

    const loaded = await knag.page.evaluate(
      'Promise.all([document.fonts.load("400 16px \\"Familjen Grotesk\\""),' +
        'document.fonts.load("400 13px \\"DM Mono\\""),' +
        'document.fonts.load("300 14px \\"DM Mono\\"")])' +
        '.then(function (r) { return r.map(function (f) { return f.length }) })',
    );

    expect(loaded, "a declared face matched no @font-face rule").toEqual([1, 1, 1]);
  });
});

test.describe("both boards", () => {
  test("🔴 each resolves a complete palette", async ({ knag }) => {
    // The classic unreadable-page bug: a colour whose only definition sits inside one
    // board's block renders that board's ink on the other board's ground. Invisible
    // until someone switches, and then total.
    await knag.page.locator("[data-settings-open]").click();
    const dialog = knag.page.locator("[data-settings]");

    for (const board of ["whiteboard", "slate"]) {
      await dialog.locator(`[data-theme-set="${board}"]`).click();
      const body = knag.page.locator("body");
      const ground = await css(body, "background-color");
      const ink = await css(body, "color");

      expect(ground, `${board} paints no ground`).not.toBe("rgba(0, 0, 0, 0)");
      expect(ink, `${board} ink matches its own ground`).not.toBe(ground);
    }
  });

  test("🔴 the status bar colour follows the board it is on", async ({ knag }) => {
    // iOS paints the status bar from the meta tag. Leaving it on slate under whiteboard
    // puts a black strip above a pale app, which reads as a rendering bug rather than a
    // preference — and it is the one token duplicated outside the stylesheet, because a
    // <meta> tag cannot read a custom property.
    await knag.page.locator("[data-settings-open]").click();
    const dialog = knag.page.locator("[data-settings]");
    const meta = knag.page.locator('meta[name="theme-color"]');

    await dialog.locator('[data-theme-set="slate"]').click();
    await expect(meta).toHaveAttribute("content", "#11150F");

    await dialog.locator('[data-theme-set="whiteboard"]').click();
    await expect(meta).toHaveAttribute("content", "#EDF1F3");
  });

  test("dark-mode tracking is on slate and off whiteboard", async ({ knag }) => {
    // Light text on a dark ground blooms, and Familjen Grotesk's weight axis starts at
    // 400 — there is no lighter weight to drop to, so the tracking is doing real work
    // rather than being a nicety. On a light ground it is not needed and subpixel AA is,
    // which is why the correction is scoped rather than global.
    await knag.page.locator("[data-settings-open]").click();
    const dialog = knag.page.locator("[data-settings]");
    const body = knag.page.locator("body");

    await dialog.locator('[data-theme-set="slate"]').click();
    expect(await css(body, "letter-spacing")).not.toBe("normal");

    await dialog.locator('[data-theme-set="whiteboard"]').click();
    expect(await css(body, "letter-spacing")).toBe("normal");
  });
});

test.describe("the checkbox", () => {
  test("🔴 a checked box draws its tick", async ({ knag }) => {
    // The tick is a `::after` on an `appearance: none` checkbox — the technique that
    // lets it be the *board* showing through the amber rather than a hardcoded white,
    // which would be wrong on one of the two boards. A browser that declines to render
    // a pseudo-element on a replaced element would give a blank amber square, and
    // nothing else in the suite would notice.
    await knag.seed(DAY);

    const box = knag.page.locator('[data-rows] li.checked input[type="checkbox"]').first();

    // The amber field, and then the mark cut out of it.
    expect(await css(box, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      Number.parseFloat(await css(box, "height", "::after")) || 0,
      "the checked box has no tick",
    ).toBeGreaterThan(0);
  });

  test("an unchecked box draws none", async ({ knag }) => {
    await knag.seed(DAY);

    const box = knag.page.locator('[data-rows] li:not(.checked) input[type="checkbox"]').first();
    expect(Number.parseFloat(await css(box, "height", "::after")) || 0).toBe(0);
  });
});

test.describe("the wipe, the only animation in the product", () => {
  test("🔴 the leaving rows fade before the gap closes", async ({ knag }) => {
    // Two stages on purpose. The rows go transparent **in place, holding their
    // height**, and only then does one collapse close the gap. Fading and collapsing at
    // once makes the list jump under the thumb that just tapped, and the release stops
    // feeling like a release and starts feeling like a mis-tap.
    //
    // Asserted on the class rather than on a measured height: `toHaveClass` retries, so
    // it catches the state without a sleep guessing at the frame it lands on.
    await knag.seed(DAY);

    await knag.page.locator("[data-clear]").click();
    await expect(knag.page.locator("[data-rows] li.wiping").first()).toBeAttached();

    // And it finishes: the row leaves the page, not just the animation.
    await expect.poll(() => knag.document()).not.toContain("- [x]");
  });

  test("🔴 reduced motion leaves the interface still", async ({ knag }) => {
    // Run under the real preference, not inferred from the token values. The tokens
    // collapsing to 1ms is what *should* happen; whether the browser resolves them
    // that way, and whether anything else is still moving, is a different question and
    // the only one worth asserting.
    await knag.page.emulateMedia({ reducedMotion: "reduce" });
    await knag.seed(DAY);

    // The blink stops entirely. A `0s` duration would leave `animation-name` set and
    // this test green while the mark carried on running an animation.
    expect(await css(knag.page.locator("footer .wordmark .block"), "animation-name")).toBe("none");

    // The wipe still happens — the row leaves, it just does not travel to get there.
    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).not.toContain("- [x]");

    await knag.page.emulateMedia({ reducedMotion: "no-preference" });
  });

  test("nothing else on the page animates", async ({ knag }) => {
    // Everything is still except the wipe and the cursor blink in the mark. A fade on
    // mount or a slide-in dialog is a bug against the system, not a nicety.
    await knag.seed(DAY);

    for (const el of ["[data-rows] li", "footer", "[data-save-status]"]) {
      expect(await css(knag.page.locator(el).first(), "animation-name"), el).toBe("none");
    }
    expect(await css(knag.page.locator("footer .wordmark .block"), "animation-name")).toBe(
      "knag-blink",
    );
  });
});

test.describe("glyphs", () => {
  test("🔴 nothing is set in a face that has no codepoint for it", async ({ knag }) => {
    // Every row and bar glyph used to be unicode set in DM Mono — `⠿ ⧉ × ⇅ ⚙ ↗` — and
    // DM Mono has a codepoint for none of them. All six were already rendering from a
    // platform fallback: a different face per OS, at a different optical weight, inside
    // a system with exactly two typefaces in it. Nothing failed and nothing looked
    // obviously wrong on the machine it was written on, which is what makes this worth a
    // test rather than a comment.
    await knag.seed("- [ ] a task");
    await knag.page.locator("[data-reorder]").click();

    for (const control of [".grip", ".copy", ".remove"]) {
      const el = knag.page.locator(`[data-rows] ${control}`).first();
      await expect(el.locator("svg")).toHaveCount(1);
      expect((await el.innerText()).trim(), `${control} still sets a glyph as text`).toBe("");
    }

    for (const control of ["[data-reorder]", "[data-settings-open]"]) {
      const el = knag.page.locator(`footer ${control}`);
      await expect(el.locator("svg")).toHaveCount(1);
      expect((await el.innerText()).trim(), `${control} still sets a glyph as text`).toBe("");
    }
  });
});

/**
 * Layout invariants that hold across every editing surface.
 *
 * 🔴 This describe exists because #116 got past everything. The footer is asserted six
 * times above — voice, colour, animation, control sizes — and its *position* was never
 * asserted anywhere, because in the row model the layout could not get it wrong. A new
 * surface then inherited the container without its contract, and the footer sat 1,223px
 * below the fold on a sixty-line page.
 */
test.describe("the footer belongs to the window", () => {
  const LONG = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

  test("stays on screen in the row list, on a page long enough to overflow", async ({ knag }) => {
    await knag.seed(LONG);
    const viewport = knag.page.viewportSize();
    const footer = await knag.page.locator("footer").boundingBox();
    expect(footer).not.toBeNull();
    expect(viewport).not.toBeNull();
    // 🔴 Measured, not asserted on a class. The bug was invisible to every rule that
    // checks what the footer looks like and visible to anything that asks where it is.
    expect((footer as { y: number; height: number }).y + (footer as { height: number }).height)
      .toBeLessThanOrEqual((viewport as { height: number }).height + 1);
  });

  test("🔴 stays on screen in the editing surface too", async ({ knag }) => {
    await knag.seed(LONG);
    await knag.useEditor();
    const viewport = knag.page.viewportSize();
    const footer = await knag.page.locator("footer").boundingBox();
    expect(footer).not.toBeNull();
    expect((footer as { y: number; height: number }).y + (footer as { height: number }).height)
      .toBeLessThanOrEqual((viewport as { height: number }).height + 1);
  });
});
