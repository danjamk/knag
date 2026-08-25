import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The PWA shell's load-bearing attributes.
 *
 * 🔴 Why a test and not just a comment in the HTML: every attribute below is
 * invisible when it goes missing. Removing `wrap="off"` or `autocorrect="off"` breaks
 * no build, throws no error, and renders identically — it just quietly lets the
 * browser rewrite the user's document, which is a violation of principle 3 and the
 * exact class of bug the CRLF finding in `blocks.ts` came from.
 *
 * `public/index.html` arrives as a binding because Miniflare does not serve the
 * `assets` binding in tests; a request for `/` falls through to the Worker and 404s.
 * See vitest.config.ts.
 */

const shell = () => env.TEST_SHELL;

/** Just the stylesheet, so a rule assertion cannot accidentally match the markup. */
const styles = () => /<style>([\s\S]*?)<\/style>/.exec(shell())?.[1] ?? "";

/**
 * The opening `<textarea>` tag alone.
 *
 * 🔴 Matching against the whole document was the first version of this, and it was
 * theatre: the CSS comment above the rule *mentions* `wrap="off"`, so `toContain`
 * stayed green after the real attribute was deleted. Verified by deleting it.
 * Assertions about an element have to be scoped to that element.
 */
function textarea(): string {
  const match = /<textarea\b[^>]*>/.exec(shell());
  if (!match) throw new Error("no <textarea> in the shell");
  return match[0];
}

describe("byte preservation depends on these (spec §8)", () => {
  const required: Array<[string, string]> = [
    ["wrap off, so no hard-wrap inserts newlines into the value", 'wrap="off"'],
    ["spellcheck off, so nothing is auto-corrected", 'spellcheck="false"'],
    ["autocapitalize off, iOS", 'autocapitalize="off"'],
    ["autocorrect off, iOS", 'autocorrect="off"'],
  ];

  for (const [name, attribute] of required) {
    it(name, () => {
      expect(textarea()).toContain(attribute);
    });
  }

  it("has exactly one textarea — the document is one field, not a form", () => {
    expect(shell().match(/<textarea/g)).toHaveLength(1);
  });
});

describe("PWA shell (spec §9)", () => {
  it("registers no inline script that could drift from the bundle", () => {
    // app.js is built from client/src/app.ts. A second, inline implementation is the
    // same failure mode as a second block parser.
    expect(shell()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
  });

  it("links the manifest and an apple-touch-icon", () => {
    expect(shell()).toContain('rel="manifest"');
    // iOS uses this rather than the manifest's icons for Add to Home Screen; without
    // it the home screen shows a screenshot of the page, which reads as a bug.
    expect(shell()).toContain('rel="apple-touch-icon"');
  });

  it("🔴 names no colour outside the theme token blocks", () => {
    // A hardcoded hex is invisible in dark mode and wrong in light mode, and nothing
    // fails when someone adds one. Every colour lives in `:root`; everything else
    // says `var(--token)`.
    const styles = /<style>([\s\S]*?)<\/style>/.exec(shell())?.[1] ?? "";
    // Drop the :root blocks — that is where colours are allowed to be literal.
    const outside = styles.replace(/:root[^{]*\{[^}]*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  it("🔴 declares the same whiteboard twice, identically", () => {
    // The board is defined in two places — `:root[data-theme="whiteboard"]` for an
    // explicit choice, and `:root:not([data-theme="slate"])` inside the light media
    // query for the OS default. They have **equal specificity** (0,2,0) and the media
    // block comes later, so on a light-preferring OS an explicit whiteboard choice
    // resolves through the second one.
    //
    // That is only harmless while the two lists agree. Edit one and the app looks
    // correct on a dark OS and wrong on a light one, from the same setting — and
    // nothing fails, because each block is internally consistent.
    const block = (selector: string): Map<string, string> => {
      const source = styles().replace(/\/\*[\s\S]*?\*\//g, "");
      const start = source.indexOf(selector);
      expect(start, `${selector} is missing`).toBeGreaterThan(-1);

      const body = source.slice(start + selector.length);
      const declarations = body.slice(body.indexOf("{") + 1, body.indexOf("}"));
      const tokens = new Map<string, string>();
      for (const line of declarations.split(";")) {
        const [name, value] = line.split(":");
        if (name?.trim().startsWith("--")) tokens.set(name.trim(), (value ?? "").trim());
      }
      return tokens;
    };

    const explicit = block(':root[data-theme="whiteboard"]');
    const osDefault = block(':root:not([data-theme="slate"])');

    expect(explicit.size).toBeGreaterThan(10);
    expect([...osDefault.entries()].sort()).toEqual([...explicit.entries()].sort());
  });

  it("🔴 never styles a bare `input` or `button` globally", () => {
    // The document is *made of* inputs. A global element selector reaches every row's
    // text field and every row checkbox, at a specificity that outranks the rules
    // written for them — which is exactly how a checkbox row's text collapsed to
    // ~17px and a checkbox rendered at ~45px. Both looked like layout accidents and
    // neither failed anything.
    const styles = /<style>([\s\S]*?)<\/style>/.exec(shell())?.[1] ?? "";
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, "");

    for (const selector of rules.split("}").map((block) => block.split("{")[0] ?? "")) {
      for (const part of selector.split(",").map((s) => s.trim())) {
        expect(part).not.toMatch(/^(input|button|textarea)$/);
      }
    }
  });

  it("scopes the row checkbox rule by input type", () => {
    // `li.checkbox input` also matches the row's text input. The type selector is
    // what keeps the two apart.
    expect(styles()).toContain('li.checkbox input[type="checkbox"]');
  });

  it("offers all three boards explicitly", () => {
    // A cycling icon made you tap twice to find out what the third option was.
    //
    // 🔴 `slate` and `whiteboard`, not `dark` and `light`. They are not themes — they
    // are the two surfaces the product already had, and naming them is the difference
    // between a generic preference and this product's. `readTheme` migrates the old
    // values so nobody's choice is silently reset.
    for (const board of ["system", "whiteboard", "slate"]) {
      expect(shell()).toContain(`data-theme-set="${board}"`);
    }
    expect(shell()).not.toContain('data-theme-set="dark"');
  });

  it("🔴 keeps one wipe keyframe — the page timing is tokens, not a second animation", () => {
    // 🔴 §9's boundary, made mechanical. The page wipe is allowed to exist because it is
    // the *same* animation at a second timing: same keyframes, same ease, page-scoped
    // tokens. A second `@keyframes` for it would be a second animation, which the house
    // rule forbids and which nothing else in the suite would catch — it would render
    // beautifully and pass every test.
    //
    // Three keyframes, and each one has to earn its place:
    //   knag-blink   the cursor in the mark. The mark, not the interface.
    //   knag-wipe    the one animation.
    //   knag-arrive  the recovery line's 90ms opacity, which is the wipe's own last
    //                beat rather than a second animation — it runs only at the end of a
    //                wipe, on `--state-duration`, with no travel and no stagger. It is a
    //                keyframe only because CSS cannot transition out of `display: none`.
    const names = (styles().match(/@keyframes\s+([\w-]+)/g) ?? []).map((k) => k.split(/\s+/)[1]);
    expect(names.sort()).toEqual(["knag-arrive", "knag-blink", "knag-wipe"]);
  });

  it("🔴 gives the page wipe its timing by redefining tokens on the element", () => {
    // The implementation of the claim above. Four redefinitions and nothing else — no
    // `animation`, no second keyframe reference. If this rule ever grows one, the page
    // wipe has stopped being a second timing and §9 has to be re-argued rather than
    // quietly widened.
    const variant =
      /li\.wiping\.page,\s*\.cm-line\.cm-wiping\.cm-page\s*\{([^}]*)\}/.exec(styles())?.[1] ??
      "";

    expect(variant, "the page variant rule is missing").not.toBe("");
    for (const token of ["--wipe-duration", "--wipe-stagger", "--wipe-collapse", "--wipe-travel"]) {
      expect(variant, token).toContain(`${token}: var(--page`);
    }
    expect(variant).not.toContain("animation");
  });

  it("🔴 collapses every motion token under reduced motion, page wipe included", () => {
    // The media query is the single place reduced motion is handled — `app.ts` reads
    // these back through `getComputedStyle`, so collapsing them here collapses the
    // sequence in both surfaces and in the JS that paces it.
    //
    // 🔴 The page tokens are the ones that would be forgotten. A retune that adds a
    // timing and not its reduced-motion counterpart leaves someone who asked for less
    // motion watching the longest animation in the product, and nothing fails.
    const query = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n      \}/.exec(
      styles(),
    )?.[1];

    expect(query, "the reduced-motion query is missing").toBeTruthy();
    for (const token of [
      "--wipe-duration",
      "--wipe-stagger",
      "--wipe-collapse",
      "--wipe-travel",
      "--page-duration",
      "--page-stagger",
      "--page-collapse",
      "--page-travel",
      "--page-beat",
    ]) {
      expect(query, token).toContain(token);
    }
  });

  it("🔴 keeps the wipe control a word, and the count inside it", () => {
    // `⌫` was the wrong promise: a backspace glyph says the bytes are gone, and the
    // whole argument of the product is that they are not. The count goes *inside* the
    // control because that is what makes it safe to tap without a confirm — you are
    // told the size of the thing you are about to do, in the thing that does it.
    const tag = /<button[^>]*data-clear[^>]*>([\s\S]*?)<\/button>/.exec(shell())?.[1] ?? "";
    expect(tag).toContain("wipe");
    expect(tag).toContain("data-clear-count");
    expect(tag).not.toContain("⌫");
  });

  it("🔴 keeps tier 1 to one permanent control, and the ledge is not tier 1", () => {
    // 🔴 The bar sits right above the keyboard on a phone, and every control on it is
    // one the reader steps over to reach the document. That budget is the reason the
    // bar is thin, and it is the thing a second tier could quietly have spent (#139).
    //
    // Counted by what is *always there*, not by `<button>` count. The rule was always
    // about permanent chrome — `data-clear` has been conditional since it shipped — and
    // a bare count would have blocked the post-wipe undo (#59), which appears after an
    // action and then is gone. The stricter half is below: anything extra has to ship
    // `hidden`, so nothing permanent can arrive by calling itself transient.
    const bar = /<div class="bar">([\s\S]*?)<\/div>/.exec(shell())?.[1] ?? "";
    const buttons = bar.match(/<button[^>]*/g) ?? [];
    const permanent = buttons.filter((button) => !button.includes("hidden"));

    // Two, and the second one **took no space** (#154). Arrange and settings went down
    // to the ledge, and the wordmark left the bar entirely so the page's name could have
    // a permanent slot (#123). That slot was always occupied — it held a `<span>` reading
    // `today` — and pages turned the label in it into the control that switches them.
    //
    // 🔴 So the budget this test protects is **space above the keyboard**, not a count of
    // buttons, and the assertion says which control is which rather than how many there
    // are. §7's "not a control until there is a second page to switch to" was scoping the
    // state *before* pages existed: the switcher is how the second page gets made, so it
    // cannot wait for one.
    expect(permanent).toHaveLength(2);
    expect(permanent.some((button) => button.includes("data-page-name"))).toBe(true);
    expect(permanent.some((button) => button.includes("data-ledge-toggle"))).toBe(true);

    // Anything beyond those two has to ship `hidden`, which is the half of the rule that
    // stops permanent chrome arriving by calling itself transient.
    expect(buttons).toHaveLength(3);
  });

  it("🔴 keeps the ledge closed and inert in the shipped shell", () => {
    // The ledge is momentary: it opens when reached for and closes when anything else
    // takes focus. Shipping it open would put a second permanent tier above the
    // keyboard, which is exactly the cost the design refused to pay.
    //
    // 🔴 `inert` as well as closed. The closed state is a zero height with
    // `overflow: hidden`, which hides the buttons from a reader and leaves every one of
    // them in the tab order — a control you cannot see and can still tab to and press.
    const ledge = /<div class="ledge"[^>]*>/.exec(shell())?.[0] ?? "";

    expect(ledge).toContain("inert");
    expect(ledge).not.toContain("data-open");
  });

  it("🔴 keeps the whole-page wipe off tier 1, and next to nothing", () => {
    // The frequencies are not comparable: sweeping the done items is every morning,
    // wiping the page is when a project ends. They may not become two similar buttons
    // side by side, which was the risk in moving the destructive one out of the sheet.
    //
    // It is on the ledge, past a hairline, alone at the far end — one tier away from
    // `wipe N` rather than one tap. It still arms by repetition; see `app.ts`.
    const bar = /<div class="bar">([\s\S]*?)<\/div>/.exec(shell())?.[1] ?? "";
    const ledge = /<div class="ledge"[^>]*>([\s\S]*?)<\/div>/.exec(shell())?.[1] ?? "";

    expect(bar).not.toContain("data-wipe-all");
    expect(ledge).toContain("data-wipe-all");
    expect(ledge.indexOf("ledge-sep")).toBeLessThan(ledge.indexOf("data-wipe-all"));
  });

  it("🔴 keeps the recovery line out of the footer", () => {
    // It is transient chrome that appears after an action and stays until the next
    // wipe, and the footer's budget is about what sits *permanently* above the
    // keyboard. Pinned above the footer rule instead, so scrolling cannot carry it
    // away and the keyboard cannot bury it — the line has to be where the regret is.
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(shell())?.[1] ?? "";

    expect(footer).not.toContain("data-restore");
    expect(shell()).toContain("data-recovery");
  });

  it("🔴 ships every conditional control hidden", () => {
    // The other half of the rule above. A control that renders on first paint and
    // hides itself in script has already cost the reader a flash of chrome they did
    // not ask for, on the surface where chrome is most expensive.
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(shell())?.[1] ?? "";

    const clear = /<button[^>]*data-clear[^>]*>/.exec(footer)?.[0] ?? "";
    expect(clear, "data-clear must ship hidden").toContain("hidden");

    // The env badge is conditional too — it only appears off production.
    const env = /<span[^>]*data-env[^>]*>/.exec(footer)?.[0] ?? "";
    expect(env, "data-env must ship hidden").toContain("hidden");

    const recovery = /<div[^>]*data-recovery[^>]*>/.exec(shell())?.[0] ?? "";
    expect(recovery, "data-recovery must ship hidden").toContain("hidden");
  });

  it("puts build info in settings, one tap away rather than buried", () => {
    // It left the footer to make room, but "is my change live" already cost a round
    // trip once (#37) and must not cost another.
    for (const field of ["version", "env", "commit", "when"]) {
      expect(shell()).toContain(`data-build-${field}`);
    }
  });

  it("declares a theme colour matching the background", () => {
    // A mismatch shows as a bright status bar strip above a dark app on iOS.
    // `#11150F` is Slate, the board — green-black, not neutral.
    expect(shell()).toContain('name="theme-color" content="#11150F"');
  });

  it("🔴 points the apple-touch-icon at the non-maskable mark", () => {
    // iOS applies its own mask. Handing it the maskable art — already padded into the
    // middle 80% for Android's circle crop — double-pads it, and the mark lands on the
    // home screen visibly smaller than every icon beside it.
    const tag = /<link[^>]*rel="apple-touch-icon"[^>]*>/.exec(shell())?.[0] ?? "";
    expect(tag).toContain("/icons/knag-icon-192.png");
    expect(tag).not.toContain("maskable");
  });

  it("🔴 ships a real /favicon.ico, so an icon resolver does not walk up to the apex", () => {
    // `not_found_handling: "single-page-application"` answers a missing `/favicon.ico`
    // with index.html and a 200. Nothing broke — Claude's connector list simply showed
    // danjamkuhn.com's favicon next to knag, because a resolver that finds HTML on the
    // host falls back to the registrable domain (#191). The MCP `icons` in serverInfo
    // were correct the whole time and were not what the client used.
    const favicon = JSON.parse(env.TEST_FAVICON) as {
      present: boolean;
      magic: number[];
      frames: number;
    };
    expect(favicon.present, "public/favicon.ico is missing").toBe(true);
    // ICONDIR: reserved 0, type 1. Anything else is a renamed PNG or the shell.
    expect(favicon.magic, "not an ICO").toEqual([0, 0, 1, 0]);
    expect(favicon.frames, "16, 32 and 48").toBeGreaterThanOrEqual(3);

    const tag = /<link[^>]*href="\/favicon\.ico"[^>]*>/.exec(shell())?.[0] ?? "";
    expect(tag, "index.html must link it, not just leave it to be guessed").toContain('rel="icon"');
  });

  it("sets viewport-fit=cover so safe-area insets resolve", () => {
    expect(shell()).toContain("viewport-fit=cover");
  });

  it("🔴 keeps the editable floor at 16px, or iOS zooms on focus and never returns", () => {
    // Asserted on the tokens rather than on a literal `font-size: 16px`, because the
    // sizes became tokens so a reading preference could override one of them (#92).
    // The floor is the reason the number exists, so the floor is what is pinned: the
    // font-size control scales `--size-row` *up* and is not offered a smaller step.
    expect(shell()).toMatch(/--size-row:\s*16px/);
    expect(shell()).toMatch(/--size-control:\s*16px/);

    // And nothing names a size outside the token block. A rule that reintroduced a bare
    // `font-size: 15px` on a field would pass the two assertions above and still zoom.
    expect(shell()).not.toMatch(/font-size:\s*1[0-5]px/);
  });
});
