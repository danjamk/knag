import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEV_ICONS, devManifest } from "../src/index.js";

/**
 * `/manifest.json` through the Worker (#196).
 *
 * Two installs of the same app on one home screen — dev the ITP test subject, prod the
 * dogfood — were identical tiles both called `knag`. Prod serves the static file
 * untouched; any other environment gets its name rewritten.
 *
 * 🔴 The rewrite is pinned on the pure function, not the route. Miniflare does not serve
 * the `assets` binding in tests, so the route cannot be observed end to end here — the
 * live half lives in scripts/verify.sh, which reads the environment from /health and
 * asserts the manifest's name against it on every deploy.
 */

const STATIC = {
  name: "knag",
  short_name: "knag",
  description: "One plain-text page, always live",
  start_url: "/",
  display: "standalone",
  icons: [{ src: "/icons/knag-icon-192.png", sizes: "192x192", type: "image/png" }],
};

describe("devManifest", () => {
  it("names the environment and wears the dev mark, and changes nothing else", () => {
    const dev = devManifest(STATIC, "dev");

    expect(dev.name).toBe("knag dev");
    expect(dev.short_name).toBe("knag dev");
    // The tile is the dev mark — the same block, unfilled (#196, ruled 2026-08-25). It
    // shipped as the name alone while the artwork waited on the design session.
    expect(dev.icons).toEqual(DEV_ICONS);
    for (const icon of DEV_ICONS) expect(icon.src).toContain("-dev");

    const { name: _n, short_name: _s, icons: _i, ...rest } = dev;
    const { name: _n2, short_name: _s2, icons: _i2, ...staticRest } = STATIC;
    expect(rest).toEqual(staticRest);
  });

  it("🔴 every dev icon exists on disk and is in the service worker's SHELL", () => {
    // Three places have to agree — this array, the link tags the client swaps and the
    // SHELL — and a file missing from any of them renders wrong rather than failing.
    // `cache.addAll` on a missing file fails the whole install, which is the loud one;
    // an icon absent from SHELL is the quiet one: a cold offline start on dev wears
    // prod's tile.
    const onDisk = JSON.parse(env.TEST_ICONS) as string[];
    const shell = /const SHELL = \[([\s\S]*?)\];/.exec(env.TEST_SW)?.[1] ?? "";

    for (const icon of DEV_ICONS) {
      const file = icon.src.replace("/icons/", "");
      expect(onDisk, `${file} is not in public/icons/`).toContain(file);
      expect(shell, `${icon.src} is not in sw.js SHELL`).toContain(`"${icon.src}"`);
    }
    // The tab's two, which the client swaps rather than the manifest naming.
    for (const file of ["favicon-dev.svg", "favicon-dev-32.png"]) {
      expect(onDisk, `${file} is not in public/icons/`).toContain(file);
      expect(shell, `/icons/${file} is not in sw.js SHELL`).toContain(`"/icons/${file}"`);
    }
  });

  it("does not mutate the static manifest it was given", () => {
    const input = { ...STATIC };
    devManifest(input, "local");
    expect(input.name).toBe("knag");
  });
});

describe("/manifest.json", () => {
  it.each(["GET", "HEAD"])(
    "%s never throws on the Worker path, whether or not the asset is served",
    async (method) => {
      // In this environment the asset fetch 404s (or the binding is absent); the route
      // must hand that back honestly rather than crash. When it *is* served, KNAG_ENV is
      // `test` here, so the name must say so.
      //
      // 🔴 HEAD is here because it 500ed: the asset response for a HEAD has no body, and
      // the rewrite parsed it. The route now fetches the asset as a GET regardless.
      const res = await SELF.fetch("https://knag.test/manifest.json", { method });

      expect([200, 404]).toContain(res.status);
      if (res.status === 200 && method === "GET") {
        expect(((await res.json()) as { name: string }).name).toBe("knag test");
      }
    },
  );
});
