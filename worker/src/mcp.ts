import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { type Principal, unauthorized } from "./auth.js";
import type { Env } from "./env.js";
import { isCompleted, parse, serialize } from "./blocks.js";
import { loadHistory, reportingZone, resolveRange } from "./history.js";
import {
  type PageRow,
  type WipeScope,
  findPageByName,
  listPages,
  readDefaultPage,
  wipe,
  writePage,
} from "./store.js";

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
  "knag is a small handful of plain-text pages. You can read all of one and write all of",
  "one. Every tool takes an optional `page` name; omit it and you get the default page,",
  "which is what every call meant before there were several.",
  "",
  "Five rules cut across every tool:",
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
  "4. REPORT THE DIFF after every write — what you added, removed and changed, AND WHICH",
  "   PAGE. The point is that the user never has to open knag to find out what you did,",
  "   and once there are several pages `the page` stops being an answer.",
  "",
  "5. NAME THE PAGE YOU READ, AND WRITE TO THAT ONE. knag_read returns the page name it",
  "   answered with; pass it back on the write. An unrecognised name is an error listing",
  "   what exists — it never falls back to the default, because a whole-page write to the",
  "   wrong page destroys a document while preserving every byte of it.",
  "",
  "There is no index and no way to list pages here — knag has none on purpose. If you do",
  "not know a page's name, get it wrong once: the error names every page that exists.",
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
 * 🔴 As of ADR-005 there are **two** bearer credentials that reach here, and the
 * principal is resolved by the caller rather than here, because only one of them can be
 * checked locally:
 *
 *   - `KNAG_BEARER_TOKEN`, compared in `authenticate()` — the Claude Code path.
 *   - An OAuth access token, which only the provider can validate, and which it hands
 *     to this handler having already done so.
 *
 * Both are `Authorization: Bearer`. Neither is a cookie, and no caller may pass a
 * session principal in — the guard below refuses it, and index.ts never constructs one.
 * So the no-ambient-authority property the Origin decision rests on is unchanged.
 *
 * Pinned in `pnpm test:security`.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  // Defence in depth. Both callers already resolve a bearer, so reaching this is a bug
  // in index.ts rather than anything a client did — but the cost of being wrong here is
  // the whole reason `/mcp` is different from every other route.
  if (principal.source !== "bearer") {
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
  const server = buildServer(env, new URL(request.url).origin);
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

/**
 * The mark, for the connector list.
 *
 * 🔴 **Absolute, derived from the request origin.** `IconSchema.src` is "URL or data
 * URI" and says nothing about what a relative path resolves against — the client
 * fetching it is Claude, not a browser sitting on this origin, so `/icons/…` is a bet
 * on someone else's base URL. The origin is already in hand and costs one argument.
 * It also keeps dev and prod each advertising their own copy rather than one of them
 * pointing at the other, which is the same reason `resourceMetadata.resource` is
 * derived rather than configured (ADR-005).
 *
 * `theme` names the ground the icon is **drawn for**, not the ink: `dark` is the slate
 * board for a dark UI, `light` is the whiteboard. Getting that backwards puts an amber
 * block on a near-white tile inside a dark connector list.
 *
 * Two entries, 256px, PNG. PNG rather than the SVG sources because it is one of the two
 * MIME types a client that renders icons at all MUST support; the design pass specifies
 * this exact array. The mark is two rectangles, so 256 downscales to a connector row
 * without artefacts and the 32/64 exports are not shipped.
 */
function serverIcons(origin: string) {
  return [
    {
      src: `${origin}/icons/mcp-icon-slate-256.png`,
      mimeType: "image/png",
      sizes: ["256x256"],
      theme: "dark" as const,
    },
    {
      src: `${origin}/icons/mcp-icon-whiteboard-256.png`,
      mimeType: "image/png",
      sizes: ["256x256"],
      theme: "light" as const,
    },
  ];
}

function buildServer(env: Env, origin: string): McpServer {
  const server = new McpServer(
    {
      name: "knag",
      title: "knag",
      version: env.KNAG_VERSION || "0.0.0-dev",
      icons: serverIcons(origin),
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

/**
 * The `page` every tool takes, and it is **optional** (#153).
 *
 * 🔴 Optional is not a nicety. §17 is explicit that a parameter added later is
 * backward-compatible only while it is optional — a required one breaks every existing
 * Claude Code config the moment this deploys, and those configs are on machines nobody
 * is going to edit.
 */
const PAGE = z
  .string()
  .min(1)
  .describe(
    "Which page, by name — case-insensitive. Omit it for the default page, which is what every call meant before pages existed. An unrecognised name is an error listing the pages that do exist; it never falls back to the default.",
  );

/**
 * Resolve the page a tool call is about, or explain why it could not be.
 *
 * 🔴 **Absent means the default page, and deliberately not "the current page."**
 * #123's task list said the latter and it is not implementable: the Worker has no current
 * page. "Current" is a per-device idea living in the browser's localStorage, and a bearer
 * token carries no device — so an agent's write would land on whatever page a phone
 * happened to be showing. Whole-document write is the only write here, which makes that a
 * non-deterministic overwrite of a page nobody named.
 *
 * 🔴 **An unrecognised name is an error, never the default.** The failure it prevents
 * is the same one, arriving by another route: an agent told to write to `shopping` after
 * someone renamed that page would silently replace today's page instead. The error lists
 * what exists, because a name that is wrong is usually a name that is nearly right.
 *
 * The default page is non-null by construction: `readPage` answers for it even when the
 * row is missing, which is spec §14.5's "empty is a valid state" and the reason a fresh
 * database is readable before anything has been written to it.
 */
type PageResult = { ok: true; page: PageRow } | { ok: false; result: ReturnType<typeof failed> };

async function agentPage(env: Env, name?: string): Promise<PageResult> {
  if (name === undefined) return { ok: true, page: await readDefaultPage(env) };

  const page = await findPageByName(env, name);
  if (page) return { ok: true, page };

  const names = (await listPages(env)).map((p) => p.name);
  return {
    ok: false,
    result: failed(
      [
        `no page named "${name}".`,
        "",
        `The pages that exist are: ${names.map((n) => `"${n}"`).join(", ")}.`,
        "",
        "Nothing was read or written. Call again with one of those, or omit `page` for the default one.",
      ].join("\n"),
    ),
  };
}

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
      inputSchema: { page: PAGE.optional() },
      outputSchema: {
        body: z.string().describe("The whole page, verbatim."),
        version: z.number().describe("Pass this as base_version on your next write."),
        updated_at: z.string().describe("ISO 8601 UTC of the last change."),
        // 🔴 Echoed back so a write can name the page it read (#153). Without it an
        // agent that omitted `page` has no way to say which page its diff describes, and
        // the contract's "report the diff" stops being answerable once there are several.
        page: z.string().describe("The name of the page this is."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ page }) => {
      const found = await agentPage(env, page);
      if (!found.ok) return found.result;
      const doc = found.page;

      return ok(
        { body: doc.body, version: doc.version, updated_at: doc.updated_at, page: doc.name },
        `Page "${doc.name}" at version ${doc.version}, updated ${doc.updated_at}.\n\n${doc.body}`,
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
        page: PAGE.optional(),
      },
      outputSchema: {
        version: z.number().describe("The version after the write."),
        updated_at: z.string(),
        changed: z.boolean().describe("False when the body was already identical."),
        page: z.string().describe("The name of the page that was written."),
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
    async ({ body, base_version, page }) => {
      // 🔴 Resolved before anything is written, and a miss writes nothing at all. The
      // agent contract's "byte-preserve every line not explicitly targeted" is a promise
      // about a *named* page; a write that lands on the wrong one keeps every byte and
      // destroys the document anyway.
      const found = await agentPage(env, page);
      if (!found.ok) return found.result;
      const target = found.page;

      const result = await writePage(env, {
        pageId: target.id,
        body,
        baseVersion: base_version,
        source: "agent",
      });

      if (result.status === "conflict") {
        return failed(conflictText(`this write to "${target.name}"`, base_version, result.current));
      }

      const changed = result.status === "applied";
      return ok(
        { version: result.version, updated_at: result.updated_at, changed, page: target.name },
        changed
          ? `wrote "${target.name}" at version ${result.version}`
          : `no change — "${target.name}" was already identical, still at version ${result.version}`,
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
        "Remove lines from the page and record what went. This is the product's central gesture: checked items deliberately sit on the page nagging until they are wiped.",
        "",
        "Two scopes:",
        "",
        "- `completed` (the default) removes every checked item (`- [x] …`), at any indentation. Unchecked lines are never touched.",
        "- `all` empties the page entirely. For a list you are simply done with — a grocery list, where you do not tick the last three things.",
        "",
        "🔴 `all` removes work that was never finished. Prefer `completed` unless the user has clearly asked for the whole page to go, and say which one you used.",
        "",
        "Nothing is lost either way: the page as it stood before the wipe is kept in the history. Only the *checked* lines are recorded as finished, so a wipe-all does not inflate what you got done.",
        "",
        "Wiping a page with nothing to remove succeeds and reports zero.",
        "",
        "🔴 Takes a `base_version` for the same reason knag_write does, and conflicts the same way.",
      ].join("\n"),
      inputSchema: {
        base_version: BASE_VERSION,
        scope: z
          .enum(["completed", "all"])
          .optional()
          .describe(
            "`completed` (default) removes checked items only. `all` empties the page, including unfinished lines.",
          ),
        page: PAGE.optional(),
      },
      outputSchema: {
        version: z.number(),
        wiped_count: z.number().describe("How many lines were removed from the page."),
        cleared_count: z
          .number()
          .describe("How many of them were checked, and so recorded as finished."),
        page: z.string().describe("The name of the page that was wiped."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Same reasoning as knag_write: a repeat conflicts rather than no-ops.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ base_version, scope, page }) => {
      const wipeScope: WipeScope = scope === "all" ? "all" : "completed";
      const found = await agentPage(env, page);
      if (!found.ok) return found.result;
      const current = found.page;

      const blocks = parse(current.body);
      const completed = blocks.filter(isCompleted);

      // `parse("")` yields a single blank block, so an empty page is detected on the
      // body rather than the block count — otherwise wiping nothing would report one.
      const wipedCount =
        wipeScope === "all" ? (current.body === "" ? 0 : blocks.length) : completed.length;

      // Reported as success with a count of zero rather than as an error: the caller
      // asked for those lines to be gone, and they are.
      if (wipedCount === 0) {
        return ok(
          { version: current.version, wiped_count: 0, cleared_count: 0, page: current.name },
          wipeScope === "all"
            ? `nothing to wipe — "${current.name}" is already empty, still at version ${current.version}`
            : `nothing to wipe — no checked items on "${current.name}", still at version ${current.version}`,
        );
      }

      const result = await wipe(env, {
        pageId: current.id,
        baseVersion: base_version,
        body: wipeScope === "all" ? "" : serialize(blocks.filter((block) => !isCompleted(block))),
        // The finished lines only, under both scopes — see the note in store.ts. The
        // full source line, not the task text, so the record reads the way the page read.
        clearedLines: completed.map((block) => block.raw),
        source: "agent",
        scope: wipeScope,
        wipedCount,
      });

      if (result.status === "conflict") {
        return failed(conflictText(`this wipe of "${current.name}"`, base_version, result.current));
      }

      // Deadpan, and honest about the two numbers when they differ: on a wipe-all the
      // count of things removed is not the count of things finished, and an agent
      // reporting the larger number as an achievement would be lying to the user.
      const summary =
        wipeScope === "all"
          ? `wiped "${current.name}" — ${result.wiped_count} lines, ${result.cleared_count} of them done`
          : `wiped ${result.wiped_count} on "${current.name}"`;

      return ok(
        {
          version: result.version,
          wiped_count: result.wiped_count,
          cleared_count: result.cleared_count,
          page: current.name,
        },
        `${summary} · page now at version ${result.version}`,
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
        page: PAGE.optional(),
      },
      outputSchema: {
        timezone: z.string(),
        since: z.string(),
        until: z.string(),
        page: z.string().describe("The name of the page this history is for."),
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
    async ({ since, until, page }) => {
      const found = await agentPage(env, page);
      if (!found.ok) return found.result;

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

      const history = await loadHistory(env, { ...range, pageId: found.page.id }, timeZone);

      // 🔴 The empty path returns structured content too. A day with nothing in it is a
      // real answer, and omitting `structuredContent` here would turn "quiet week" into
      // a protocol error.
      return ok(
        { ...(history as unknown as Record<string, unknown>), page: found.page.name },
        `"${found.page.name}" · ${summarize(history)}`,
      );
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
