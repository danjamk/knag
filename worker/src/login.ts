import { authenticate, hashToken, isSecureContext, issueSession, readCookie, unauthorized } from "./auth.js";
import { type Env, envName } from "./env.js";
import { inviteMail, loginMail, sendMail } from "./mail.js";
import {
  claimOperatorEmail,
  consumeLoginCode,
  createLoginCode,
  findLoginCodeByLink,
  findLoginCodeByRequest,
  findUserByEmail,
  recentLoginCodes,
  recordLoginAttempt,
  sweepExpiredLoginCodes,
  type LoginCodeRow,
  type UserRow,
} from "./store.js";

/**
 * Email login (#231, ADR-008 §2). Type your email, get a mail; the mail carries a link
 * and a six-digit code, and either one mints the same server-set session cookie the
 * passphrase did.
 *
 * Three handlers:
 *
 *   POST /api/login         { email, device_label?, next? }  → 200, always, and a mail
 *                           if the address is a live person's and not throttled
 *   POST /api/login/code    { code } + the request cookie      → 200 + session
 *   GET  /login/<token>                                       → 302 to the page + session
 *
 * 🔴 `POST /api/login` says nothing about who exists. Known, unknown, revoked and
 * throttled all get the same 200 and the same cookie; the difference is whether a mail
 * goes out, and that is visible only to the inbox. The reason is logged, never returned
 * (spec §4.2's rule, one endpoint over).
 *
 * 🔴 The code is bound to the browser that asked. `LOGIN_COOKIE` is set on the request
 * and its hash is the row's `request_hash`; verification looks the row up *by that
 * cookie*, so a code typed on any other screen matches nothing. Six digits and five
 * attempts are safe only because of that binding, which is why the link — which can be
 * tapped anywhere — is 32 random bytes rather than six digits.
 */

/** The request cookie's name. Ten minutes; cleared when the code is spent. */
export const LOGIN_COOKIE = "knag_login";

/** How long a code and its link stay good. An invite's link (below) gets a week. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** How long an invite link stays good (ADR-008 §3). Long enough to be read on a weekend. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Wrong codes before the row is dead. Five, against a keyspace of a million, bound to one browser. */
export const MAX_ATTEMPTS = 5;

/** One a minute, five an hour, per person. */
const THROTTLE = { perMinute: 1, perHour: 5 };

/** Where an expired or spent link sends you: the login screen, which says why. */
const EXPIRED = "/?login=expired";

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Six digits, zero-padded, from the CSPRNG — never `Math.random`. */
function sixDigits(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String((n ?? 0) % 1_000_000).padStart(6, "0");
}

/**
 * An address as the person typed it, normalised only as far as an identifier needs:
 * trimmed and lowercased. Not validated beyond "has an @ and fits" — a login endpoint
 * that explains what is wrong with an address is describing its own rules to a stranger,
 * and the only address that matters is one already in `users`.
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !email.includes("@") || /\s/.test(email)) return null;
  return email;
}

/** The OAuth hand-off, when it is one — the same rule as `safeNext` in the client. */
function safeNext(raw: unknown): string | null {
  return typeof raw === "string" && raw.startsWith("/oauth/authorize?") ? raw : null;
}

function cookie(request: Request, name: string, value: string, maxAge: number): string {
  const attributes = [`${name}=${value}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (isSecureContext(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export async function requestLogin(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { email: rawEmail, device_label: rawLabel, next: rawNext } = (payload ?? {}) as Record<string, unknown>;
  const email = normaliseEmail(rawEmail);
  if (!email) return Response.json({ error: "email must be an address" }, { status: 400 });

  const now = new Date();
  await sweepExpiredLoginCodes(env, now);

  // The request cookie is minted whatever happens below, so the response for an unknown
  // address is byte-identical to the one for a known one.
  const requestToken = randomHex(32);
  const headers = { "Set-Cookie": cookie(request, LOGIN_COOKIE, requestToken, CODE_TTL_MS / 1000) };

  let user = await findUserByEmail(env, email);
  // The operator's address arrives as a secret, not a row (migration 0009). The first
  // request that names it claims it — once, and only while the row has none.
  if (!user && env.KNAG_OPERATOR_EMAIL && email === env.KNAG_OPERATOR_EMAIL.trim().toLowerCase()) {
    user = await claimOperatorEmail(env, email);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!user) {
    console.warn(`login requested from ${ip} for an address that is not here`);
    return Response.json({ ok: true }, { headers });
  }

  const recent = await recentLoginCodes(env, user.id, now);
  if (recent.lastMinute >= THROTTLE.perMinute || recent.lastHour >= THROTTLE.perHour) {
    console.warn(`login for user ${user.id} throttled (${recent.lastMinute}/min, ${recent.lastHour}/hr) from ${ip}`);
    return Response.json({ ok: true }, { headers });
  }

  const code = sixDigits();
  const linkToken = randomHex(32);
  await createLoginCode(
    env,
    {
      userId: user.id,
      linkHash: await hashToken(linkToken),
      codeHash: await hashToken(code),
      requestHash: await hashToken(requestToken),
      deviceLabel: typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim().slice(0, 64) : null,
      next: safeNext(rawNext),
      ttlMs: CODE_TTL_MS,
    },
    now,
  );

  await sendMail(
    env,
    loginMail({
      to: email,
      origin: new URL(request.url).origin,
      linkToken,
      code,
      minutes: CODE_TTL_MS / 60_000,
      environment: envName(env),
    }),
  );

  return Response.json({ ok: true }, { headers });
}

export async function verifyCode(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const raw = (payload as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" ? raw.replace(/\s+/g, "") : "";

  const requestToken = readCookie(request.headers.get("Cookie"), LOGIN_COOKIE);
  if (!requestToken || !/^\d{6}$/.test(code)) return rejected(request, "no request cookie or malformed code");

  const now = new Date();
  const row = await findLoginCodeByRequest(env, await hashToken(requestToken), now);
  if (!row) return rejected(request, "no live code for this request");
  if (row.attempts >= MAX_ATTEMPTS) return rejected(request, `row ${row.id} exhausted`);

  if ((await hashToken(code)) !== row.code_hash) {
    const attempts = await recordLoginAttempt(env, row.id);
    return rejected(request, `wrong code for row ${row.id} (attempt ${attempts})`);
  }
  if (!(await consumeLoginCode(env, row.id, now))) return rejected(request, `row ${row.id} already spent`);

  const session = await finishLogin(request, env, row, now);
  const headers = new Headers();
  if (session) headers.append("Set-Cookie", session);
  headers.append("Set-Cookie", cookie(request, LOGIN_COOKIE, "", 0));
  return Response.json({ ok: true, next: row.next }, { headers });
}

export async function consumeLink(request: Request, env: Env, token: string): Promise<Response> {
  const now = new Date();
  const row = token ? await findLoginCodeByLink(env, await hashToken(token), now) : null;
  if (!row || !(await consumeLoginCode(env, row.id, now))) {
    console.warn("login link rejected: unknown, expired or already used");
    return Response.redirect(new URL(EXPIRED, request.url).toString(), 302);
  }

  const session = await finishLogin(request, env, row, now);
  const headers = new Headers({ Location: new URL(row.next ?? "/", request.url).toString() });
  if (session) headers.append("Set-Cookie", session);
  return new Response(null, { status: 302, headers });
}

/**
 * Send someone their invite (#232, ADR-008 §3) — the first login mail, with a seven-day
 * link and no code. The row is a normal `login_codes` row so the link is consumed by the
 * same `consumeLink` as any other, and `consumeLoginCode`'s single-use guard applies.
 *
 * 🔴 The code and request halves are filled with random bytes that are hashed and then
 * dropped. Both columns are NOT NULL and UNIQUE, and a row with no code has to satisfy
 * them with values nothing can ever match — never a fixed sentinel, which the unique
 * index would refuse on the second invite and which would be a known value in the
 * table besides.
 *
 * Not throttled: the operator sent it, and change-email sends it again on purpose.
 */
export async function sendInvite(
  env: Env,
  input: { origin: string; user: UserRow; invitedBy: string | null },
  now: Date = new Date(),
): Promise<void> {
  if (!input.user.email) return;
  const linkToken = randomHex(32);
  await createLoginCode(
    env,
    {
      userId: input.user.id,
      linkHash: await hashToken(linkToken),
      codeHash: await hashToken(randomHex(32)),
      requestHash: await hashToken(randomHex(32)),
      deviceLabel: null,
      next: null,
      ttlMs: INVITE_TTL_MS,
    },
    now,
  );
  await sendMail(
    env,
    inviteMail({
      to: input.user.email,
      from: input.invitedBy,
      origin: input.origin,
      linkToken,
      days: INVITE_TTL_MS / 86_400_000,
      environment: envName(env),
    }),
  );
}

/**
 * Mint the session — or don't (ADR-008 §2). A browser that already holds a live session
 * for the same person keeps it: no new row, no new device in the list. That was the
 * spike's second question, and it is answered here by construction. A live session for
 * a *different* person is replaced, which is what a shared phone needs.
 */
async function finishLogin(
  request: Request,
  env: Env,
  row: LoginCodeRow,
  now: Date,
): Promise<string | null> {
  const existing = await authenticate(request, env);
  if (existing?.source === "session" && existing.id === row.user_id) return null;
  return await issueSession(request, env, row.user_id, row.device_label, now);
}

/** One opaque 401 for every way a code can fail. The reason is logged, never returned. */
function rejected(request: Request, reason: string): Response {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  console.warn(`login code rejected from ${ip}: ${reason}`);
  return unauthorized();
}
