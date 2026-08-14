import type { D1Migration } from "cloudflare:test";
import type { Env as KnagEnv } from "../src/env.js";

// `env` from `cloudflare:test` is typed off the global `Cloudflare.Env` interface.
// Point it at our hand-written Env so the test suite typechecks against the same
// shape the Worker does — including the secrets, which `wrangler types` cannot know
// about because they are never in wrangler.jsonc.
//
// TEST_MIGRATIONS is deliberately declared here and not in Env: vitest.config.ts
// passes it through as a binding, and the Worker must never be able to reach for it.
declare global {
  namespace Cloudflare {
    interface Env extends KnagEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
