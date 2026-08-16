import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticate, unauthorized } from "./auth.js";
import type { Env } from "./env.js";
import { isCompleted, parse, serialize } from "./blocks.js";
import { loadHistory, reportingZone, resolveRange } from "./history.js";
import { clearCompleted, readDocument, writeDocument } from "./store.js";

/**
 * The MCP server — the agent half of the product (spec §10, §14.6).
 *
 * Not a feature bolted onto a notes app. knag is one plain-text page precisely so that
 * an agent can read all of it and rewrite all of it without an object graph in the way,
 * and this file is where that pays out. It is also, for now, the **only** way to reach
 * history: there is no history browser and the brand system argues there should not be
 * one, so these four tools are the interface, not a convenience over it.
 *
 * Built against `claude-shared/docs/standards/mcp.md`. knag sits at the simple end:
 * bearer rather than OAuth 2.1 (one operator, no third-party client, no consent screen)
 * and no Resources. The rules that apply in full are §2 request isolation, §3 tool
 * design, §4 annotations, §5 server instructions, §6 structured output and §9 security.
 */

/**
 * Server-level `instructions` — the rules that cut across every tool, stated once
 * (mcp.md §5), plus the voice.
 *
 * The voice paragraph is not decoration. An agent writing to the page is a *second
 * author*, and the difference between "wiped 6" and "Successfully cleared 6 completed
 * items!" is the difference between the product's voice and a generic one. This is the
 * cheapest possible way to make every agent conversation on-brand, and it costs one
 * string.
 *
 * 🔴 The security-critical rules also stay **named in the tools that enforce them**.
 * De-duplicating them entirely is how a guardrail gets silently dropped by someone
 * trimming a description (mcp.md §5).
 */
const INSTRUCTIONS = [
  "knag is one plain-text page. You can read all of it and write all of it.",
  "",
  "Four rules cut across every tool:",
  "",
  "1. WHOLE-PAGE WRITE IS THE ONLY WRITE. Byte-preserve every line you are not",
  "   explicitly changing. Indentation, blank lines, trailing whitespace and line",
  "   endings all matter and all survive a round trip. Surgical edits only — never",
  "   reformat, retitle, sort, or tidy anything you were not asked to touch.",
  "",
  "2. ALWAYS READ IMMEDIATELY BEFORE WRITING. Never write from a body you are carrying",
  "   from earlier in the conversation. Three devices sync to this page and any of them",
  "   may have saved since you last looked.",
  "",
  "3. ON A CONFLICT, RE-READ AND RE-APPLY THE INTENT. knag_write and knag_wipe return",
  "   the current version and the current body when they conflict. Use them. Retrying",
  "   with the stale body is the one action here that destroys work.",
  "",
  "4. REPORT THE DIFF after every write — what you added, removed and changed. The",
  "   point is that the user never has to open knag to find out what you did.",
  "",
  "The page is plain text and renders as plain text. There is no markdown rendering:",
  "`**bold**` stays four asterisks on screen. A line matching `- [ ] text` is a",
  "checkbox and `- [x] text` is a checked one, at any indentation; everything else is a",
  "literal line. Do not add formatting the page cannot show.",
  "",
  "Voice, whenever you write about knag to the user: lowercase `knag`, deadpan, no",
  "exclamation marks, no congratulating. It is `the page`. Removing checked items is",
  "`wiping`. Say `wiped 6`, not `Successfully cleared 6 completed items!`.",
].join("\n");

/**
 * `POST /mcp`.
 *
 * 🔴 **Bearer only, deliberately** — every other route in knag accepts the session
 * cookie as well.
 *
 * mcp.md §8's argument for *not* blocking foreign `Origin` headers rests on one claim:
 * a `/mcp` that never accepts a cookie grants no ambient authority, so a rebound page
 * can only make unauthenticated requests that 401 anyway. Accept the cookie here and
 * that sentence stops being true and the Origin decision loses its foundation.
 *
 * The cookie is `SameSite=Lax` and this route is POST-only, so a cross-site POST would
 * not carry it today regardless — but that makes the safety property depend on a cookie
 * attribute rather than on construction, and mcp.md §9 is explicit that by-construction
 * is the stronger posture. No MCP client sends cookies, so this costs nothing.
 *
 * Pinned in `pnpm test:security`.
 */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const principal = await authenticate(request, env);

  // A valid session cookie resolves a principal and is still refused here. MCP clients
  // expect a 401 to mean "authenticate", never "go away" — anything else surfaces as a
  // silent empty tool list, which is the hardest MCP failure to diagnose (mcp.md §8).
  if (!principal || principal.source !== "bearer") {
    return unauthorized();
  }

  noteMcpOrigin(request);

  // 🔴 A NEW server and transport per request. Never module-scoped.
  //
  // Module scope survives between requests on a Worker and hoisting this looks like a
  // free optimization. It is not: sharing a server or transport can leak one caller's
  // response into another's, and the SDK added a guard against exactly this (mcp.md
  // §2). knag has one operator today, which makes the blast radius small and the habit
  // no less wrong — §17's multi-user branch would turn it into an incident.
  const server = buildServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless, and **omitting `sessionIdGenerator` is how you say so** — the SDK
    // treats its absence as "session management disabled". The documented spelling is
    // `sessionIdGenerator: undefined`, which `exactOptionalPropertyTypes` rejects; the
    // transport reads it as `=== undefined` either way. Do not add the key back.
    //
    // There is no session worth resuming: every request carries its own bearer and
    // every tool reads the live page, so a session would hold nothing that is not
    // already in D1. The SDK also refuses to reuse a stateless transport across
    // requests, which makes the per-request construction above mandatory rather than
    // merely correct.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * Note a foreign `Origin`. Observational only — it never blocks.
 *
 * 🔴 The MCP spec's Origin-validation rule is written for **localhost-bound** servers
 * that grant access by network position. On a remote, token-authenticated endpoint it
 * defends a door that does not exist, and enforcing it breaks real traffic: claude.ai's
 * web app POSTs here from the browser carrying `Origin: https://claude.ai`, and a 403
 * kills the tool-list refresh and reads to the user as "server unavailable."
 *
 * pagevault shipped that block and reverted it within the hour. This is the honest read
 * of the MUST for this topology, not a gap left open (mcp.md §8, spec §14.6).
 *
 * A missing `Origin` — Claude Code, the connector infrastructure, anything that is not
 * a browser — is the ordinary case and is not logged.
 */
function noteMcpOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  if (origin === new URL(request.url).origin) return;

  console.info(`mcp request from origin ${origin}`);
}

function buildServer(env: Env): McpServer {
  const server = new McpServer(
    {
      name: "knag",
      title: "knag",
      version: env.KNAG_VERSION || "0.0.0-dev",
      // The connector list shows an icon here, and the SDK supports separate light and
      // dark variants. Deliberately absent until the design pass delivers the mark —
      // a placeholder icon is the first impression in Claude's connector UI, and a
      // wrong one is worse than none.
    },
    { instructions: INSTRUCTIONS },
  );

  registerRead(server, env);
  registerWrite(server, env);
  registerWipe(server, env);
  registerHistory(server, env);

  return server;
}

/**
 * Both halves of a tool result, every time (mcp.md §6).
 *
 * 🔴 The trap this exists to spring shut: when a tool declares an `outputSchema`, any
 * NON-error success that omits `structuredContent` is a **protocol** error in the SDK's
 * validator — the exact failure "errors are results, not exceptions" exists to prevent.
 * So every success path goes through here, including the empty ones.
 */
function ok(structured: Record<string, unknown>, prose: string) {
  return {
    content: [{ type: "text" as const, text: prose }],
    structuredContent: structured,
  };
}

/**
 * A failure the model can act on — an `isError` result, never a thrown exception and
 * never an HTTP 500 (mcp.md §6, spec §14.6).
 *
 * `isError` results are exempt from the `structuredContent` requirement above, so the
 * detail has to be legible in the prose. For a conflict that means carrying the current
 * body inline: the whole point is that the agent re-applies its intent without a second
 * round trip.
 */
function failed(prose: string) {
  return { content: [{ type: "text" as const, text: prose }], isError: true };
}

/** The conflict message. Structured enough to act on, prose enough to read. */
function conflictText(action: string, sent: number, current: { version: number; body: string }) {
  return [
    `version_conflict: the page moved from version ${sent} to ${current.version} while you were working.`,
    "",
    `Do not retry ${action} with your original body. Re-apply your intent to the current`,
    `page below, then call again with base_version: ${current.version}.`,
    "",
    `--- current page (version ${current.version}) ---`,
    current.body,
    "--- end of page ---",
  ].join("\n");
}

const BASE_VERSION = z
  .number()
  .int()
  .nonnegative()
  .describe(
    "The version you last read, from knag_read. The write applies only if the page is still at this version; anything else is a conflict. Use 0 only for a page you believe is empty.",
  );

function registerRead(server: McpServer, env: Env): void {
  server.registerTool(
    "knag_read",
    {
      title: "Read the page",
      description: [
        "Read the whole page, exactly as stored — every byte, including indentation, blank lines and trailing whitespace.",
        "",
        "Returns the `version`, which every write must carry. 🔴 Call this immediately before every knag_write or knag_wipe, even if you read earlier in this conversation: three devices sync to this page and a body you are holding may already be stale.",
        "",
        "Checkbox lines look like `- [ ] task` (open) and `- [x] task` (done), at any indentation. Fenced code blocks use ``` and are ordinary lines in the page.",
      ].join("\n"),
      inputSchema: {},
      outputSchema: {
        body: z.string().describe("The whole page, verbatim."),
        version: z.number().describe("Pass this as base_version on your next write."),
        updated_at: z.string().describe("ISO 8601 UTC of the last change."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const doc = await readDocument(env);
      return ok(
        { body: doc.body, version: doc.version, updated_at: doc.updated_at },
        `Page at version ${doc.version}, updated ${doc.updated_at}.\n\n${doc.body}`,
      );
    },
  );
}

function registerWrite(server: McpServer, env: Env): void {
  server.registerTool(
    "knag_write",
    {
      title: "Write the page",
      description: [
        "Replace the whole page. This is the only write there is — there is no append, no patch and no delete, because read-modify-write covers every case identically on a page this size.",
        "",
        "🔴 Whole-page replacement means every line you send is the page. Byte-preserve everything you were not asked to change: indentation, blank lines, trailing whitespace, `*` versus `-`, and line endings all survive a round trip and all matter. Never reformat, sort, retitle or tidy in passing.",
        "",
        "🔴 Read immediately before calling this, and send that read's `version` as `base_version`. If the page moved in between you get a conflict carrying the current version and body — re-apply your intent to that body and call again. Retrying with the stale body destroys work and is the one thing this tool cannot undo for you.",
        "",
        "Writing an identical body is a no-op: nothing is recorded and the version does not move.",
      ].join("\n"),
      inputSchema: {
        body: z
          .string()
          .describe("The complete new page. An empty string is valid and wipes it entirely."),
        base_version: BASE_VERSION,
      },
      outputSchema: {
        version: z.number().describe("The version after the write."),
        updated_at: z.string(),
        changed: z.boolean().describe("False when the body was already identical."),
      },
      annotations: {
        readOnlyHint: false,
        // Honest, not cautious: this replaces the entire page, and a careless body
        // loses every line it omits.
        destructiveHint: true,
        // 🔴 False on purpose. A second identical call does not repeat the effect — it
        // conflicts. Hosts read this hint to decide whether a blind retry is safe, and
        // a blind retry is exactly what the agent contract forbids: on conflict you
        // re-read and re-apply. Marking it idempotent would invite the one behaviour
        // that loses work.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ body, base_version }) => {
      const result = await writeDocument(env, { body, baseVersion: base_version, source: "agent" });

      if (result.status === "conflict") {
        return failed(conflictText("this write", base_version, result.current));
      }

      const changed = result.status === "applied";
      return ok(
        { version: result.version, updated_at: result.updated_at, changed },
        changed
          ? `wrote the page at version ${result.version}`
          : `no change — the page was already identical, still at version ${result.version}`,
      );
    },
  );
}

function registerWipe(server: McpServer, env: Env): void {
  server.registerTool(
    "knag_wipe",
    {
      title: "Wipe the page",
      description: [
        "Remove every checked item (`- [x] …`) from the page, at any indentation, and record what was removed.",
        "",
        "This is the same action as the wipe control in the app, and it is the product's central gesture: checked items deliberately sit on the page nagging until they are wiped. Nothing is lost — the removed lines are written to the history as the authoritative record of what was finished, and the page as it stood before the wipe is kept.",
        "",
        "Unchecked lines are never touched. Wiping a page with nothing checked succeeds and reports zero.",
        "",
        "🔴 Takes a `base_version` for the same reason knag_write does, and conflicts the same way.",
      ].join("\n"),
      inputSchema: { base_version: BASE_VERSION },
      outputSchema: {
        version: z.number(),
        wiped_count: z.number().describe("How many checked lines were removed."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Same reasoning as knag_write: a repeat conflicts rather than no-ops.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ base_version }) => {
      const current = await readDocument(env);
      const blocks = parse(current.body);
      const completed = blocks.filter(isCompleted);

      // Reported as success with a count of zero rather than as an error: the caller
      // asked for the checked items to be gone, and they are.
      if (completed.length === 0) {
        return ok(
          { version: current.version, wiped_count: 0 },
          `nothing to wipe — no checked items on the page, still at version ${current.version}`,
        );
      }

      const result = await clearCompleted(env, {
        baseVersion: base_version,
        body: serialize(blocks.filter((block) => !isCompleted(block))),
        // The full source line, not the task text — the record should read the way the
        // page read.
        clearedLines: completed.map((block) => block.raw),
        source: "agent",
      });

      if (result.status === "conflict") {
        return failed(conflictText("this wipe", base_version, result.current));
      }

      return ok(
        { version: result.version, wiped_count: result.cleared_count },
        `wiped ${result.cleared_count} · page now at version ${result.version}`,
      );
    },
  );
}

const HISTORY_BOUNDARY =
  "A bare date (2026-08-14), resolved to local midnight in the page's timezone, or a full ISO 8601 instant.";

function registerHistory(server: McpServer, env: Env): void {
  server.registerTool(
    "knag_history",
    {
      title: "Read history",
      description: [
        "What changed on the page, and what got wiped, grouped by local day.",
        "",
        "Each entry carries the lines that `appeared` and `disappeared` since the entry before it. Each day also carries `cleared` — the lines removed by a wipe that day. 🔴 Prefer `cleared` when answering what someone finished: the line diff is a set difference and is blind to a duplicate line being removed, while the wipe record is exact.",
        "",
        "Dates are local, not UTC — an edit at 11pm belongs to that day, not the next one. The resolved timezone comes back in the response.",
        "",
        "Defaults to the last seven days. `since=2026-08-14&until=2026-08-14` returns that whole day.",
        "",
        "There is no history screen in the app, so this is how history gets read. An entry with an empty diff and a `cleared_count` above zero is a wipe: it snapshots the page as it stood before, so its own diff is empty by construction and the `cleared` lines are the record.",
      ].join("\n"),
      inputSchema: {
        since: z.string().optional().describe(`Start of the range. ${HISTORY_BOUNDARY}`),
        until: z
          .string()
          .optional()
          .describe(`End of the range, inclusive of a whole bare date. ${HISTORY_BOUNDARY}`),
      },
      outputSchema: {
        timezone: z.string(),
        since: z.string(),
        until: z.string(),
        truncated: z.boolean().describe("True when older entries in range were dropped."),
        days: z.array(
          z.object({
            date: z.string().describe("Local date, YYYY-MM-DD."),
            revisions: z.array(
              z.object({
                id: z.number(),
                version: z.number(),
                created_at: z.string(),
                local_time: z.string(),
                source: z.string().describe("`pwa`, `agent`, or `system`."),
                event_type: z.string().nullable(),
                appeared: z.array(z.string()),
                disappeared: z.array(z.string()),
                cleared_count: z.number(),
              }),
            ),
            cleared: z.array(
              z.object({
                id: z.number(),
                revision_id: z.number(),
                line_text: z.string(),
                cleared_at: z.string(),
                local_time: z.string(),
              }),
            ),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ since, until }) => {
      const timeZone = reportingZone(env.KNAG_TZ);
      const range = resolveRange(
        { since: since ?? null, until: until ?? null },
        timeZone,
        new Date(),
      );

      // An input-validation failure is a result the model can self-correct from, not a
      // protocol error (mcp.md §6, sharpened by SEP-1303).
      if (!range.ok) {
        return failed(`invalid ${range.field}: ${range.message}`);
      }

      const history = await loadHistory(env, range, timeZone);

      // 🔴 The empty path returns structured content too. A day with nothing in it is a
      // real answer, and omitting `structuredContent` here would turn "quiet week" into
      // a protocol error.
      return ok(history as unknown as Record<string, unknown>, summarize(history));
    },
  );
}

/** A readable rendering beside the structured payload (mcp.md §6 — best-in-class does both). */
function summarize(history: Awaited<ReturnType<typeof loadHistory>>): string {
  if (history.days.length === 0) {
    return `nothing between ${history.since} and ${history.until} (${history.timezone})`;
  }

  const lines = [`${history.timezone} · ${history.since} to ${history.until}`];
  if (history.truncated) lines.push("(truncated — older entries in range were dropped)");

  for (const day of history.days) {
    lines.push("", day.date);
    for (const revision of day.revisions) {
      const parts: string[] = [];
      if (revision.appeared.length) parts.push(`+${revision.appeared.length}`);
      if (revision.disappeared.length) parts.push(`-${revision.disappeared.length}`);
      if (revision.cleared_count) parts.push(`wiped ${revision.cleared_count}`);
      lines.push(`  ${revision.local_time} ${revision.source} ${parts.join(" ") || "no change"}`);
    }
    for (const item of day.cleared) {
      lines.push(`  ${item.local_time} wiped: ${item.line_text}`);
    }
  }

  return lines.join("\n");
}
