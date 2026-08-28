import { env } from "cloudflare:test";
import { SESSION_COOKIE, hashToken } from "../src/auth.js";
import { type UserRow, createSession, createUser } from "../src/store.js";

/**
 * The people in the suite (#230).
 *
 * 🔴 `OPERATOR` is migration 0009's seed row, the way `DEFAULT_PAGE_ID` is migration
 * 0004's — a fixture fact the tests may lean on because the migration writes the number
 * explicitly. Nothing in the Worker resolves the operator by it: `auth.ts` asks by role.
 * A test that needs *the operator as the Worker sees them* should go through a login or
 * a bearer, not through this constant.
 */
export const OPERATOR = 1;

/**
 * A second person, with a live session — the first time any owner predicate in
 * `store.ts` can be wrong. Returns the cookie header value to send as them.
 */
export async function member(
  email = "friend@example.com",
  now: Date = new Date(),
): Promise<{ user: UserRow; cookie: string }> {
  const user = await createUser(env, { email }, now);
  const raw = `member-${user.id}-${now.getTime()}`;
  await createSession(
    env,
    {
      userId: user.id,
      tokenHash: await hashToken(raw),
      publicId: `member-${user.id}`,
      deviceLabel: "phone",
      expiresAt: new Date(now.getTime() + 86_400_000),
    },
    now,
  );
  return { user, cookie: `${SESSION_COOKIE}=${raw}` };
}
