import type { Env } from "./env.js";
import { createSession, findLiveSession, sweepExpiredSessions } from "./store.js";

/**
 * Authentication. Every route goes through `authenticate()`.
 *
 * 🔴 The contract that matters: this returns a **Principal, not a boolean**, and no
 * handler anywhere asks whether the passphrase matched. Handlers key off
 * `principal.id`.
 *
 * Today `id` is always OWNER — that is the point, not an oversight. A shared
 * passphrase does not survive a second human and would not pass App Store review
 * (ADR-001, spec §17). Keeping every caller on `principal.id` means replacing the
 * credential scheme later is a change to this file, not to the whole tree.
 *
 * Bearer is first-class on every `/api/*` route, not an agent afterthought: a native
 * wrapper authenticates from the Keychain with a header, never a cookie.
 */

export const OWNER = "dan";

export type Principal = {
  id: string;
  source: "session" | "bearer";

  /**
   * The caller's own session, when it has one (#125).
   *
   * 🔴 `publicId` is the surrogate from migration 0003, never `token_hash` — the hash
   * is the SHA-256 of a live credential and this object reaches handlers that build
   * response bodies. `tokenHash` is carried too, because logging out means deleting
   * the row for the credential presented rather than for a row the caller named, but
   * it must not be serialised.
   *
   * Absent for `source: "bearer"`, which holds no session. Handlers that need one say
   * so; they do not ask how the principal was resolved.
   */
  session?: { publicId: string; tokenHash: string };
};

/**
 * Constant-time secret comparison.
 *
 * Hash both sides first so the lengths always match — `timingSafeEqual` throws on
 * unequal lengths, and the length itself would otherwise leak. Never `===`.
 */
export async function secretEquals(a: string | undefined, b: string | undefined): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/** SHA-256 of a session cookie value, hex. Only the hash is ever stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The session cookie's name. One document, one cookie, one user. */
export const SESSION_COOKIE = "knag_session";

/** A year, matching the cookie's Max-Age. Re-auth is the thing that kills daily use. */
const SESSION_TTL_SECONDS = 31_536_000;

/** Free text from the caller, headed for the database. Long enough for 'macbook-pro'. */
const MAX_DEVICE_LABEL = 64;

/**
 * Read one cookie out of a `Cookie` header.
 *
 * Split on `;` and only on the FIRST `=` — a cookie value may legally contain `=`
 * (base64url does not, but nothing here should depend on that holding forever).
 */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Resolve a request to a principal, or null.
 *
 * Bearer is checked first: it is the explicit credential, and a browser that happens
 * to carry both should not have its cookie silently win over a header the caller
 * deliberately set.
 */
export async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) {
    const presented = header.slice("Bearer ".length).trim();
    if (await secretEquals(presented, env.KNAG_BEARER_TOKEN)) {
      return { id: OWNER, source: "bearer" };
    }
  }

  const cookie = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  if (cookie) {
    // The stored value is a hash, so lookup is an equality match on a digest rather
    // than a scan-and-compare. There is nothing to compare in constant time here —
    // an attacker who can guess a 256-bit token does not need a timing side channel.
    const tokenHash = await hashToken(cookie);
    const session = await findLiveSession(env, tokenHash);
    if (session) {
      return {
        id: OWNER,
        source: "session",
        // `public_id` is NOT NULL in practice — the migration backfilled every row and
        // `createSession` always sets it — but the column is nullable because SQLite
        // would not let it be added otherwise, so the type says so and this does not
        // pretend to know better.
        ...(session.public_id
          ? { session: { publicId: session.public_id, tokenHash } }
          : {}),
      };
    }
  }

  return null;
}

/**
 * Mint a session and return the `Set-Cookie` value for it.
 *
 * 🔴 Server-set, and that is the whole point. Safari's ITP caps *client*-set cookies
 * at 7 days of inactivity; a `Set-Cookie` from the origin is exempt. A notepad that
 * asks for a passphrase every week is a notepad that stops getting opened, and issue
 * #4 exists to prove this survives the week (ADR-001, spec §4).
 */
export async function issueSession(
  request: Request,
  env: Env,
  deviceLabel: string | null,
  now: Date = new Date(),
): Promise<string> {
  await sweepExpiredSessions(env, now);

  const raw = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 🔴 Generated independently of `raw`, not derived from it. A public id that is any
  // function of the token is a public id that leaks the token to anyone who can invert
  // it, and this one goes in response bodies (#125). Half the width because it names a
  // row rather than guarding one — guessing it grants nothing without a credential.
  const publicId = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await createSession(
    env,
    {
      tokenHash: await hashToken(raw),
      publicId,
      deviceLabel: deviceLabel?.slice(0, MAX_DEVICE_LABEL) || null,
      expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
    },
    now,
  );

  const attributes = [
    `${SESSION_COOKIE}=${raw}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];

  // Secure everywhere real. Omitted only over plain HTTP on loopback, because Safari
  // will not store a Secure cookie there and `wrangler dev` serves http://localhost —
  // so without this, local development of the PWA has no way to log in, on the exact
  // browser this product is built for. Unreachable in any deployed environment:
  // Cloudflare terminates TLS, so a deployed request is never http:.
  if (isSecureContext(request)) attributes.push("Secure");

  return attributes.join("; ");
}

/**
 * The `Set-Cookie` that ends a session in the browser (#125).
 *
 * 🔴 Attributes must match `issueSession` exactly apart from the expiry — a browser
 * matches a deletion cookie on name, Path and Domain, so a mismatched `Path` leaves
 * the original cookie sitting there and the user appears to log out and then does not.
 * The row is deleted server-side regardless, so a browser that ignores this is logged
 * out anyway; this is what stops it sending a dead cookie on every subsequent request.
 */
export function clearSession(request: Request): string {
  const attributes = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (isSecureContext(request)) attributes.push("Secure");
  return attributes.join("; ");
}

function isSecureContext(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  return url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
}

/**
 * 401 with `WWW-Authenticate`, so an MCP client surfaces "authenticate" rather than
 * a silent empty tool list. No detail in the body — a login endpoint that
 * distinguishes its failure modes is a login endpoint that helps enumerate them.
 */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="knag"',
    },
  });
}
