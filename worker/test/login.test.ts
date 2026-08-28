import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, hashToken } from "../src/auth.js";
import { CODE_TTL_MS, LOGIN_COOKIE, MAX_ATTEMPTS } from "../src/login.js";
import { outbox } from "../src/mail.js";
import { createUser, findOperator } from "../src/store.js";
import {
  OPERATOR,
  OPERATOR_EMAIL,
  codeIn,
  lastMail,
  linkIn,
  loginViaMail,
  member,
  operatorSession,
  requestCookie,
} from "./users.js";

/**
 * Email login (#231, ADR-008 §2): type your email, get a mail; the mail carries a link
 * and a code; either mints the session.
 *
 * 🔴 Three properties are load-bearing and each has a test whose name starts with the
 * marker: the endpoint says nothing about who exists; the code is bound to the browser
 * that asked; a login on a device with a live session reuses it. The rest is the
 * ordinary shape of the thing.
 *
 * Mail never leaves the isolate: without `RESEND_API_KEY` the Worker pushes it onto
 * `mail.ts`'s outbox, which is what the suite reads. That is the interface ADR-008 §9
 * asked for — the tests read the code out of D1's neighbour, never a mailbox.
 */

const ORIGIN = "https://knag.test";
const LOGIN = `${ORIGIN}/api/login`;
const CODE = `${ORIGIN}/api/login/code`;
const DOC = `${ORIGIN}/api/doc`;

const json = { "Content-Type": "application/json" };

function ask(email: unknown, extra: Record<string, unknown> = {}, headers: HeadersInit = {}) {
  return SELF.fetch(LOGIN, {
    method: "POST",
    headers: { ...json, ...headers },
    body: JSON.stringify({ email, ...extra }),
  });
}

function type(code: string, cookie: string) {
  return SELF.fetch(CODE, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ code }) });
}

function tap(token: string, headers: HeadersInit = {}) {
  return SELF.fetch(`${ORIGIN}/login/${token}`, { redirect: "manual", headers });
}

function sessionCookie(res: Response): string {
  const m = (res.headers.get("Set-Cookie") ?? "").match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  if (!m) throw new Error("no session cookie");
  return `${SESSION_COOKIE}=${m[1]}`;
}

async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /api/login — asking for a mail", () => {
  it("sends one mail carrying a link and a six-digit code, and sets the request cookie", async () => {
    const before = outbox.length;
    const res = await ask(OPERATOR_EMAIL, { device_label: "iphone" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Set-Cookie")).toContain(`${LOGIN_COOKIE}=`);
    expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(res.headers.get("Set-Cookie")).toContain(`Max-Age=${CODE_TTL_MS / 1000}`);

    expect(outbox.length).toBe(before + 1);
    const mail = lastMail();
    expect(mail?.to).toBe(OPERATOR_EMAIL);
    expect(codeIn(mail)).toMatch(/^\d{6}$/);
    expect(mail?.text).toContain(`${ORIGIN}/login/${linkIn(mail)}`);
    // The one line of onboarding the product has (ADR-008 §3).
    expect(mail?.text).toContain("add knag to your home screen first");
  });

  it("🔴 says nothing about who exists: unknown, revoked and known get the same answer", async () => {
    const known = await ask(OPERATOR_EMAIL);
    const before = outbox.length;
    const unknown = await ask("nobody@example.com");
    expect(outbox.length).toBe(before);

    const { user } = await member("gone@example.com");
    await env.DB.prepare("UPDATE users SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), user.id).run();
    const revoked = await ask("gone@example.com");
    expect(outbox.length).toBe(before);

    for (const res of [known, unknown, revoked]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(res.headers.get("Set-Cookie")).toContain(`${LOGIN_COOKIE}=`);
    }
  });

  it("claims the operator's address from the secret on first sight, once", async () => {
    expect((await findOperator(env))?.email).toBeNull();

    await ask(OPERATOR_EMAIL.toUpperCase());
    expect((await findOperator(env))?.email).toBe(OPERATOR_EMAIL);
    expect(lastMail()?.to).toBe(OPERATOR_EMAIL);
  });

  it("throttles a person to one mail a minute and five an hour", async () => {
    const first = outbox.length;
    await ask(OPERATOR_EMAIL);
    expect(outbox.length).toBe(first + 1);

    const res = await ask(OPERATOR_EMAIL);
    // Same 200, same cookie — and no second mail.
    expect(res.status).toBe(200);
    expect(outbox.length).toBe(first + 1);

    // Five older rows inside the hour but outside the minute: the hourly cap holds too.
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    await env.DB.prepare("UPDATE login_codes SET created_at = ? WHERE user_id = ?").bind(stale, OPERATOR).run();
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare(
        "INSERT INTO login_codes (user_id, link_hash, code_hash, request_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(OPERATOR, `l${i}`, "c", `r${i}`, stale, new Date().toISOString())
        .run();
    }
    await ask(OPERATOR_EMAIL);
    expect(outbox.length).toBe(first + 1);
  });

  it("400s a body that is not an address, without a cookie", async () => {
    for (const bad of [12, "", "no-at-sign", "two words@x.y", null]) {
      const res = await ask(bad);
      expect(res.status, String(bad)).toBe(400);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });
});

describe("POST /api/login/code — typing the code", () => {
  it("mints the session and clears the request cookie", async () => {
    const res = await loginViaMail({ deviceLabel: "iphone" });

    expect(res.status).toBe(200);
    const header = res.headers.get("Set-Cookie") ?? "";
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toContain(`${LOGIN_COOKIE}=;`);

    expect((await SELF.fetch(DOC, { headers: { Cookie: sessionCookie(res) } })).status).toBe(200);
    const row = await env.DB.prepare("SELECT device_label FROM sessions").first<{ device_label: string }>();
    expect(row?.device_label).toBe("iphone");
  });

  it("🔴 is bound to the browser that asked: the right code without the cookie is worth nothing", async () => {
    await ask(OPERATOR_EMAIL);
    const code = codeIn(lastMail());

    expect((await type(code, "")).status).toBe(401);
    expect((await type(code, `${LOGIN_COOKIE}=forged`)).status).toBe(401);
    expect(await sessionCount()).toBe(0);
  });

  it("accepts the code with its space, as the mail shows it", async () => {
    const asked = await ask(OPERATOR_EMAIL);
    const code = codeIn(lastMail());
    const res = await type(`${code.slice(0, 3)} ${code.slice(3)}`, requestCookie(asked));
    expect(res.status).toBe(200);
  });

  it("is one attempt closer to dead on every wrong code, and dead after five", async () => {
    const asked = await ask(OPERATOR_EMAIL);
    const cookie = requestCookie(asked);
    const code = codeIn(lastMail());
    const wrong = code === "000000" ? "000001" : "000000";

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const res = await type(wrong, cookie);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
    // Even the right code, now.
    expect((await type(code, cookie)).status).toBe(401);
    expect(await sessionCount()).toBe(0);
  });

  it("works once", async () => {
    const asked = await ask(OPERATOR_EMAIL);
    const cookie = requestCookie(asked);
    const code = codeIn(lastMail());

    expect((await type(code, cookie)).status).toBe(200);
    expect((await type(code, cookie)).status).toBe(401);
    expect(await sessionCount()).toBe(1);
  });

  it("refuses an expired code", async () => {
    const asked = await ask(OPERATOR_EMAIL);
    await env.DB.prepare("UPDATE login_codes SET expires_at = ?").bind("2020-01-01T00:00:00Z").run();

    expect((await type(codeIn(lastMail()), requestCookie(asked))).status).toBe(401);
  });

  it("carries `next` back so the client can finish the consent hand-off", async () => {
    const next = "/oauth/authorize?client_id=x";
    const res = await loginViaMail({ next });
    expect(await res.json()).toEqual({ ok: true, next });

    const junk = await loginViaMail({ next: "https://evil.example/" });
    expect(await junk.json()).toEqual({ ok: true, next: null });
  });
});

describe("GET /login/<token> — tapping the link", () => {
  it("lands on the page with a session, and works once", async () => {
    await ask(OPERATOR_EMAIL);
    const token = linkIn(lastMail());

    const res = await tap(token);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/`);
    expect((await SELF.fetch(DOC, { headers: { Cookie: sessionCookie(res) } })).status).toBe(200);

    const again = await tap(token);
    expect(again.status).toBe(302);
    expect(again.headers.get("Location")).toBe(`${ORIGIN}/?login=expired`);
    expect(again.headers.get("Set-Cookie")).toBeNull();
  });

  it("sends an unknown or expired token to the login screen, which says why", async () => {
    expect((await tap("0".repeat(64))).headers.get("Location")).toBe(`${ORIGIN}/?login=expired`);
    expect((await tap("")).status).not.toBe(200);

    await ask(OPERATOR_EMAIL);
    await env.DB.prepare("UPDATE login_codes SET expires_at = ?").bind("2020-01-01T00:00:00Z").run();
    expect((await tap(linkIn(lastMail()))).headers.get("Location")).toBe(`${ORIGIN}/?login=expired`);
  });

  it("lands on the consent screen when that is what the mail was for", async () => {
    const next = "/oauth/authorize?client_id=x";
    await ask(OPERATOR_EMAIL, { next });
    const res = await tap(linkIn(lastMail()));
    expect(res.headers.get("Location")).toBe(`${ORIGIN}${next}`);
  });

  it("stores only hashes: the table never holds the link, the code or the request token", async () => {
    const asked = await ask(OPERATOR_EMAIL);
    const mail = lastMail();
    const rows = await env.DB.prepare("SELECT link_hash, code_hash, request_hash FROM login_codes").all<Record<string, string>>();
    const stored = Object.values(rows.results[0] ?? {});

    expect(stored).toContain(await hashToken(linkIn(mail)));
    expect(stored).toContain(await hashToken(codeIn(mail)));
    expect(stored).not.toContain(linkIn(mail));
    expect(stored).not.toContain(codeIn(mail));
    expect(stored).not.toContain(requestCookie(asked).split("=")[1]);
  });
});

describe("🔴 a device with a live session keeps it", () => {
  it("reuses the session on the code path — no new row, no new device", async () => {
    const existing = `${SESSION_COOKIE}=${await operatorSession("iphone")}`;
    expect(await sessionCount()).toBe(1);

    const res = await loginViaMail({ cookie: existing });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain(`${SESSION_COOKIE}=`);
    expect(await sessionCount()).toBe(1);
    expect((await SELF.fetch(DOC, { headers: { Cookie: existing } })).status).toBe(200);
  });

  it("reuses it on the link path too", async () => {
    const existing = `${SESSION_COOKIE}=${await operatorSession("mac")}`;
    await ask(OPERATOR_EMAIL);

    const res = await tap(linkIn(lastMail()), { Cookie: existing });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await sessionCount()).toBe(1);
  });

  it("replaces a session that belongs to somebody else — the shared phone", async () => {
    const theirs = await createUser(env, { email: "partner@example.com" });
    const { cookie: partner } = await member("other@example.com");
    void theirs;

    const res = await loginViaMail({ cookie: partner });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=`);

    // The new cookie is the operator's; the partner's row is untouched but not the one
    // this browser now carries.
    const mine = await SELF.fetch(`${ORIGIN}/api/pages`, { headers: { Cookie: sessionCookie(res) } });
    expect(mine.status).toBe(200);
  });
});
