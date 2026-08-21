import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { oldestRevisionAt } from "../src/store.js";

/**
 * `GET /api/history/depth` — when the record starts (#132).
 *
 * One fact, and the only part of the redesigned Settings sheet that is not markup. The
 * build line gains `history · N days` because how far back the record goes is something a
 * person occasionally needs and could not previously find anywhere.
 *
 * 🔴 **The reason this is a route at all is that it must not be on `/health`.** That is
 * the one unauthenticated route in the product, and the age of your document is a fact
 * about your document rather than about the deployment. It would have been one line to
 * add there and it would have handed a stranger the age of the page for the cost of a
 * `curl`.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const authed = { Authorization: `Bearer ${BEARER}` };

describe("GET /api/history/depth", () => {
  it("🔴 refuses an unauthenticated caller", async () => {
    // The whole reason it is not a field on `/health`. If this ever answers without a
    // principal, the route has become the thing it was created to avoid being.
    const res = await SELF.fetch("https://knag.test/api/history/depth");
    expect(res.status).toBe(401);
  });

  it("answers a bearer with the oldest revision's timestamp", async () => {
    const res = await SELF.fetch("https://knag.test/api/history/depth", { headers: authed });
    expect(res.status).toBe(200);

    const { since } = (await res.json()) as { since: string | null };

    // Migration 0002 logs a baseline revision, so a fresh database is never empty here.
    expect(since).toBeTruthy();
    expect(Number.isNaN(Date.parse(since as string))).toBe(false);
  });

  it("matches what the store reports, so the route adds no arithmetic of its own", async () => {
    const res = await SELF.fetch("https://knag.test/api/history/depth", { headers: authed });
    const { since } = (await res.json()) as { since: string | null };

    expect(since).toBe(await oldestRevisionAt(env));
  });

  it("🔴 stays the oldest as the log grows, and caught a real bug doing it", async () => {
    // This failed on the first run, against `SELECT min(created_at)`, and the reason is
    // worth keeping: `created_at` is **text**, and the two writers disagree on precision.
    // Every revision is `toISOString()` at milliseconds; migration 0002's baseline row is
    // `strftime` at seconds. `...22.068Z` sorts before `...22Z` because `.` is below `Z`,
    // so inside a shared second `min()` returns the *newer* row.
    //
    // In production the baseline is days old and `min()` would have looked correct
    // forever — right up until someone read the number on a page created that minute.
    // The fix orders by `id`, which is monotonic and has no format to disagree about.
    const before = await oldestRevisionAt(env);

    await SELF.fetch("https://knag.test/api/doc", {
      method: "PUT",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "a line the log did not have", base_version: 1 }),
    });

    expect(await oldestRevisionAt(env)).toBe(before);
  });

  it("refuses a method that is not GET", async () => {
    const res = await SELF.fetch("https://knag.test/api/history/depth", {
      method: "POST",
      headers: authed,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});
