import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, writePage } from "../src/store.js";
import { OPERATOR } from "./users.js";

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
    // 🔴 **The anchor moved when #155 dropped `documents`, and the assertion survived.**
    // This used to compare page 1 against the row it was backfilled *from*. That row is
    // gone, and the lazy contraction would have been to delete this test with it — losing
    // the only check that the backfill copied rather than invented.
    //
    // Migration 0002 seeded revision 1 from the same `documents` row that 0004 later
    // copied into `pages`, and revisions are append-only and sealed. So the baseline
    // revision is a surviving witness to what the document held at migration time, and
    // page 1 still has to match it — body, version, timestamp and source.
    //
    // What this has always been about: a backfill that inserted a fresh empty row looks
    // identical on a fresh database and loses the document on a real one.
    const baseline = await env.DB.prepare(
      "SELECT body, version, created_at, source FROM revisions WHERE id = 1",
    ).first<{ body: string; version: number; created_at: string; source: string }>();
    const after = await page(PAGE_1);

    expect(baseline).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after?.body).toBe(baseline?.body);
    expect(after?.version).toBe(baseline?.version);
    expect(after?.updated_at).toBe(baseline?.created_at);
    expect(after?.source).toBe(baseline?.source);
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
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "milk\n", baseVersion: 1, source: "pwa" });

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

describe("the contract half has run (#155)", () => {
  it("🔴 `documents` is gone", async () => {
    // Three deploys, and this is the third: expand (0004, in 1.1.0) → stop writing
    // (1.1.2, carrying no migration at all) → drop (0006, here). The middle release is
    // what made this one uneventful. `make migrate` runs before `make deploy`, so the
    // Worker live at this moment is the *previous* one — and in 1.1.1 that Worker still
    // mirrored to this table on every save (ADR-002 §3).
    //
    // Asked of `sqlite_master` rather than by SELECTing and catching: a thrown query
    // proves the read failed, not that the table is absent.
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    ).first<{ name: string }>();

    expect(row).toBeNull();
  });

  it("🔴 takes nothing with it — `revisions` and `cleared_items` are intact", async () => {
    // The task on #155 that is easiest to skip because it sounds obvious. Nothing ever
    // referenced `documents` — `cleared_items.revision_id` points at `revisions(id)` — so
    // the drop should cascade nowhere. "Should" is the word that precedes a lost history,
    // and this runs against the only copy of the document.
    const baseline = await env.DB.prepare("SELECT body FROM revisions WHERE id = 1").first<{
      body: string;
    }>();
    expect(baseline).not.toBeNull();

    // Stronger than counting rows: the foreign key still resolves, which a `revisions`
    // that had been dropped and recreated by the migration would not do.
    await env.DB.prepare(
      "INSERT INTO cleared_items (revision_id, line_text, cleared_at) VALUES (1, ?, ?)",
    )
      .bind("survived the drop", "2026-08-21T00:00:00Z")
      .run();

    const cleared = await env.DB.prepare(
      "SELECT line_text FROM cleared_items WHERE revision_id = 1",
    ).first<{ line_text: string }>();

    expect(cleared?.line_text).toBe("survived the drop");
  });
});
