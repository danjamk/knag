import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, revisionsInRange, wipe, writePage } from "../src/store.js";
import { OPERATOR } from "./users.js";

/**
 * `GET /api/history` end to end (spec §5, §14.3).
 *
 * The fixture sits on **8 March 2026**, the US spring-forward day, and the whole point
 * of that date is the boundary: the 8th is 23 hours long in Chicago and runs from
 * 06:00Z to 05:00Z the next day. One revision is deliberately written at 04:00Z on the
 * 9th — 23:00 local on the 8th — so any implementation that groups or bounds in UTC
 * files it under the wrong day and fails.
 *
 * Everything is seeded in the past on purpose. Migration 0002 logs a baseline revision
 * at the moment the suite runs, and a fixture anchored near "now" would silently
 * include it.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const authed = { Authorization: `Bearer ${BEARER}` };

type HistoryDay = {
  date: string;
  revisions: Array<{
    id: number;
    version: number;
    local_time: string;
    source: string;
    event_type: string | null;
    appeared: string[];
    disappeared: string[];
    cleared_count: number;
  }>;
  cleared: Array<{ line_text: string; local_time: string; revision_id: number }>;
};

type HistoryBody = {
  timezone: string;
  since: string;
  until: string;
  days: HistoryDay[];
  truncated: boolean;
};

function history(query = ""): Promise<Response> {
  return SELF.fetch(`https://knag.test/api/history${query}`, { headers: authed });
}

async function historyJson(query = ""): Promise<HistoryBody> {
  const res = await history(query);
  expect(res.status).toBe(200);
  return (await res.json()) as HistoryBody;
}

/** The migration seeds (1, '', 1, now, 'system'). */
const SEEDED_VERSION = 1;

/**
 * Four saves spanning the DST boundary, spaced past the ten-minute coalescing window
 * so each lands as its own revision rather than folding into the last.
 */
async function seedRevisions(): Promise<void> {
  await writePage(
      env,
      { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "alpha", baseVersion: SEEDED_VERSION, source: "pwa" },
    new Date("2026-03-07T18:00:00.000Z"), // 12:00 Sat, CST
  );
  await writePage(
      env,
      { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "alpha\nbravo", baseVersion: 2, source: "pwa" },
    new Date("2026-03-08T13:00:00.000Z"), // 08:00 Sun, CDT — after the jump
  );
  await writePage(
      env,
      { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "alpha\nbravo\ncharlie", baseVersion: 3, source: "agent" },
    new Date("2026-03-09T04:00:00.000Z"), // 23:00 Sun local — the 8th, not the 9th
  );
  await writePage(
      env,
      { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "alpha\ncharlie", baseVersion: 4, source: "pwa" },
    new Date("2026-03-09T18:00:00.000Z"), // 13:00 Mon
  );
}

describe("auth", () => {
  it("401s with WWW-Authenticate when no credential is presented", async () => {
    const res = await SELF.fetch("https://knag.test/api/history");

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="knag"');
  });

  it("401s on a wrong bearer token", async () => {
    const res = await SELF.fetch("https://knag.test/api/history", {
      headers: { Authorization: "Bearer not-the-token" },
    });

    expect(res.status).toBe(401);
  });

  it("405s a write method and says what is allowed", async () => {
    const res = await SELF.fetch("https://knag.test/api/history", {
      method: "POST",
      headers: authed,
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

describe("parameters", () => {
  it("400s a malformed since", async () => {
    expect((await history("?since=yesterday")).status).toBe(400);
  });

  it("400s a date that does not exist", async () => {
    expect((await history("?since=2026-02-31")).status).toBe(400);
  });

  it("400s a malformed until", async () => {
    expect((await history("?until=soon")).status).toBe(400);
  });

  it("400s an inverted range rather than answering it with silence", async () => {
    // An empty result for a typo looks exactly like a week in which nothing happened.
    const res = await history("?since=2026-03-09&until=2026-03-07");

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "since must be before until" });
  });

  it("accepts a full ISO instant on either end", async () => {
    const body = await historyJson("?since=2026-03-08T00:00:00Z&until=2026-03-09T00:00:00Z");

    expect(body.since).toBe("2026-03-08T00:00:00.000Z");
    expect(body.until).toBe("2026-03-09T00:00:00.000Z");
  });

  it("defaults to a seven-day window ending now", async () => {
    const body = await historyJson();

    const span = new Date(body.until).getTime() - new Date(body.since).getTime();
    expect(span).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(span).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it("reports the zone it resolved boundaries in", async () => {
    expect((await historyJson()).timezone).toBe("America/Chicago");
  });
});

describe("a single local day", () => {
  beforeEach(seedRevisions);

  it("resolves a bare date to the whole local day, DST included", async () => {
    const body = await historyJson("?since=2026-03-08&until=2026-03-08");

    // 🔴 06:00Z to 05:00Z — 23 hours, because the 8th is the spring-forward day.
    expect(body.since).toBe("2026-03-08T06:00:00.000Z");
    expect(body.until).toBe("2026-03-09T05:00:00.000Z");
  });

  it("files a 04:00Z revision under the previous local day", async () => {
    const body = await historyJson("?since=2026-03-08&until=2026-03-08");

    // 04:00Z on the 9th is 23:00 on the 8th in Chicago. Grouped or bounded in UTC,
    // this revision is missing from Sunday and Sunday's story is wrong.
    expect(body.days.map((day) => day.date)).toEqual(["2026-03-08"]);
    expect(body.days[0]?.revisions.map((r) => r.local_time)).toEqual(["08:00", "23:00"]);
  });

  it("excludes the days on either side", async () => {
    const body = await historyJson("?since=2026-03-08&until=2026-03-08");

    expect(body.days[0]?.revisions).toHaveLength(2);
    expect(body.days[0]?.revisions.flatMap((r) => r.appeared)).toEqual(["bravo", "charlie"]);
  });

  it("diffs the first entry against the revision before the range", async () => {
    // 🔴 Saturday's "alpha" is the floor. Without it Sunday opens by reporting
    // "alpha" as new, and a day in which one line was added reads as a fresh start.
    const body = await historyJson("?since=2026-03-08&until=2026-03-08");

    expect(body.days[0]?.revisions[0]).toMatchObject({
      appeared: ["bravo"],
      disappeared: [],
    });
  });

  it("sees a removal whose only evidence is outside the range", async () => {
    // Monday's save dropped "bravo", which was added on Sunday. The floor for Monday
    // is Sunday's last revision, so the removal is visible even though nothing in
    // range ever contained "bravo".
    const body = await historyJson("?since=2026-03-09&until=2026-03-09");

    expect(body.days[0]?.revisions[0]).toMatchObject({
      appeared: [],
      disappeared: ["bravo"],
    });
  });

  it("carries the write source through", async () => {
    const body = await historyJson("?since=2026-03-08&until=2026-03-08");

    expect(body.days[0]?.revisions.map((r) => r.source)).toEqual(["pwa", "agent"]);
  });
});

describe("a multi-day range", () => {
  beforeEach(seedRevisions);

  it("groups by local date, newest day first", async () => {
    const body = await historyJson("?since=2026-03-07&until=2026-03-09");

    expect(body.days.map((day) => day.date)).toEqual(["2026-03-09", "2026-03-08", "2026-03-07"]);
  });

  it("chains the diff across day boundaries", async () => {
    const body = await historyJson("?since=2026-03-07&until=2026-03-09");
    const byDate = Object.fromEntries(body.days.map((day) => [day.date, day]));

    expect(byDate["2026-03-07"]?.revisions[0]?.appeared).toEqual(["alpha"]);
    expect(byDate["2026-03-08"]?.revisions[0]?.appeared).toEqual(["bravo"]);
    expect(byDate["2026-03-09"]?.revisions[0]?.disappeared).toEqual(["bravo"]);
  });

  it("returns an empty day list for a range with nothing in it", async () => {
    const body = await historyJson("?since=2026-01-01&until=2026-01-07");

    expect(body.days).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  it("never returns a document body", async () => {
    // The diff is the product. Shipping four full snapshots per day would make the
    // response grow with the document rather than with what happened to it.
    const raw = await (await history("?since=2026-03-07&until=2026-03-09")).text();

    expect(raw).not.toContain('"body"');
  });
});

describe("cleared items", () => {
  beforeEach(async () => {
    await writePage(
      env,
      { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "- [x] laundry\n- [ ] taxes", baseVersion: SEEDED_VERSION, source: "pwa" },
      new Date("2026-03-08T13:00:00.000Z"),
    );
    await wipe(
      env,
      { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID,
        baseVersion: 2,
        body: "- [ ] taxes",
        clearedLines: ["- [x] laundry"],
        source: "pwa",
        scope: "completed",
        wipedCount: 1,
      },
      new Date("2026-03-08T22:00:00.000Z"), // 17:00 local
    );
  });

  it("returns the done-record filed by local date", async () => {
    const body = await historyJson("?since=2026-03-08&until=2026-03-08");

    expect(body.days[0]?.cleared).toHaveLength(1);
    expect(body.days[0]?.cleared[0]).toMatchObject({
      line_text: "- [x] laundry",
      local_time: "17:00",
    });
  });

  it("counts the swept lines onto the clear_completed revision", async () => {
    const body = await historyJson("?since=2026-03-08&until=2026-03-08");

    const clear = body.days[0]?.revisions.find((r) => r.event_type === "clear_completed");
    expect(clear?.cleared_count).toBe(1);
    // 🔴 Empty by construction: the clear snapshots the *pre*-clear body, which is
    // identical to the revision before it (spec §14.2). The `cleared` rows above are
    // the record of what was finished — the diff is not, and never was.
    expect(clear).toMatchObject({ appeared: [], disappeared: [] });
    expect(clear?.id).toBe(body.days[0]?.cleared[0]?.revision_id);
  });

  it("excludes a clear outside the range", async () => {
    expect((await historyJson("?since=2026-03-09&until=2026-03-09")).days).toEqual([]);
  });
});

describe("the revision cap", () => {
  beforeEach(seedRevisions);

  const RANGE = {
    since: new Date("2026-03-07T06:00:00.000Z"),
    until: new Date("2026-03-10T05:00:00.000Z"),
  };

  it("keeps the newest revisions, not the oldest", async () => {
    // 🔴 The reason the query runs DESC. An ascending LIMIT drops the recent end,
    // which is the end anyone asking about their history is asking about.
    const page = await revisionsInRange(env, { pageId: DEFAULT_PAGE_ID, ...RANGE, limit: 2 });

    expect(page.truncated).toBe(true);
    expect(page.revisions.map((r) => r.body)).toEqual(["alpha\nbravo\ncharlie", "alpha\ncharlie"]);
  });

  it("hands back the dropped revision immediately before the page, as the diff floor", async () => {
    // Without it a truncated page opens by reporting its whole document as new.
    const page = await revisionsInRange(env, { pageId: DEFAULT_PAGE_ID, ...RANGE, limit: 2 });

    expect(page.precedingDropped?.body).toBe("alpha\nbravo");
  });

  it("reports no truncation and no floor when everything fits", async () => {
    const page = await revisionsInRange(env, { pageId: DEFAULT_PAGE_ID, ...RANGE, limit: 50 });

    expect(page.truncated).toBe(false);
    expect(page.precedingDropped).toBeNull();
    expect(page.revisions.map((r) => r.body)).toEqual([
      "alpha",
      "alpha\nbravo",
      "alpha\nbravo\ncharlie",
      "alpha\ncharlie",
    ]);
  });

  it("returns rows oldest-first, which is the order the diff chain needs", async () => {
    const page = await revisionsInRange(env, { pageId: DEFAULT_PAGE_ID, ...RANGE });

    const times = page.revisions.map((r) => r.created_at);
    expect([...times].sort()).toEqual(times);
  });
});
