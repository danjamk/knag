import type { Env } from "./env.js";

/**
 * Every D1 statement in knag lives in this file.
 *
 * 🔴 No SQL anywhere else in the tree. Not in a route handler, not in the MCP tools,
 * not "just this one query." That rule is the whole reason a multi-user schema would
 * be a one-file change instead of a rewrite (spec §17), and it is worth exactly as
 * much as the last exception made to it.
 *
 * 🔴 **Every read and write names an owner** (#230, ADR-008 §5). A query here that reaches
 * for a page without its owner is the two-page bug of #152 again — it will not show up
 * until there are two people, and then it shows up as one person reading another's page.
 * Missing and not-yours are the same answer: `null`, and a 404 from the route. Never a
 * fall back to some other page.
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

/**
 * 🔴 Since #230 nothing at runtime resolves a default *by this number*. A request that
 * names no page is about its caller's default page — `defaultPageFor(env, ownerId)`, the
 * owner's oldest live page — and this constant survives only as the name of migration
 * 0004's seed row, which the test suite and the migration comments refer to. Reaching for
 * it in a handler would hand one person's page to another.
 */

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
 * Read one of `ownerId`'s pages, or `null` if there is no such page — including when the
 * page exists and belongs to somebody else.
 *
 * 🔴 **Missing and not-yours are the same `null`, and the caller must say so rather than
 * serve a default.** A request for page 7 answered with page 1's body would let a caller
 * write a whole document over a page it never named — and whole-document write is the
 * only write this product has. Nothing here distinguishes the two absences, on purpose:
 * a 404 that differed for "exists, not yours" would confirm the page exists.
 *
 * The synthetic empty-at-version-0 answer this used to give for a missing default row is
 * gone with #230 — with a default page per owner there is no id to synthesise. Spec
 * §14.5's invariant — a fresh database is readable, and empty is a valid state — is kept
 * by `defaultPageFor`, which creates the page rather than pretending one is there.
 */
export async function readPage(env: Env, ownerId: number, pageId: number): Promise<PageRow | null> {
  return await env.DB.prepare(
    `SELECT id, name, body, version, updated_at FROM pages
      WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
  )
    .bind(pageId, ownerId)
    .first<PageRow>();
}

/**
 * The page a request that names none is about: `ownerId`'s **oldest live page** (#230).
 *
 * 🔴 Oldest by `id`, not first by `position`. Reordering the switcher (#195) is a thing a
 * person does with a thumb, and it must not silently move where an agent's whole-document
 * write lands when it omits `page`, nor which page cannot be deleted. Creation order is
 * stable; for the operator it is migration 0004's row 1, exactly as before.
 *
 * 🔴 **Always answers, by construction rather than by pretence.** Spec §14.5 says a fresh
 * database is readable and empty is a valid state. `readPage` used to satisfy that with a
 * synthetic version-0 row for the default id; with a default per owner there is no id to
 * synthesise, so an owner with no live page gets one created — empty, named `today`,
 * `source: system` like the seed — and the read proceeds. The only ways to arrive here
 * with nothing are a skipped migration and a user created outside `createUser`, and both
 * are better healed than 500'd against the only copy of a document.
 */
export async function defaultPageFor(env: Env, ownerId: number): Promise<PageRow> {
  const page = await oldestLivePage(env, ownerId);
  if (page) return page;

  const created = await createPage(env, { ownerId, name: DEFAULT_PAGE_NAME, source: "system" });
  const healed = await readPage(env, ownerId, created.id);
  if (!healed) throw new Error("defaultPageFor created a page it cannot read back");
  return healed;
}

async function oldestLivePage(env: Env, ownerId: number): Promise<PageRow | null> {
  return await env.DB.prepare(
    `SELECT id, name, body, version, updated_at FROM pages
      WHERE owner_id = ? AND deleted_at IS NULL
      ORDER BY id ASC LIMIT 1`,
  )
    .bind(ownerId)
    .first<PageRow>();
}

/**
 * Find a page by name, case-insensitively (#153).
 *
 * 🔴 **Names, because a human types them into a prompt.** The MCP `page` parameter is
 * the one identifier in this product that gets written down by a person — into a project
 * instruction, a saved prompt, a CLAUDE.md — and `page: "shopping"` survives being read
 * back by a human where `page: 3` does not. The browser holds ids because it never has to
 * explain them to anybody.
 *
 * The cost is that a rename breaks whatever was written down. That is accepted and it is
 * why the caller must fail loudly with the list rather than fall back to the default —
 * a rename that silently redirects an agent's whole-document write is the one outcome
 * worse than an error.
 *
 * Case-insensitive against `idx_pages_name`, which is `COLLATE NOCASE` and unique — so
 * this can never have two answers.
 */
export async function findPageByName(
  env: Env,
  ownerId: number,
  name: string,
): Promise<PageRow | null> {
  return await env.DB.prepare(
    `SELECT id, name, body, version, updated_at FROM pages
      WHERE owner_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL`,
  )
    .bind(ownerId, name)
    .first<PageRow>();
}

/**
 * Every one of `ownerId`'s pages, in their order — the switcher's list (#154) and nothing more.
 *
 * 🔴 No counts, no last-modified, no body. §7's rule for the selector is that
 * *anything else you add is a column, and a column is a file manager*, and the cheapest
 * place to hold that line is the query that cannot return the data in the first place.
 *
 * The order is `position` (#195), backfilled to `id` by migration 0008 so an untouched
 * list is still creation order. `position` itself is not returned: the order is the
 * array's, and a number the client could display would be a column.
 */
export async function listPages(
  env: Env,
  ownerId: number,
): Promise<Array<{ id: number; name: string; has_template: boolean }>> {
  const { results } = await env.DB.prepare(
    // `template IS NOT NULL` rather than the template itself: whether a page has one is a
    // fact the switcher's last row needs, and the body of it is not something any list
    // should be carrying around.
    `SELECT id, name, template IS NOT NULL AS has_template FROM pages
      WHERE owner_id = ? AND deleted_at IS NULL ORDER BY COALESCE(position, id), id`,
  )
    .bind(ownerId)
    .all<{ id: number; name: string; has_template: number }>();

  return results.map((row) => ({ id: row.id, name: row.name, has_template: row.has_template === 1 }));
}

/**
 * Put the live pages in the given order (#195). `ids` must be exactly the set of live
 * page ids — every one, once, and nothing retired or unknown — or nothing changes and
 * this returns `false`. A partial list would leave the rest with stale positions that
 * happen to sort somewhere, and "happen to" is not an order.
 *
 * One statement per page inside a batch, so a reorder is atomic and a device polling
 * `listPages` mid-way never sees half of one.
 */
export async function reorderPages(env: Env, ownerId: number, ids: number[]): Promise<boolean> {
  const live = (await listPages(env, ownerId)).map((page) => page.id);
  const wanted = [...ids];
  if (wanted.length !== live.length) return false;
  if (new Set(wanted).size !== wanted.length) return false;
  const liveSet = new Set(live);
  if (!wanted.every((id) => liveSet.has(id))) return false;

  await env.DB.batch(
    wanted.map((id, index) =>
      env.DB.prepare(
        "UPDATE pages SET position = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
      ).bind(index + 1, id, ownerId),
    ),
  );
  return true;
}

/**
 * Rename a page. The name is the agent's handle (#153), so this is not cosmetic.
 *
 * Returns `false` when the name is taken — by the partial unique index, which only sees
 * live pages, so a retired page's name is free to reuse.
 */
export async function renamePage(
  env: Env,
  ownerId: number,
  pageId: number,
  name: string,
): Promise<boolean> {
  try {
    const result = await env.DB.prepare(
      "UPDATE pages SET name = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
    )
      .bind(name, pageId, ownerId)
      .run();
    return result.meta.changes === 1;
  } catch {
    // A unique-index violation. Reported as "taken" rather than thrown: the caller is a
    // route that has to say so in a sentence, and there is exactly one reason this fails.
    return false;
  }
}

/**
 * Retire a page. **Nothing is deleted.**
 *
 * 🔴 Its revisions and cleared items stay exactly where they are, which is what makes
 * "delete does not confirm" an honest thing to say (principle 4, ADR-003 §5). Recovering
 * one is clearing a single column, and there is no code path here that removes a row.
 *
 * 🔴 The owner's default page cannot be retired, and that is structural rather than a
 * policy. It is what a request naming no page resolves to and what every MCP tool writes
 * to when none is named (`defaultPageFor`). Retiring it would silently move both onto the
 * next-oldest page — a whole-document write target changing under an agent that named
 * nothing — and "there is always a page, and it is the same one" is a cheaper invariant
 * to keep than that is to explain.
 */
export type DeleteResult = "deleted" | "not_found" | "refused_default";

export async function deletePage(
  env: Env,
  ownerId: number,
  pageId: number,
  now: Date = new Date(),
): Promise<DeleteResult> {
  const oldest = await oldestLivePage(env, ownerId);
  if (oldest && pageId === oldest.id) return "refused_default";

  const result = await env.DB.prepare(
    "UPDATE pages SET deleted_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
  )
    .bind(now.toISOString(), pageId, ownerId)
    .run();

  return result.meta.changes === 1 ? "deleted" : "not_found";
}

/**
 * Save this page's current body as its template, or clear it.
 *
 * 🔴 **A template is a page's reset state** (#165). Edit the page to the baseline you
 * want, save it, and wiping that page returns it there instead of emptying it. It shipped
 * in 1.1.0 as a seed for *new* pages, which is a description of one consequence mistaken
 * for the feature — and it made the wipe less useful on exactly the pages that need it
 * most. A grocery list with twenty standing items is the case: you add to it, you shop,
 * you wipe, and the twenty come back unchecked.
 *
 * 🔴 **It is still just a saved body.** No template language, no variables, no
 * placeholders — every step past "the bytes you had" is a feature nobody asked for that
 * the page cannot render anyway (ADR-004). The save half of this was always right; what
 * was wrong is what read it.
 */
export async function saveTemplate(
  env: Env,
  ownerId: number,
  pageId: number,
  keep: boolean,
): Promise<boolean> {
  const result = await env.DB.prepare(
    keep
      ? "UPDATE pages SET template = body WHERE id = ? AND owner_id = ? AND deleted_at IS NULL"
      : "UPDATE pages SET template = NULL WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
  )
    .bind(pageId, ownerId)
    .run();
  return result.meta.changes === 1;
}

/** A page's template, or null. Read on the whole-page wipe path. */
export async function pageTemplate(
  env: Env,
  ownerId: number,
  pageId: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT template FROM pages WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
  )
    .bind(pageId, ownerId)
    .first<{ template: string | null }>();
  return row?.template ?? null;
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
  input: { ownerId: number; pageId: number; body: string; baseVersion: number; source: WriteSource },
  now: Date = new Date(),
): Promise<WriteResult> {
  const current = await readPage(env, input.ownerId, input.pageId);
  // Only reachable if the caller skipped `readPage` — every route resolves the page
  // first and 404s. Treated as a conflict rather than throwing: the caller's `base_version`
  // describes a page that is not there (or not theirs), which is exactly what a conflict
  // means, and it carries an empty body so nothing of anyone's leaks in the answer.
  if (!current) {
    return { status: "conflict", current: { id: input.pageId, name: "", body: "", version: 0, updated_at: new Date(0).toISOString() } };
  }
  const updatedAt = now.toISOString();

  // spec §14.5: base_version 0 means "I believe nothing is here yet." It is honoured
  // against an empty page — an empty body has nothing to lose, and first boot has to be
  // reachable from a client that has never read. Any other stale base_version is a
  // conflict. (The row itself always exists by now: `defaultPageFor` creates a missing
  // one rather than `readPage` pretending, so the version-0 INSERT this used to carry
  // is gone with #230.)
  const initialising = input.baseVersion === 0 && current.body === "";
  if (!initialising && input.baseVersion !== current.version) {
    return { status: "conflict", current };
  }

  if (input.body === current.body) {
    return { status: "noop", version: current.version, updated_at: current.updated_at };
  }

  const result = await env.DB.prepare(
    `UPDATE pages
        SET body = ?, version = version + 1, updated_at = ?, source = ?
      WHERE id = ? AND owner_id = ? AND version = ?`,
  )
    .bind(input.body, updatedAt, input.source, input.pageId, input.ownerId, current.version)
    .run();

  // Zero rows means another write landed between the read and the UPDATE. Re-read
  // rather than reporting the state we no longer believe.
  if (result.meta.changes !== 1) {
    const reread = await readPage(env, input.ownerId, input.pageId);
    return { status: "conflict", current: reread ?? current };
  }

  const version = current.version + 1;

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
 * page's own row is simply the newest such state.
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
 * written to `cleared_items` — see below. Without a distinct event, history would show an
 * entry claiming two items were cleared and then four more lines disappearing with nothing
 * to explain them.
 *
 * Since #91 those four lines land on the result row this batch writes rather than on
 * whatever save came next, so they are at least adjacent to their cause — but they still
 * need the event to say *why*, which is what this distinction is for.
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
 * 🔴 **Every statement carries the same `version = ?` guard, and the CAS is found by
 * identity rather than by position** — see `casIndex`.
 *
 * D1's `batch()` is a transaction, but not a *conditional* one: a mismatched
 * `base_version` would otherwise still seal a revision and write `cleared_items` rows
 * for a sweep that never happened — leaving the authoritative done-record claiming
 * items were finished while they sit unchecked in the document. Worse than not
 * clearing at all, and invisible until someone reads their history.
 *
 * Guarding every statement on the *pre-wipe* version fixes it. Statements 1–3 do not
 * touch `pages.version`, so all four observe the same value, and no other writer
 * can interleave inside a transaction. Either the version matches at batch start and
 * all four apply, or it does not and none do.
 */
export async function wipe(
  env: Env,
  input: {
    ownerId: number;
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
  const current = await readPage(env, input.ownerId, input.pageId);
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

  // 🔴 A reset is its own event, not a `wipe_all` the reader has to infer (#91).
  //
  // The obvious inference does not work: a surface cannot tell a reset from an emptying by
  // looking at the diff, because a template line that was **already on the page** is not
  // something the wipe *added* — it never left — so `appeared` is empty on exactly the
  // grocery case the feature exists for. The server is the only thing that knows a
  // template was laid back down, so it says so here.
  //
  // `event_type` is free text with no CHECK, so a third value needs no migration.
  const eventType =
    input.scope === "all" && input.body !== "" ? "reset" : EVENT_TYPE[input.scope];

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

  // Hoisted out of the array below so the batch's result can be found by identity rather
  // than by arithmetic on the array's length. See `casIndex`.
  const cas = env.DB.prepare(
    `UPDATE pages SET body = ?, version = version + 1, updated_at = ?, source = ?
      WHERE id = ? AND owner_id = ? AND version = ?`,
  ).bind(input.body, timestamp, input.source, pageId, input.ownerId, version);

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
      eventType,
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
    cas,

    // 5. The state the wipe *left*, recorded now rather than whenever the next save
    //    happens to arrive (#91).
    //
    //    🔴 **Without this the log cannot say what a wipe took.** Statement 2 snapshots
    //    the *pre*-wipe body, which is byte-identical to the revision before it, so a wipe
    //    entry's diff is empty by construction. The post-wipe state used to enter the log
    //    only on the next ordinary save — which meant the wiped lines surfaced as
    //    `disappeared` on an unrelated later revision, minutes or hours away and attributed
    //    to whatever edit happened to come next.
    //
    //    For the everyday sweep that was survivable, because `cleared_items` is the
    //    authoritative done-record and carries the ticked lines exactly. For a whole-page
    //    wipe it was not: `cleared_items` deliberately holds finished lines only, so a note
    //    or an undone task taken by a page wipe appeared **nowhere** in `/api/history`. It
    //    existed solely inside statement 2's body, and that endpoint returns diffs and
    //    cleared rows, never bodies.
    //
    //    Sealed, for statement 2's reason: an unsealed row here would be coalesced into by
    //    the next save inside the ten-minute window, overwriting the state it exists to
    //    record. `event_type` is NULL — the *event* is statement 2; this is its result.
    //
    //    🔴 Guarded on the **post-CAS** version rather than the pre-wipe one, unlike every
    //    statement above. By the time this runs statement 4 has already bumped it, so the
    //    guard the others use would refuse every time. Reading `version + 1` makes this
    //    land exactly when the CAS applied and never when it did not.
    env.DB.prepare(
      `INSERT INTO revisions (page_id, body, version, created_at, is_sealed, source, event_type)
       SELECT ?, ?, ?, ?, 1, ?, NULL WHERE (SELECT version FROM pages WHERE id = ?) = ?`,
    ).bind(pageId, input.body, version + 1, timestamp, input.source, pageId, version + 1),
  ];

  // 🔴 Which statement decided is looked up, never counted.
  //
  // It was `results[results.length - 1]`, which was correct only for as long as the CAS
  // happened to be last. #152 added a rollback shadow after it, and a mirror matching zero
  // rows would have reported the whole wipe as a conflict; the fix was `length - 2`, which
  // is the same bug carrying a different constant. #155 removed that shadow, so counting
  // from the end would give the right answer again today — which is exactly why it is
  // still not counted. `indexOf` cannot disagree with which statement is the CAS.
  const casIndex = statements.indexOf(cas);
  const results = await env.DB.batch(statements);

  if (results[casIndex]?.meta.changes !== 1) {
    const reread = await readPage(env, input.ownerId, pageId);
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
 *
 * **Per owner, though** (#230): "how long have *I* been using knag" is a fact about one
 * person's record. Retired pages count — their history was kept on purpose (0005).
 */
export async function oldestRevisionAt(env: Env, ownerId: number): Promise<string | null> {
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
    `SELECT r.created_at AS at FROM revisions r
       JOIN pages p ON p.id = r.page_id
      WHERE p.owner_id = ?
      ORDER BY r.id ASC LIMIT 1`,
  )
    .bind(ownerId)
    .first<{ at: string | null }>();
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
 * A duplicate name is rejected by `idx_pages_name` — per owner and case-insensitive since
 * #230, so two people can each have a `today` — and surfaces as a thrown D1 error rather
 * than a silently renamed page.
 */
export async function createPage(
  env: Env,
  input: { ownerId: number; name: string; body?: string; source: WriteSource },
  now: Date = new Date(),
): Promise<{ id: number; name: string }> {
  const timestamp = now.toISOString();
  const body = input.body ?? "";

  // Appended: one past the highest position among the owner's live pages (#195). Retired
  // pages keep theirs, so the subquery excludes them or a long-dead page could leave a gap
  // the switcher would never show but a reorder would have to reason about.
  const row = await env.DB.prepare(
    `INSERT INTO pages (owner_id, name, body, version, updated_at, source, template, created_at, position)
     VALUES (?, ?, ?, 1, ?, ?, NULL, ?,
       (SELECT COALESCE(MAX(COALESCE(position, id)), 0) + 1 FROM pages
         WHERE owner_id = ? AND deleted_at IS NULL))
     RETURNING id, name`,
  )
    .bind(input.ownerId, input.name, body, timestamp, input.source, timestamp, input.ownerId)
    .first<{ id: number; name: string }>();

  if (!row) throw new Error("page insert returned no row");

  // The page starts with a revision, like the seeded one does (migration 0002), so its
  // history has a floor to diff the first edit against rather than reporting the whole
  // body as `appeared`.
  await recordRevision(env, { pageId: row.id, body, version: 1, source: input.source }, now);

  return row;
}

// ── Users ────────────────────────────────────────────────────────────────────

/**
 * Who a principal is (#230, ADR-008 §1). `operator` is the one person who hosts this
 * deployment; everyone else is a `member`. There is no third role and no per-role
 * permission table — the operator gate (#232) is one comparison.
 */
export type UserRole = "operator" | "member";

export type UserRow = {
  id: number;
  email: string | null;
  role: UserRole;
  created_at: string;
  revoked_at: string | null;
};

const USER_COLUMNS = "id, email, role, created_at, revoked_at";

/**
 * The operator — resolved by role, never by number.
 *
 * `null` only when migration 0009 has not run, which the deploy order makes impossible
 * in any environment `make migrate` reaches before `make deploy`. `authenticate()` treats
 * it as "nobody", which surfaces a skipped migration as a 401 rather than as a Worker
 * that quietly assumes row 1.
 */
export async function findOperator(env: Env): Promise<UserRow | null> {
  return await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users WHERE role = 'operator' AND revoked_at IS NULL LIMIT 1`,
  ).first<UserRow>();
}

/**
 * A live user by id, or `null` — and a revoked user is `null` here too. This is the
 * lookup behind an OAuth access token (ADR-008 §6): the grant carries the person's id,
 * and revoking the person (#232) has to stop every token they were ever issued without
 * touching the provider's store. One predicate here does that by construction.
 */
export async function findUser(env: Env, id: number): Promise<UserRow | null> {
  return await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND revoked_at IS NULL`,
  )
    .bind(id)
    .first<UserRow>();
}

/**
 * Create a user and their first page. The invite (#232) calls this; the suite calls it to
 * be the second person, which is the first time any owner predicate in this file can be
 * wrong.
 *
 * The page comes with the person rather than on first request, so "there is always a
 * page" (`defaultPageFor`) holds from the first read and the healing path there stays the
 * exception it is documented as. No cap enforced here, for `createPage`'s reason: the
 * invite count is a tripwire in the route, not a data constraint.
 */
export async function createUser(
  env: Env,
  input: { email: string; role?: UserRole },
  now: Date = new Date(),
): Promise<UserRow> {
  const row = await env.DB.prepare(
    `INSERT INTO users (email, role, created_at) VALUES (?, ?, ?)
     RETURNING ${USER_COLUMNS}`,
  )
    .bind(input.email, input.role ?? "member", now.toISOString())
    .first<UserRow>();
  if (!row) throw new Error("user insert returned no row");

  await createPage(env, { ownerId: row.id, name: DEFAULT_PAGE_NAME, source: "system" }, now);
  return row;
}

// ── The operator's view of everyone (#232, ADR-008 §8, §11, §12) ────────────

/**
 * How many people this deployment will hold, the operator included. A tripwire in the
 * code, the way `MAX_PAGES` is: spec §14.4's arithmetic puts ~4k requests a day per
 * person against a 100k/day free tier, and a number the operator has to remember is a
 * hope. Workers Paid would move this to roughly eighty by changing one constant.
 */
export const MAX_USERS = 25;

/** People who count against the cap: live ones. A revoked person costs no requests. */
export async function countLiveUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE revoked_at IS NULL").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

/**
 * A user by id, revoked or not. The admin view is the one reader that needs to see a
 * revoked person — to delete them — so this is the one lookup that does not filter on
 * `revoked_at`. Nothing on a request path resolves a principal through it.
 */
export async function findUserAny(env: Env, id: number): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

/**
 * Change email (ADR-008 §4) — the operator's only recovery lever. The person lost the
 * address, not the account: identity is `users.id`, so their pages stay put. Returns
 * `false` when the address is already someone's; the unique NOCASE index is what
 * refuses it and the caller turns that into a 409.
 */
export async function updateUserEmail(env: Env, id: number, email: string): Promise<boolean> {
  try {
    const result = await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, id).run();
    return (result.meta.changes ?? 0) > 0;
  } catch (error) {
    if (String(error).includes("UNIQUE")) return false;
    throw error;
  }
}

/**
 * Revoke a person: stamp `revoked_at`, and take every session and pending login code
 * with it. The stamp is what does the work — `findLiveSession` and `findUser` both
 * carry `revoked_at IS NULL`, so a session row that somehow survived would still not
 * resolve, and an OAuth token they hold dies at `findUser` on its next request. The
 * deletes are hygiene, not the mechanism.
 *
 * Their pages stay: revoke is "out", not "gone". Delete is below.
 */
export async function revokeUser(env: Env, id: number, now: Date = new Date()): Promise<boolean> {
  const [stamped] = await env.DB.batch([
    env.DB.prepare("UPDATE users SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(
      now.toISOString(),
      id,
    ),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(id),
  ]);
  return (stamped?.meta.changes ?? 0) > 0;
}

/**
 * Delete a person and every row they own — "deletion on request" (ADR-008 §12). Hard,
 * in one batch: cleared items through their revisions, revisions through their pages,
 * the pages, sessions, login codes, settings, and the row itself. Order matters only for
 * the subqueries, which is why the leaves go first.
 *
 * 🔴 Never the operator. The route refuses it before this is reached, and this refuses
 * it again by predicate: a deployment with no operator has nobody who can log in.
 */
export async function deleteUserHard(env: Env, id: number): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM cleared_items WHERE revision_id IN
         (SELECT r.id FROM revisions r JOIN pages p ON p.id = r.page_id WHERE p.owner_id = ?)`,
    ).bind(id),
    env.DB.prepare("DELETE FROM revisions WHERE page_id IN (SELECT id FROM pages WHERE owner_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM pages WHERE owner_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ? AND role <> 'operator'").bind(id),
  ]);
  return (results[results.length - 1]?.meta.changes ?? 0) > 0;
}

/** One row of the admin table. Counts, dates and an address — never page content. */
export type UserStats = {
  id: number;
  email: string | null;
  role: UserRole;
  created_at: string;
  revoked_at: string | null;
  /** The newest of their devices' `last_seen_at`, falling back to its `created_at`. */
  last_seen_at: string | null;
  devices: number;
  pages: number;
  /**
   * `revisions` rows in the window by a person or their agent — coalescing makes a row
   * a sitting. `system` rows (a new page's baseline) are nobody's and are not counted.
   */
  sittings: number;
  /** Of those, the agent's. */
  agent_sittings: number;
  wipes: number;
  items_done: number;
};

/**
 * Everyone, with what the free-tier question needs (ADR-008 §11): how many devices
 * poll, how much gets written, and by whom. Every number is scoped to the person's own
 * pages through `owner_id`; nothing here reads a `body`.
 *
 * 🔴 The window is `since`, computed by the caller, so a test can pin it and so the
 * route says "30 days" in one place. Expired sessions are excluded the way
 * `listLiveSessions` excludes them: the sweep runs on login only.
 */
export async function listUserStats(env: Env, since: Date, now: Date = new Date()): Promise<UserStats[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.created_at, u.revoked_at,
            (SELECT max(coalesce(s.last_seen_at, s.created_at)) FROM sessions s
              WHERE s.user_id = u.id) AS last_seen_at,
            (SELECT count(*) FROM sessions s
              WHERE s.user_id = u.id AND s.expires_at > ?1) AS devices,
            (SELECT count(*) FROM pages p
              WHERE p.owner_id = u.id AND p.deleted_at IS NULL) AS pages,
            (SELECT count(*) FROM revisions r JOIN pages p ON p.id = r.page_id
              WHERE p.owner_id = u.id AND r.created_at >= ?2 AND r.source <> 'system') AS sittings,
            (SELECT count(*) FROM revisions r JOIN pages p ON p.id = r.page_id
              WHERE p.owner_id = u.id AND r.created_at >= ?2 AND r.source = 'agent') AS agent_sittings,
            (SELECT count(*) FROM revisions r JOIN pages p ON p.id = r.page_id
              WHERE p.owner_id = u.id AND r.created_at >= ?2
                AND r.event_type = 'clear_completed') AS wipes,
            (SELECT count(*) FROM cleared_items c
               JOIN revisions r ON r.id = c.revision_id JOIN pages p ON p.id = r.page_id
              WHERE p.owner_id = u.id AND c.cleared_at >= ?2) AS items_done
       FROM users u
      ORDER BY u.role = 'operator' DESC, u.created_at ASC, u.id ASC`,
  )
    .bind(now.toISOString(), since.toISOString())
    .all<UserStats>();
  return results;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

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
  input: {
    userId: number;
    tokenHash: string;
    publicId: string;
    deviceLabel: string | null;
    expiresAt: Date;
  },
  now: Date = new Date(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions (user_id, token_hash, public_id, created_at, expires_at, device_label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.userId,
      input.tokenHash,
      input.publicId,
      now.toISOString(),
      input.expiresAt.toISOString(),
      input.deviceLabel,
    )
    .run();
}

/**
 * Look up a live session by token hash, and the live user it belongs to.
 *
 * 🔴 `expires_at > ?` is in the WHERE clause, not checked by the caller. The sweep
 * runs on login only, so an expired row can sit here for a year — a lookup that
 * returned it and trusted a caller to compare dates would be a session that never
 * actually expires.
 *
 * 🔴 Joined to `users` with `revoked_at IS NULL` for the same reason (#230). Revoking a
 * person (#232) deletes their sessions, but a lookup that did not also check the person
 * would make that deletion the *only* thing standing between a revoked user and the page
 * — one missed row and they are back. Here it is a predicate, not a procedure.
 */
export async function findLiveSession(
  env: Env,
  tokenHash: string,
  now: Date = new Date(),
): Promise<LiveSession | null> {
  return await env.DB.prepare(
    `SELECT s.device_label, s.public_id, s.user_id, s.last_seen_at, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.revoked_at IS NULL`,
  )
    .bind(tokenHash, now.toISOString())
    .first<LiveSession>();
}

export type LiveSession = {
  device_label: string | null;
  public_id: string | null;
  user_id: number;
  last_seen_at: string | null;
  role: UserRole;
};

/**
 * Record that a device was heard from (#232). The caller decides *whether* — `auth.ts`
 * calls this only when the row is more than an hour stale, so a 4-second poll costs
 * one write an hour rather than one a request. Keyed by token hash because that is
 * what the request proved possession of.
 */
export async function touchSession(env: Env, tokenHash: string, now: Date = new Date()): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
    .bind(now.toISOString(), tokenHash)
    .run();
}

/** One row of the device list. Never carries `token_hash` — see the migration. */
export type SessionRecord = {
  public_id: string;
  device_label: string | null;
  created_at: string;
  expires_at: string;
};

/**
 * Every one of `userId`'s sessions that is still live, newest first.
 *
 * 🔴 `token_hash` is not selected, and that is not an oversight to be tidied up later:
 * it is the SHA-256 of a live credential and this result reaches a response body.
 * Expired rows are excluded here for the same reason `findLiveSession` does it — the
 * sweep only runs on login, so a dead row can sit in the table for a year and listing
 * it would offer the operator a device to revoke that already cannot log in.
 */
export async function listLiveSessions(
  env: Env,
  userId: number,
  now: Date = new Date(),
): Promise<SessionRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT public_id, device_label, created_at, expires_at
       FROM sessions
      WHERE user_id = ? AND expires_at > ?
      ORDER BY created_at DESC`,
  )
    .bind(userId, now.toISOString())
    .all<SessionRecord>();

  return results;
}

/**
 * Revoke one of `userId`'s sessions by its surrogate id. Returns whether a row went.
 *
 * The boolean is what lets the handler answer 404 for an id that never existed rather
 * than 204 for everything, which would make a typo indistinguishable from a revocation.
 * Somebody else's id matches nothing here, and so gets the same 404 — a device list is
 * not a thing one person can prune for another (#230).
 */
export async function deleteSession(env: Env, userId: number, publicId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM sessions WHERE public_id = ? AND user_id = ?")
    .bind(publicId, userId)
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
 * Sign out everywhere — every one of `userId`'s sessions. `keepPublicId` spares the
 * caller's own row so the operator is not logged out by the act of securing everything
 * else — the panic button is for a lost phone, and being ejected from the device you are
 * holding while using it is a worse experience than the problem.
 *
 * Pass null to take everything, which is what a bearer caller gets: it holds no
 * session, so there is nothing of its own to spare.
 */
export async function deleteOtherSessions(
  env: Env,
  userId: number,
  keepPublicId: string | null,
): Promise<number> {
  const result = keepPublicId
    ? await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND public_id IS NOT ?")
        .bind(userId, keepPublicId)
        .run()
    : await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();

  return result.meta.changes ?? 0;
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The one setting the server holds (#190): free text a person writes, appended to the
 * MCP server's `instructions` under a fixed heading for *their* agent sessions. Global
 * to the account rather than per page — a page's purpose is one line inside it — and
 * capped, because it rides in every agent conversation's system prompt.
 *
 * 🔴 Never exposed as a tool. An agent editing its own instructions is not a feature.
 */
export const AGENT_INSTRUCTIONS = { key: "agent_instructions", max: 4000 } as const;

/**
 * 🔴 Reads `user_settings`, never `settings` (#234, expand: read new). Migration 0010
 * backfilled the operator's row, and the old table is written to below only so a rollback
 * to the previous Worker would still find the operator's current text.
 */
export async function readSetting(env: Env, userId: number, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?")
    .bind(userId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Upsert. An empty value is stored as empty rather than deleted — absent and blank read
 * the same.
 *
 * 🔴 **Writes `user_settings` only** — release two of #234's three. 1.7.0 wrote both
 * tables so a rollback would still read current text; this release stops writing the
 * legacy `settings` table and carries no migration, which is exactly what makes it look
 * skippable and exactly why it is not (ADR-002 §3): the Worker live during the contract
 * migration must be one that no longer writes the column being dropped. The release
 * after this one drops `settings`.
 */
export async function writeSetting(
  env: Env,
  userId: number,
  key: string,
  value: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(userId, key, value, new Date().toISOString())
    .run();
}

// ── Users, by address ────────────────────────────────────────────────────────

/** A live user by address, case-insensitively (`idx_users_email` is NOCASE). */
export async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = ? COLLATE NOCASE AND revoked_at IS NULL`,
  )
    .bind(email)
    .first<UserRow>();
}

/**
 * The same lookup without the `revoked_at` filter — for the invite (#232), which has to
 * refuse an address that is here in either state. Nothing on a request path resolves a
 * principal through it.
 */
export async function findUserByEmailAny(env: Env, email: string): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? COLLATE NOCASE`)
    .bind(email)
    .first<UserRow>();
}

/**
 * Give the operator their address, once (#231).
 *
 * Migration 0009 seeded the operator with `email NULL` because a migration cannot read a
 * secret. The first login request that names `KNAG_OPERATOR_EMAIL` fills it in here —
 * and only if it is still empty, so this is a one-time claim rather than a rename. `null`
 * means somebody already did, or there is no operator row.
 */
export async function claimOperatorEmail(env: Env, email: string): Promise<UserRow | null> {
  return await env.DB.prepare(
    `UPDATE users SET email = ?
      WHERE role = 'operator' AND email IS NULL AND revoked_at IS NULL
      RETURNING ${USER_COLUMNS}`,
  )
    .bind(email)
    .first<UserRow>();
}

// ── Login codes ──────────────────────────────────────────────────────────────

/** A login-code row as the verifier needs it. `code_hash` never reaches a response. */
export type LoginCodeRow = {
  id: number;
  user_id: number;
  code_hash: string;
  device_label: string | null;
  next: string | null;
  expires_at: string;
  attempts: number;
};

const LOGIN_CODE_COLUMNS = "id, user_id, code_hash, device_label, next, expires_at, attempts";

export async function createLoginCode(
  env: Env,
  input: {
    userId: number;
    linkHash: string;
    codeHash: string;
    requestHash: string;
    deviceLabel: string | null;
    next: string | null;
    ttlMs: number;
  },
  now: Date = new Date(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO login_codes
       (user_id, link_hash, code_hash, request_hash, device_label, next, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.userId,
      input.linkHash,
      input.codeHash,
      input.requestHash,
      input.deviceLabel,
      input.next,
      now.toISOString(),
      new Date(now.getTime() + input.ttlMs).toISOString(),
    )
    .run();
}

/**
 * How many mails this person has been sent lately — the per-address throttle's input.
 *
 * 🔴 The throttle is per *person*, not per caller. `/api/login` is a send-mail-to-this-
 * address endpoint and anyone can type an address; what has to be bounded is how often
 * one inbox can be made to ring, and the caller's identity is not something a login
 * endpoint has. Unknown addresses create no row and so cost nothing to count.
 */
export async function recentLoginCodes(
  env: Env,
  userId: number,
  now: Date = new Date(),
): Promise<{ lastMinute: number; lastHour: number }> {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS hour, SUM(created_at > ?) AS minute
       FROM login_codes WHERE user_id = ? AND created_at > ?`,
  )
    .bind(minuteAgo, userId, hourAgo)
    .first<{ hour: number; minute: number | null }>();
  return { lastMinute: row?.minute ?? 0, lastHour: row?.hour ?? 0 };
}

/**
 * The live row behind a request cookie, or `null`.
 *
 * 🔴 `expires_at > ?` and `consumed_at IS NULL` are in the WHERE clause, for
 * `findLiveSession`'s reason: a lookup that returned a spent or expired row and trusted
 * the caller to notice is a code that never expires.
 */
export async function findLoginCodeByRequest(
  env: Env,
  requestHash: string,
  now: Date = new Date(),
): Promise<LoginCodeRow | null> {
  return await env.DB.prepare(
    `SELECT ${LOGIN_CODE_COLUMNS} FROM login_codes
      WHERE request_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(requestHash, now.toISOString())
    .first<LoginCodeRow>();
}

/** The live row behind a link token, or `null`. Same predicates as by request. */
export async function findLoginCodeByLink(
  env: Env,
  linkHash: string,
  now: Date = new Date(),
): Promise<LoginCodeRow | null> {
  return await env.DB.prepare(
    `SELECT ${LOGIN_CODE_COLUMNS} FROM login_codes
      WHERE link_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(linkHash, now.toISOString())
    .first<LoginCodeRow>();
}

/**
 * Spend a row. Returns whether *this* call did — the `consumed_at IS NULL` guard makes
 * two consumers racing (the link tapped twice, a code posted twice) resolve to one
 * winner, which is what "works once" means.
 */
export async function consumeLoginCode(
  env: Env,
  id: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
  )
    .bind(now.toISOString(), id)
    .run();
  return result.meta.changes === 1;
}

/** One more wrong code against this row. Returns the new count. */
export async function recordLoginAttempt(env: Env, id: number): Promise<number> {
  const row = await env.DB.prepare(
    "UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? RETURNING attempts",
  )
    .bind(id)
    .first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

/** Drop rows that can never be used again. Called on login request; no cron trigger. */
export async function sweepExpiredLoginCodes(env: Env, now: Date = new Date()): Promise<void> {
  await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ? OR consumed_at IS NOT NULL")
    .bind(new Date(now.getTime() - 86_400_000).toISOString())
    .run();
}
