import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach } from "vitest";

// Apply worker/migrations to the real Miniflare D1 before every test.
//
// Real D1, real schema, real constraints — a CHECK or a foreign key that only exists
// in production is a CHECK that has never been tested. The migrations array is read
// in Node at config time and handed over as a binding; the runtime has no filesystem.
//
// 🔴 `reset()` is not optional, and this ran as `beforeAll` until it wasn't. Older
// vitest-pool-workers wrapped each test in an isolated storage stack automatically;
// 0.18 does not, so without this every test inherits the previous test's document and
// a suite about *versioning* silently tests the wrong versions. `reset()` empties the
// bindings including the migration bookkeeping table, so the migrations reapply.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
