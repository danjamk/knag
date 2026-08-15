import {
  type Principal,
  authenticate,
  issueSession,
  secretEquals,
  unauthorized,
} from "./auth.js";
import { type Env, buildInfo } from "./env.js";
import { isCompleted, parse, serialize } from "./blocks.js";
import {
  buildHistory,
  daysBefore,
  isKnownTimeZone,
  localMidnight,
  resolveBoundary,
  wallClock,
} from "./history.js";
import {
  type DocumentSource,
  clearCompleted,
  clearedItemsInRange,
  readDocument,
  revisionBefore,
  revisionsInRange,
  writeDocument,
} from "./store.js";

/**
 * knag — one plain-text document, always live.
 *
 * Live: `/health`, the document API (spec §5), and auth (§4) — passphrase login,
 * session cookie, bearer. The MCP server (§10) arrives with build-order step 10; see
 * docs/spec.md §13.
 *
 * Routing note: `run_worker_first` in wrangler.jsonc lists exactly the paths that
 * reach this handler. Everything else is served from `public/` by Workers Static
 * Assets without a Worker invocation, which is most of the free-tier request budget
 * (spec §14.4). Adding a route here means adding it there too.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated by design, and reports nothing about the document. `make health`
    // asserts this matches the checkout it is run from, which is the only thing that
    // catches "deployed from the wrong branch."
    if (url.pathname === "/health") {
      return Response.json(buildInfo(env));
    }

    // The one unauthenticated /api/* route, necessarily — it is how a principal comes
    // into existence. Rate-limited by a Cloudflare WAF rule rather than in code
    // (spec §4.2); dev sits on *.workers.dev with no such rule in front of it.
    if (url.pathname === "/api/login") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      return login(request, env);
    }

    if (url.pathname === "/api/doc/clear-completed") {
      const principal = await authenticate(request, env);
      if (!principal) return unauthorized();

      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      return clear(request, env, principal);
    }

    if (url.pathname === "/api/history") {
      const principal = await authenticate(request, env);
      if (!principal) return unauthorized();

      if (request.method !== "GET") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      return getHistory(url, env);
    }

    if (url.pathname === "/api/doc") {
      // 🔴 Every route resolves a principal, and no handler below asks how it was
      // resolved beyond mapping it to a write source. Bearer is first-class here, not
      // an agent afterthought — a native wrapper authenticates from the Keychain with
      // a header and never sees a cookie (spec §4.1).
      const principal = await authenticate(request, env);
      if (!principal) return unauthorized();

      if (request.method === "GET") return getDoc(request, env);
      if (request.method === "PUT") return putDoc(request, env, principal);

      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "GET, PUT" } },
      );
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Exchange the passphrase for a session cookie.
 *
 * 🔴 Every failure path returns the same opaque 401 with the same shape. A login
 * endpoint that distinguishes "no passphrase field" from "wrong passphrase" from
 * "server has no passphrase configured" is a login endpoint that helps enumerate
 * its own state (spec §4.2).
 */
async function login(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return loginFailed(request, "malformed body");
  }

  const { passphrase, device_label: deviceLabel } = (payload ?? {}) as Record<string, unknown>;

  if (typeof passphrase !== "string") {
    return loginFailed(request, "no passphrase presented");
  }
  if (!(await secretEquals(passphrase, env.KNAG_PASSPHRASE))) {
    return loginFailed(request, "passphrase mismatch");
  }

  const cookie = await issueSession(
    request,
    env,
    typeof deviceLabel === "string" ? deviceLabel : null,
  );

  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}

/**
 * One 401 for every way a login can fail. The reason is logged, never returned —
 * observability is enabled on this Worker, so the operator can see what the caller
 * cannot.
 */
function loginFailed(request: Request, reason: string): Response {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  console.warn(`login failed from ${ip}: ${reason}`);
  return unauthorized();
}

/**
 * Sweep the checked items (spec §5, §14.2).
 *
 * The parse lives here rather than in `store.ts` — the store owns SQL and the order
 * of operations, this owns what "completed" means. That is `kind === 'checkbox' &&
 * checked`, **at any indentation level**, and nothing else: a nested done item is
 * still done, and a line that merely looks like a checkbox was never one.
 *
 * Serialization is `blocks.map(b => b.raw).join('\n')` over the survivors, so every
 * line that stays is written back from its untouched source — indentation, markers,
 * trailing whitespace and CRLF included.
 */
async function clear(request: Request, env: Env, principal: Principal): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { base_version: baseVersion } = (payload ?? {}) as Record<string, unknown>;
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return Response.json({ error: "base_version must be a non-negative integer" }, { status: 400 });
  }

  const current = await readDocument(env);
  const blocks = parse(current.body);
  const completed = blocks.filter(isCompleted);

  // Nothing to do. Reported as success with a count of zero rather than as an error:
  // the caller asked for the checked items to be gone, and they are.
  if (completed.length === 0) {
    return Response.json(
      { version: current.version, cleared_count: 0 },
      { headers: { ETag: etagFor(current.version) } },
    );
  }

  const result = await clearCompleted(
    env,
    {
      baseVersion,
      body: serialize(blocks.filter((block) => !isCompleted(block))),
      // The full source line, not the task text — the done-record should read the
      // way the document read.
      clearedLines: completed.map((block) => block.raw),
      source: sourceFor(principal),
    },
  );

  if (result.status === "conflict") {
    return Response.json(
      { error: "version_conflict", ...result.current },
      { status: 409, headers: { ETag: etagFor(result.current.version) } },
    );
  }

  return Response.json(
    { version: result.version, cleared_count: result.cleared_count },
    { headers: { ETag: etagFor(result.version) } },
  );
}

/**
 * Days a bare `GET /api/history` covers, counting today. A week, because a week is the
 * unit the question gets asked in.
 */
const DEFAULT_HISTORY_DAYS = 7;

/**
 * The zone every history boundary is resolved in (spec §14.3).
 *
 * A misconfigured `KNAG_TZ` falls back to UTC and says so in the logs rather than
 * throwing: the endpoint answering in the wrong zone is a bad day, and the endpoint
 * returning 500 because someone fat-fingered a var is a worse one. The fallback is
 * visible in the response — `timezone` is echoed — so it cannot be mistaken for
 * working.
 */
function reportingZone(env: Env): string {
  const configured = env.KNAG_TZ || "America/Chicago";
  if (isKnownTimeZone(configured)) return configured;

  console.warn(`KNAG_TZ is not a known IANA zone: ${configured}. Falling back to UTC.`);
  return "UTC";
}

/**
 * What changed, and what got finished, grouped by local day (spec §5, §14.3).
 *
 * `since` and `until` each take a bare date (`2026-08-14`, resolved to local midnight
 * in the reporting zone) or a full ISO instant. `until` from a bare date is the *next*
 * local midnight, so asking for a single day returns that day.
 *
 * 🔴 One extra revision is read from below `since` purely as the diff floor. It is not
 * returned. Without it the first entry of every range diffs against nothing and reports
 * the entire document as new, which makes the feature actively misleading on exactly
 * the query it exists for.
 */
async function getHistory(url: URL, env: Env): Promise<Response> {
  const timeZone = reportingZone(env);
  const now = new Date();
  const today = wallClock(now, timeZone);

  const since = resolveBoundary(url.searchParams.get("since"), "since", timeZone, () =>
    localMidnight(daysBefore(today, DEFAULT_HISTORY_DAYS - 1), timeZone),
  );
  if (!since) {
    return Response.json(
      { error: "since must be YYYY-MM-DD or an ISO 8601 instant" },
      { status: 400 },
    );
  }

  const until = resolveBoundary(url.searchParams.get("until"), "until", timeZone, () => now);
  if (!until) {
    return Response.json(
      { error: "until must be YYYY-MM-DD or an ISO 8601 instant" },
      { status: 400 },
    );
  }

  // An inverted range is a typo, not a request for nothing. Answering it with an empty
  // result would look exactly like a week in which nothing happened.
  if (since.getTime() >= until.getTime()) {
    return Response.json({ error: "since must be before until" }, { status: 400 });
  }

  // Three indexed reads in parallel. `revisionBefore` is issued unconditionally even
  // though a truncated page supersedes it — one extra indexed lookup is cheaper than
  // the second round trip that finding out first would cost.
  const [before, page, cleared] = await Promise.all([
    revisionBefore(env, since),
    revisionsInRange(env, { since, until }),
    clearedItemsInRange(env, { since, until }),
  ]);

  return Response.json(
    buildHistory({
      // A truncated page starts partway into the range, so the revision before the
      // range is the wrong floor for it — the one the cap dropped is the right one.
      baseline: page.precedingDropped ?? before,
      revisions: page.revisions,
      cleared,
      since,
      until,
      timeZone,
      truncated: page.truncated,
    }),
  );
}

/**
 * Bytes. Not in the issue, and deliberate: the document is expected to be a few KB,
 * this is ~200x that, and it is the difference between a looping client and a row D1
 * refuses to write. The failure it prevents happens against the only copy.
 */
const MAX_BODY_BYTES = 1_048_576;

/** HTTP entity-tags are quoted. The version is the whole tag — nothing else changes. */
function etagFor(version: number): string {
  return `"${version}"`;
}

/**
 * RFC 9110 §13.1.2. A list, each entry optionally weak-prefixed, plus `*` meaning
 * "any current representation". Weak comparison is the right one for If-None-Match,
 * so `W/` is stripped rather than rejected.
 */
function ifNoneMatchSatisfied(header: string | null, version: number): boolean {
  if (!header) return false;
  return header.split(",").some((raw) => {
    const tag = raw.trim().replace(/^W\//, "");
    return tag === "*" || tag === etagFor(version);
  });
}

async function getDoc(request: Request, env: Env): Promise<Response> {
  const doc = await readDocument(env);
  const etag = etagFor(doc.version);

  // 304 carries no body but must still carry the tag, so a client that revalidates
  // repeatedly never loses track of the version it is holding.
  if (ifNoneMatchSatisfied(request.headers.get("If-None-Match"), doc.version)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return Response.json(doc, { headers: { ETag: etag } });
}

/**
 * The write source is derived from how the caller authenticated, never read from the
 * request body. Spec §5 sketches `source` as a request field; it carries no
 * information the principal does not already have, and a caller-supplied value is
 * unvalidated text headed for the only copy of the document.
 */
function sourceFor(principal: Principal): DocumentSource {
  return principal.source === "bearer" ? "agent" : "pwa";
}

async function putDoc(request: Request, env: Env, principal: Principal): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { body, base_version: baseVersion } = (payload ?? {}) as Record<string, unknown>;

  // An empty string is a valid document and a valid write. Only the absence of a
  // string is an error — conflating the two is how "empty" starts reading as "failed"
  // (spec §14.5).
  if (typeof body !== "string") {
    return Response.json({ error: "body must be a string" }, { status: 400 });
  }
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return Response.json({ error: "base_version must be a non-negative integer" }, { status: 400 });
  }
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Document too large" }, { status: 413 });
  }

  const result = await writeDocument(env, { body, baseVersion, source: sourceFor(principal) });

  // 🔴 The 409 body is not a courtesy. The agent contract (spec §10) re-applies its
  // intent from exactly this payload, so it has to carry the current body as well as
  // the version — otherwise every conflict costs a second round trip, and a retry
  // with the stale body is the data loss this endpoint exists to prevent.
  if (result.status === "conflict") {
    return Response.json(
      { error: "version_conflict", ...result.current },
      { status: 409, headers: { ETag: etagFor(result.current.version) } },
    );
  }

  // A no-op reports the unchanged version rather than a distinct status: the caller's
  // question is "what version am I on now", and the answer is the same either way.
  return Response.json(
    { version: result.version, updated_at: result.updated_at },
    { headers: { ETag: etagFor(result.version) } },
  );
}
