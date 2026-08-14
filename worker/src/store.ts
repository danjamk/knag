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

/** Drop sessions that have already expired. Called on login; no cron trigger. */
export async function sweepExpiredSessions(env: Env, now: Date = new Date()): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()).run();
}
