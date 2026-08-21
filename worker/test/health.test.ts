import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readDefaultPage } from "../src/store.js";

describe("GET /health", () => {
  it("reports the baked build id without authentication", async () => {
    const res = await SELF.fetch("https://knag.test/health");

    expect(res.status).toBe(200);
    // `environment` is the field people skip and then need — a deploy that looks
    // right and went to the wrong place is indistinguishable from one that failed.
    expect(await res.json()).toMatchObject({
      ok: true,
      version: "0.0.0-test",
      environment: "test",
      deployed_at: "1970-01-01T00:00:00Z",
    });
  });
});

describe("unknown routes", () => {
  it("404s as JSON", async () => {
    const res = await SELF.fetch("https://knag.test/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("discovery probes", () => {
  // 🔴 What this pins is the Worker half only. Miniflare does not serve the `assets`
  // binding, so every path already reaches the Worker here and this passes with or
  // without the `run_worker_first` entry that put it in front of them. The half that
  // can regress — static assets answering a probe with the PWA shell and a 200 — is
  // only observable against a real deployment, and lives in scripts/verify.sh.
  //
  // Kept anyway, because it names the contract: a probe for metadata knag does not
  // serve gets an honest absence, never a document. The paths knag *does* serve are
  // covered in oauth.test.ts.
  it.each([
    "/.well-known/openid-configuration",
    "/.well-known/webfinger",
    "/.well-known/security.txt",
  ])("refuses %s rather than answering with the shell", async (path) => {
    const res = await SELF.fetch(`https://knag.test${path}`);

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toContain("text/html");
  });
});

describe("first boot", () => {
  // The migration seeds the single row. Empty body is a valid state and must never
  // be confused with a failed read anywhere downstream (spec §14.5).
  it("reads the seeded document as an empty body", async () => {
    const doc = await readDefaultPage(env);

    expect(doc.body).toBe("");
    expect(doc.version).toBe(1);
  });
});
