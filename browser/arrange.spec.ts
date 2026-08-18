import { expect, test } from "./fixtures.js";

/**
 * Picking several rows in Arrange, then copying or deleting them together (#96).
 *
 * 🔴 Why this is a browser test and not a unit one: the whole feature is a gesture and
 * a mode. `removeMany` is pure and tested in `client/test/`; what cannot be tested there
 * is that a tap on a row reaches the `li` at all — which depends on Arrange setting
 * `pointer-events: none` on the row's textarea, and on drag being grip-only.
 *
 * 🔴 Clipboard reads are not available in headless WebKit, so these tests **record what
 * the page hands to `navigator.clipboard.writeText`** rather than reading the system
 * clipboard back. That is the contract worth pinning anyway: what knag decided to copy.
 * Reading the OS clipboard would be testing WebKit.
 *
 * Its own file rather than an addition to an existing one: Arrange had no spec, and
 * `wipe.spec.ts` is already at the ~15-test mark that `scripts/browser-tests.sh`
 * documents as where a spec file starts flaking on cumulative `wrangler dev` traffic.
 */

const DOC = "alpha\n- [ ] milk\n- [x] eggs\nbravo\ncharlie";

/** Record clipboard writes instead of performing them. */
async function watchClipboard(page: import("@playwright/test").Page): Promise<void> {
  // Typed structurally, not as a Navigator: `browser/tsconfig.json` carries no DOM lib
  // on purpose, because `client/src` is the only place in the tree where DOM exists.
  // Asking for the one property this needs keeps that true — same trick as `caretOffset`
  // in the fixtures.
  await page.evaluate(() => {
    const g = globalThis as unknown as {
      __copied: string[];
      navigator: { clipboard: object };
    };
    g.__copied = [];
    Object.defineProperty(g.navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        g.__copied.push(text);
      },
    });
  });
}

const copied = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (globalThis as unknown as { __copied: string[] }).__copied);

test.describe("picking rows in Arrange", () => {
  test("🔴 a tap picks a row, and picks nothing outside the mode", async ({ knag }) => {
    // Outside Arrange the row is a live input and a tap belongs to the caret. Inside it,
    // the row is read-only and the gesture is free.
    await knag.seed(DOC);

    await knag.rows().nth(0).click();
    expect(await knag.rows().nth(0).getAttribute("class")).not.toContain("picked");

    await knag.page.locator("[data-reorder]").click();
    await knag.rows().nth(0).click();
    expect(await knag.rows().nth(0).getAttribute("class")).toContain("picked");
  });

  test("🔴 a picked row is visibly different, not just class-different", async ({ knag }) => {
    // The defect this pins. The first version tinted the ground and nothing else:
    // `--press-tint` against `--arrange-tint` is a contrast ratio of **1.14**, where 3.0
    // is the floor for a non-text UI element. Multi-select worked the whole time and read
    // as broken, because you could not see that a row had been picked.
    //
    // Every other test here asserts the `picked` class, which is why none of them caught
    // it. This one asserts something a person could actually perceive.
    await knag.seed("alpha\nbravo");
    await knag.page.locator("[data-reorder]").click();

    // Typed structurally: browser/tsconfig.json carries no DOM lib, because client/src
    // is the only place in the tree where DOM exists. Same trick as the fixtures.
    const shadow = (i: number) =>
      knag.rows().nth(i).evaluate((el: unknown) => {
        const g = globalThis as unknown as {
          getComputedStyle: (e: unknown) => { boxShadow: string };
        };
        return g.getComputedStyle(el).boxShadow;
      });

    expect(await shadow(0)).toBe("none");
    await knag.rows().nth(0).click();

    const picked = await shadow(0);
    expect(picked).not.toBe("none");
    // Amber, the one colour in the interface, and the only thing certain to be visible
    // on a phone in daylight. Either board's amber counts: WebKit here reports a light
    // colour scheme, so this renders Whiteboard's #b07100 rather than Slate's #ffb000 —
    // and pinning one of them would make this a test of the runner's theme.
    expect(picked).toMatch(/rgb\(255, 176, 0\)|rgb\(176, 113, 0\)/);
    expect(await shadow(1)).toBe("none");
  });

  test("a second tap puts it back", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.page.locator("[data-reorder]").click();

    const row = knag.rows().nth(1);
    await row.click();
    expect(await row.getAttribute("class")).toContain("picked");
    await row.click();
    expect(await row.getAttribute("class")).not.toContain("picked");
  });

  test("🔴 the grip does not pick", async ({ knag }) => {
    // The grip is the drag initiator. A drag that failed to start would otherwise leave
    // the row picked, which is a selection nobody asked for.
    await knag.seed(DOC);
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(0).locator(".grip").click();
    expect(await knag.rows().nth(0).getAttribute("class")).not.toContain("picked");
  });

  test("leaving Arrange clears the selection", async ({ knag }) => {
    await knag.seed(DOC);
    const arrange = knag.page.locator("[data-reorder]");

    await arrange.click();
    await knag.rows().nth(0).click();
    await knag.rows().nth(2).click();
    await arrange.click();          // out
    await arrange.click();          // and back in

    expect(await knag.rows().nth(0).getAttribute("class")).not.toContain("picked");
    expect(await knag.rows().nth(2).getAttribute("class")).not.toContain("picked");
  });
});

test.describe("the controls themselves", () => {
  test("🔴 a tap on the glyph works, not just the padding around it", async ({ knag }) => {
    // A bug that shipped and was invisible for exactly the reason it is hard to notice:
    // the controls are 36px holding a 17px glyph, and the delegated handlers guarded on
    // `instanceof HTMLElement`. An SVG element is not an HTMLElement, so a tap landing
    // on the drawing -- the middle of the control -- was dropped, while a tap on the
    // padding worked. "Sometimes the button does nothing" is the shape of the report.
    //
    // Clicking the svg explicitly rather than the button, because Playwright's default
    // click targets the element centre and would hit the glyph either way; naming it is
    // what makes the test say what it is testing.
    await knag.seed("alpha\nbravo");
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(1).locator("[data-remove] svg").click();

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("alpha");
  });
});

test.describe("copying a selection", () => {
  test("🔴 copies every picked row, in document order", async ({ knag }) => {
    await knag.seed(DOC);
    await watchClipboard(knag.page);
    await knag.page.locator("[data-reorder]").click();

    // Picked out of order on purpose; the copy is in document order regardless.
    await knag.rows().nth(3).click();
    await knag.rows().nth(0).click();
    await knag.rows().nth(0).locator("[data-copy]").click();

    await expect.poll(() => copied(knag.page)).toEqual(["alpha\nbravo"]);
  });

  test("🔴 strips the checkbox prefix, as single-row copy already does", async ({ knag }) => {
    // "Copies what the row displays" — the rule set when per-row copy landed. A bulk
    // copy that suddenly carried `- [ ] ` would make the two controls disagree.
    await knag.seed(DOC);
    await watchClipboard(knag.page);
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(1).click();
    await knag.rows().nth(2).click();
    await knag.rows().nth(1).locator("[data-copy]").click();

    await expect.poll(() => copied(knag.page)).toEqual(["milk\neggs"]);
  });

  test("copying an unpicked row copies only that row", async ({ knag }) => {
    await knag.seed(DOC);
    await watchClipboard(knag.page);
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(0).click();       // picked
    await knag.rows().nth(4).locator("[data-copy]").click();   // not picked

    await expect.poll(() => copied(knag.page)).toEqual(["charlie"]);
  });
});

test.describe("deleting a selection", () => {
  test("🔴 deletes every picked row in one edit", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(1).click();
    await knag.rows().nth(3).click();
    await knag.rows().nth(1).locator("[data-remove]").click();

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("alpha\n- [x] eggs\ncharlie");
  });

  test("🔴 non-adjacent rows do not shift under each other", async ({ knag }) => {
    // The failure removeMany exists to prevent: deleting index 1 then index 3 against a
    // shifting array removes the wrong second row.
    await knag.seed("a\nb\nc\nd\ne");
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(1).click();
    await knag.rows().nth(3).click();
    await knag.rows().nth(1).locator("[data-remove]").click();

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("a\nc\ne");
  });

  test("deleting an unpicked row deletes only that row", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(0).click();       // picked
    await knag.rows().nth(4).locator("[data-remove]").click();   // not picked

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("alpha\n- [ ] milk\n- [x] eggs\nbravo");
  });

  test("the selection does not survive its own delete", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.page.locator("[data-reorder]").click();

    await knag.rows().nth(0).click();
    await knag.rows().nth(1).click();
    await knag.rows().nth(0).locator("[data-remove]").click();
    await knag.saved();

    for (const i of [0, 1, 2]) {
      expect(await knag.rows().nth(i).getAttribute("class")).not.toContain("picked");
    }
  });
});
