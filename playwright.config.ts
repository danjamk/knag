import { createHash } from "node:crypto";
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

export const TEST_BEARER = "playwright-bearer-do-not-use-in-production";

/**
 * How the suite logs in (#231, ADR-008 §9): a session row seeded straight into the local
 * D1 before the server starts, and its raw token set as the cookie by the fixture. There
 * is no passphrase any more, and the email flow's second half is a mail — which under
 * `wrangler dev` goes to the server's stdout, where Playwright deliberately does not
 * look (#107). The form's two states are exercised by `login.spec.ts` up to the point
 * where a mail would be read; the session itself is seeded.
 *
 * 🔴 `user_id = 1` is migration 0009's seed row for the operator — a fixture fact, the
 * way `worker/test/users.ts` uses it, and nothing the Worker resolves by number.
 *
 * Local only — `wrangler dev` never leaves the machine.
 */
export const TEST_SESSION_TOKEN = "playwright-session-do-not-use-in-production";
export const TEST_OPERATOR_EMAIL = "operator@knag.test";

/**
 * A session row, as SQL, for the local D1. `devices.spec.ts` uses the same shape to make
 * a second device mid-test, through `wrangler d1 execute --local` — which is also why
 * this is a function here rather than a string in the command below.
 *
 * 🔴 Anything computed from the clock is computed **where the SQL runs**, never at
 * import: Playwright loads this file once in its main process and again in each worker,
 * and a label minted at import time would differ between the process that seeded it and
 * the one looking for it.
 */
export function sessionRowSql(token: string, label: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + 31_536_000_000);
  return (
    "INSERT INTO sessions (user_id, token_hash, public_id, created_at, expires_at, device_label) VALUES " +
    `(1, '${hash}', '${hash.slice(0, 32)}', '${now.toISOString()}', '${expires.toISOString()}', '${label}')`
  );
}

const SEED_SQL = [
  "DELETE FROM sessions WHERE device_label = 'playwright' OR device_label LIKE 'elsewhere-%'",
  sessionRowSql(TEST_SESSION_TOKEN, "playwright"),
].join("; ");

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
      `pnpm exec wrangler d1 execute knag-dev --local --config worker/wrangler.jsonc --command "${SEED_SQL}"`,
      "pnpm build",
      [
        "pnpm exec wrangler dev --config worker/wrangler.jsonc",
        `--port ${PORT}`,
        `--var KNAG_OPERATOR_EMAIL:${TEST_OPERATOR_EMAIL}`,
        `--var KNAG_BEARER_TOKEN:${TEST_BEARER}`,
        "--var KNAG_ENV:local",
        "--var KNAG_VERSION:0.0.0-browser",
        "--var KNAG_DEPLOYED_AT:1970-01-01T00:00:00Z",
      ].join(" "),
    ].join(" && "),
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,

    // 🔴 Opt-in, and NOT on in CI by default — piping this perturbs the thing it
    // measures (#107).
    //
    // Playwright ignores webServer stdout by default and pipes only stderr, which is why
    // two CI failures where the dev server died produced no account from the server of
    // how it died. Piping it did produce that account — wrangler dies printing an empty
    // `✘ [ERROR]` and writes no error to its own log — but it also took the flake from
    // two occurrences in weeks to **five CI runs out of five**.
    //
    // The likely reason is that wrangler logs a line per request, `sync.spec.ts` polls
    // in a loop and carries the heaviest request traffic in the suite, and a pipe the
    // reader does not drain fast enough blocks the writer. A blocked stdout write inside
    // the server's event loop is a good way to produce exactly this death.
    //
    // So it stays off, and becomes the reproducer #107 never had: set
    // KNAG_WRANGLER_STDOUT=1 to turn a rare flake into a near-certain one on demand.
    stdout: process.env.KNAG_WRANGLER_STDOUT ? "pipe" : "ignore",
  },
});
