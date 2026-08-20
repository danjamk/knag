import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read at config time, in Node — the test runtime has no filesystem. setup.ts applies
// them to the real Miniflare D1, so the suite runs against the same schema
// `make migrate` ships rather than a hand-written fixture.
//
// (The bundled type docs still point at a `/config` subpath; in 0.18 this is exported
// from the package root. This file is excluded from tsconfig — it runs in Node under
// Vite, with neither the Workers nor the DOM type set.)
const migrations = await readD1Migrations(
  fileURLToPath(new URL("./worker/migrations", import.meta.url)),
);

// The PWA shell, same trick, for the same reason: read in Node, handed over as a
// binding. Miniflare does not serve the `assets` binding in tests — a request for `/`
// falls through to the Worker and 404s — so this is the only way the suite can assert
// on the shell at all.
//
// It exists to pin the textarea attributes that make byte preservation work
// (spec §8). Losing `wrap="off"` or `autocorrect="off"` does not break a build or a
// render; it silently lets iOS rewrite the user's document.
const shell = readFileSync(fileURLToPath(new URL("./public/index.html", import.meta.url)), "utf8");

// The landing page (#90), read the same way and for the same reason. It is served from
// GitHub Pages rather than by the Worker, so nothing else in the suite would ever look at
// it — and every constraint on it is the kind that fails silently. A CDN reference, a
// second board, a word off the kill list: all of them render.
const site = readFileSync(fileURLToPath(new URL("./site/index.html", import.meta.url)), "utf8");

// 🔴 `site/fonts/` is a copy of `public/fonts/`, because Pages gets a folder and the
// brief forbids a build step and a CDN. A copy can drift, and when it does the page
// renders in a fallback stack — which looks merely *wrong* rather than broken, so nobody
// files it. Hashed here so a test can say so out loud.
const digests = (dir: string): Record<string, string> => {
  const at = fileURLToPath(new URL(dir, import.meta.url));
  const out: Record<string, string> = {};
  for (const name of readdirSync(at)) {
    if (!name.endsWith(".woff2")) continue;
    out[name] = createHash("sha256").update(readFileSync(`${at}/${name}`)).digest("hex");
  }
  return out;
};
const fontDigests = JSON.stringify({
  app: digests("./public/fonts"),
  site: digests("./site/fonts"),
});

// vitest-pool-workers 0.18 (the Vitest 4 line) exposes this as a Vite plugin.
// `defineWorkersConfig` from ".../config" is the Vitest 3 API and is gone.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Read the real Worker config, so tests run against the same bindings and
      // compatibility date as production. A drifting test config is a test suite
      // that passes while production breaks.
      wrangler: { configPath: "./worker/wrangler.jsonc" },

      miniflare: {
        // Vars ship blank in the committed wrangler.jsonc (make deploy bakes them),
        // so tests supply their own. Secrets never come from the config.
        bindings: {
          KNAG_VERSION: "0.0.0-test",
          KNAG_DEPLOYED_AT: "1970-01-01T00:00:00Z",
          KNAG_ENV: "test",
          KNAG_TZ: "America/Chicago",
          KNAG_PASSPHRASE: "test-passphrase-do-not-use-in-production",
          KNAG_BEARER_TOKEN: "test-bearer-do-not-use-in-production",

          // Consumed by the test suite, not by the Worker.
          TEST_MIGRATIONS: migrations,
          TEST_SHELL: shell,
          TEST_SITE: site,
          TEST_FONT_DIGESTS: fontDigests,
        },
      },
    }),
  ],

  test: {
    // `client/test` holds pure logic only — no DOM, no fetch — so it runs in the same
    // workers pool as everything else rather than earning a second environment. The
    // moment a client test needs a document, that stops being true and this needs
    // splitting into projects.
    include: ["worker/test/**/*.test.ts", "client/test/**/*.test.ts"],
    // Applies worker/migrations against the real Miniflare D1 and resets it between
    // tests. Real D1, real schema — mocking a binding tests the mock.
    setupFiles: ["./worker/test/setup.ts"],
  },
});
