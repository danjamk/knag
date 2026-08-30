import { SELF, env } from "cloudflare:test";
import { SESSION_COOKIE, hashToken } from "../src/auth.js";
import { type Mail, outbox } from "../src/mail.js";
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

// ── Logging in (#231) ────────────────────────────────────────────────────────

/** Matches vitest.config.ts — the address `KNAG_OPERATOR_EMAIL` names. */
export const OPERATOR_EMAIL = "operator@knag.test";

/**
 * A live session for the operator, made directly. For tests that are about *sessions*
 * — the device list, revocation, sign out everywhere — and need several of them: the
 * login flow throttles a person to one mail a minute, and that is the feature, not
 * something a fixture should route around. Returns the raw cookie value.
 */
export async function operatorSession(
  label: string | null = null,
  now: Date = new Date(),
): Promise<string> {
  const raw = `operator-${label ?? "session"}-${crypto.randomUUID()}`;
  await createSession(
    env,
    {
      userId: OPERATOR,
      tokenHash: await hashToken(raw),
      publicId: crypto.randomUUID().replace(/-/g, ""),
      deviceLabel: label,
      expiresAt: new Date(now.getTime() + 31_536_000_000),
    },
    now,
  );
  return raw;
}

/** The most recent mail the Worker would have sent. Under test nothing leaves the isolate. */
export function lastMail(): Mail | undefined {
  return outbox[outbox.length - 1];
}

/** The six digits in a login mail, as typed — no space. */
export function codeIn(mail: Mail | undefined): string {
  const m = mail?.text.match(/\b(\d{3}) (\d{3})\b/);
  if (!m) throw new Error("no code in the mail");
  return `${m[1]}${m[2]}`;
}

/** The link token in a login mail. */
export function linkIn(mail: Mail | undefined): string {
  const m = mail?.text.match(/\/login\/([0-9a-f]{64})/);
  if (!m?.[1]) throw new Error("no link in the mail");
  return m[1];
}

/** The `knag_login` request cookie a `/api/login` response set, as a Cookie header value. */
export function requestCookie(res: Response): string {
  const header = res.headers.get("Set-Cookie") ?? "";
  const m = header.match(/knag_login=([^;]*)/);
  if (!m) throw new Error("no request cookie set");
  return `knag_login=${m[1]}`;
}

/**
 * Log in the way a person does: ask for a mail, read the code out of it, type it.
 * Returns the code step's response — its first `Set-Cookie` is the session.
 */
export async function loginViaMail(
  input: { email?: string; deviceLabel?: string; origin?: string; cookie?: string; next?: string } = {},
): Promise<Response> {
  const origin = input.origin ?? "https://knag.test";
  const asked = await SELF.fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(input.cookie ? { Cookie: input.cookie } : {}) },
    body: JSON.stringify({
      email: input.email ?? OPERATOR_EMAIL,
      device_label: input.deviceLabel,
      next: input.next,
    }),
  });
  if (asked.status !== 200) throw new Error(`login request ${asked.status}`);
  const code = codeIn(lastMail());
  const cookies = [requestCookie(asked), input.cookie].filter(Boolean).join("; ");
  return await SELF.fetch(`${origin}/api/login/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify({ code }),
  });
}
