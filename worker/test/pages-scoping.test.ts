import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  COALESCE_WINDOW_MS,
  DEFAULT_PAGE_ID,
  createPage,
  clearedItemsInRange,
  readDefaultPage,
  readPage,
  revisionsInRange,
  wipe,
  writePage,
} from "../src/store.js";

/**
 * Two pages, which is the first time any of this can be wrong (#152).
 *
 * 🔴 **Every assertion here would pass on a store with no page filter at all.** That is
 * the point of the file: one page made `WHERE page_id = ?` and no clause identical, so
 * the queries that reached for "the newest revision" or "max(id)" were correct by
 * accident and stayed correct right up until a second page existed. Nothing in the app
 * can create one yet — #154 does — so the second page is made here, by the store, and
 * that is deliberate: shipping the schema without exercising it is shipping an untested
 * schema with a green suite in front of it.
 *
 * The failure mode these pin is not an error. It is one page's history quietly
 * containing another page's body.
 */

const T0 = new Date("2026-08-20T12:00:00.000Z");
const at = (msAfterT0: number) => new Date(T0.getTime() + msAfterT0);
const MINUTE = 60_000;

const BEARER = "test-bearer-do-not-use-in-production";
const authed = { Authorization: `Bearer ${BEARER}` };

/** The seeded document is version 1 and empty; a created page starts at version 1 too. */
const V1 = 1;

async function second(name = "shopping") {
  return await createPage(env, { name, body: "", source: "pwa" }, T0);
}

async function revisionsOn(pageId: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, page_id, body, is_sealed FROM revisions WHERE page_id = ? ORDER BY id",
  )
    .bind(pageId)
    .all<{ id: number; page_id: number; body: string; is_sealed: number }>();
  return results;
}

describe("writes stay on their page", () => {
  it("leaves the other page's body and version untouched", async () => {
    const other = await second();

    await writePage(env, { pageId: other.id, body: "milk\neggs\n", baseVersion: V1, source: "pwa" }, at(0));

    expect((await readPage(env, other.id))?.body).toBe("milk\neggs\n");
    expect((await readDefaultPage(env)).body).toBe("");
  });

  it("🔴 does not coalesce one page's save into the other page's revision", async () => {
    const other = await second();

    // Well inside the ten-minute window, which is what makes this the interesting case.
    // `newestUnsealedRevision` used to ask for the newest unsealed revision full stop —
    // so this save would have been UPDATEd into today's revision, replacing today's body
    // with the shopping list and losing both.
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "today's list\n", baseVersion: V1, source: "pwa" }, at(0));
    await writePage(env, { pageId: other.id, body: "milk\n", baseVersion: V1, source: "pwa" }, at(MINUTE));

    expect(COALESCE_WINDOW_MS).toBeGreaterThan(MINUTE);

    const mine = await revisionsOn(DEFAULT_PAGE_ID);
    const theirs = await revisionsOn(other.id);

    expect(mine.map((r) => r.body)).toContain("today's list\n");
    expect(mine.map((r) => r.body)).not.toContain("milk\n");
    expect(theirs.map((r) => r.body)).toContain("milk\n");
    expect(theirs.map((r) => r.body)).not.toContain("today's list\n");
  });

  it("still coalesces two saves to the same page, which is spec §3", async () => {
    // The filter must not have turned coalescing off altogether — that would swap silent
    // corruption for an unbounded log, and both are failures.
    const before = (await revisionsOn(DEFAULT_PAGE_ID)).length;

    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "a\n", baseVersion: V1, source: "pwa" }, at(0));
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "ab\n", baseVersion: V1 + 1, source: "pwa" }, at(MINUTE));

    const after = await revisionsOn(DEFAULT_PAGE_ID);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]?.body).toBe("ab\n");
  });
});

describe("wiping stays on its page", () => {
  it("🔴 seals its own page's newest revision, never the other page's", async () => {
    const other = await second();

    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "- [ ] keep\n", baseVersion: V1, source: "pwa" }, at(0));
    await writePage(env, { pageId: other.id, body: "- [x] milk\n", baseVersion: V1, source: "pwa" }, at(MINUTE));

    // 🔴 Captured before the wipe. Migration 0002's baseline revision ships **sealed**,
    // so "this page has no sealed revision" is false from first boot and would have made
    // this test fail against correct code. What the bug would actually do is seal *this
    // specific row* — the newest one on the default page — so that is what is asserted.
    const mineBefore = await revisionsOn(DEFAULT_PAGE_ID);
    const newestMine = mineBefore[mineBefore.length - 1];
    expect(newestMine?.is_sealed).toBe(0);

    await wipe(
      env,
      {
        pageId: other.id,
        baseVersion: V1 + 1,
        body: "",
        clearedLines: ["- [x] milk"],
        source: "pwa",
        scope: "completed",
        wipedCount: 1,
      },
      at(2 * MINUTE),
    );

    // `(SELECT max(id) FROM revisions)` is the newest revision on *any* page, and the
    // other page's write above is newer than this one's. Sealing it would freeze today's
    // history against a wipe it had nothing to do with — and sealing is irreversible in
    // the sense that matters: a sealed revision is never coalesced into again, so the
    // next few minutes of typing each gain their own row and the log silently changes
    // shape.
    const stillMine = (await revisionsOn(DEFAULT_PAGE_ID)).find((r) => r.id === newestMine?.id);
    expect(stillMine?.is_sealed).toBe(0);
    expect((await revisionsOn(other.id)).some((r) => r.is_sealed === 1)).toBe(true);
  });

  it("🔴 files its cleared items against a revision on its own page", async () => {
    const other = await second();

    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "- [ ] keep\n", baseVersion: V1, source: "pwa" }, at(0));
    await writePage(env, { pageId: other.id, body: "- [x] milk\n", baseVersion: V1, source: "pwa" }, at(MINUTE));

    await wipe(
      env,
      {
        pageId: other.id,
        baseVersion: V1 + 1,
        body: "",
        clearedLines: ["- [x] milk"],
        source: "pwa",
        scope: "completed",
        wipedCount: 1,
      },
      at(2 * MINUTE),
    );

    // The done-record is authoritative — `/api/history` treats it as the answer to "what
    // did I finish" rather than deriving it. A cleared item pointing at another page's
    // revision puts one page's finished work in another page's report, and nothing in
    // either page's own data looks wrong.
    const { results } = await env.DB.prepare(
      `SELECT r.page_id AS page_id FROM cleared_items c JOIN revisions r ON r.id = c.revision_id`,
    ).all<{ page_id: number }>();

    expect(results.length).toBe(1);
    expect(results[0]?.page_id).toBe(other.id);
  });

  it("leaves the other page's body alone", async () => {
    const other = await second();
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "keep me\n", baseVersion: V1, source: "pwa" }, at(0));
    await writePage(env, { pageId: other.id, body: "wipe me\n", baseVersion: V1, source: "pwa" }, at(MINUTE));

    await wipe(
      env,
      { pageId: other.id, baseVersion: V1 + 1, body: "", clearedLines: [], source: "pwa", scope: "all", wipedCount: 1 },
      at(2 * MINUTE),
    );

    expect((await readDefaultPage(env)).body).toBe("keep me\n");
    expect((await readPage(env, other.id))?.body).toBe("");
  });
});

describe("history stays on its page", () => {
  const RANGE = { since: new Date("2026-08-20T00:00:00.000Z"), until: new Date("2026-08-21T00:00:00.000Z") };

  it("🔴 does not return the other page's revisions", async () => {
    const other = await second();
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "mine\n", baseVersion: V1, source: "pwa" }, at(0));
    await writePage(env, { pageId: other.id, body: "theirs\n", baseVersion: V1, source: "pwa" }, at(MINUTE));

    const mine = await revisionsInRange(env, { pageId: DEFAULT_PAGE_ID, ...RANGE });
    expect(mine.revisions.map((r) => r.body)).toContain("mine\n");
    expect(mine.revisions.map((r) => r.body)).not.toContain("theirs\n");
  });

  it("🔴 does not return the other page's cleared items", async () => {
    const other = await second();
    await writePage(env, { pageId: other.id, body: "- [x] milk\n", baseVersion: V1, source: "pwa" }, at(0));
    await wipe(
      env,
      {
        pageId: other.id,
        baseVersion: V1 + 1,
        body: "",
        clearedLines: ["- [x] milk"],
        source: "pwa",
        scope: "completed",
        wipedCount: 1,
      },
      at(MINUTE),
    );

    // `cleared_items` has no page column and must not grow one — it scopes through the
    // join, so this is the assertion that the join is actually there.
    expect(await clearedItemsInRange(env, { pageId: DEFAULT_PAGE_ID, ...RANGE })).toHaveLength(0);
    expect(await clearedItemsInRange(env, { pageId: other.id, ...RANGE })).toHaveLength(1);
  });
});

describe("the rollback shadow", () => {
  it("🔴 tracks only the default page, because `documents` has CHECK (id = 1)", async () => {
    const other = await second();
    const before = await env.DB.prepare("SELECT body FROM documents WHERE id = 1").first<{ body: string }>();

    await writePage(env, { pageId: other.id, body: "not the default page\n", baseVersion: V1, source: "pwa" }, at(0));

    // There is nowhere to put a second page, which is exactly the constraint the split
    // exists to escape — and the reason #155 must drop `documents` before #154 can create
    // pages a rollback would lose.
    const after = await env.DB.prepare("SELECT body FROM documents WHERE id = 1").first<{ body: string }>();
    expect(after?.body).toBe(before?.body);
  });
});

describe("a page that does not exist", () => {
  it("reads as null rather than as the default page", async () => {
    expect(await readPage(env, 999)).toBeNull();
  });

  it("🔴 404s on the API instead of serving page 1", async () => {
    // Whole-document write is the only write this product has. Serving the default page
    // to a caller who asked for page 999 would let the next PUT overwrite a page it never
    // named — the same class of mistake as defaulting an agent to "the current page".
    const res = await SELF.fetch("https://knag.test/api/doc?page=999", { headers: authed });
    expect(res.status).toBe(404);
  });

  it("400s a page that is not a positive integer", async () => {
    const res = await SELF.fetch("https://knag.test/api/doc?page=abc", { headers: authed });
    expect(res.status).toBe(400);
  });

  it("refuses to write to it", async () => {
    const res = await SELF.fetch("https://knag.test/api/doc", {
      method: "PUT",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x", base_version: 0, page: 999 }),
    });
    expect(res.status).toBe(404);
  });
});

describe("a request that names no page", () => {
  it("🔴 behaves exactly as it did before pages existed", async () => {
    // The whole reason the expand half is deployable on its own: every client built
    // before #154 sends no `page`, and must keep working through the release where the
    // schema changes underneath it.
    const res = await SELF.fetch("https://knag.test/api/doc", { headers: authed });
    expect(res.status).toBe(200);

    const doc = (await res.json()) as { body: string; version: number; id: number; name: string };
    expect(doc.version).toBe(V1);
    expect(doc.id).toBe(DEFAULT_PAGE_ID);
    expect(doc.name).toBe("today");
  });
});
