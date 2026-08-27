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
    expect(await css(knag.page.locator("[data-login] .wordmark"), "font-family")).toContain(
      "DM Mono",
    );

    // 🔴 The page's name is the *human* voice, and it is the one that is easy to get
    // wrong: it sits on the bar, surrounded by machine strings, and every instinct says
    // to set it in mono like its neighbours. It is what the reader called the document.
    expect(await css(knag.page.locator(".page-name"), "font-family")).toContain(
      "Familjen Grotesk",
    );
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
    await knag.openSettings();
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
    await knag.openSettings();
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
    await knag.openSettings();
    const dialog = knag.page.locator("[data-settings]");
    const body = knag.page.locator("body");

    await dialog.locator('[data-theme-set="slate"]').click();
    expect(await css(body, "letter-spacing")).not.toBe("normal");

    await dialog.locator('[data-theme-set="whiteboard"]').click();
    expect(await css(body, "letter-spacing")).toBe("normal");
  });
});

test.describe("the checkbox", () => {
  // 🔴 Rewritten for one surface (#113). Three of these read
  // `[data-rows] li.checked input`, which only Arrange renders now — and Arrange has no
  // checked/unchecked distinction worth asserting design against, because its rows are
  // dimmed and non-interactive by definition.
  //
  // The claim that mattered survives and is now simpler to state: the surface draws its
  // own box rather than letting the platform own one.

  test("🔴 the editing surface draws the box, not a native one", async ({ knag }) => {
    // It used to be a *native* checkbox tinted with `accent-color: var(--amber)`, which
    // looks right until the window loses focus: macOS desaturates native form controls
    // in an inactive window, so the amber and the border both vanished and the box
    // rendered system white-and-black. On a screen kept open beside your work all day,
    // that is most of the time.
    //
    // 🔴 This pins the *mechanism*, not the symptom — window-inactive rendering cannot
    // be reproduced headlessly. `appearance: none` is what takes the control away from
    // the platform, and a platform that does not own it cannot restyle it on blur.
    await knag.seed(DAY);
    await knag.useEditor();

    const box = knag.boxes().first();
    await expect(box).toBeVisible();

    expect(await css(box, "appearance")).toBe("none");
  });

  test("🔴 a checked box draws its tick, and an unchecked one draws none", async ({ knag }) => {
    // The tick is a `::after` on an `appearance: none` checkbox — the technique that
    // lets it be the *board* showing through the amber rather than a hardcoded white,
    // which would be wrong on one of the two boards. A browser that declines to render
    // a pseudo-element on a replaced element would give a blank amber square, and
    // nothing else in the suite would notice.
    await knag.seed(DAY);
    await knag.useEditor();

    const checked = knag.page.locator("[data-surface] .cm-done input.cm-box").first();
    await expect(checked).toBeVisible();

    // The amber field, and then the mark cut out of it.
    expect(await css(checked, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      Number.parseFloat(await css(checked, "height", "::after")) || 0,
      "the checked box has no tick",
    ).toBeGreaterThan(0);

    const unchecked = knag.page
      .locator("[data-surface] .cm-line:not(.cm-done) input.cm-box")
      .first();
    expect(Number.parseFloat(await css(unchecked, "height", "::after")) || 0).toBe(0);
  });

  test("🔴 the target is 44px and reaches the edge, and the ink did not move", async ({
    knag,
  }) => {
    // An 18px box was the whole hit area, in a product whose own rule is 44 (#193). The
    // span around it is the target; the box is the ink. Two things have to hold at once:
    // a tap well outside the ink toggles, and nothing on the line moved to pay for it.
    await knag.seed(["plain", "- [ ] tap me", ""].join("\n"));
    await knag.useEditor();

    const lines = knag.page.locator("[data-surface] .cm-line");
    const plain = await lines.nth(0).boundingBox();
    const line = lines.nth(1);
    const row = await line.boundingBox();
    const ink = await line.locator("input.cm-box").boundingBox();
    if (!plain || !row || !ink) throw new Error("no geometry");

    // The ink: 18px, at --row-pad-left from the line's edge, on a line no taller than a
    // plain one. If the target had widened the flow, either number moves.
    expect(ink.width).toBe(18);
    expect(ink.x - row.x).toBe(14);
    expect(row.height).toBe(plain.height);

    // 🔴 And the span itself is no taller than the ink (#226). The target used to be the
    // span — 44px, pulled back with negative margins — and every assertion above held
    // while WebKit drew a 44px caret on every checkbox line, because the native caret
    // takes the line's tallest border box and ignores margins. The caret cannot be
    // measured from here; the box that sets its height can.
    const hit = await line.locator(".cm-box-hit").boundingBox();
    if (!hit) throw new Error("no geometry");
    expect(hit.height).toBe(18);

    // The target: 12px left of the ink is inside the row padding, 20px below its top is
    // past the ink's bottom edge — neither point is on the box, both are on the target.
    await knag.page.mouse.click(ink.x - 12, ink.y + 20);
    await expect(line).toHaveClass(/cm-done/);
    // Polled: the save behind the toggle is debounced, and the byte is the product.
    await expect.poll(() => knag.document()).toBe(["plain", "- [x] tap me", ""].join("\n"));
  });
});

test.describe("the wipe, the only animation in the product", () => {
  test("🔴 the leaving lines fade before the gap closes", async ({ knag }) => {
    // Two stages on purpose. The rows go transparent **in place, holding their
    // height**, and only then does one collapse close the gap. Fading and collapsing at
    // once makes the list jump under the thumb that just tapped, and the release stops
    // feeling like a release and starts feeling like a mis-tap.
    //
    // Asserted on the class rather than on a measured height: `toHaveClass` retries, so
    // it catches the state without a sleep guessing at the frame it lands on.
    await knag.seed(DAY);

    await knag.useEditor();
    await knag.page.locator("[data-clear]").click();
    await expect(knag.page.locator("[data-surface] .cm-line.cm-wiping").first()).toBeAttached();

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
    expect(await css(knag.page.locator("[data-login] .wordmark .block"), "animation-name")).toBe(
      "none",
    );

    // The wipe still happens — the row leaves, it just does not travel to get there.
    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).not.toContain("- [x]");

    await knag.page.emulateMedia({ reducedMotion: "no-preference" });
  });

  test("nothing else on the page animates", async ({ knag }) => {
    // Everything is still except the wipe and the cursor blink in the mark. A fade on
    // mount or a slide-in dialog is a bug against the system, not a nicety.
    await knag.seed(DAY);

    await knag.useEditor();

    for (const el of ["[data-surface] .cm-line", "footer", "[data-save-status]", "[data-ledge]"]) {
      expect(await css(knag.page.locator(el).first(), "animation-name"), el).toBe("none");
    }
    expect(await css(knag.page.locator("[data-login] .wordmark .block"), "animation-name")).toBe(
      "knag-blink",
    );
  });

  test("🔴 the ledge is a state change, not a second animation", async ({ knag }) => {
    // The boundary the one-animation rule now draws (#139, CLAUDE.md). The ledge has to
    // move — instant reads as a bug on a 120Hz screen — and the way it is allowed to is
    // by being a control arriving at its state rather than motion: a transition, on the
    // press tint's own token, with no keyframes and no travel.
    //
    // Asserted as a transition *and* as no animation, because either alone passes while
    // the other one quietly becomes a keyframed slide.
    await knag.seed(DAY);
    const ledge = knag.page.locator("[data-ledge]");

    expect(await css(ledge, "animation-name")).toBe("none");
    expect(await css(ledge, "transition-property")).toBe("height");

    // Compared in milliseconds rather than as strings: the token says `90ms` and every
    // engine reports the resolved duration as `0.09s`, so a string comparison fails on a
    // unit rather than on the thing being asserted.
    const ms = (value: string) =>
      value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;

    expect(ms(await css(ledge, "transition-duration"))).toBe(
      ms(await css(knag.page.locator("body"), "--state-duration")),
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
    await knag.arrange();

    for (const control of [".grip", ".copy", ".remove"]) {
      const el = knag.page.locator(`[data-rows] ${control}`).first();
      await expect(el.locator("svg")).toHaveCount(1);
      expect((await el.innerText()).trim(), `${control} still sets a glyph as text`).toBe("");
    }

    // 🔴 The bar's controls now carry a label under the glyph (#139), so "no text at
    // all" stopped being the right assertion — the label *is* text and is meant to be.
    // What still has to hold is that the drawing is an SVG and the text is the word:
    // a unicode glyph creeping back in would not equal the label.
    await knag.openLedge();

    for (const [control, label] of [
      ["[data-reorder]", "arrange"],
      ["[data-settings-open]", "settings"],
      ["[data-copy-page]", "copy"],
    ]) {
      const el = knag.page.locator(`[data-ledge] ${control}`);
      await expect(el.locator("svg")).toHaveCount(1);
      expect((await el.innerText()).trim(), `${control} sets something other than its label`).toBe(
        label,
      );
    }

    // Tier 1's one glyph control has no label and must still have no text.
    const toggle = knag.page.locator("[data-ledge-toggle]");
    await expect(toggle.locator("svg")).toHaveCount(1);
    expect((await toggle.innerText()).trim()).toBe("");
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
