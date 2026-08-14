import type { Env } from "./env.js";

/**
 * Authentication. Every route goes through `authenticate()`.
 *
 * 🔴 The contract that matters: this returns a **Principal, not a boolean**, and no
 * handler anywhere asks whether the passphrase matched. Handlers key off
 * `principal.id`.
 *
 * Today `id` is always OWNER — that is the point, not an oversight. A shared
 * passphrase does not survive a second human and would not pass App Store review
 * (ADR-0001, spec §17). Keeping every caller on `principal.id` means replacing the
 * credential scheme later is a change to this file, not to the whole tree.
 *
 * Bearer is first-class on every `/api/*` route, not an agent afterthought: a native
 * wrapper authenticates from the Keychain with a header, never a cookie.
 */

export const OWNER = "dan";

export type Principal = {
  id: string;
  source: "session" | "bearer";
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

/**
 * Resolve a request to a principal, or null.
 *
 * Bearer path is live. The session-cookie path arrives with build-order step 2
 * (spec §13) along with `POST /api/login`; until then the PWA has nothing to log
 * into and only the agent path authenticates.
 */
export async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) {
    const presented = header.slice("Bearer ".length).trim();
    if (await secretEquals(presented, env.KNAG_BEARER_TOKEN)) {
      return { id: OWNER, source: "bearer" };
    }
  }
  return null;
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
