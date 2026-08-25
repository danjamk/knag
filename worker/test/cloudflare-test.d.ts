import type { D1Migration } from "cloudflare:test";
import type { Env as KnagEnv } from "../src/env.js";

// `env` from `cloudflare:test` is typed off the global `Cloudflare.Env` interface.
// Point it at our hand-written Env so the test suite typechecks against the same
// shape the Worker does — including the secrets, which `wrangler types` cannot know
// about because they are never in wrangler.jsonc.
//
// TEST_MIGRATIONS and TEST_SHELL are deliberately declared here and not in Env:
// vitest.config.ts passes them through as bindings, and the Worker must never be able
// to reach for either.
declare global {
  namespace Cloudflare {
    interface Env extends KnagEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** `public/index.html`, read at config time. Miniflare does not serve assets. */
      TEST_SHELL: string;
      TEST_SITE: string;
      TEST_FONT_DIGESTS: string;
      /** `{ present, magic, frames }` of `public/favicon.ico`, read at config time (#191). */
      TEST_FAVICON: string;
    }
  }
}

export {};
