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
          KNAG_TZ: "America/Chicago",
          KNAG_PASSPHRASE: "test-passphrase-do-not-use-in-production",
          KNAG_BEARER_TOKEN: "test-bearer-do-not-use-in-production",

          // Consumed by worker/test/setup.ts, not by the Worker.
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],

  test: {
    include: ["worker/test/**/*.test.ts"],
    // Applies worker/migrations against the real Miniflare D1 and resets it between
    // tests. Real D1, real schema — mocking a binding tests the mock.
    setupFiles: ["./worker/test/setup.ts"],
  },
});
