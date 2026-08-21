import type { Env } from "./env.js";
import {
  type ClearedRecord,
  type RevisionRecord,
  clearedItemsInRange,
  revisionBefore,
  revisionsInRange,
} from "./store.js";

/**
 * History — the derived view over the revision log (spec §5, §14.3).
 *
 * Everything except `loadHistory` at the bottom is pure: it takes rows and returns the
 * shape that **both** `GET /api/history` and the `knag_history` MCP tool hand back, so
 * the two cannot drift into answering the same question differently. `loadHistory` is
 * the one function that reads, and it exists so neither caller assembles the query
 * itself — a second assembly is a second set of boundary decisions.
 *
 * No SQL lives here. The three reads come from `store.ts`, which is still the only
 * file in the tree that holds a statement.
 *
 * Two things here are not obvious and are the whole reason this is its own module:
 *
 * 1. **Every boundary is a local-time question.** D1 stores UTC. "What did I finish
 *    Tuesday" filed in UTC puts everything after ~7pm Chicago on Wednesday. The zone
 *    maths uses `Intl.DateTimeFormat` exclusively — see `zonedInstant`.
 *
 * 2. **The first revision in range diffs against the one before it**, not against
 *    nothing. Otherwise the opening entry of every range reports the entire document
 *    as `appeared`, and a day that changed one line reads as a day that wrote forty.
 */

/** A local wall-clock reading. No zone attached — that is the caller's business. */
export type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * One `Intl.DateTimeFormat` per zone, reused.
 *
 * Constructing one is expensive enough to matter when it happens twice per revision
 * per request, and a Worker isolate is exactly the place a small module-scoped cache
 * is safe: it holds no request state and cannot leak between principals.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;

  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // 🔴 `hourCycle`, never `hour12: false`. The two together are not equivalent —
    // `hour12: false` takes precedence and, on some ICU builds, renders midnight as
    // hour 24, which turns local midnight into the wrong day exactly at the boundary
    // this module exists to get right.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(timeZone, made);
  return made;
}

/** `true` if the runtime recognises the zone. An unknown zone throws at construction. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** What the clock on the wall in `timeZone` reads at `instant`. */
export function wallClock(instant: Date, timeZone: string): Wall {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const hour = value("hour");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    // Belt and braces against the hour-24 rendering the `hourCycle` above already
    // rules out. This costs one comparison and the failure it guards is silent.
    hour: hour === 24 ? 0 : hour,
    minute: value("minute"),
    second: value("second"),
  };
}

/** Local date as `YYYY-MM-DD` — the grouping key, per spec §14.3. */
export function localDate(instant: Date, timeZone: string): string {
  const { year, month, day } = wallClock(instant, timeZone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Local `HH:MM`, so an entry can be read without doing the conversion in your head. */
export function localTime(instant: Date, timeZone: string): string {
  const { hour, minute } = wallClock(instant, timeZone);
  return `${pad(hour, 2)}:${pad(minute, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The zone's offset at `instant`, in milliseconds, signed local-minus-UTC.
 *
 * Derived by formatting the instant into the zone and reading the difference — the
 * only way to ask a runtime what an offset *was* on a given date. There is no table
 * of offsets to consult and no arithmetic that gets DST right.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asIfUTC = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // The wall reading has no sub-second component, so neither may the thing it is
  // compared against, or every offset comes out short by the instant's milliseconds.
  return asIfUTC - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the clock in `timeZone` reads `wall`.
 *
 * 🔴 This is a fixed point, not a subtraction, and the difference is DST. Subtracting
 * "the" offset requires knowing the offset, which requires knowing the instant, which
 * is what is being computed. So: guess with the offset in force at the wall time read
 * as UTC, re-probe at the guess, and settle.
 *
 * The algorithm is Luxon's `fixOffset`, followed rather than reinvented because its
 * third case is the one nobody thinks of. Three outcomes:
 *
 * - **Normal.** Both probes agree; the first guess was right.
 * - **Near a transition.** The probes disagree, the second guess re-probes to itself,
 *   and that is the answer. This is the ordinary DST-week case, and it is the one a
 *   single subtraction gets wrong — 03:30 on a spring-forward morning lands an hour
 *   late without it.
 * - **The wall time does not exist** — the spring-forward gap, where clocks jump from
 *   01:59 to 03:00 and 02:30 never happens. Nothing satisfies the request, so the
 *   probes oscillate and a choice has to be made.
 *
 * 🔴 In that third case knag takes the **later** instant where Luxon takes the earlier,
 * and the reason is that this function's only caller is a day boundary. The later
 * instant is the first moment that actually exists on the requested date; the earlier
 * one sits *before* the date begins, which would file the closing hour of the previous
 * day under this one — the precise error §14.3 exists to prevent, reintroduced at the
 * one boundary a year where nobody would look for it.
 *
 * Chicago transitions at 02:00 local, so its midnights never reach the third case.
 * Zones that shift at midnight do — America/Santiago springs forward at 00:00 — and
 * `KNAG_TZ` is a var anyone can change.
 */
export function zonedInstant(wall: Wall, timeZone: string): Date {
  const asIfUTC = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

  const first = offsetMs(new Date(asIfUTC), timeZone);
  const guess = asIfUTC - first;

  const second = offsetMs(new Date(guess), timeZone);
  if (first === second) return new Date(guess);

  const refined = asIfUTC - second;
  const third = offsetMs(new Date(refined), timeZone);
  if (second === third) return new Date(refined);

  // Smaller offset, later instant. See the note above on why later is the right end
  // of a gap for a day boundary.
  return new Date(asIfUTC - Math.min(second, third));
}

/** Local midnight on `date` (`YYYY-MM-DD`), as a UTC instant. */
export function localMidnight(date: BareDate, timeZone: string): Date {
  return zonedInstant({ ...date, hour: 0, minute: 0, second: 0 }, timeZone);
}

export type BareDate = { year: number; month: number; day: number };

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `YYYY-MM-DD`, rejecting the ones that only look like dates (`2026-02-31`). */
export function parseBareDate(value: string): BareDate | null {
  const match = BARE_DATE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-trip through Date.UTC, which normalises overflow rather than rejecting it:
  // 2026-02-31 becomes March 3rd, and comes back with a different day.
  const round = new Date(Date.UTC(year, month - 1, day));
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() + 1 !== month ||
    round.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/** The calendar day after `date`. Overflow is `Date.UTC`'s problem, not ours. */
export function nextDay(date: BareDate): BareDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/** The calendar day `count` days before `date`. */
export function daysBefore(date: BareDate, count: number): BareDate {
  const back = new Date(Date.UTC(date.year, date.month - 1, date.day - count));
  return {
    year: back.getUTCFullYear(),
    month: back.getUTCMonth() + 1,
    day: back.getUTCDate(),
  };
}

/**
 * Resolve one end of the requested range to a UTC instant.
 *
 * Three accepted forms, and the middle one is the reason this is not a one-liner:
 *
 * - **Absent** → the caller's default.
 * - **A bare date** (`2026-08-14`) → local midnight in `timeZone`. For `until` this is
 *   local midnight of the *next* day, so `since=2026-08-14&until=2026-08-14` returns
 *   Tuesday rather than nothing. A range whose ends are the same day and which
 *   contains nothing is not a range anyone would type on purpose.
 * - **A full ISO instant** (anything containing `T`) → taken as given. Present so a
 *   caller that already knows the exact moment is not forced to think in days.
 *
 * `null` means the value was malformed — a 400, not a guess.
 */
export function resolveBoundary(
  raw: string | null,
  edge: "since" | "until",
  timeZone: string,
  fallback: () => Date,
): Date | null {
  if (raw === null || raw === "") return fallback();

  if (raw.includes("T")) {
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  const date = parseBareDate(raw);
  if (!date) return null;

  return localMidnight(edge === "until" ? nextDay(date) : date, timeZone);
}

/**
 * Split a body into comparable lines.
 *
 * A trailing `\r` is dropped for comparison only — nothing here is ever written back,
 * so this is not a violation of "nothing is normalized" (principle 3), which governs
 * the round trip. Without it, a document saved once from a CRLF client and once from
 * an LF one reports every single line as both appeared and disappeared.
 */
export function comparableLines(body: string): string[] {
  return body.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Line-set diff: what is in `after` and not `before`, and the reverse (spec §5).
 *
 * Set semantics, deliberately. Character diffs and move detection are both real
 * improvements and both wrong for this product — the question is "what did I finish",
 * and reordering a list is not an answer to it. Set semantics also make blank-line and
 * indentation churn silent, which is most of what a plain-text editing session
 * produces.
 *
 * Two consequences worth knowing before reading a result:
 *
 * - **A duplicate line is invisible.** Two identical `- [ ] milk` lines, one deleted,
 *   diff to nothing. `cleared_items` is the authoritative done-record precisely
 *   because it does not have this property (spec §5).
 * - **Whitespace-only lines never appear in the output.** They are structure, not
 *   content, and they are the single noisiest thing a set diff can report.
 *
 * Output keeps first-appearance order, so a result reads down the document.
 */
export function diffLines(
  before: string,
  after: string,
): { appeared: string[]; disappeared: string[] } {
  const beforeLines = comparableLines(before);
  const afterLines = comparableLines(after);

  return {
    appeared: onlyIn(afterLines, new Set(beforeLines)),
    disappeared: onlyIn(beforeLines, new Set(afterLines)),
  };
}

function onlyIn(lines: string[], other: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    if (other.has(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }

  return out;
}

export type HistoryRevision = {
  id: number;
  version: number;
  created_at: string;
  /** `HH:MM` in the reporting zone, so the entry reads without conversion. */
  local_time: string;
  source: string;
  event_type: string | null;
  appeared: string[];
  disappeared: string[];
  /** Non-zero only on a `clear_completed` entry. See the note in `buildHistory`. */
  cleared_count: number;
};

export type HistoryCleared = {
  id: number;
  revision_id: number;
  line_text: string;
  cleared_at: string;
  local_time: string;
};

export type HistoryDay = {
  /** Local date, `YYYY-MM-DD`. Grouping is by this, never by the UTC date (§14.3). */
  date: string;
  revisions: HistoryRevision[];
  cleared: HistoryCleared[];
};

export type History = {
  timezone: string;
  /** The resolved range, echoed as UTC instants so the caller can see what was asked. */
  since: string;
  until: string;
  /** Newest day first — the question is almost always about the recent end. */
  days: HistoryDay[];
  /** `true` if the revision cap was hit and older entries in range were dropped. */
  truncated: boolean;
};

/**
 * Shape the rows into days.
 *
 * `baseline` is the newest revision *strictly before* `since`. It is the diff floor and
 * never appears in the output — without it the first entry of every range diffs against
 * an empty document and reports the whole thing as new. A `null` baseline is correct
 * and means the range reaches back past the start of the log.
 *
 * 🔴 **A `clear_completed` entry has an empty diff, by construction.** The clear path
 * snapshots the *pre*-clear body (spec §14.2), which is identical to the revision
 * before it, and the swept body only enters the log on the next ordinary save — where
 * the swept lines then show up as `disappeared`. That is faithful to the log and it is
 * why the entry carries `cleared_count`, and why the day carries `cleared`: those rows,
 * not the diff, are the record of what was finished.
 */
export function buildHistory(input: {
  baseline: RevisionRecord | null;
  /** In range, ascending by `created_at`. */
  revisions: RevisionRecord[];
  /** In range, ascending by `cleared_at`. */
  cleared: ClearedRecord[];
  since: Date;
  until: Date;
  timeZone: string;
  truncated: boolean;
}): History {
  const { timeZone } = input;

  const clearedCounts = new Map<number, number>();
  for (const item of input.cleared) {
    clearedCounts.set(item.revision_id, (clearedCounts.get(item.revision_id) ?? 0) + 1);
  }

  const days = new Map<string, HistoryDay>();
  const dayFor = (date: string): HistoryDay => {
    let day = days.get(date);
    if (!day) {
      day = { date, revisions: [], cleared: [] };
      days.set(date, day);
    }
    return day;
  };

  let previousBody = input.baseline?.body ?? "";

  for (const revision of input.revisions) {
    const at = new Date(revision.created_at);
    const { appeared, disappeared } = diffLines(previousBody, revision.body);

    dayFor(localDate(at, timeZone)).revisions.push({
      id: revision.id,
      version: revision.version,
      created_at: revision.created_at,
      local_time: localTime(at, timeZone),
      source: revision.source,
      event_type: revision.event_type,
      appeared,
      disappeared,
      cleared_count: clearedCounts.get(revision.id) ?? 0,
    });

    previousBody = revision.body;
  }

  for (const item of input.cleared) {
    const at = new Date(item.cleared_at);
    dayFor(localDate(at, timeZone)).cleared.push({
      id: item.id,
      revision_id: item.revision_id,
      line_text: item.line_text,
      cleared_at: item.cleared_at,
      local_time: localTime(at, timeZone),
    });
  }

  return {
    timezone: timeZone,
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    // Newest first. Dates are `YYYY-MM-DD`, so a string sort is a chronological sort.
    days: [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    truncated: input.truncated,
  };
}

/** Days a request with no `since` covers, counting today. A week, because that is the
 * unit the question gets asked in. */
export const DEFAULT_HISTORY_DAYS = 7;

/**
 * The zone every boundary is resolved in, given whatever `KNAG_TZ` holds (spec §14.3).
 *
 * A misconfigured zone falls back to UTC and says so in the logs rather than throwing.
 * Answering in the wrong zone is a bad day; returning 500 because someone fat-fingered
 * a var is a worse one. The fallback is never silent — the resolved zone is echoed in
 * every response, so it cannot be mistaken for working.
 */
export function reportingZone(configured: string | undefined): string {
  const zone = configured || "America/Chicago";
  if (isKnownTimeZone(zone)) return zone;

  console.warn(`KNAG_TZ is not a known IANA zone: ${zone}. Falling back to UTC.`);
  return "UTC";
}

export type RangeResult =
  | { ok: true; since: Date; until: Date }
  /** The parameter that was wrong, so the caller can name it. */
  | { ok: false; field: "since" | "until" | "range"; message: string };

/**
 * Resolve the requested window, or say which parameter was wrong.
 *
 * Shared by the HTTP route and the MCP tool so a bare date means the same thing on
 * both. An inverted range is rejected rather than answered: an empty result for a typo
 * is indistinguishable from a quiet week, and the caller has no way to tell.
 */
export function resolveRange(
  params: { since: string | null; until: string | null },
  timeZone: string,
  now: Date,
): RangeResult {
  const today = wallClock(now, timeZone);

  const since = resolveBoundary(params.since, "since", timeZone, () =>
    localMidnight(daysBefore(today, DEFAULT_HISTORY_DAYS - 1), timeZone),
  );
  if (!since) {
    return { ok: false, field: "since", message: "since must be YYYY-MM-DD or an ISO 8601 instant" };
  }

  const until = resolveBoundary(params.until, "until", timeZone, () => now);
  if (!until) {
    return { ok: false, field: "until", message: "until must be YYYY-MM-DD or an ISO 8601 instant" };
  }

  if (since.getTime() >= until.getTime()) {
    return { ok: false, field: "range", message: "since must be before until" };
  }

  return { ok: true, since, until };
}

/**
 * Read the log and shape it. The one entry point behind both surfaces.
 *
 * 🔴 One extra revision is read from **below** `since` purely as the diff floor, and it
 * is never returned. Without it the first entry of every range diffs against nothing
 * and reports the entire page as new, which makes the feature actively misleading on
 * exactly the query it exists for.
 */
export async function loadHistory(
  env: Env,
  range: { pageId: number; since: Date; until: Date },
  timeZone: string,
): Promise<History> {
  // Three indexed reads in parallel. `revisionBefore` is issued unconditionally even
  // though a truncated page supersedes it — one extra indexed lookup is cheaper than
  // the second round trip that finding out first would cost.
  //
  // 🔴 All three carry `range.pageId` (#152). A diff floor taken from another page would
  // report that page's whole body as `disappeared` and this page's as `appeared` — a
  // history that is not merely incomplete but actively wrong, on the one query the
  // feature exists for.
  const [before, page, cleared] = await Promise.all([
    revisionBefore(env, range.pageId, range.since),
    revisionsInRange(env, range),
    clearedItemsInRange(env, range),
  ]);

  return buildHistory({
    // A truncated page starts partway into the range, so the revision before the range
    // is the wrong floor for it — the one the cap dropped is the right one.
    baseline: page.precedingDropped ?? before,
    revisions: page.revisions,
    cleared,
    since: range.since,
    until: range.until,
    timeZone,
    truncated: page.truncated,
  });
}

export type { ClearedRecord, RevisionRecord };
