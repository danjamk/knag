import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, listPages, reorderPages } from "../src/store.js";

/**
 * The pages' order (#195): `position`, server-side, so every device sees the same list.
 *
 * 🔴 Not a column. `listPages` returns names and a template flag in the order wanted,
 * never the position itself — a number the client could display would be a column, and
 * §7 says a column is a file manager. The order is the array's.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const authed = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };
const PAGES = "https://knag.test/api/pages";

async function create(name: string): Promise<number> {
  const res = await SELF.fetch(PAGES, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const order = (ids: number[]) =>
  SELF.fetch(`${PAGES}/order`, { method: "PUT", headers: authed, body: JSON.stringify({ ids }) });

async function listed(): Promise<number[]> {
  const res = await SELF.fetch(PAGES, { headers: { Authorization: `Bearer ${BEARER}` } });
  return ((await res.json()) as { pages: Array<{ id: number }> }).pages.map((p) => p.id);
}

describe("the default order", () => {
  it("is creation order, and a new page lands last", async () => {
    // Migration 0008 backfills `position = id`, so an untouched list is what it always
    // was; `createPage` appends one past the highest live position.
    const a = await create("a");
    const b = await create("b");
    expect(await listed()).toEqual([DEFAULT_PAGE_ID, a, b]);
  });

  it("🔴 returns no position — the order is the array's", async () => {
    await create("a");
    for (const page of await listPages(env)) {
      expect(Object.keys(page).sort()).toEqual(["has_template", "id", "name"]);
    }
  });
});

describe("PUT /api/pages/order", () => {
  it("refuses an unauthenticated caller", async () => {
    const res = await SELF.fetch(`${PAGES}/order`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("puts the pages in the order given, and every read agrees", async () => {
    const a = await create("a");
    const b = await create("b");

    const res = await order([b, DEFAULT_PAGE_ID, a]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pages: Array<{ id: number }> }).pages.map((p) => p.id)).toEqual(
      [b, DEFAULT_PAGE_ID, a],
    );
    expect(await listed()).toEqual([b, DEFAULT_PAGE_ID, a]);
  });

  it("a page created after a reorder still lands last", async () => {
    const a = await create("a");
    await order([a, DEFAULT_PAGE_ID]);
    const b = await create("b");
    expect(await listed()).toEqual([a, DEFAULT_PAGE_ID, b]);
  });

  it("🔴 refuses a list that is not exactly the live set, as a 409 carrying the list", async () => {
    const a = await create("a");
    const b = await create("b");

    // Missing one.
    let res = await order([a, DEFAULT_PAGE_ID]);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { pages: unknown[] }).pages).toHaveLength(3);

    // One twice.
    res = await order([a, a, b]);
    expect(res.status).toBe(409);

    // One that does not exist.
    res = await order([a, b, DEFAULT_PAGE_ID, 999]);
    expect(res.status).toBe(409);

    // And nothing moved.
    expect(await listed()).toEqual([DEFAULT_PAGE_ID, a, b]);
  });

  it("🔴 a retired page is not part of the set, and cannot be smuggled back in", async () => {
    const a = await create("a");
    const b = await create("b");
    await SELF.fetch(`${PAGES}/${a}`, { method: "DELETE", headers: authed });

    expect((await order([b, DEFAULT_PAGE_ID])).status).toBe(200);
    expect(await listed()).toEqual([b, DEFAULT_PAGE_ID]);

    expect((await order([a, b, DEFAULT_PAGE_ID])).status).toBe(409);
  });

  it("400s a body that is not a list of page ids, and 405s any other method", async () => {
    const bad = (body: string) =>
      SELF.fetch(`${PAGES}/order`, { method: "PUT", headers: authed, body });
    expect((await bad("not json")).status).toBe(400);
    expect((await bad(JSON.stringify({ ids: "1,2" }))).status).toBe(400);
    expect((await bad(JSON.stringify({ ids: [1, "2"] }))).status).toBe(400);
    expect((await bad(JSON.stringify({ ids: [0] }))).status).toBe(400);

    const res = await SELF.fetch(`${PAGES}/order`, { method: "POST", headers: authed, body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT");
  });

  it("the store refuses the same things, so the route adds no rule of its own", async () => {
    const a = await create("a");
    expect(await reorderPages(env, [a])).toBe(false);
    expect(await reorderPages(env, [a, DEFAULT_PAGE_ID])).toBe(true);
    expect(await listed()).toEqual([a, DEFAULT_PAGE_ID]);
  });
});
