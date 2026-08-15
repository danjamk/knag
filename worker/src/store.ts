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

  return { status: "applied", version: current.version + 1, updated_at: updatedAt };
}

/** Drop sessions that have already expired. Called on login; no cron trigger. */
export async function sweepExpiredSessions(env: Env, now: Date = new Date()): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()).run();
}
