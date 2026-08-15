import { describe, expect, it } from "vitest";
import {
  buildHistory,
  comparableLines,
  daysBefore,
  diffLines,
  isKnownTimeZone,
  localDate,
  localMidnight,
  localTime,
  nextDay,
  parseBareDate,
  resolveBoundary,
  wallClock,
  zonedInstant,
} from "../src/history.js";

/**
 * The pure half of `/api/history` (spec §5, §14.3).
 *
 * The zone tests carry real UTC offsets written out longhand rather than computed —
 * a test that derives its expectation the same way the code does agrees with the code
 * whatever the code says. Chicago is UTC-6 in winter and UTC-5 in summer, and those
 * two numbers are the entire content of half this file.
 */

const CHICAGO = "America/Chicago";

describe("wall-clock reading", () => {
  it("reads local time, not UTC", () => {
    // 03:00 UTC on the 15th is still the 14th in Chicago — the exact failure §14.3
    // exists to prevent.
    expect(wallClock(new Date("2026-08-15T03:00:00Z"), CHICAGO)).toEqual({
      year: 2026,
      month: 8,
      day: 14,
      hour: 22,
      minute: 0,
      second: 0,
    });
  });

  it("renders midnight as hour 0, never 24", () => {
    // Some ICU builds render midnight as 24 under `hour12: false`, which would file
    // midnight under the previous day.
    expect(wallClock(new Date("2026-08-15T05:00:00Z"), CHICAGO).hour).toBe(0);
  });

  it("formats the grouping key and the display time", () => {
    const at = new Date("2026-08-15T03:04:05Z");

    expect(localDate(at, CHICAGO)).toBe("2026-08-14");
    expect(localTime(at, CHICAGO)).toBe("22:04");
  });

  it("pads a single-digit month and day", () => {
    expect(localDate(new Date("2026-01-05T18:00:00Z"), CHICAGO)).toBe("2026-01-05");
  });

  it("recognises a real zone and rejects a fake one", () => {
    expect(isKnownTimeZone(CHICAGO)).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("America/Nowhere")).toBe(false);
  });
});

describe("local midnight as a UTC instant", () => {
  it("resolves a summer date at CDT, UTC-5", () => {
    expect(localMidnight({ year: 2026, month: 8, day: 14 }, CHICAGO).toISOString()).toBe(
      "2026-08-14T05:00:00.000Z",
    );
  });

  it("resolves a winter date at CST, UTC-6", () => {
    expect(localMidnight({ year: 2026, month: 1, day: 14 }, CHICAGO).toISOString()).toBe(
      "2026-01-14T06:00:00.000Z",
    );
  });

  it("is a no-op in UTC", () => {
    expect(localMidnight({ year: 2026, month: 8, day: 14 }, "UTC").toISOString()).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });

  it("handles a zone east of UTC", () => {
    // Tokyo is UTC+9 year round, so local midnight is the *previous* UTC day. A sign
    // error passes every Chicago test in this file and fails this one.
    expect(localMidnight({ year: 2026, month: 8, day: 14 }, "Asia/Tokyo").toISOString()).toBe(
      "2026-08-13T15:00:00.000Z",
    );
  });

  it("handles a half-hour offset", () => {
    // Kolkata is UTC+5:30. Any implementation that reasons in whole hours fails here.
    expect(localMidnight({ year: 2026, month: 8, day: 14 }, "Asia/Kolkata").toISOString()).toBe(
      "2026-08-13T18:30:00.000Z",
    );
  });
});

describe("DST boundaries", () => {
  // US DST 2026: forward 08 March, back 01 November. Both at 02:00 local.

  it("resolves midnight on the spring-forward day", () => {
    // The 8th begins at 00:00 CST (UTC-6). The jump happens two hours later, so
    // midnight is unaffected — but an implementation that probes the offset at the
    // *end* of the day gets UTC-5 and lands an hour early.
    expect(localMidnight({ year: 2026, month: 3, day: 8 }, CHICAGO).toISOString()).toBe(
      "2026-03-08T06:00:00.000Z",
    );
  });

  it("resolves midnight on the day after spring-forward", () => {
    expect(localMidnight({ year: 2026, month: 3, day: 9 }, CHICAGO).toISOString()).toBe(
      "2026-03-09T05:00:00.000Z",
    );
  });

  it("resolves midnight on the fall-back day", () => {
    // The 1st begins at 00:00 CDT (UTC-5) and ends at CST.
    expect(localMidnight({ year: 2026, month: 11, day: 1 }, CHICAGO).toISOString()).toBe(
      "2026-11-01T05:00:00.000Z",
    );
  });

  it("makes the spring-forward day 23 hours long", () => {
    const start = localMidnight({ year: 2026, month: 3, day: 8 }, CHICAGO);
    const end = localMidnight({ year: 2026, month: 3, day: 9 }, CHICAGO);

    // 🔴 The whole point. A day is not 86,400,000 ms, and a range built by adding
    // 24 hours to a start would leak an hour of the 9th into the 8th.
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("makes the fall-back day 25 hours long", () => {
    const start = localMidnight({ year: 2026, month: 11, day: 1 }, CHICAGO);
    const end = localMidnight({ year: 2026, month: 11, day: 2 }, CHICAGO);

    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("groups the repeated hour by the local date it fell on", () => {
    // 01:30 local happens twice on 01 November. Both readings are the 1st.
    expect(localDate(new Date("2026-11-01T06:30:00Z"), CHICAGO)).toBe("2026-11-01");
    expect(localDate(new Date("2026-11-01T07:30:00Z"), CHICAGO)).toBe("2026-11-01");
  });

  it("🔴 resolves a wall time in the hours after spring-forward", () => {
    // 03:30 on the 8th is 08:30Z. The naive version — probe the offset once at the
    // wall time read as UTC, subtract — probes at 03:30Z, which is still the previous
    // evening in Chicago and therefore still CST, and lands an hour late at 09:30Z.
    //
    // Every local-midnight case in this file passes without the second probe, because
    // midnight's probe point falls on the same side of the transition as its answer.
    // This one does not, and it is the reason `zonedInstant` is a fixed point.
    expect(
      zonedInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 30, second: 0 }, CHICAGO)
        .toISOString(),
    ).toBe("2026-03-08T08:30:00.000Z");
  });

  it("🔴 resolves a wall time in the hours after fall-back", () => {
    // The mirror image: 03:00 on 01 November is 09:00Z, and a single probe gives
    // 08:00Z — an hour early, in the other direction.
    expect(
      zonedInstant({ year: 2026, month: 11, day: 1, hour: 3, minute: 0, second: 0 }, CHICAGO)
        .toISOString(),
    ).toBe("2026-11-01T09:00:00.000Z");
  });

  it("resolves a wall time inside the fall-back repeat deterministically", () => {
    // 01:30 on 01 November exists twice — 06:30Z at CDT and 07:30Z at CST. The first
    // is the answer; what matters is that it is always the same answer.
    const at = zonedInstant(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      CHICAGO,
    );

    expect(at.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(zonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, CHICAGO)).toEqual(at);
  });

  it("does not throw on a wall time that never happened", () => {
    // 02:30 on 08 March does not exist. There is no right answer; there is only a
    // deterministic one that is not a crash and not an infinite loop.
    const at = zonedInstant(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      CHICAGO,
    );

    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(localDate(at, CHICAGO)).toBe("2026-03-08");
  });

  it("🔴 starts a day whose midnight does not exist at the moment the day begins", () => {
    // Santiago springs forward at 00:00 on 06 September 2026: 23:59 on the 5th is
    // followed by 01:00 on the 6th, and midnight never happens. The two candidates
    // are 03:00Z (23:00 on the 5th) and 04:00Z (01:00 on the 6th).
    //
    // 🔴 The later one, and this is the deviation from Luxon. Taking the earlier
    // would put the last hour of the 5th inside the 6th's range — filing a day's
    // closing work under the next day, which is the exact error §14.3 is about.
    const at = localMidnight({ year: 2026, month: 9, day: 6 }, "America/Santiago");

    expect(at.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(localDate(at, "America/Santiago")).toBe("2026-09-06");
  });

  it("keeps days tiling across a midnight gap, with the loss on the right day", () => {
    const santiago = "America/Santiago";
    const fifth = localMidnight({ year: 2026, month: 9, day: 5 }, santiago);
    const sixth = localMidnight({ year: 2026, month: 9, day: 6 }, santiago);
    const seventh = localMidnight({ year: 2026, month: 9, day: 7 }, santiago);

    // The 5th is an ordinary 24 hours — it ends on time, at what would have been the
    // 6th's midnight.
    expect(sixth.getTime() - fifth.getTime()).toBe(24 * 60 * 60 * 1000);

    // 🔴 The 6th is the short one, because it starts an hour late. Taking the earlier
    // end of the gap instead would make the 5th 23 hours and the 6th 24 — moving an
    // hour of Saturday's work onto Sunday.
    expect(seventh.getTime() - sixth.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});

describe("bare date parsing", () => {
  it("accepts a well-formed date", () => {
    expect(parseBareDate("2026-08-14")).toEqual({ year: 2026, month: 8, day: 14 });
  });

  it("rejects a date that does not exist", () => {
    // Date.UTC silently rolls 2026-02-31 into March. Accepting it would answer a
    // question about a day that never happened.
    expect(parseBareDate("2026-02-31")).toBeNull();
    expect(parseBareDate("2026-13-01")).toBeNull();
  });

  it("accepts 29 February in a leap year and rejects it otherwise", () => {
    expect(parseBareDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseBareDate("2026-02-29")).toBeNull();
  });

  it("rejects anything that is not exactly YYYY-MM-DD", () => {
    for (const value of ["2026-8-14", "26-08-14", "2026/08/14", "yesterday", "", "2026-08-14 "]) {
      expect(parseBareDate(value), value).toBeNull();
    }
  });
});

describe("calendar arithmetic", () => {
  it("crosses a month boundary", () => {
    expect(nextDay({ year: 2026, month: 8, day: 31 })).toEqual({ year: 2026, month: 9, day: 1 });
  });

  it("crosses a year boundary", () => {
    expect(nextDay({ year: 2026, month: 12, day: 31 })).toEqual({ year: 2027, month: 1, day: 1 });
    expect(daysBefore({ year: 2027, month: 1, day: 2 }, 7)).toEqual({
      year: 2026,
      month: 12,
      day: 26,
    });
  });

  it("crosses a leap day", () => {
    expect(nextDay({ year: 2028, month: 2, day: 28 })).toEqual({ year: 2028, month: 2, day: 29 });
  });
});

describe("resolving a range boundary", () => {
  const fallback = () => new Date("1999-01-01T00:00:00.000Z");

  it("falls back when the parameter is absent or empty", () => {
    expect(resolveBoundary(null, "since", CHICAGO, fallback)).toEqual(fallback());
    expect(resolveBoundary("", "since", CHICAGO, fallback)).toEqual(fallback());
  });

  it("resolves a bare since to local midnight of that day", () => {
    expect(resolveBoundary("2026-08-14", "since", CHICAGO, fallback)?.toISOString()).toBe(
      "2026-08-14T05:00:00.000Z",
    );
  });

  it("resolves a bare until to local midnight of the NEXT day", () => {
    // 🔴 Otherwise `since=2026-08-14&until=2026-08-14` — the query a human actually
    // types for "what did I do Friday" — is an empty range and returns nothing.
    expect(resolveBoundary("2026-08-14", "until", CHICAGO, fallback)?.toISOString()).toBe(
      "2026-08-15T05:00:00.000Z",
    );
  });

  it("makes a single-day range exactly one day long", () => {
    const since = resolveBoundary("2026-08-14", "since", CHICAGO, fallback);
    const until = resolveBoundary("2026-08-14", "until", CHICAGO, fallback);

    expect((until?.getTime() ?? 0) - (since?.getTime() ?? 0)).toBe(24 * 60 * 60 * 1000);
  });

  it("takes a full ISO instant as given", () => {
    expect(resolveBoundary("2026-08-14T12:34:56Z", "since", CHICAGO, fallback)?.toISOString()).toBe(
      "2026-08-14T12:34:56.000Z",
    );
  });

  it("returns null for anything malformed", () => {
    for (const value of ["nonsense", "2026-02-31", "2026-08-14T99:00:00Z"]) {
      expect(resolveBoundary(value, "since", CHICAGO, fallback), value).toBeNull();
    }
  });
});

describe("line-set diff", () => {
  it("reports lines added and lines removed", () => {
    const before = "alpha\nbravo";
    const after = "alpha\ncharlie";

    expect(diffLines(before, after)).toEqual({
      appeared: ["charlie"],
      disappeared: ["bravo"],
    });
  });

  it("reports nothing for a reorder", () => {
    // Set semantics, on purpose. Moving a line is not something you finished.
    expect(diffLines("a\nb\nc", "c\nb\na")).toEqual({ appeared: [], disappeared: [] });
  });

  it("sees a checkbox being ticked, because the line text changes", () => {
    expect(diffLines("- [ ] milk", "- [x] milk")).toEqual({
      appeared: ["- [x] milk"],
      disappeared: ["- [ ] milk"],
    });
  });

  it("ignores blank and whitespace-only lines", () => {
    // Structure, not content — and the noisiest thing a set diff can report.
    expect(diffLines("a", "a\n\n   \n\t")).toEqual({ appeared: [], disappeared: [] });
  });

  it("ignores a change of line ending", () => {
    // 🔴 A document saved once from a CRLF client and once from an LF one would
    // otherwise report every line as both added and removed.
    expect(diffLines("a\r\nb", "a\nb")).toEqual({ appeared: [], disappeared: [] });
  });

  it("keeps document order and does not repeat a duplicate", () => {
    expect(diffLines("", "z\na\nz\nb").appeared).toEqual(["z", "a", "b"]);
  });

  it("is blind to a duplicate line being removed", () => {
    // Documented, not a bug: this is why `cleared_items` is the authoritative record
    // of what got finished (spec §5).
    expect(diffLines("dup\ndup", "dup")).toEqual({ appeared: [], disappeared: [] });
  });

  it("splits lines and strips only a trailing CR", () => {
    expect(comparableLines("a\r\nb\rc\n")).toEqual(["a", "b\rc", ""]);
  });
});

describe("assembling the response", () => {
  const revision = (
    id: number,
    body: string,
    created_at: string,
    extra: Partial<{ version: number; source: string; event_type: string | null }> = {},
  ) => ({
    id,
    body,
    version: extra.version ?? id,
    created_at,
    source: extra.source ?? "pwa",
    event_type: extra.event_type ?? null,
  });

  const range = {
    since: new Date("2026-08-14T05:00:00Z"),
    until: new Date("2026-08-16T05:00:00Z"),
    timeZone: CHICAGO,
    truncated: false,
  };

  it("diffs the first revision against the baseline, not against nothing", () => {
    // 🔴 The failure this prevents: every range opening with the whole document
    // reported as new, so a day in which one line changed reads as a day of forty.
    const history = buildHistory({
      ...range,
      baseline: revision(1, "alpha\nbravo", "2026-08-13T18:00:00.000Z"),
      revisions: [revision(2, "alpha\ncharlie", "2026-08-14T14:00:00.000Z")],
      cleared: [],
    });

    expect(history.days[0]?.revisions[0]).toMatchObject({
      appeared: ["charlie"],
      disappeared: ["bravo"],
    });
  });

  it("treats a null baseline as an empty document", () => {
    const history = buildHistory({
      ...range,
      baseline: null,
      revisions: [revision(1, "first thing", "2026-08-14T14:00:00.000Z")],
      cleared: [],
    });

    expect(history.days[0]?.revisions[0]?.appeared).toEqual(["first thing"]);
  });

  it("never returns the baseline itself", () => {
    const history = buildHistory({
      ...range,
      baseline: revision(1, "before the range", "2026-08-13T18:00:00.000Z"),
      revisions: [revision(2, "in range", "2026-08-14T14:00:00.000Z")],
      cleared: [],
    });

    expect(history.days.flatMap((d) => d.revisions).map((r) => r.id)).toEqual([2]);
  });

  it("groups by local date and puts the newest day first", () => {
    const history = buildHistory({
      ...range,
      baseline: null,
      revisions: [
        revision(1, "a", "2026-08-14T14:00:00.000Z"),
        revision(2, "a\nb", "2026-08-15T02:00:00.000Z"),
        revision(3, "a\nb\nc", "2026-08-15T16:00:00.000Z"),
      ],
      cleared: [],
    });

    // 🔴 02:00Z on the 15th is 21:00 on the 14th in Chicago. Grouped in UTC this
    // lands on the wrong day, which is §14.3's entire reason for existing.
    expect(history.days.map((day) => day.date)).toEqual(["2026-08-15", "2026-08-14"]);
    expect(history.days[1]?.revisions.map((r) => r.id)).toEqual([1, 2]);
    expect(history.days[0]?.revisions.map((r) => r.id)).toEqual([3]);
  });

  it("chains the diff across a day boundary", () => {
    const history = buildHistory({
      ...range,
      baseline: null,
      revisions: [
        revision(1, "a", "2026-08-14T14:00:00.000Z"),
        revision(2, "a\nb", "2026-08-15T16:00:00.000Z"),
      ],
      cleared: [],
    });

    // The second day diffs against the last state of the first, not against nothing.
    expect(history.days[0]?.revisions[0]?.appeared).toEqual(["b"]);
  });

  it("carries the local time of each entry", () => {
    const history = buildHistory({
      ...range,
      baseline: null,
      revisions: [revision(1, "a", "2026-08-15T02:04:00.000Z")],
      cleared: [],
    });

    expect(history.days[0]?.revisions[0]?.local_time).toBe("21:04");
  });

  it("files cleared items by local date and counts them onto their revision", () => {
    const history = buildHistory({
      ...range,
      baseline: revision(1, "- [x] laundry", "2026-08-14T13:00:00.000Z"),
      revisions: [
        revision(2, "- [x] laundry", "2026-08-14T14:00:00.000Z", {
          event_type: "clear_completed",
        }),
      ],
      cleared: [
        { id: 1, revision_id: 2, line_text: "- [x] laundry", cleared_at: "2026-08-14T14:00:00.000Z" },
        { id: 2, revision_id: 2, line_text: "- [x] dishes", cleared_at: "2026-08-14T14:00:00.000Z" },
      ],
    });

    const day = history.days[0];
    expect(day?.cleared.map((c) => c.line_text)).toEqual(["- [x] laundry", "- [x] dishes"]);
    expect(day?.cleared[0]?.local_time).toBe("09:00");

    // 🔴 A clear_completed revision snapshots the *pre*-clear body, identical to the
    // one before it, so its own diff is empty by construction (spec §14.2). The
    // count is what makes the entry legible; `cleared` is the actual record.
    expect(day?.revisions[0]).toMatchObject({
      event_type: "clear_completed",
      appeared: [],
      disappeared: [],
      cleared_count: 2,
    });
  });

  it("leaves cleared_count at zero for an ordinary save", () => {
    const history = buildHistory({
      ...range,
      baseline: null,
      revisions: [revision(1, "a", "2026-08-14T14:00:00.000Z")],
      cleared: [],
    });

    expect(history.days[0]?.revisions[0]?.cleared_count).toBe(0);
  });

  it("keeps a day that only has cleared items", () => {
    const history = buildHistory({
      ...range,
      baseline: null,
      revisions: [],
      cleared: [
        { id: 1, revision_id: 9, line_text: "- [x] done", cleared_at: "2026-08-15T16:00:00.000Z" },
      ],
    });

    expect(history.days.map((d) => d.date)).toEqual(["2026-08-15"]);
    expect(history.days[0]?.revisions).toEqual([]);
  });

  it("echoes the range and the zone it was resolved in", () => {
    const history = buildHistory({ ...range, baseline: null, revisions: [], cleared: [] });

    expect(history).toMatchObject({
      timezone: CHICAGO,
      since: "2026-08-14T05:00:00.000Z",
      until: "2026-08-16T05:00:00.000Z",
      days: [],
      truncated: false,
    });
  });

  it("passes truncation through", () => {
    const history = buildHistory({
      ...range,
      truncated: true,
      baseline: null,
      revisions: [],
      cleared: [],
    });

    expect(history.truncated).toBe(true);
  });
});
