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

  it("offers all three theme options explicitly", () => {
    // A cycling icon made you tap twice to find out what the third option was.
    for (const theme of ["system", "light", "dark"]) {
      expect(shell()).toContain(`data-theme-set="${theme}"`);
    }
  });

  it("keeps the footer to three permanent controls", () => {
    // 🔴 The footer is the only chrome in the app and sits right above the keyboard.
    // Every control here is one the reader steps over to reach the document. Rare
    // things belong in settings; this is the line that stops them creeping back.
    //
    // Counted by what is *always there*, not by `<button>` count. The rule was always
    // about permanent chrome — `data-clear` has been conditional since it shipped — and
    // a bare count would have blocked the post-wipe undo (#59), which appears for a few
    // hours after an action and then is gone. The stricter half is below: anything
    // extra has to ship `hidden`, so nothing permanent can arrive by calling itself
    // transient.
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(shell())?.[1] ?? "";
    const buttons = footer.match(/<button[^>]*>/g) ?? [];
    const permanent = buttons.filter((button) => !button.includes("hidden"));

    expect(permanent).toHaveLength(2);
    expect(buttons).toHaveLength(4);
  });

  it("🔴 ships every conditional footer control hidden", () => {
    // The other half of the rule above. A control that renders on first paint and
    // hides itself in script has already cost the reader a flash of chrome they did
    // not ask for, on the surface where chrome is most expensive.
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(shell())?.[1] ?? "";

    for (const attribute of ["data-clear", "data-restore"]) {
      const tag = new RegExp(`<button[^>]*${attribute}[^>]*>`).exec(footer)?.[0] ?? "";
      expect(tag, `${attribute} must ship hidden`).toContain("hidden");
    }
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
    expect(shell()).toContain('name="theme-color" content="#111111"');
  });

  it("sets viewport-fit=cover so safe-area insets resolve", () => {
    expect(shell()).toContain("viewport-fit=cover");
  });

  it("keeps the input font at 16px, or iOS zooms on focus and never returns", () => {
    expect(shell()).toMatch(/font-size:\s*16px/);
  });
});
