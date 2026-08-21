import type { Env } from "./env.js";

/**
 * Every D1 statement in knag lives in this file.
 *
 * 🔴 No SQL anywhere else in the tree. Not in a route handler, not in the MCP tools,
 * not "just this one query." That rule is the whole reason a multi-user schema would
 * be a one-file change instead of a rewrite (spec §17), and it is worth exactly as
 * much as the last exception made to it.
 *
 * The single-row id is a constant here, never a literal 1 in a handler.
 */

/**
 * The page every caller resolves to when none is named.
 *
 * 🔴 **The default page, not an identity** (#152). It was `DOC_ID` and it meant "the
 * only row there can be" — `documents` carried `CHECK (id = 1)` and the constant was a
 * statement of that fact. `pages` has no such CHECK, so this is now a *default*: the page
 * a request that names none is talking about, and the page every row written before
 * migration 0004 was backfilled onto.
 *
 * 🔴 It is never the answer to "the page you asked for does not exist." Falling back
 * here on an unrecognised page would put a whole-document write somewhere the caller did
 * not name, against the only copy of that document. Missing is `null` and the route says
 * so; see `readPage`.
 */
export const DEFAULT_PAGE_ID = 1;

/** What migration 0004 named page 1 — the label tier 1 has always displayed. */
export const DEFAULT_PAGE_NAME = "today";

export type PageRow = {
  id: number;
  name: string;
  body: string;
  version: number;
  updated_at: string;
};

/**
 * Who wrote. Derived from the principal at the route, never taken from the request
 * body — bearer *is* agent and session *is* pwa, so a caller-supplied value carries
 * no information the server does not already have, and does carry the risk of
 * unvalidated text landing in the only copy of the document.
 *
 * `system` is the migration's seed row. Nothing at runtime writes it.
 */
export type WriteSource = "pwa" | "agent" | "system";

export type WriteResult =
  /** Applied. `version` is the new one. */
  | { status: "applied"; version: number; updated_at: string }
  /** Body was already identical. Nothing bumped, nothing written. */
  | { status: "noop"; version: number; updated_at: string }
  /** `base_version` did not match. Carries the current state so the caller can re-apply. */
  | { status: "conflict"; current: PageRow };

/**
 * Read one page's live state, or `null` if there is no such page.
 *
 * 🔴 **Two different kinds of absence, and conflating them is a data-loss path.**
 *
 * A missing *default* page reads as an empty body at version 0 rather than throwing —
 * defensive in case the migration was skipped, and because empty is a valid state that
 * must never be confused with a failed read (spec §14.5). `PUT` with `base_version: 0`
 * then initialises it. That behaviour is unchanged and is scoped to the default page.
 *
 * A missing *named* page is `null`, and the caller must say so rather than serving the
 * default. A request for page 7 answered with page 1's body would let a caller write a
 * whole document over a page it never named — and whole-document write is the only write
 * this product has.
 */
export async function readPage(env: Env, pageId: number): Promise<PageRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, body, version, updated_at FROM pages WHERE id = ?",
  )
    .bind(pageId)
    .first<PageRow>();

  if (row) return row;
  if (pageId !== DEFAULT_PAGE_ID) return null;

  return {
    id: DEFAULT_PAGE_ID,
    name: DEFAULT_PAGE_NAME,
    body: "",
    version: 0,
    updated_at: new Date(0).toISOString(),
  };
}

/**
 * The default page, which always answers.
 *
 * A named seam for the one case `readPage` cannot return `null` for, so callers that
 * genuinely mean "the page a request without a page is about" do not each carry a
 * non-null assertion. The invariant is spec §14.5's — empty is a valid state, so a
 * missing row reads as an empty body at version 0 rather than as an absence.
 */
export async function readDefaultPage(env: Env): Promise<PageRow> {
  const page = await readPage(env, DEFAULT_PAGE_ID);
  if (!page) throw new Error("readPage returned null for the default page");
  return page;
}

/**
 * Every page, oldest first — the switcher's list (#154) and nothing more.
 *
 * 🔴 No counts, no last-modified, no body. §7's rule for the selector is that
 * *anything else you add is a column, and a column is a file manager*, and the cheapest
 * place to hold that line is the query that cannot return the data in the first place.
 */
export async function listPages(env: Env): Promise<Array<{ id: number; name: string }>> {
  const { results } = await env.DB.prepare("SELECT id, name FROM pages ORDER BY id").all<{
    id: number;
    name: string;
  }>();
  return results;
}

/**
 * Compare-and-swap the document.
 *
 * 🔴 The write is a single conditional UPDATE carrying `version = ?` in its WHERE
 * clause, not a read followed by a write. The read above it decides what to *report*;
 * the UPDATE decides what happens. Two saves landing together therefore cannot both
 * apply — the loser matches zero rows and is reported as a conflict, which is the
 * one catastrophic data-loss path in this project (spec §6).
 *
 * Never merges, never overwrites. A conflict returns the current state so the caller
 * re-applies its intent rather than making a second round trip (spec §5, §10).
 */
export async function writePage(
  env: Env,
  input: { pageId: number; body: string; baseVersion: number; source: WriteSource },
  now: Date = new Date(),
): Promise<WriteResult> {
  const current = await readPage(env, input.pageId);
  // Only reachable if the caller skipped `readPage` — every route resolves the page
  // first and 404s. Treated as a conflict rather than throwing: the caller's `base_version`
  // describes a page that is not there, which is exactly what a conflict means.
  if (!current) {
    return { status: "conflict", current: { id: input.pageId, name: "", body: "", version: 0, updated_at: new Date(0).toISOString() } };
  }
  const updatedAt = now.toISOString();

  // spec §14.5: base_version 0 means "I believe nothing is here yet." It is honoured
  // against a missing row and against an empty one — an empty body has nothing to
  // lose, and first boot has to be reachable from a client that has never read.
  // Any other stale base_version is a conflict.
  const initialising = input.baseVersion === 0 && current.body === "";
  if (!initialising && input.baseVersion !== current.version) {
    return { status: "conflict", current };
  }

  if (input.body === current.body) {
    return { status: "noop", version: current.version, updated_at: current.updated_at };
  }

  // No row at all. Only reachable if the migration was skipped — the seed in
  // 0001_init.sql means the normal path never comes here (spec §14.5).
  if (current.version === 0) {
    await env.DB.prepare(
      `INSERT INTO pages (id, name, body, version, updated_at, source, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(input.pageId, DEFAULT_PAGE_NAME, input.body, updatedAt, input.source, updatedAt)
      .run();
    await mirrorToDocuments(env, input.pageId, { body: input.body, version: 1, updatedAt, source: input.source });
    await recordRevision(
      env,
      { pageId: input.pageId, body: input.body, version: 1, source: input.source },
      now,
    );
    return { status: "applied", version: 1, updated_at: updatedAt };
  }

  const result = await env.DB.prepare(
    `UPDATE pages
        SET body = ?, version = version + 1, updated_at = ?, source = ?
      WHERE id = ? AND version = ?`,
  )
    .bind(input.body, updatedAt, input.source, input.pageId, current.version)
    .run();

  // Zero rows means another write landed between the read and the UPDATE. Re-read
  // rather than reporting the state we no longer believe.
  if (result.meta.changes !== 1) {
    const reread = await readPage(env, input.pageId);
    return { status: "conflict", current: reread ?? current };
  }

  const version = current.version + 1;
  await mirrorToDocuments(env, input.pageId, { body: input.body, version, updatedAt, source: input.source });

  // 🔴 After the CAS, never batched with it. D1's batch is a transaction but not a
  // conditional one — the revision write would apply even when the UPDATE matched
  // zero rows, recording a state that never existed. Sequencing costs a torn write
  // if D1 fails between the two, and that failure surfaces as a 500 rather than a
  // silent gap: the document is saved, one intermediate snapshot is missing, and
  // coalescing already discards intermediates by design.
  await recordRevision(
    env,
    { pageId: input.pageId, body: input.body, version, source: input.source },
    now,
  );

  return { status: "applied", version, updated_at: updatedAt };
}

/**
 * Keep `documents` in step with the default page, for as long as it exists (#155).
 *
 * 🔴 **This is the rollback, and it is the whole reason expand and contract are two
 * releases.** `pages` is the authority from here on; `documents` is a shadow that lets the
 * previous Worker keep serving a current document if this one has to be rolled back.
 * Without it, expand and contract collapse into a single irreversible step against the
 * only copy of the document.
 *
 * Only the default page, because `documents` still carries `CHECK (id = 1)` and there is
 * nowhere to put a second page. That is exactly the constraint the split exists to escape,
 * and it means a rollback after #154 ships would lose pages 2..n — which is why #155
 * drops this before the switcher can create them.
 *
 * Never the authority on whether a write applied. It runs after the CAS has already
 * decided, and a mirror that silently matched zero rows must not turn an applied write
 * into a conflict.
 */
async function mirrorToDocuments(
  env: Env,
  pageId: number,
  state: { body: string; version: number; updatedAt: string; source: WriteSource },
): Promise<void> {
  if (pageId !== DEFAULT_PAGE_ID) return;

  await env.DB.prepare(
    `UPDATE documents SET body = ?, version = ?, updated_at = ?, source = ? WHERE id = ?`,
  )
    .bind(state.body, state.version, state.updatedAt, state.source, DEFAULT_PAGE_ID)
    .run();
}

/**
 * How close two saves must be for the second to fold into the first (spec §3).
 *
 * Ten minutes bounds the log at roughly six revisions an hour of continuous editing,
 * which is what makes full snapshots affordable for a document of a few KB.
 */
export const COALESCE_WINDOW_MS = 10 * 60 * 1000;

type RevisionRow = { id: number; created_at: string };

/**
 * The newest revision, if it is still open to being coalesced into.
 *
 * 🔴 `is_sealed = 0` is in the WHERE clause, not checked by the caller. A sealed
 * revision marks a state that must survive — clear-completed seals before it sweeps
 * (spec §14.2) — and a lookup that returned one and trusted the caller to notice
 * would let the next save inside the window silently overwrite the pre-clear
 * document.
 */
async function newestUnsealedRevision(env: Env, pageId: number): Promise<RevisionRow | null> {
  // 🔴 `page_id` is in the WHERE clause, and it has to be (#152). Without it the newest
  // unsealed revision is the newest on *any* page — so a save to the shopping list inside
  // the ten-minute window would be coalesced into today's revision, overwriting one page's
  // history with another page's body. Invisible while there is one page and silent
  // corruption the moment there are two.
  return await env.DB.prepare(
    `SELECT id, created_at FROM revisions
      WHERE page_id = ? AND is_sealed = 0
      ORDER BY id DESC LIMIT 1`,
  )
    .bind(pageId)
    .first<RevisionRow>();
}

/**
 * Record a document state in the log, coalescing per spec §3.
 *
 * Full snapshots, never diffs. The document is a few KB and a diff is cheap to
 * compute at read time, whereas a chain of diffs is only as good as its weakest link
 * — one bad entry and everything after it is unrecoverable.
 *
 * The snapshot is of the state *after* the write: `version` is the version this body
 * became. So the log answers "what did the document look like at version N", and the
 * live row in `documents` is simply the newest such state.
 */
async function recordRevision(
  env: Env,
  input: { pageId: number; body: string; version: number; source: WriteSource; eventType?: string },
  now: Date,
): Promise<void> {
  const newest = await newestUnsealedRevision(env, input.pageId);
  const withinWindow =
    newest !== null && now.getTime() - new Date(newest.created_at).getTime() < COALESCE_WINDOW_MS;

  if (newest && withinWindow) {
    // Updated in place, `created_at` untouched — the window is measured from when the
    // burst started, not from the last keystroke. Otherwise continuous typing would
    // hold one revision open forever and the log would never gain an entry.
    await env.DB.prepare("UPDATE revisions SET body = ?, version = ?, source = ? WHERE id = ?")
      .bind(input.body, input.version, input.source, newest.id)
      .run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO revisions (page_id, body, version, created_at, is_sealed, source, event_type)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      input.pageId,
      input.body,
      input.version,
      now.toISOString(),
      input.source,
      input.eventType ?? null,
    )
    .run();
}

export type ClearResult =
  | {
      status: "cleared";
      version: number;
      /** Rows written to `cleared_items` — the *finished* lines, and only those. */
      cleared_count: number;
      /** Rows removed from the page. Larger than `cleared_count` on a wipe-all. */
      wiped_count: number;
    }
  | { status: "conflict"; current: PageRow };

/**
 * Which lines a wipe takes (spec §5, #58).
 *
 * `completed` sweeps the checked items. `all` empties the page — what a grocery list
 * actually needs, where you do not tick the last three things, you are simply done.
 */
export type WipeScope = "completed" | "all";

/**
 * The `revisions.event_type` each scope records.
 *
 * 🔴 Two values, not one, and the distinction is load-bearing rather than cosmetic. A
 * wipe-all removes lines that were never finished, and those are deliberately **not**
 * written to `cleared_items` — see below. Without a distinct event, history would show
 * an entry claiming two items were cleared and then, on the next ordinary save, four
 * more lines disappearing with nothing to explain them.
 *
 * The column is free text with no CHECK, so this needs no migration.
 */
const EVENT_TYPE: Record<WipeScope, string> = {
  completed: "clear_completed",
  all: "wipe_all",
};

/**
 * Wipe the page, keeping an explicit record of what went (spec §5).
 *
 * The caller decides *what* goes — it owns the parser — and hands over the rewritten
 * body plus the lines to record. This function owns only the order, which is the part
 * that has to be right.
 *
 * 🔴 **`clearedLines` is the done-record, not the undo buffer.** It holds the lines
 * that were *finished*, which for a wipe-all is only the checked ones. `cleared_items`
 * is what `/api/history` reports as authoritative for "what did I get done", precisely
 * because a line-set diff cannot be trusted for that question — writing unfinished
 * lines into it would poison the one record that has to stay clean.
 *
 * Recovery does not need it. Statement 2 below snapshots the whole pre-wipe document
 * and seals it, so every removed line is derivable from that snapshot and the body this
 * writes, for both scopes ([#59](https://github.com/danjamk/knag/issues/59)).
 *
 * 🔴 **Every statement carries the same `version = ?` guard, and the CAS is last.**
 *
 * D1's `batch()` is a transaction, but not a *conditional* one: a mismatched
 * `base_version` would otherwise still seal a revision and write `cleared_items` rows
 * for a sweep that never happened — leaving the authoritative done-record claiming
 * items were finished while they sit unchecked in the document. Worse than not
 * clearing at all, and invisible until someone reads their history.
 *
 * Guarding every statement on the *pre-wipe* version fixes it. Statements 1–3 do not
 * touch `documents.version`, so all four observe the same value, and no other writer
 * can interleave inside a transaction. Either the version matches at batch start and
 * all four apply, or it does not and none do.
 */
export async function wipe(
  env: Env,
  input: {
    pageId: number;
    baseVersion: number;
    body: string;
    clearedLines: string[];
    source: WriteSource;
    scope: WipeScope;
    /** Rows removed from the page. Equals `clearedLines.length` for `completed`. */
    wipedCount: number;
  },
  now: Date = new Date(),
): Promise<ClearResult> {
  const current = await readPage(env, input.pageId);
  if (!current) {
    return {
      status: "conflict",
      current: { id: input.pageId, name: "", body: "", version: 0, updated_at: new Date(0).toISOString() },
    };
  }
  if (input.baseVersion !== current.version) {
    return { status: "conflict", current };
  }

  const timestamp = now.toISOString();
  const version = current.version;
  const pageId = input.pageId;

  // Repeated on every statement below, and it reads *this* page's version rather than
  // the single row `documents` used to guarantee.
  const guard = "(SELECT version FROM pages WHERE id = ?) = ?";

  // 🔴 The newest revision **on this page**, and every statement below that reaches for
  // one goes through here (#152). It was `(SELECT max(id) FROM revisions)` — the newest
  // revision on *any* page.
  //
  // Statement 1 is where that is a real bug: it runs **before** statement 2 inserts, so
  // the global max is whatever page was written to last. Wiping the shopping list would
  // seal today's revision — freezing today's history against a wipe it had nothing to do
  // with, and nothing in the wipe's own result would look wrong. Negative-verified.
  //
  // Statement 3 was correct *by construction* rather than by intent: statement 2 has
  // already inserted by then and always holds the highest id, so the global max happened
  // to be the right row. That is a property of the batch's ordering, not of the query,
  // and one reordering away from being wrong. Scoped here so it is right on purpose.
  const newestOnPage = "(SELECT max(id) FROM revisions WHERE page_id = ?)";

  const statements = [
    // 1. Seal the newest revision, so the pre-clear state cannot be swallowed by the
    //    ten-minute coalescing window (spec §3).
    env.DB.prepare(
      `UPDATE revisions SET is_sealed = 1
        WHERE id = ${newestOnPage} AND ${guard}`,
    ).bind(pageId, pageId, version),

    // 2. Record the pre-clear document. Sealed as well: it is the newest revision
    //    after this batch, and an unsealed one would be coalesced into by the next
    //    save inside the window — overwriting the very state this row exists to keep.
    env.DB.prepare(
      `INSERT INTO revisions (page_id, body, version, created_at, is_sealed, source, event_type)
       SELECT ?, ?, ?, ?, 1, ?, ? WHERE ${guard}`,
    ).bind(
      pageId,
      current.body,
      version,
      timestamp,
      input.source,
      EVENT_TYPE[input.scope],
      pageId,
      version,
    ),

    // 3. The authoritative done-record, so "what did I finish" is a lookup rather
    //    than a diff.
    //
    //    🔴 `max(id)`, not `last_insert_rowid()`. The obvious version does not work:
    //    inside a D1 batch, `last_insert_rowid()` does not observe an INSERT from an
    //    earlier statement in the same batch — it returned the id of a revision from
    //    a previous request, silently pointing every cleared item at the wrong row.
    //    Rows from statement 2 *are* visible to a subquery, so `max(id)` resolves
    //    correctly. Caught by asserting the foreign key rather than the row count.
    //
    //    If statement 2 was guarded out, so is this, and `max(id)` is never consulted.
    ...input.clearedLines.map((line) =>
      env.DB.prepare(
        `INSERT INTO cleared_items (revision_id, line_text, cleared_at)
         SELECT ${newestOnPage}, ?, ? WHERE ${guard}`,
      ).bind(pageId, line, timestamp, pageId, version),
    ),

    // 4. The page itself, because this is the statement that moves the version the
    //    other three are guarding on. **The authority on whether the wipe happened.**
    env.DB.prepare(
      `UPDATE pages SET body = ?, version = version + 1, updated_at = ?, source = ?
        WHERE id = ? AND version = ?`,
    ).bind(input.body, timestamp, input.source, pageId, version),

    // 5. The rollback shadow, after the CAS and never the authority — see
    //    `mirrorToDocuments`. Guarded on the *old* version so a `documents` that has
    //    drifted is left alone rather than overwritten from a page it no longer tracks.
    env.DB.prepare(
      `UPDATE documents SET body = ?, version = ?, updated_at = ?, source = ?
        WHERE id = ? AND ? = ${DEFAULT_PAGE_ID}`,
    ).bind(input.body, version + 1, timestamp, input.source, DEFAULT_PAGE_ID, pageId),
  ];

  // 🔴 Statement 4 decides, by index rather than by position from the end. It was
  // `results[results.length - 1]` and that was correct while the CAS was last; adding the
  // shadow write after it would have made a mirror that matched zero rows report the
  // whole wipe as a conflict.
  const casIndex = statements.length - 2;
  const results = await env.DB.batch(statements);

  if (results[casIndex]?.meta.changes !== 1) {
    const reread = await readPage(env, pageId);
    return { status: "conflict", current: reread ?? current };
  }

  return {
    status: "cleared",
    version: version + 1,
    cleared_count: input.clearedLines.length,
    wiped_count: input.wipedCount,
  };
}

/**
 * The most revisions one history request will return.
 *
 * The log gains roughly six entries an hour of continuous editing, so a year of heavy
 * use is inside this. The cap exists so a caller asking for "everything" cannot make
 * the Worker assemble an unbounded response against the only copy of the document —
 * and when it bites, `truncated` says so rather than the answer quietly being partial.
 */
export const MAX_HISTORY_REVISIONS = 500;

/**
 * A revision row. Defined here rather than in `history.ts` because it is a row shape,
 * and because the dependency has to point one way: `history.ts` reads from the store,
 * so the store cannot import from it.
 */
export type RevisionRecord = {
  id: number;
  body: string;
  version: number;
  created_at: string;
  source: string;
  event_type: string | null;
};

/** A swept line. The authoritative record of what was finished (spec §5). */
export type ClearedRecord = {
  id: number;
  revision_id: number;
  line_text: string;
  cleared_at: string;
};

const REVISION_COLUMNS = "id, body, version, created_at, source, event_type";

export type RevisionPage = {
  /** In range and under the cap, **oldest first** — the order the diff chain needs. */
  revisions: RevisionRecord[];
  /**
   * The revision immediately before `revisions[0]`, when the cap dropped it. Becomes
   * the diff floor in place of `revisionBefore`, so a truncated page still diffs its
   * first entry against something real.
   */
  precedingDropped: RevisionRecord | null;
  truncated: boolean;
};

/**
 * When the record starts — the timestamp of the oldest revision, or null on an empty log.
 *
 * 🔴 **Read behind authentication, never from `/health`.** How far back your record goes
 * is a fact about your document, not about the deployment, and `/health` is the one route
 * that answers to anybody. Putting it there would hand a stranger the age of the page for
 * the cost of a `curl`, which is a small leak and still a leak.
 *
 * Cheap by construction: `min()` over an indexed integer primary key's table with no
 * predicate is a single row read, and it is fetched when the sheet opens rather than on
 * the poll that runs every few seconds.
 *
 * 🔴 **Deliberately not per-page** (#152). Every other query in this file gained a page
 * and this one did not, so the omission is a decision rather than a miss. It answers "how
 * long have I been using knag", which is a fact about the record as a whole and belongs on
 * the build line with the version and the environment. Per-page it would answer "how old
 * is this page", which is a different question nobody has asked and which would make the
 * build line change when you switch pages.
 */
export async function oldestRevisionAt(env: Env): Promise<string | null> {
  // 🔴 Ordered by `id`, **not** `min(created_at)`, and the difference is not stylistic.
  // `created_at` is text, and the two writers in this file disagree on precision: every
  // revision is `toISOString()` at milliseconds, while migration 0002's baseline row is
  // `strftime` at seconds. `2026-08-20T12:50:22.068Z` sorts *before* `2026-08-20T12:50:22Z`
  // because `.` is below `Z` — so inside a shared second `min()` returns the **newer**
  // row. `revisionsInRange` documents the same trap; this walked into it and a test
  // caught it.
  //
  // `id` is a monotonic integer primary key, so the oldest revision is simply the first
  // one, and this is an index read rather than a scan.
  const row = await env.DB.prepare(
    "SELECT created_at AS at FROM revisions ORDER BY id ASC LIMIT 1",
  ).first<{ at: string | null }>();
  return row?.at ?? null;
}

/**
 * Revisions in `[since, until)`, capped.
 *
 * 🔴 Half-open, and that is what makes adjacent days tile. `until` resolved from a bare
 * date is the *next* local midnight (see `resolveBoundary`), so an inclusive upper
 * bound would put midnight's revision in both Tuesday and Wednesday.
 *
 * 🔴 **The query runs newest-first and the result is reversed.** Ascending with a LIMIT
 * would drop the recent end of a long range, which is the end anyone asking about their
 * history wants. Descending drops the far end instead, and hands back the row just
 * past the cap for free — which is exactly the diff floor the kept window needs.
 *
 * The comparison is lexicographic on ISO8601 text, which is a correct chronological
 * sort only because every writer here uses `toISOString()`. The one exception is the
 * baseline row, which migration 0002 copies from the document seeded by 0001 with
 * `strftime` at second precision. `2026-08-15T13:00:00Z` sorts *after*
 * `2026-08-15T13:00:00.000Z` — `Z` is above `.` — so the two disagree inside a single
 * second and nowhere else. Every day boundary is further away than that, and `id` is
 * the tiebreak.
 */
export async function revisionsInRange(
  env: Env,
  range: { pageId: number; since: Date; until: Date; limit?: number },
): Promise<RevisionPage> {
  const limit = range.limit ?? MAX_HISTORY_REVISIONS;

  const { results } = await env.DB.prepare(
    `SELECT ${REVISION_COLUMNS} FROM revisions
      WHERE page_id = ? AND created_at >= ? AND created_at < ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(
      range.pageId,
      range.since.toISOString(),
      range.until.toISOString(),
      // One past the cap, so "exactly at the limit" is distinguishable from "more than
      // the limit" without a second count query — and so the extra row can serve as the
      // floor when it turns out there was one.
      limit + 1,
    )
    .all<RevisionRecord>();

  const truncated = results.length > limit;
  const kept = truncated ? results.slice(0, limit) : results;

  return {
    revisions: kept.reverse(),
    precedingDropped: truncated ? (results[limit] ?? null) : null,
    truncated,
  };
}

/**
 * The newest revision strictly before `since` — the diff floor, never returned to the
 * caller.
 *
 * Without it the first entry in any range has nothing to diff against and reports the
 * entire document as `appeared`. `null` is a correct answer and means the range reaches
 * back past the start of the log.
 */
export async function revisionBefore(
  env: Env,
  pageId: number,
  since: Date,
): Promise<RevisionRecord | null> {
  return await env.DB.prepare(
    `SELECT ${REVISION_COLUMNS} FROM revisions
      WHERE page_id = ? AND created_at < ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
  )
    .bind(pageId, since.toISOString())
    .first<RevisionRecord>();
}

/**
 * Swept lines in `[since, until)`, oldest first — the authoritative done-record.
 *
 * Not capped. A clear writes one row per checked item and they are short; the thing
 * worth protecting is the revision bodies, which are whole documents.
 */
export async function clearedItemsInRange(
  env: Env,
  range: { pageId: number; since: Date; until: Date },
): Promise<ClearedRecord[]> {
  // 🔴 Joined to `revisions` rather than given a `page_id` of its own (#152). A
  // cleared item's page **is** its revision's page, and a second copy of that fact is a
  // second thing to keep in step — they would disagree the first time a revision moved,
  // and the done-record is the authoritative answer to "what did I finish".
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.revision_id, c.line_text, c.cleared_at FROM cleared_items c
       JOIN revisions r ON r.id = c.revision_id
      WHERE r.page_id = ? AND c.cleared_at >= ? AND c.cleared_at < ?
      ORDER BY c.cleared_at, c.id`,
  )
    .bind(range.pageId, range.since.toISOString(), range.until.toISOString())
    .all<ClearedRecord>();

  return results;
}

/**
 * Create a page (#154 uses it; #152 needs it to have something to test scoping against).
 *
 * 🔴 No ceiling enforced here, on purpose. The cap of nine is a **design** decision
 * about what the switcher may show (§7) — a tripwire, not a limit — and putting it in the
 * store would make it a data constraint that the agent and a future import would also hit,
 * which is not what it is for. The control that creates pages enforces it.
 *
 * A duplicate name is rejected by `idx_pages_name`, case-insensitively, and surfaces as a
 * thrown D1 error rather than a silently renamed page.
 */
export async function createPage(
  env: Env,
  input: { name: string; body?: string; source: WriteSource },
  now: Date = new Date(),
): Promise<{ id: number; name: string }> {
  const timestamp = now.toISOString();
  const body = input.body ?? "";

  const row = await env.DB.prepare(
    `INSERT INTO pages (name, body, version, updated_at, source, template, created_at)
     VALUES (?, ?, 1, ?, ?, NULL, ?)
     RETURNING id, name`,
  )
    .bind(input.name, body, timestamp, input.source, timestamp)
    .first<{ id: number; name: string }>();

  if (!row) throw new Error("page insert returned no row");

  // The page starts with a revision, like the seeded one does (migration 0002), so its
  // history has a floor to diff the first edit against rather than reporting the whole
  // body as `appeared`.
  await recordRevision(env, { pageId: row.id, body, version: 1, source: input.source }, now);

  return row;
}

/** Drop sessions that have already expired. Called on login; no cron trigger. */
export async function sweepExpiredSessions(env: Env, now: Date = new Date()): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()).run();
}

/**
 * Record a new session. Only the SHA-256 of the cookie value is ever stored, so a
 * dump of this table does not let the holder log in as anyone.
 */
export async function createSession(
  env: Env,
  input: { tokenHash: string; publicId: string; deviceLabel: string | null; expiresAt: Date },
  now: Date = new Date(),
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, public_id, created_at, expires_at, device_label) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      input.tokenHash,
      input.publicId,
      now.toISOString(),
      input.expiresAt.toISOString(),
      input.deviceLabel,
    )
    .run();
}

/**
 * Look up a live session by token hash.
 *
 * 🔴 `expires_at > ?` is in the WHERE clause, not checked by the caller. The sweep
 * runs on login only, so an expired row can sit here for a year — a lookup that
 * returned it and trusted a caller to compare dates would be a session that never
 * actually expires.
 */
export async function findLiveSession(
  env: Env,
  tokenHash: string,
  now: Date = new Date(),
): Promise<{ device_label: string | null; public_id: string | null } | null> {
  return await env.DB.prepare(
    "SELECT device_label, public_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(tokenHash, now.toISOString())
    .first<{ device_label: string | null; public_id: string | null }>();
}

/** One row of the device list. Never carries `token_hash` — see the migration. */
export type SessionRecord = {
  public_id: string;
  device_label: string | null;
  created_at: string;
  expires_at: string;
};

/**
 * Every session that is still live, newest first.
 *
 * 🔴 `token_hash` is not selected, and that is not an oversight to be tidied up later:
 * it is the SHA-256 of a live credential and this result reaches a response body.
 * Expired rows are excluded here for the same reason `findLiveSession` does it — the
 * sweep only runs on login, so a dead row can sit in the table for a year and listing
 * it would offer the operator a device to revoke that already cannot log in.
 */
export async function listLiveSessions(
  env: Env,
  now: Date = new Date(),
): Promise<SessionRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT public_id, device_label, created_at, expires_at
       FROM sessions
      WHERE expires_at > ?
      ORDER BY created_at DESC`,
  )
    .bind(now.toISOString())
    .all<SessionRecord>();

  return results;
}

/**
 * Revoke one session by its surrogate id. Returns whether a row actually went.
 *
 * The boolean is what lets the handler answer 404 for an id that never existed rather
 * than 204 for everything, which would make a typo indistinguishable from a revocation.
 */
export async function deleteSession(env: Env, publicId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM sessions WHERE public_id = ?")
    .bind(publicId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Revoke the session holding this token hash — log out, as opposed to revoking some
 * other device. Takes the hash rather than the public id because the caller is proving
 * possession of the credential, not naming a row.
 */
export async function deleteSessionByToken(env: Env, tokenHash: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Sign out everywhere. `keepPublicId` spares the caller's own row so the operator is
 * not logged out by the act of securing everything else — the panic button is for a
 * lost phone, and being ejected from the device you are holding while using it is a
 * worse experience than the problem.
 *
 * Pass null to take everything, which is what a bearer caller gets: it holds no
 * session, so there is nothing of its own to spare.
 */
export async function deleteOtherSessions(
  env: Env,
  keepPublicId: string | null,
): Promise<number> {
  const result = keepPublicId
    ? await env.DB.prepare("DELETE FROM sessions WHERE public_id IS NOT ?").bind(keepPublicId).run()
    : await env.DB.prepare("DELETE FROM sessions").run();

  return result.meta.changes ?? 0;
}
