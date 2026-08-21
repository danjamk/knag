import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, readDefaultPage, wipe } from "../src/store.js";

/**
 * Clear-completed — the sweep, and the only destructive path in the product.
 *
 * Queried with raw SQL rather than through store.ts: a test that asks the module
 * under test whether it ordered its own writes correctly cannot catch it lying.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const authed = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };

const DOC = "https://knag.test/api/doc";
const CLEAR = "https://knag.test/api/doc/clear-completed";

const SEEDED_VERSION = 1;

function put(payload: unknown): Promise<Response> {
  return SELF.fetch(DOC, { method: "PUT", headers: authed, body: JSON.stringify(payload) });
}

function clear(payload: unknown): Promise<Response> {
  return SELF.fetch(CLEAR, { method: "POST", headers: authed, body: JSON.stringify(payload) });
}

async function revisions() {
  const { results } = await env.DB.prepare(
    "SELECT id, body, version, is_sealed, event_type FROM revisions ORDER BY id",
  ).all<{ id: number; body: string; version: number; is_sealed: number; event_type: string | null }>();
  return results;
}

async function clearedItems() {
  const { results } = await env.DB.prepare(
    "SELECT revision_id, line_text FROM cleared_items ORDER BY id",
  ).all<{ revision_id: number; line_text: string }>();
  return results;
}

const MIXED = "- [x] done one\n- [ ] still open\n  - [X] nested done\nplain text\n\n```\n- [x] not a task\n```";
const SURVIVORS = "- [ ] still open\nplain text\n\n```\n- [x] not a task\n```";

describe("what counts as completed (spec §14.2)", () => {
  beforeEach(async () => {
    await put({ body: MIXED, base_version: SEEDED_VERSION });
  });

  it("removes checked boxes at any indentation and nothing else", async () => {
    const res = await clear({ base_version: SEEDED_VERSION + 1 });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cleared_count: 2, version: SEEDED_VERSION + 2 });
    expect((await readDefaultPage(env)).body).toBe(SURVIVORS);
  });

  it("leaves a checked box inside a fence alone", async () => {
    // It is a fence block, not a checkbox block — the parser already decided that,
    // and clear must not second-guess it with its own regex.
    await clear({ base_version: SEEDED_VERSION + 1 });

    expect((await readDefaultPage(env)).body).toContain("- [x] not a task");
  });

  it("preserves the survivors byte for byte", async () => {
    await clear({ base_version: SEEDED_VERSION + 1 });

    const body = (await readDefaultPage(env)).body;
    expect(body).toBe(SURVIVORS);
    // The blank line survived, so spacing is intact.
    expect(body.split("\n")).toContain("");
  });

  it("records the full source line, not the task text", async () => {
    await clear({ base_version: SEEDED_VERSION + 1 });

    expect((await clearedItems()).map((c) => c.line_text)).toEqual([
      "- [x] done one",
      "  - [X] nested done",
    ]);
  });
});

describe("order of operations (spec §5)", () => {
  beforeEach(async () => {
    await put({ body: MIXED, base_version: SEEDED_VERSION });
  });

  it("seals the revision that existed before the clear", async () => {
    // Otherwise the next save inside the coalescing window overwrites the pre-clear
    // state — the one thing the sweep must not destroy.
    const before = await revisions();
    const newest = before[before.length - 1];
    expect(newest?.is_sealed).toBe(0);

    await clear({ base_version: SEEDED_VERSION + 1 });

    const after = await revisions();
    expect(after.find((r) => r.id === newest?.id)?.is_sealed).toBe(1);
  });

  it("inserts a sealed clear_completed revision holding the PRE-clear body", async () => {
    await clear({ base_version: SEEDED_VERSION + 1 });

    const log = await revisions();
    // 🔴 Named by its event, not taken as the newest (#91). A wipe writes **two** rows
    // now — the pre-wipe snapshot that carries the event, and the state it left — so
    // `log[log.length - 1]` is the result row and this assertion silently moved to the
    // wrong one. Exactly the shape of the bug #152 found in `store.ts`, one layer up.
    const clearRevision = log.find((r) => r.event_type === "clear_completed");

    expect(clearRevision).toMatchObject({ event_type: "clear_completed", is_sealed: 1 });
    // 🔴 Pre-clear, not post-clear. This row is the recovery path for a sweep done by
    // mistake; holding the post-clear body would make it worthless.
    expect(clearRevision?.body).toBe(MIXED);
  });

  it("points cleared_items at the clear_completed revision", async () => {
    await clear({ base_version: SEEDED_VERSION + 1 });

    const log = await revisions();
    // Named by its event rather than by position — see the note above.
    const clearRevision = log.find((r) => r.event_type === "clear_completed");
    const items = await clearedItems();

    expect(items).toHaveLength(2);
    // last_insert_rowid() inside a D1 batch has to resolve to the revision inserted
    // two statements earlier. If it did not, these would dangle.
    for (const item of items) {
      expect(item.revision_id).toBe(clearRevision?.id);
    }
  });

  it("leaves the next save unable to coalesce over any of it", async () => {
    await clear({ base_version: SEEDED_VERSION + 1 });
    const afterClear = await revisions();

    await put({ body: "something new", base_version: SEEDED_VERSION + 2 });

    const log = await revisions();
    expect(log).toHaveLength(afterClear.length + 1);
    // Every pre-existing row is untouched — the new save inserted rather than folding.
    for (const row of afterClear) {
      expect(log.find((r) => r.id === row.id)?.body).toBe(row.body);
    }
  });
});

describe("conflict", () => {
  beforeEach(async () => {
    await put({ body: MIXED, base_version: SEEDED_VERSION });
  });

  it("409s a stale base_version and carries the current state", async () => {
    const res = await clear({ base_version: SEEDED_VERSION });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "version_conflict", body: MIXED });
  });

  it("🔴 writes absolutely nothing on a stale base_version", async () => {
    // The failure this guards against: D1's batch is a transaction but not a
    // *conditional* one, so a naive implementation seals a revision and writes
    // cleared_items for a sweep that never happened — leaving the authoritative
    // done-record claiming items were finished while they sit unchecked in the
    // document. Worse than not clearing at all, and invisible until someone reads
    // their history.
    const revisionsBefore = await revisions();
    const itemsBefore = await clearedItems();

    await clear({ base_version: SEEDED_VERSION });

    expect(await revisions()).toEqual(revisionsBefore);
    expect(await clearedItems()).toEqual(itemsBefore);
    expect((await readDefaultPage(env)).body).toBe(MIXED);
  });
});

describe("a write landing between the read and the batch", () => {
  it("🔴 applies all four statements or none, never some", async () => {
    // The early `base_version` check catches every *stale* request before the batch
    // runs — which means it also hides the per-statement guard from every test above.
    // This is the only path that reaches it: two store-level calls whose awaits
    // interleave, exactly as the compare-and-swap race in api.test.ts does.
    //
    // Weaken the guard and this returns `cleared` while the document never changed,
    // leaving a sealed revision and cleared_items for a sweep that did not happen.
    await put({ body: MIXED, base_version: SEEDED_VERSION });
    const version = SEEDED_VERSION + 1;

    // Two identical clears rather than a clear racing a write. Racing a write leaves
    // *which* call loses up to the scheduler, so the loser's side effects — the thing
    // being tested — only get inspected on some runs. Two clears against the same
    // base_version make the outcome deterministic: exactly one wins, and the other is
    // guaranteed to have taken the path that must leave nothing behind.
    const request = {
      pageId: DEFAULT_PAGE_ID,
      baseVersion: version,
      body: SURVIVORS,
      clearedLines: ["- [x] done one", "  - [X] nested done"],
      source: "pwa" as const,
      scope: "completed" as const,
      wipedCount: 2,
    };
    const results = await Promise.all([wipe(env, request), wipe(env, request)]);

    expect(results.filter((r) => r.status === "cleared")).toHaveLength(1);
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(1);

    // 🔴 The assertion the guard exists for. The loser reached its batch — its own
    // early check passed, because it read the same version the winner did — so only
    // the per-statement guard stops it sealing a revision and writing a second set of
    // cleared_items for a sweep that never happened.
    expect(await clearedItems()).toHaveLength(2);
    expect((await revisions()).filter((r) => r.event_type === "clear_completed")).toHaveLength(1);
    expect((await readDefaultPage(env)).body).toBe(SURVIVORS);
    expect((await readDefaultPage(env)).version).toBe(version + 1);
  });
});

describe("nothing to clear", () => {
  it("succeeds with a count of zero and touches nothing", async () => {
    await put({ body: "- [ ] open\nplain", base_version: SEEDED_VERSION });
    const before = await readDefaultPage(env);
    const revisionsBefore = await revisions();

    const res = await clear({ base_version: before.version });

    // Success, not an error: the caller asked for the checked items to be gone and
    // they are. Bumping a version for a no-op would also break every other client's
    // base_version for nothing.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cleared_count: 0, version: before.version });
    expect(await readDefaultPage(env)).toEqual(before);
    expect(await revisions()).toEqual(revisionsBefore);
  });
});

describe("the route", () => {
  it("401s without a credential, before any parsing", async () => {
    const res = await SELF.fetch(CLEAR, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 1 }),
    });

    expect(res.status).toBe(401);
  });

  it("405s a GET and says what is allowed", async () => {
    const res = await SELF.fetch(CLEAR, { headers: { Authorization: `Bearer ${BEARER}` } });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("400s a bad base_version", async () => {
    expect((await clear({})).status).toBe(400);
    expect((await clear({ base_version: "1" })).status).toBe(400);
    expect((await clear({ base_version: -1 })).status).toBe(400);
  });
});

describe("wipe-all (#58)", () => {
  beforeEach(async () => {
    await put({ body: MIXED, base_version: SEEDED_VERSION });
  });

  it("empties the page, including lines that were never finished", async () => {
    const res = await clear({ base_version: SEEDED_VERSION + 1, scope: "all" });

    expect(res.status).toBe(200);
    expect((await readDefaultPage(env)).body).toBe("");
  });

  it("🔴 records only the checked lines as finished, not everything it removed", async () => {
    // The decision this feature turns on. `cleared_items` answers "what did I get
    // done", and it is what /api/history reports as authoritative precisely because a
    // line-set diff cannot be trusted for that question. A wipe-all removes work that
    // was never finished; writing those lines here would inflate the done-record and
    // corrupt the one table whose job is to stay honest.
    //
    // MIXED has six blocks, two of them checked.
    await clear({ base_version: SEEDED_VERSION + 1, scope: "all" });

    const items = await clearedItems();
    expect(items.map((i) => i.line_text)).toEqual(["- [x] done one", "  - [X] nested done"]);
  });

  it("reports the two counts separately, because they mean different things", async () => {
    const res = await clear({ base_version: SEEDED_VERSION + 1, scope: "all" });

    // Six rows left the page; two of them were things anyone actually finished.
    expect(await res.json()).toMatchObject({ wiped_count: 6, cleared_count: 2 });
  });

  it("records a distinct event_type, so history can tell the two apart", async () => {
    // Without this, history shows an entry claiming two items were cleared and then,
    // on the next ordinary save, four more lines vanishing with nothing to explain
    // them. The column is free text with no CHECK, so this costs no migration.
    await clear({ base_version: SEEDED_VERSION + 1, scope: "all" });

    const events = (await revisions()).map((r) => r.event_type);
    expect(events).toContain("wipe_all");
    expect(events).not.toContain("clear_completed");
  });

  it("seals a snapshot of the whole pre-wipe page, which is what makes it recoverable", async () => {
    // 🔴 #59 restores by diffing this snapshot against the post-wipe body — not by
    // reading cleared_items, which deliberately does not hold the unfinished lines.
    // If this snapshot is ever unsealed or partial, undo silently loses work.
    await clear({ base_version: SEEDED_VERSION + 1, scope: "all" });

    const snapshot = (await revisions()).find((r) => r.event_type === "wipe_all");
    expect(snapshot?.body).toBe(MIXED);
    expect(snapshot?.is_sealed).toBe(1);
  });

  it("is a no-op on an already-empty page, reported as success", async () => {
    await put({ body: "", base_version: SEEDED_VERSION + 1 });
    const emptyVersion = (await readDefaultPage(env)).version;

    const res = await clear({ base_version: emptyVersion, scope: "all" });

    // `parse("")` yields one blank block, so a block count would report having removed
    // something from a page that had nothing on it.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ wiped_count: 0, cleared_count: 0 });
    expect((await readDefaultPage(env)).version).toBe(emptyVersion);
  });

  it("conflicts on a stale base_version without touching anything", async () => {
    const res = await clear({ base_version: SEEDED_VERSION, scope: "all" });

    expect(res.status).toBe(409);
    expect((await readDefaultPage(env)).body).toBe(MIXED);
    expect(await clearedItems()).toHaveLength(0);
  });

  it("defaults to completed when no scope is sent, so an older PWA keeps working", async () => {
    const res = await clear({ base_version: SEEDED_VERSION + 1 });

    expect(res.status).toBe(200);
    expect((await readDefaultPage(env)).body).toBe(SURVIVORS);
  });

  it("400s an unrecognised scope rather than quietly doing the safer thing", async () => {
    // Defaulting a typo to `completed` would look like it worked and leave the page
    // full — the caller asked for something this route does not do, and should hear so.
    const res = await clear({ base_version: SEEDED_VERSION + 1, scope: "everything" });

    expect(res.status).toBe(400);
    expect((await readDefaultPage(env)).body).toBe(MIXED);
  });
});

describe("the state the wipe left (#91)", () => {
  // 🔴 The log used to be unable to say what a whole-page wipe took.
  //
  // A wipe snapshots the *pre*-wipe body, which is byte-identical to the revision before
  // it, so the event's own diff is empty by construction. The post-wipe state only entered
  // the log on the next ordinary save, which meant the wiped lines surfaced as
  // `disappeared` on an unrelated later revision — minutes away and attributed to whatever
  // edit happened to come next.
  //
  // For the sweep that was survivable: `cleared_items` is exact and carries the ticked
  // lines. For a page wipe it was not, because `cleared_items` deliberately holds finished
  // lines only — so a note or an undone task appeared **nowhere** in `/api/history`.
  const NOTE = "Kingspan 70mm quoted 2wks";
  const PAGE = `${NOTE}\n- [x] done thing\n- [ ] undone thing`;

  beforeEach(async () => {
    await put({ body: PAGE, base_version: SEEDED_VERSION });
  });

  it("🔴 records the post-wipe body as a second sealed revision", async () => {
    await clear({ base_version: SEEDED_VERSION + 1, scope: "all" });

    const log = await revisions();
    const event = log.find((r) => r.event_type === "wipe_all");
    const result = log[log.length - 1];

    // Two rows, and they are different rows: the event holds what was there, the result
    // holds what is there. Naming them by role rather than by position, because position
    // is exactly what broke when this shipped.
    expect(event?.body).toBe(PAGE);
    expect(result?.event_type).toBeNull();
    expect(result?.body).toBe("");
    expect(result?.id).toBeGreaterThan(event?.id ?? 0);

    // Sealed for the same reason the event row is: an unsealed row here would be
    // coalesced into by the next save inside the ten-minute window, overwriting the
    // state it exists to record.
    expect(result?.is_sealed).toBe(1);
    expect(result?.version).toBe(SEEDED_VERSION + 2);
  });

  it("🔴 puts a wiped note in /api/history, which cleared_items never could", async () => {
    await clear({ base_version: SEEDED_VERSION + 1, scope: "all" });

    const res = await SELF.fetch("https://knag.test/api/history?days=7", { headers: authed });
    const history = (await res.json()) as {
      days: Array<{
        revisions: Array<{ event_type: string | null; disappeared: string[] }>;
        cleared: Array<{ line_text: string }>;
      }>;
    };

    const day = history.days[0];
    const disappeared = day?.revisions.flatMap((r) => r.disappeared) ?? [];

    // The whole point. A note has no done state, so it is not in the done-record — and
    // before this change that meant it was not anywhere.
    expect(disappeared).toContain(NOTE);
    expect(disappeared).toContain("- [ ] undone thing");
    expect(day?.cleared.map((c) => c.line_text)).toEqual(["- [x] done thing"]);
  });

  it("does not record a result row when the wipe was refused", async () => {
    // The guard reads the *post*-CAS version, unlike every other statement in the batch.
    // A stale base_version must leave the log exactly as it was.
    const before = await revisions();

    const res = await clear({ base_version: SEEDED_VERSION, scope: "all" });

    expect(res.status).toBe(409);
    expect(await revisions()).toHaveLength(before.length);
  });

  it("records what a sweep left too, so the two scopes read the same way", async () => {
    await clear({ base_version: SEEDED_VERSION + 1 });

    const log = await revisions();
    const result = log[log.length - 1];

    expect(result?.event_type).toBeNull();
    expect(result?.body).toBe(`${NOTE}\n- [ ] undone thing`);
  });
});
