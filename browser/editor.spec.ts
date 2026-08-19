import { expect, test } from "./fixtures.js";

/**
 * The CodeMirror surface (#110).
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

    await knag.page.locator("[data-reorder]").click();
    await expect(knag.rows()).toHaveCount(7);
    // 🔴 Destroyed, not hidden. Two live editing surfaces over one document is the
    // failure the two-rendering design exists to avoid.
    await expect(knag.surface()).toHaveCount(0);
  });

  test("a trip through Arrange with no drag is byte-identical", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    await knag.page.locator("[data-reorder]").click();
    await expect(knag.rows()).toHaveCount(7);
    await knag.page.locator("[data-reorder]").click();
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
