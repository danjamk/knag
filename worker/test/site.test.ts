import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The landing page (#90).
 *
 * 🔴 **Nothing else in the suite ever looks at this file.** It is served from GitHub
 * Pages, not by the Worker, so it has no route, no request and no browser test — and
 * every constraint on it is the kind that fails silently. A CDN reference works on the
 * machine that wrote it. A drifted font copy renders in a fallback stack and looks merely
 * *wrong*. A word off the kill list reads fine to the person who typed it.
 *
 * So the checks are static and they are here, where the shell's are, for the same reason:
 * read in Node at config time and handed over as a binding, because the test runtime has
 * no filesystem.
 */

const site = () => env.TEST_SITE;

/** Just the stylesheet, so a markup assertion cannot accidentally match a CSS comment. */
const styles = () => /<style>([\s\S]*?)<\/style>/.exec(site())?.[1] ?? "";

describe("the landing page is self-contained (#90)", () => {
  it("🔴 references nothing off this origin", () => {
    // The brief's hardest constraint: static, self-contained, no framework, no build
    // step, no npm, **no CDN**. The fonts are in-repo and must be referenced locally.
    // A Google Fonts link would work perfectly on the machine that added it and put the
    // product's typography behind somebody else's uptime and privacy policy.
    const external = site().match(/(?:src|href)="https?:\/\/[^"]+"/g) ?? [];

    // The only absolute URLs allowed are ones nothing is *fetched* from: the canonical,
    // the OG tags, and the one link the page asks for.
    for (const ref of external) {
      expect(ref, `${ref} is fetched from another origin`).toMatch(
        /github\.com\/danjamk\/knag|danjamk\.github\.io\/knag/,
      );
    }
    expect(site()).not.toContain("fonts.googleapis");
    expect(site()).not.toContain("cdn.");
  });

  it("🔴 keeps site/fonts byte-identical to public/fonts", () => {
    // The copy exists because Pages gets a folder and there is no build step to assemble
    // one. A copy can drift, and the drift is invisible: the page renders in the fallback
    // stack, which looks like a design nobody quite finished rather than like a bug.
    const { app, site: copied } = JSON.parse(env.TEST_FONT_DIGESTS) as {
      app: Record<string, string>;
      site: Record<string, string>;
    };

    expect(Object.keys(copied).sort()).toEqual(Object.keys(app).sort());
    for (const [name, hash] of Object.entries(app)) {
      expect(copied[name], `${name} differs between public/fonts and site/fonts`).toBe(hash);
    }
  });

  it("commits to slate, rather than following the OS", () => {
    // #90's decision 3, answered in the design's §8: the app has two boards because it is
    // read for hours; a landing page is read for forty seconds. Committing to one halves
    // the work and loses nothing — but only if there is genuinely no second board, and a
    // stray media query would be a half-built one.
    expect(styles()).not.toContain("prefers-color-scheme");
    expect(site()).toContain('content="dark"');
  });

  it("🔴 has an answer for reduced motion, in both halves", () => {
    // The hero *is* an animation, so a reader who cannot have motion has to be given
    // something rather than a still board that never empties. The tokens collapse and the
    // script takes a different path — and it needs both: collapsing the tokens alone
    // leaves the wipe running at 1ms, which is a flicker rather than an answer.
    expect(styles()).toContain("prefers-reduced-motion");
    expect(site()).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
  });

  it("🔴 counts what it claims to have wiped", () => {
    // The amber line says `wiped 6`. If someone edits the board and does not edit the
    // line, the page states a number the picture above it contradicts — which is a small
    // lie on the one surface whose entire argument is that the product tells the truth
    // about what it threw away.
    const claimed = /wiped (\d+)/.exec(site())?.[1];
    const done = (site().match(/<li data-done>/g) ?? []).length;

    expect(claimed, "the recovery line is missing").toBeTruthy();
    expect(done).toBe(Number(claimed));
  });

  it("says the line, and asks for one thing", () => {
    expect(site()).toContain("Throwing it away is the feature.");
    expect(site()).toContain("One page. Wiped every morning.");

    // knag has no signup — it is a repo you deploy yourself — so the call to action is
    // GitHub or nothing. Anything else would be asking for something that does not exist.
    const links = site().match(/<a [^>]*href="([^"]+)"/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("github.com/danjamk/knag");
  });

  it("🔴 stays off the kill list", () => {
    // Brand §13, and these are the words that arrive in a landing page by themselves.
    for (const word of [
      "seamless",
      "effortless",
      "supercharge",
      "unlock",
      "reimagine",
      "AI-powered",
    ]) {
      expect(site().toLowerCase(), `${word} is on the kill list`).not.toContain(
        word.toLowerCase(),
      );
    }
  });

  it("implies no second document, because there is not one", () => {
    // spec §12. The page may render whatever it likes — ADR-004 governs the app, not
    // this — but it may not describe a product knag is not.
    expect(site()).not.toMatch(/\bdocuments\b|\bnotebooks\b|\byour pages\b/i);
  });

  it("carries the card that actually gets seen", () => {
    // The OG image is what a pasted link renders as, which is more often than the site
    // itself. `og.png` is committed output; `scripts/og-card.sh` regenerates it.
    expect(site()).toContain('property="og:image"');
    expect(site()).toContain("og.png");
    expect(site()).toContain('name="twitter:card" content="summary_large_image"');
  });
});
