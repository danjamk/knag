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

/** The one and only document row. `documents` has CHECK (id = 1). */
export const DOC_ID = 1;

export type DocumentRow = {
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
export type DocumentSource = "pwa" | "agent" | "system";

export type WriteResult =
  /** Applied. `version` is the new one. */
  | { status: "applied"; version: number; updated_at: string }
  /** Body was already identical. Nothing bumped, nothing written. */
  | { status: "noop"; version: number; updated_at: string }
  /** `base_version` did not match. Carries the current state so the caller can re-apply. */
  | { status: "conflict"; current: DocumentRow };

/**
 * Read the live document.
 *
 * A missing row reads as an empty body at version 0 rather than throwing — defensive
 * in case the migration was skipped, and because empty is a valid state that must
 * never be confused with a failed read (spec §14.5). `PUT` with `base_version: 0`
 * then initialises it.
 */
export async function readDocument(env: Env): Promise<DocumentRow> {
  const row = await env.DB.prepare(
    "SELECT body, version, updated_at FROM documents WHERE id = ?",
  )
    .bind(DOC_ID)
    .first<DocumentRow>();

  return row ?? { body: "", version: 0, updated_at: new Date(0).toISOString() };
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
export async function writeDocument(
  env: Env,
  input: { body: string; baseVersion: number; source: DocumentSource },
  now: Date = new Date(),
): Promise<WriteResult> {
  const current = await readDocument(env);
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
      "INSERT INTO documents (id, body, version, updated_at, source) VALUES (?, ?, 1, ?, ?)",
    )
      .bind(DOC_ID, input.body, updatedAt, input.source)
      .run();
    await recordRevision(env, { body: input.body, version: 1, source: input.source }, now);
    return { status: "applied", version: 1, updated_at: updatedAt };
  }

  const result = await env.DB.prepare(
    `UPDATE documents
        SET body = ?, version = version + 1, updated_at = ?, source = ?
      WHERE id = ? AND version = ?`,
  )
    .bind(input.body, updatedAt, input.source, DOC_ID, current.version)
    .run();

  // Zero rows means another write landed between the read and the UPDATE. Re-read
  // rather than reporting the state we no longer believe.
  if (result.meta.changes !== 1) {
    return { status: "conflict", current: await readDocument(env) };
  }

  const version = current.version + 1;

  // 🔴 After the CAS, never batched with it. D1's batch is a transaction but not a
  // conditional one — the revision write would apply even when the UPDATE matched
  // zero rows, recording a state that never existed. Sequencing costs a torn write
  // if D1 fails between the two, and that failure surfaces as a 500 rather than a
  // silent gap: the document is saved, one intermediate snapshot is missing, and
  // coalescing already discards intermediates by design.
  await recordRevision(env, { body: input.body, version, source: input.source }, now);

  return { status: "applied", version, updated_at: updatedAt };
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
async function newestUnsealedRevision(env: Env): Promise<RevisionRow | null> {
  return await env.DB.prepare(
    "SELECT id, created_at FROM revisions WHERE is_sealed = 0 ORDER BY id DESC LIMIT 1",
  ).first<RevisionRow>();
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
  input: { body: string; version: number; source: DocumentSource; eventType?: string },
  now: Date,
): Promise<void> {
  const newest = await newestUnsealedRevision(env);
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
    `INSERT INTO revisions (body, version, created_at, is_sealed, source, event_type)
     VALUES (?, ?, ?, 0, ?, ?)`,
  )
    .bind(input.body, input.version, now.toISOString(), input.source, input.eventType ?? null)
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
  | { status: "conflict"; current: DocumentRow };

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
    baseVersion: number;
    body: string;
    clearedLines: string[];
    source: DocumentSource;
    scope: WipeScope;
    /** Rows removed from the page. Equals `clearedLines.length` for `completed`. */
    wipedCount: number;
  },
  now: Date = new Date(),
): Promise<ClearResult> {
  const current = await readDocument(env);
  if (input.baseVersion !== current.version) {
    return { status: "conflict", current };
  }

  const timestamp = now.toISOString();
  const version = current.version;

  // Repeated on every statement below. `documents` has CHECK (id = 1), so this reads
  // the single row.
  const guard = "(SELECT version FROM documents WHERE id = ?) = ?";

  const statements = [
    // 1. Seal the newest revision, so the pre-clear state cannot be swallowed by the
    //    ten-minute coalescing window (spec §3).
    env.DB.prepare(
      `UPDATE revisions SET is_sealed = 1
        WHERE id = (SELECT max(id) FROM revisions) AND ${guard}`,
    ).bind(DOC_ID, version),

    // 2. Record the pre-clear document. Sealed as well: it is the newest revision
    //    after this batch, and an unsealed one would be coalesced into by the next
    //    save inside the window — overwriting the very state this row exists to keep.
    env.DB.prepare(
      `INSERT INTO revisions (body, version, created_at, is_sealed, source, event_type)
       SELECT ?, ?, ?, 1, ?, ? WHERE ${guard}`,
    ).bind(current.body, version, timestamp, input.source, EVENT_TYPE[input.scope], DOC_ID, version),

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
         SELECT (SELECT max(id) FROM revisions), ?, ? WHERE ${guard}`,
      ).bind(line, timestamp, DOC_ID, version),
    ),

    // 4. The document itself, last, because this is the statement that moves the
    //    version the other three are guarding on.
    env.DB.prepare(
      `UPDATE documents SET body = ?, version = version + 1, updated_at = ?, source = ?
        WHERE id = ? AND version = ?`,
    ).bind(input.body, timestamp, input.source, DOC_ID, version),
  ];

  const results = await env.DB.batch(statements);

  // The CAS is the authority on whether anything happened at all.
  if (results[results.length - 1]?.meta.changes !== 1) {
    return { status: "conflict", current: await readDocument(env) };
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
  range: { since: Date; until: Date; limit?: number },
): Promise<RevisionPage> {
  const limit = range.limit ?? MAX_HISTORY_REVISIONS;

  const { results } = await env.DB.prepare(
    `SELECT ${REVISION_COLUMNS} FROM revisions
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(
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
export async function revisionBefore(env: Env, since: Date): Promise<RevisionRecord | null> {
  return await env.DB.prepare(
    `SELECT ${REVISION_COLUMNS} FROM revisions
      WHERE created_at < ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
  )
    .bind(since.toISOString())
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
  range: { since: Date; until: Date },
): Promise<ClearedRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, revision_id, line_text, cleared_at FROM cleared_items
      WHERE cleared_at >= ? AND cleared_at < ?
      ORDER BY cleared_at, id`,
  )
    .bind(range.since.toISOString(), range.until.toISOString())
    .all<ClearedRecord>();

  return results;
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
  input: { tokenHash: string; deviceLabel: string | null; expiresAt: Date },
  now: Date = new Date(),
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, created_at, expires_at, device_label) VALUES (?, ?, ?, ?)",
  )
    .bind(input.tokenHash, now.toISOString(), input.expiresAt.toISOString(), input.deviceLabel)
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
): Promise<{ device_label: string | null } | null> {
  return await env.DB.prepare(
    "SELECT device_label FROM sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(tokenHash, now.toISOString())
    .first<{ device_label: string | null }>();
}
