import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readDocument } from "../src/store.js";

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

describe("first boot", () => {
  // The migration seeds the single row. Empty body is a valid state and must never
  // be confused with a failed read anywhere downstream (spec §14.5).
  it("reads the seeded document as an empty body", async () => {
    const doc = await readDocument(env);

    expect(doc.body).toBe("");
    expect(doc.version).toBe(1);
  });
});
