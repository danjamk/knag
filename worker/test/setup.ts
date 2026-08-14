import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply worker/migrations to the real Miniflare D1 before any test runs.
//
// Real D1, real schema, real constraints — a CHECK or a foreign key that only exists
// in production is a CHECK that has never been tested. The migrations array is read
// in Node at config time and handed over as a binding; the runtime has no filesystem.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
