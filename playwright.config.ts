import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests, against **WebKit**.
 *
 * 🔴 WebKit specifically, not Chromium. iOS mandates WebKit, so Safari's engine is
 * the one that has to be right — and every bug this suite exists to catch was found
 * on an iPhone by a human, after 263 green unit tests said nothing was wrong.
 *
 * What lives here is what the vitest suite structurally cannot reach: rendering,
 * geometry, visibility, focus and caret. What does *not* live here is logic — the
 * typing model, the parser and the sync policy are pure functions with their own
 * tests, and duplicating them through a browser would be slower and no more true.
 *
 * Not part of `pnpm check`. The browser download is ~80MB and CI time is not free,
 * so this is its own script and its own job.
 *
 * 🔴 **Run it through `pnpm test:browser`, not `playwright test`.** That script invokes
 * this config once per spec file, because a single `wrangler dev` does not survive the
 * whole suite — it exits fatally partway through and every remaining test then fails at
 * `page.goto`. Reasoning and measurements: `scripts/browser-tests.sh` and #69.
 */

/** Fixed so tests can log in. Local only — `wrangler dev` never leaves the machine. */
export const TEST_PASSPHRASE = "playwright-passphrase-do-not-use-in-production";
export const TEST_BEARER = "playwright-bearer-do-not-use-in-production";

const PORT = 8788;

export default defineConfig({
  testDir: "./browser",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 🔴 Zero, and it stays zero. Retries were the obvious answer to #69 and the wrong
  // one: they would have turned CI green while hiding both that failure and the next
  // real one. This suite is the only place several of knag's guarantees are checked —
  // #62 was a real bug that 344 green unit tests missed — so a re-run that passes has
  // to mean something. The flake is fixed at its source in scripts/browser-tests.sh.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },

  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],

  webServer: {
    // 🔴 Secrets come through `--var` rather than a `.dev.vars` file, so a developer's
    // real local secrets are never a test dependency and never get read by CI.
    //
    // `http://localhost` also exercises the one branch `make deploy` cannot: the
    // session cookie drops `Secure` on loopback, because Safari refuses to store a
    // Secure cookie there (spec §5). That path has been untested until now.
    command: [
      "pnpm exec wrangler d1 migrations apply knag-dev --local --config worker/wrangler.jsonc",
      "pnpm build",
      [
        "pnpm exec wrangler dev --config worker/wrangler.jsonc",
        `--port ${PORT}`,
        `--var KNAG_PASSPHRASE:${TEST_PASSPHRASE}`,
        `--var KNAG_BEARER_TOKEN:${TEST_BEARER}`,
        "--var KNAG_ENV:local",
        "--var KNAG_VERSION:0.0.0-browser",
        "--var KNAG_DEPLOYED_AT:1970-01-01T00:00:00Z",
      ].join(" "),
    ].join(" && "),
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
