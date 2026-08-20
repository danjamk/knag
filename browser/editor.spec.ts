import { expect, test } from "./fixtures.js";

/**
 * The CodeMirror surface itself (#110).
 *
 * Typing lives in `editor-typing.spec.ts`, and remote changes and offline in
 * `editor-sync.spec.ts` — split for #107, because every dead-server failure in CI has
 * landed in whichever spec file was slowest at the time and this one was three times
 * longer than any other. Keep each under a minute.
 *
 * 🔴 Every assertion here is about **bytes or computed style**, never about a class name.
 * #108 shipped a selection nobody could see past twelve tests, all of which asserted the
 * `picked` class rather than whether it was visible. The same trap is wide open on a
 * surface whose whole job is drawing controls over text.
 */

const DOC = [
  "Thursday",
  "",
  "- [ ] call the accountant",
  "- [x] renew the domain",
  "  - [ ] and update the DNS record",
  "* star bullet",
  "notes https://example.com/x",
].join("\n");

test.describe("the editing surface", () => {
  test("mounts, and shows the document", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();
    await expect(knag.surface()).toContainText("call the accountant");
    await expect(knag.surface()).toContainText("star bullet");
  });

  test("draws a control over every checkbox and nothing else", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();
    await expect(knag.boxes()).toHaveCount(3);
  });

  test("the marker bytes are hidden but still in the document", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();
    // The prefix is drawn as a control, so it must not also be readable as text...
    await expect(knag.surface()).not.toContainText("- [ ] call");
    // ...while the file still says exactly what it said.
    expect(await knag.document()).toBe(DOC);
  });

  test("toggling a checkbox rewrites exactly one byte", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();
    await knag.boxes().first().click();
    await knag.saved();

    const after = await knag.document();
    expect(after).toBe(DOC.replace("- [ ] call the accountant", "- [x] call the accountant"));

    let differences = 0;
    for (let i = 0; i < Math.max(DOC.length, after.length); i += 1) {
      if (DOC[i] !== after[i]) differences += 1;
    }
    expect(differences).toBe(1);
  });

  test("a checked line is visibly struck through, not merely classed", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();
    // 🔴 Computed style. The #108 lesson: a state that cannot be seen has not shipped.
    const decoration = await knag.page
      .locator("[data-surface] .cm-done")
      .first()
      .evaluate((element) => {
        const host = element as unknown as { ownerDocument: { defaultView: unknown } };
        const view = host.ownerDocument.defaultView as {
          getComputedStyle: (e: unknown) => { textDecorationLine: string };
        };
        return view.getComputedStyle(element).textDecorationLine;
      });
    expect(decoration).toContain("line-through");
  });

  test("a row holding a URL gets an affordance that opens it", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();
    const open = knag.page.locator("[data-surface] a.cm-open");
    await expect(open).toHaveCount(1);
    await expect(open).toHaveAttribute("href", "https://example.com/x");
    // Without noopener the opened page gets a handle on this one via window.opener.
    await expect(open).toHaveAttribute("rel", /noopener/);
  });
});

test.describe("selection across lines — the reason this exists", () => {
  test("a selection spans more than one line", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    await knag.surface().click();
    await knag.page.keyboard.press("ControlOrMeta+Home");
    for (let i = 0; i < 3; i += 1) await knag.page.keyboard.press("Shift+ArrowDown");

    const selected = await knag.selection();
    expect(selected).toContain("Thursday");
    expect(selected.split("\n").length).toBeGreaterThan(1);
  });

  test("deleting across lines removes exactly those bytes", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    await knag.surface().click();
    await knag.page.keyboard.press("ControlOrMeta+Home");
    // Two lines down selects "Thursday" and the blank line after it.
    await knag.page.keyboard.press("Shift+ArrowDown");
    await knag.page.keyboard.press("Shift+ArrowDown");
    await knag.page.keyboard.press("Backspace");
    await knag.saved();

    // 🔴 An exact identity, not "shorter" or "no longer contains". This is the drill that
    // destroyed the raw contenteditable spike in ADR-006 — one Backspace across rows left
    // stray spans and inlined font styles, and it all rendered correctly.
    expect(await knag.document()).toBe(DOC.slice(DOC.indexOf("- [ ] call")));
  });

  test("copying across lines puts the marker bytes on the clipboard", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    await knag.surface().click();
    await knag.page.keyboard.press("ControlOrMeta+Home");
    for (let i = 0; i < 4; i += 1) await knag.page.keyboard.press("Shift+ArrowDown");

    // 🔴 The clipboard, not `getSelection().toString()`. The marker is a *replacing*
    // decoration, so the DOM does not contain `- [ ] ` at all and the selection string
    // cannot see it — while CodeMirror's copy handler writes document text. Asserting on
    // the selection measured the rendering and called it the clipboard.
    const copied = await knag.page.evaluate(async () => {
      const host = globalThis as unknown as {
        document: {
          addEventListener: (t: string, f: (e: unknown) => void, o: unknown) => void;
          execCommand: (c: string) => boolean;
        };
      };
      return new Promise<string>((resolve) => {
        host.document.addEventListener(
          "copy",
          (event) => {
            const e = event as { clipboardData?: { getData: (t: string) => string } };
            resolve(e.clipboardData?.getData("text/plain") ?? "");
          },
          { once: true },
        );
        host.document.execCommand("copy");
      });
    });

    // Recorded rather than judged: a selection copy takes document text, so it carries
    // `- [ ] `, while Arrange's per-row copy strips it. The two disagree, #110 has to
    // decide which is right, and this pins today's answer so the change is visible.
    expect(copied).toContain("- [ ] call the accountant");
  });
});

test.describe("byte preservation", () => {
  test("a CRLF document survives editing another line", async ({ knag }) => {
    const crlf = "alpha\r\nbeta\ngamma\r\n";
    await knag.seed(crlf);
    await knag.useEditor();

    await knag.surface().click();
    await knag.page.keyboard.press("ControlOrMeta+End");
    await knag.page.keyboard.type("X");
    await knag.saved();

    // Every ending untouched, and the typed character where it was typed.
    expect(await knag.document()).toBe("alpha\r\nbeta\ngamma\r\nX");
  });

  test("trailing whitespace and a tab survive a round trip", async ({ knag }) => {
    const awkward = "trailing spaces   \n\ttab indented\n* star\n";
    await knag.seed(awkward);
    await knag.useEditor();
    await expect(knag.surface()).toContainText("tab indented");
    expect(await knag.document()).toBe(awkward);
  });
});

test.describe("Arrange, from the editing surface", () => {
  test("entering Arrange swaps to rows and destroys the surface", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    await knag.arrange();
    await expect(knag.rows()).toHaveCount(7);
    // 🔴 Destroyed, not hidden. Two live editing surfaces over one document is the
    // failure the two-rendering design exists to avoid.
    await expect(knag.surface()).toHaveCount(0);
  });

  test("a trip through Arrange with no drag is byte-identical", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    await knag.arrange();
    await expect(knag.rows()).toHaveCount(7);
    await knag.arrange();
    await expect(knag.surface()).toBeVisible();
    await knag.saved();

    // The check that matters. A broken drag is visible in seconds; two renderings quietly
    // disagreeing about the document is not.
    expect(await knag.document()).toBe(DOC);
  });
});

test.describe("the preference", () => {
  test("survives a reload", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();
    await knag.page.reload();
    await expect(knag.surface()).toBeVisible();
    await expect(knag.rows()).toHaveCount(0);
  });
});

test.describe("layout", () => {
  test("🔴 exactly one scroller, never two", async ({ knag }) => {
    await knag.seed(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n"));
    await knag.useEditor();

    // 🔴 Pins the trap in #116's obvious fix. Adding `overflow-y: auto` to the container
    // to match `[data-rows]` looks right and gives two nested scrollers, because
    // CodeMirror brings its own — and a nested scroller inside the page is what made
    // long-press-and-drag fight scrolling on iOS during the spike. If this ever reads 2,
    // selection on a phone has quietly got worse and nothing else will say so.
    const scrollers = await knag.page.evaluate(() => {
      const host = globalThis as unknown as {
        document: { querySelectorAll: (s: string) => ArrayLike<unknown> };
        getComputedStyle: (e: unknown) => { overflowY: string };
      };
      const all = Array.from(host.document.querySelectorAll("[data-surface], [data-surface] *"));
      return all.filter((el) => ["auto", "scroll"].includes(host.getComputedStyle(el).overflowY))
        .length;
    });
    expect(scrollers).toBe(1);
  });
});
