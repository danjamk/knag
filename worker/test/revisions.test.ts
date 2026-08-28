import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COALESCE_WINDOW_MS, DEFAULT_PAGE_ID, writePage } from "../src/store.js";
import { OPERATOR } from "./users.js";

/**
 * The revision log — principle 4, "deletion is not loss".
 *
 * Queried with raw SQL rather than through store.ts on purpose: a test that asks the
 * module under test whether it recorded history cannot catch it failing to.
 */

const T0 = new Date("2026-08-15T12:00:00.000Z");
const at = (msAfterT0: number) => new Date(T0.getTime() + msAfterT0);

const MINUTE = 60_000;

async function revisions(): Promise<
  Array<{ id: number; body: string; version: number; created_at: string; is_sealed: number; source: string; event_type: string | null }>
> {
  const { results } = await env.DB.prepare(
    "SELECT id, body, version, created_at, is_sealed, source, event_type FROM revisions ORDER BY id",
  ).all<{
    id: number;
    body: string;
    version: number;
    created_at: string;
    is_sealed: number;
    source: string;
    event_type: string | null;
  }>();
  return results;
}

/** The seeded document is version 1 and empty; migration 0002 logs it as a baseline. */
const SEEDED_VERSION = 1;

async function write(body: string, baseVersion: number, when: Date) {
  return writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body, baseVersion, source: "pwa" }, when);
}

describe("the baseline revision (migration 0002)", () => {
  it("records whatever the document was when the log was introduced", async () => {
    const log = await revisions();

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ body: "", version: SEEDED_VERSION, source: "system" });
  });

  it("is sealed, so the next save cannot overwrite it", async () => {
    // The whole reason it exists is to preserve a state. An unsealed baseline would
    // be coalesced into by the very next write and lose exactly that.
    expect((await revisions())[0]?.is_sealed).toBe(1);
  });
});

describe("recording", () => {
  it("logs a full snapshot of the state after the write", async () => {
    await write("first line", SEEDED_VERSION, T0);

    const log = await revisions();
    expect(log).toHaveLength(2);
    // Full snapshot, not a diff: the body is the whole document at that version.
    expect(log[1]).toMatchObject({ body: "first line", version: 2, is_sealed: 0, source: "pwa" });
  });

  it("records the source of the write", async () => {
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "by an agent", baseVersion: SEEDED_VERSION, source: "agent" }, T0);

    expect((await revisions())[1]?.source).toBe("agent");
  });

  it("leaves event_type null for an ordinary save", async () => {
    // 'clear_completed' is set by the clear path (#12), and nothing else sets it.
    await write("a", SEEDED_VERSION, T0);

    expect((await revisions())[1]?.event_type).toBeNull();
  });

  it("writes nothing for a no-op", async () => {
    await write("same", SEEDED_VERSION, T0);
    const before = await revisions();

    await write("same", 2, at(MINUTE));

    expect(await revisions()).toEqual(before);
  });

  it("writes nothing for a conflict", async () => {
    await write("winner", SEEDED_VERSION, T0);
    const before = await revisions();

    const result = await write("loser", SEEDED_VERSION, at(MINUTE));

    expect(result.status).toBe("conflict");
    expect(await revisions()).toEqual(before);
  });
});

describe("coalescing (spec §3)", () => {
  it("folds a save inside the window into the newest revision", async () => {
    await write("one", SEEDED_VERSION, T0);
    await write("one two", 2, at(MINUTE));

    const log = await revisions();
    // Baseline plus one — the second save updated in place rather than inserting.
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ body: "one two", version: 3 });
  });

  it("measures the window from when the burst started, not the last keystroke", async () => {
    // 🔴 If `created_at` were bumped on each coalesce, continuous typing would hold
    // one revision open indefinitely and the log would never gain a second entry.
    await write("a", SEEDED_VERSION, T0);
    await write("ab", 2, at(9 * MINUTE));

    expect((await revisions())[1]?.created_at).toBe(T0.toISOString());
  });

  it("inserts once the window has passed", async () => {
    await write("one", SEEDED_VERSION, T0);
    await write("two", 2, at(11 * MINUTE));

    const log = await revisions();
    expect(log).toHaveLength(3);
    expect(log[1]).toMatchObject({ body: "one", version: 2 });
    expect(log[2]).toMatchObject({ body: "two", version: 3 });
  });

  it("coalesces at 9 minutes and does not at 11", async () => {
    await write("start", SEEDED_VERSION, T0);
    await write("nine", 2, at(9 * MINUTE));
    expect(await revisions()).toHaveLength(2);

    await write("eleven", 3, at(9 * MINUTE + 11 * MINUTE));
    expect(await revisions()).toHaveLength(3);
  });

  it("treats the boundary itself as outside the window", async () => {
    await write("start", SEEDED_VERSION, T0);
    await write("exactly", 2, at(COALESCE_WINDOW_MS));

    // Strictly less than, so ten minutes on the nose inserts. Either choice is
    // defensible; the test exists so the choice is not accidental.
    expect(await revisions()).toHaveLength(3);
  });

  it("never coalesces into a sealed revision", async () => {
    await write("before the clear", SEEDED_VERSION, T0);

    // What clear-completed will do (#12): seal the newest revision so the pre-clear
    // state cannot be swallowed by the window.
    await env.DB.prepare("UPDATE revisions SET is_sealed = 1 WHERE id = (SELECT max(id) FROM revisions)").run();

    await write("after the clear", 2, at(MINUTE));

    const log = await revisions();
    expect(log).toHaveLength(3);
    expect(log[1]).toMatchObject({ body: "before the clear", is_sealed: 1 });
    expect(log[2]).toMatchObject({ body: "after the clear", is_sealed: 0 });
  });
});

describe("what the log guarantees", () => {
  it("keeps every state that survived a window boundary recoverable", async () => {
    // The product promise: sweep the document clean without losing the record.
    await write("monday", SEEDED_VERSION, T0);
    await write("tuesday", 2, at(30 * MINUTE));
    await write("wednesday", 3, at(60 * MINUTE));

    expect((await revisions()).map((r) => r.body)).toEqual([
      "",
      "monday",
      "tuesday",
      "wednesday",
    ]);
  });

  it("discards only intermediates inside a burst, which is the point", async () => {
    await write("a", SEEDED_VERSION, T0);
    await write("ab", 2, at(MINUTE));
    await write("abc", 3, at(2 * MINUTE));

    // Three saves, one revision: 'a' and 'ab' are gone by design, 'abc' is kept.
    expect((await revisions()).map((r) => r.body)).toEqual(["", "abc"]);
  });
});
