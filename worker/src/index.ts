import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  OWNER,
  type Principal,
  authenticate,
  clearSession,
  issueSession,
  secretEquals,
  unauthorized,
} from "./auth.js";
import { type Env, buildInfo } from "./env.js";
import { isCompleted, parse, serialize } from "./blocks.js";
import { loadHistory, reportingZone, resolveRange } from "./history.js";
import { handleMcp } from "./mcp.js";
import { handleAuthorize } from "./oauth.js";
import {
  type DocumentSource,
  type WipeScope,
  deleteOtherSessions,
  deleteSession,
  deleteSessionByToken,
  listLiveSessions,
  oldestRevisionAt,
  readDocument,
  wipe,
  writeDocument,
} from "./store.js";

/**
 * knag — one plain-text document, always live.
 *
 * Live: `/health`, the document API (spec §5), auth (§4) — passphrase login, session
 * cookie, bearer — and the MCP server at `/mcp` (§10, §14.6).
 *
 * Routing note: `run_worker_first` in wrangler.jsonc lists exactly the paths that
 * reach this handler. Everything else is served from `public/` by Workers Static
 * Assets without a Worker invocation, which is most of the free-tier request budget
 * (spec §14.4). Adding a route here means adding it there too.
 *
 * `/.well-known/*` is routed here to reach the 404 at the bottom of this function,
 * and for no other reason. Static assets answer an unmatched path with the PWA shell
 * and a 200, so a client probing for OAuth metadata would read `text/html` as a
 * malformed document rather than as an absent one — a strictly worse failure to
 * diagnose than the absence it is reporting (ADR-005 §4). knag serves no discovery
 * metadata yet; when it does, the handler goes above the 404, not around it.
 */
const router = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The OAuth consent screen (ADR-005). Routed here by the provider rather than
    // served by it, because proving the visitor is the operator is knag's job.
    if (url.pathname === "/oauth/authorize") {
      return handleAuthorize(request, env);
    }

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

    // No `/mcp` branch here, deliberately. The OAuthProvider claims that path as its
    // `apiRoute`, so a request either carries a token it minted — in which case it goes
    // straight to `handleMcp` — or gets the provider's 401 with the metadata pointer a
    // connector needs to start the handshake. Neither reaches this router.

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

    // 🔴 Behind auth, and that is the whole reason it is not on `/health`. The build
    // line it feeds is one glance — version, environment, and how far back the record
    // goes — but only the first two are facts about the deployment. The third is a fact
    // about the document, and `/health` answers to anybody.
    //
    // Its own route rather than a field on `/api/doc`, which is polled every few
    // seconds: this is read once, when the sheet opens.
    if (url.pathname === "/api/carbon") {
      const principal = await authenticate(request, env);
      if (!principal) return unauthorized();

      if (request.method !== "GET") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }

      const since = await oldestRevisionAt(env);
      return Response.json({ since });
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

    if (url.pathname === "/api/logout") {
      const principal = await authenticate(request, env);
      if (!principal) return unauthorized();

      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      return logout(request, env, principal);
    }

    // 🔴 The router's first path-parameter route. Everything above matches `pathname`
    // exactly, so this is checked with a prefix and the id is taken from the tail —
    // deliberately not a regex over the whole path, because `/api/sessions` and
    // `/api/sessions/<id>` are different resources with different methods and folding
    // them into one branch is how a DELETE with no id becomes a DELETE of everything.
    if (url.pathname === "/api/sessions" || url.pathname.startsWith("/api/sessions/")) {
      const principal = await authenticate(request, env);
      if (!principal) return unauthorized();

      const tail = url.pathname.slice("/api/sessions".length);

      if (tail === "" || tail === "/") {
        if (request.method === "GET") return listSessions(env, principal);
        if (request.method === "DELETE") return revokeOthers(env, principal);

        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "GET, DELETE" } },
        );
      }

      if (request.method !== "DELETE") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "DELETE" } },
        );
      }
      return revokeSession(request, env, principal, decodeURIComponent(tail.slice(1)));
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * The device list (#125).
 *
 * 🔴 `is_current` is computed here rather than stored, and it is what makes the list
 * usable: without it the operator is choosing between four opaque rows and the one
 * they must not revoke looks like the others. A bearer caller has no session, so every
 * row reads `false` — correct, not a special case.
 */
async function listSessions(env: Env, principal: Principal): Promise<Response> {
  const sessions = await listLiveSessions(env);

  return Response.json({
    sessions: sessions.map((s) => ({
      id: s.public_id,
      label: s.device_label,
      created_at: s.created_at,
      expires_at: s.expires_at,
      is_current: s.public_id === principal.session?.publicId,
    })),
  });
}

/**
 * End this session.
 *
 * 🔴 400 rather than 401 for a bearer, and the distinction is the point. A bearer is
 * perfectly well authenticated — it simply holds no session, so there is nothing here
 * to end. Answering 401 would tell an agent its credential was rejected and send it
 * off to re-authenticate against a problem that re-authenticating cannot fix.
 *
 * `KNAG_BEARER_TOKEN` is revoked by rotating the Worker secret, which is stated in the
 * body so the answer arrives with the refusal rather than in a doc somewhere.
 */
async function logout(request: Request, env: Env, principal: Principal): Promise<Response> {
  if (!principal.session) {
    return Response.json(
      { error: "No session to end. A bearer token is revoked by rotating KNAG_BEARER_TOKEN." },
      { status: 400 },
    );
  }

  await deleteSessionByToken(env, principal.session.tokenHash);

  // Deleted by token hash, not by public id: the caller is proving possession of the
  // credential rather than naming a row, so this cannot log out anyone else even if
  // the id were wrong.
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearSession(request) } });
}

/**
 * Revoke one device by its surrogate id.
 *
 * 404 for an id that matched nothing, so a typo is distinguishable from a revocation.
 * There is no ownership check because there is one owner (`OWNER`); when that stops
 * being true this is the line that has to change, which is why it says so here.
 */
async function revokeSession(
  request: Request,
  env: Env,
  principal: Principal,
  publicId: string,
): Promise<Response> {
  const revoked = await deleteSession(env, publicId);
  if (!revoked) return Response.json({ error: "No such session" }, { status: 404 });

  // Revoking your own row from the device list is a log out, and it has to clear the
  // cookie too — otherwise the browser keeps sending a credential whose row is gone,
  // which reads to the user as "it did nothing" until the next reload.
  return new Response(null, {
    status: 204,
    ...(principal.session?.publicId === publicId
      ? { headers: { "Set-Cookie": clearSession(request) } }
      : {}),
  });
}

/**
 * Sign out everywhere else — the panic button for a lost phone.
 *
 * Spares the caller's own session, so securing everything else does not eject you from
 * the device you are holding. A bearer has no session to spare and takes every row,
 * which is the honest reading of the request rather than a refusal.
 */
async function revokeOthers(env: Env, principal: Principal): Promise<Response> {
  const revoked = await deleteOtherSessions(env, principal.session?.publicId ?? null);
  return Response.json({ revoked });
}

/**
 * One provider per origin, cached for the life of the isolate.
 *
 * The provider holds no per-request state — pagevault keeps a single one at module
 * scope — but knag derives `resource` from the origin, so it needs one per hostname
 * rather than one outright.
 *
 * Bounded deliberately. A Worker is reachable only at the hostnames Cloudflare routes
 * to it, which is two at most; the cap is there so that if that ever stops being true,
 * this degrades into the construct-every-time behaviour rather than growing without
 * limit in a long-lived isolate.
 */
const providers = new Map<string, OAuthProvider<Env>>();
const MAX_CACHED_PROVIDERS = 4;

/**
 * OAuth 2.1 for the hosted Claude surfaces — claude.ai, Desktop, mobile (ADR-005, #64).
 *
 * The provider serves `/oauth/token`, `/oauth/register` and the `.well-known` metadata,
 * routes `/oauth/authorize` to the router above, and everything else to it as well.
 *
 * 🔴 Keyed on the request origin rather than configured, so `resource` is whatever the
 * caller actually reached. That is what pins access-token audiences to this server
 * (RFC 8707), and it means the value cannot drift between the two wrangler env blocks
 * because there is no value in them to drift — a `*.workers.dev` deployment and a
 * custom domain each advertise themselves correctly with no config at all.
 *
 * Constructing it is not free: the constructor validates both handlers and four
 * endpoints and builds the capability document. That is fine once per origin and
 * wasteful on every poll, which is what the cache above is for.
 */
function oauthProvider(origin: string): OAuthProvider<Env> {
  const cached = providers.get(origin);
  if (cached) return cached;

  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    // The provider has already validated the access token by the time this runs, and it
    // is the only thing that could — so the principal is constructed here rather than
    // re-derived. `source: "bearer"` is the literal truth: an OAuth access token arrives
    // as `Authorization: Bearer`, and it lands in the revision log as `agent`, which is
    // what it is.
    apiHandler: {
      fetch: (request: Request, env: Env) =>
        handleMcp(request, env, { id: OWNER, source: "bearer" }),
    },
    defaultHandler: router,
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    resourceMetadata: { resource: `${origin}/mcp` },
    onError: ({ code, description, status }) =>
      void console.warn(`oauth ${status} ${code}: ${description}`),
  });

  if (providers.size < MAX_CACHED_PROVIDERS) providers.set(origin, provider);
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 🔴 Preserve the static-bearer path, ahead of OAuth. `KNAG_BEARER_TOKEN` is not a
    // token this provider issued, so the provider would 401 it — taking out Claude Code,
    // the one surface that has ever worked, in the commit that adds the others. ADR-005
    // §1: two independent ways in, neither depending on the other.
    //
    // Falling through on a *failed* bearer rather than rejecting is deliberate: an
    // OAuth access token also arrives as `Authorization: Bearer`, and the provider is
    // the only thing that can tell whether it minted it.
    if (url.pathname === "/mcp") {
      const principal = await authenticate(request, env);
      if (principal?.source === "bearer") return handleMcp(request, env, principal);
    }

    return oauthProvider(url.origin).fetch(request, env, ctx);
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
 * Wipe the page — the checked items, or all of it (spec §5, §14.2, #58).
 *
 * The parse lives here rather than in `store.ts` — the store owns SQL and the order
 * of operations, this owns what "completed" means. That is `kind === 'checkbox' &&
 * checked`, **at any indentation level**, and nothing else: a nested done item is
 * still done, and a line that merely looks like a checkbox was never one.
 *
 * Serialization is `blocks.map(b => b.raw).join('\n')` over the survivors, so every
 * line that stays is written back from its untouched source — indentation, markers,
 * trailing whitespace and CRLF included.
 *
 * 🔴 The route keeps the name `clear-completed` even though it now does more. Renaming
 * it would break every deployed PWA on a page whose whole premise is that you can leave
 * a device open for days, for no gain a `scope` field does not already give. Spec §10
 * already settled this shape for `cleared_items`: a new surface gets the new word, the
 * old ones get it when they are being changed for a real reason.
 */
async function clear(request: Request, env: Env, principal: Principal): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const { base_version: baseVersion, scope } = (payload ?? {}) as Record<string, unknown>;
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return Response.json({ error: "base_version must be a non-negative integer" }, { status: 400 });
  }

  // Absent means `completed`, so a PWA built before #58 keeps working unchanged. An
  // unrecognised value is rejected rather than defaulted — a typo'd scope silently
  // wiping only the checked items would look like it worked.
  if (scope !== undefined && scope !== "completed" && scope !== "all") {
    return Response.json({ error: 'scope must be "completed" or "all"' }, { status: 400 });
  }
  const wipeScope: WipeScope = scope === "all" ? "all" : "completed";

  const current = await readDocument(env);
  const blocks = parse(current.body);
  const completed = blocks.filter(isCompleted);

  // An empty page has nothing to wipe under either scope. `parse("")` yields a single
  // blank block, so this is checked on the body rather than the block count — otherwise
  // wiping an already-empty page would report having removed one thing.
  const wipedCount = wipeScope === "all" ? (current.body === "" ? 0 : blocks.length) : completed.length;

  // Nothing to do. Reported as success with a count of zero rather than as an error:
  // the caller asked for those lines to be gone, and they are.
  if (wipedCount === 0) {
    return Response.json(
      { version: current.version, cleared_count: 0, wiped_count: 0 },
      { headers: { ETag: etagFor(current.version) } },
    );
  }

  const result = await wipe(env, {
    baseVersion,
    body: wipeScope === "all" ? "" : serialize(blocks.filter((block) => !isCompleted(block))),
    // 🔴 The finished lines only, under both scopes. `cleared_items` answers "what did I
    // get done"; a wipe-all removes things that were never done, and recording those
    // here would corrupt the one record `/api/history` treats as authoritative. The
    // sealed snapshot is what makes the rest recoverable (#59).
    //
    // The full source line, not the task text — the done-record should read the way the
    // document read.
    clearedLines: completed.map((block) => block.raw),
    source: sourceFor(principal),
    scope: wipeScope,
    wipedCount,
  });

  if (result.status === "conflict") {
    return Response.json(
      { error: "version_conflict", ...result.current },
      { status: 409, headers: { ETag: etagFor(result.current.version) } },
    );
  }

  return Response.json(
    {
      version: result.version,
      cleared_count: result.cleared_count,
      wiped_count: result.wiped_count,
    },
    { headers: { ETag: etagFor(result.version) } },
  );
}

/**
 * What changed, and what got finished, grouped by local day (spec §5, §14.3).
 *
 * `since` and `until` each take a bare date (`2026-08-14`, resolved to local midnight
 * in the reporting zone) or a full ISO instant. `until` from a bare date is the *next*
 * local midnight, so asking for a single day returns that day.
 *
 * The resolution and the read both live in `history.ts` — `knag_history` calls exactly
 * the same two functions, so the HTTP surface and the agent surface cannot answer the
 * same question differently.
 */
async function getHistory(url: URL, env: Env): Promise<Response> {
  const timeZone = reportingZone(env.KNAG_TZ);
  const range = resolveRange(
    { since: url.searchParams.get("since"), until: url.searchParams.get("until") },
    timeZone,
    new Date(),
  );

  if (!range.ok) {
    return Response.json({ error: range.message }, { status: 400 });
  }

  return Response.json(await loadHistory(env, range, timeZone));
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
