import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, writePage } from "../src/store.js";

/**
 * Migration 0004 — the expand half of pages (#152).
 *
 * 🔴 Raw SQL throughout, never `store.ts`. This asserts what the *migration* did; asking
 * the module under test whether the migration worked is how a backfill that silently did
 * nothing gets a green suite.
 *
 * These are also the assertions that stay useful after #155 contracts. What is pinned
 * here is not "a table exists" but the three things that would be expensive to discover
 * later: the document really carried over, names are unique case-insensitively, and every
 * existing revision belongs to page 1.
 */

const PAGE_1 = 1;

type PageRow = {
  id: number;
  name: string;
  body: string;
  version: number;
  updated_at: string;
  source: string;
  template: string | null;
  created_at: string;
};

async function page(id: number): Promise<PageRow | null> {
  return await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first<PageRow>();
}

describe("the pages table", () => {
  it("🔴 carries today's document over as page 1, byte for byte", async () => {
    // The seed in 0001 is an empty body at version 1, and 0002 logs it as a baseline.
    // What matters is not the value but that `pages` holds the *same* one — a backfill
    // that inserted a fresh empty row would look identical on a fresh database and lose
    // the document on a real one.
    const before = await env.DB.prepare("SELECT body, version, updated_at, source FROM documents WHERE id = 1")
      .first<{ body: string; version: number; updated_at: string; source: string }>();
    const after = await page(PAGE_1);

    expect(after).not.toBeNull();
    expect(after?.body).toBe(before?.body);
    expect(after?.version).toBe(before?.version);
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(after?.source).toBe(before?.source);
  });

  it("names it `today`, which is what tier 1 has always displayed", async () => {
    // The name is not new information — it is the label coming out of the markup and
    // into the data, which is what makes it renameable in #154.
    expect((await page(PAGE_1))?.name).toBe("today");
  });

  it("starts with no template, because a template is something you save", async () => {
    expect((await page(PAGE_1))?.template).toBeNull();
  });

  it("🔴 refuses two names that differ only in case", async () => {
    await env.DB.prepare(
      "INSERT INTO pages (name, body, version, updated_at, source, created_at) VALUES ('Shopping', '', 1, '', 'system', '')",
    ).run();

    // #153 resolves the MCP `page` parameter by name. Two pages a lookup cannot tell
    // apart would make an agent's whole-document write land somewhere ambiguous, against
    // the only copy of a document. Decided in the migration rather than in the route,
    // because adding this index later could fail on rows that already exist.
    await expect(
      env.DB.prepare(
        "INSERT INTO pages (name, body, version, updated_at, source, created_at) VALUES ('shopping', '', 1, '', 'system', '')",
      ).run(),
    ).rejects.toThrow();
  });

  it("does not stop two different names", async () => {
    // The guard above must be uniqueness, not a bad index that rejects everything.
    await env.DB.prepare(
      "INSERT INTO pages (name, body, version, updated_at, source, created_at) VALUES ('shopping', '', 1, '', 'system', '')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO pages (name, body, version, updated_at, source, created_at) VALUES ('work', '', 1, '', 'system', '')",
    ).run();

    const { results } = await env.DB.prepare("SELECT name FROM pages ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["today", "shopping", "work"]);
  });
});

describe("revisions gain a page", () => {
  it("🔴 backfills every existing revision onto page 1", async () => {
    // 0002 writes a baseline revision, so there is a real row here rather than an empty
    // table agreeing with itself.
    const { results } = await env.DB.prepare("SELECT page_id FROM revisions").all<{ page_id: number }>();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.page_id === PAGE_1)).toBe(true);
  });

  it("defaults new revisions to page 1, so today's write path is unchanged", async () => {
    // 🔴 This is what makes the expand half safe to deploy on its own: the currently
    // deployed Worker knows nothing about `page_id` and its INSERTs still land correctly.
    // `make migrate` runs before `make deploy`, so that is not a hypothetical window.
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "milk\n", baseVersion: 1, source: "pwa" });

    const newest = await env.DB.prepare(
      "SELECT page_id, body FROM revisions ORDER BY id DESC LIMIT 1",
    ).first<{ page_id: number; body: string }>();
    expect(newest?.body).toBe("milk\n");
    expect(newest?.page_id).toBe(PAGE_1);
  });
});

describe("cleared_items", () => {
  it("🔴 needs no page column, because it scopes through its revision", async () => {
    // Asserted rather than trusted. If `cleared_items` ever gained a direct page
    // reference it would be a second source of truth for the same fact, and the two
    // would disagree the first time a revision moved.
    const { results } = await env.DB.prepare("PRAGMA table_info(cleared_items)").all<{ name: string }>();
    const columns = results.map((r) => r.name);

    expect(columns).toContain("revision_id");
    expect(columns).not.toContain("page_id");
  });
});

describe("the contract half has not run", () => {
  it("🔴 leaves `documents` standing, one release after the dual write stopped", async () => {
    // 🔴 **Expand/contract is three deploys, not two.** The table can only be dropped by
    // a migration, and `make migrate` runs before `make deploy` — so the Worker live at
    // drop time is the *previous* one. Removing the dual write and dropping the table in
    // one release puts a writer and a missing table in the same window (ADR-002 §3).
    //
    // So this release stops writing and leaves the table; the next one drops it. When
    // that lands, this test inverts.
    const row = await env.DB.prepare("SELECT id FROM documents WHERE id = 1").first<{ id: number }>();
    expect(row?.id).toBe(1);
  });
});
