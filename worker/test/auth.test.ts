import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, authenticate, hashToken, secretEquals } from "../src/auth.js";
import { OPERATOR, loginViaMail, operatorSession } from "./users.js";

// Matches vitest.config.ts.
const BEARER = "test-bearer-do-not-use-in-production";

const LOGIN = "https://knag.test/api/login";
const DOC = "https://knag.test/api/doc";

/**
 * The raw session cookie value out of a Set-Cookie header, for reuse as a credential.
 * The code step sets two cookies — the session first, then the cleared request cookie —
 * and `headers.get` joins them, so the first `name=value` is the session's.
 */
function cookieValue(res: Response): string {
  const header = res.headers.get("Set-Cookie") ?? "";
  return header.slice(header.indexOf("=") + 1, header.indexOf(";"));
}

/**
 * The session the login flow mints (#231). The flow itself — the mail, the code, the
 * link, the throttle, the binding — is login.test.ts; what is pinned here is the
 * **cookie** it ends in, because the cookie is what #4 measured and nothing about it
 * may change.
 */
describe("the session the email login mints", () => {
  it("is a session cookie on the code step's response", async () => {
    const res = await loginViaMail();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=`);
  });

  it("sets the cookie attributes the PWA depends on", async () => {
    const cookie = (await loginViaMail()).headers.get("Set-Cookie") ?? "";

    // 🔴 Server-set with a year of Max-Age. Safari ITP caps *client*-set cookies at 7
    // days of inactivity; this exemption is the whole reason login is an endpoint
    // rather than a bit of JS. Issue #4 proves it survives the week for real.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("Secure");
  });

  it("omits Secure only over plain http on loopback", async () => {
    // Safari will not store a Secure cookie over http://localhost, and `wrangler dev`
    // serves exactly that — without this, the PWA cannot be developed locally on the
    // browser it targets. Unreachable in any deployed environment: Cloudflare
    // terminates TLS, so a deployed request is never http:.
    const local = await loginViaMail({ origin: "http://localhost" });
    expect(local.headers.get("Set-Cookie")).not.toContain("Secure");

    const remote = await loginViaMail({ origin: "http://knag.test" });
    expect(remote.headers.get("Set-Cookie")).toContain("Secure");
  });

  it("stores only the hash of the cookie value", async () => {
    const raw = cookieValue(await loginViaMail());

    // Queried directly rather than through store.ts: a test that asks the module
    // under test whether it kept the secret out of the database cannot catch it
    // lying. A dump of this table must not let the holder log in as anyone.
    const rows = await env.DB.prepare("SELECT token_hash FROM sessions").all<{
      token_hash: string;
    }>();

    expect(rows.results).toHaveLength(1);
    const stored = rows.results[0]?.token_hash;
    expect(stored).toBe(await hashToken(raw));
    expect(stored).not.toBe(raw);
  });

  it("records the device label typed on the first screen, capped", async () => {
    // Typed with the email, minted with the code — it rides the login_codes row between.
    await loginViaMail({ deviceLabel: "iphone" });
    const row = await env.DB.prepare("SELECT device_label FROM sessions").first<{
      device_label: string;
    }>();
    expect(row?.device_label).toBe("iphone");
  });

  it("sweeps expired sessions on login", async () => {
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, created_at, expires_at, device_label) VALUES (?, ?, ?, ?)",
    )
      .bind("stale", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z", "ghost")
      .run();

    await loginViaMail();

    const row = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE token_hash = ?")
      .bind("stale")
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("POST /api/login, the surface", () => {
  it("405s a GET rather than treating it as a login attempt", async () => {
    const res = await SELF.fetch(LOGIN);

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

describe("the session cookie as a credential", () => {
  it("authenticates /api/doc", async () => {
    const raw = await operatorSession();

    const res = await SELF.fetch(DOC, { headers: { Cookie: `${SESSION_COOKIE}=${raw}` } });

    expect(res.status).toBe(200);
  });

  it("authorizes a write, recorded as pwa rather than agent", async () => {
    const raw = await operatorSession();

    const res = await SELF.fetch(DOC, {
      method: "PUT",
      headers: { Cookie: `${SESSION_COOKIE}=${raw}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "from the phone", base_version: 1 }),
    });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT source FROM pages WHERE id = 1").first<{
      source: string;
    }>();
    expect(row?.source).toBe("pwa");
  });

  it("survives alongside other cookies in the header", async () => {
    const raw = await operatorSession();

    const res = await SELF.fetch(DOC, {
      headers: { Cookie: `other=1; ${SESSION_COOKIE}=${raw}; trailing=2` },
    });

    expect(res.status).toBe(200);
  });

  it("rejects a forged, unknown, or empty cookie", async () => {
    for (const value of ["forged", "", await hashToken("guess")]) {
      const res = await SELF.fetch(DOC, { headers: { Cookie: `${SESSION_COOKIE}=${value}` } });
      expect(res.status).toBe(401);
    }
  });

  it("rejects the stored hash presented as if it were the token", async () => {
    // The obvious break if lookup ever compared the presented value to itself.
    const raw = await operatorSession();

    const res = await SELF.fetch(DOC, {
      headers: { Cookie: `${SESSION_COOKIE}=${await hashToken(raw)}` },
    });

    expect(res.status).toBe(401);
  });

  it("rejects an expired session even though the sweep has not run", async () => {
    // 🔴 The sweep only runs on login, so an expired row can sit in the table for a
    // year. Expiry has to be enforced at lookup or the session never actually ends.
    const raw = "expired-token-value";
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, created_at, expires_at, device_label) VALUES (?, ?, ?, ?)",
    )
      .bind(await hashToken(raw), "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z", "old-phone")
      .run();

    const res = await SELF.fetch(DOC, { headers: { Cookie: `${SESSION_COOKIE}=${raw}` } });

    expect(res.status).toBe(401);
  });
});

describe("bearer is first-class on every /api/* route", () => {
  it("authenticates reads and writes, recorded as agent", async () => {
    const headers = { Authorization: `Bearer ${BEARER}` };

    expect((await SELF.fetch(DOC, { headers })).status).toBe(200);

    const res = await SELF.fetch(DOC, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "from the agent", base_version: 1 }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT source FROM pages WHERE id = 1").first<{
      source: string;
    }>();
    expect(row?.source).toBe("agent");
  });

  it("wins over a session cookie when both are presented", async () => {
    const raw = await operatorSession();
    const request = new Request(DOC, {
      headers: { Authorization: `Bearer ${BEARER}`, Cookie: `${SESSION_COOKIE}=${raw}` },
    });

    // The static bearer is the operator's and only the operator's (ADR-008 §6).
    expect(await authenticate(request, env)).toEqual({ id: OPERATOR, role: "operator", source: "bearer" });
  });

  it("falls through to the cookie when the bearer is wrong", async () => {
    const raw = await operatorSession();
    const request = new Request(DOC, {
      headers: { Authorization: "Bearer wrong", Cookie: `${SESSION_COOKIE}=${raw}` },
    });

    // Matched rather than deep-equalled: a session principal now also carries its own
    // identity (#125), and this test is about *which credential won*, not about the
    // shape of the object. Deep equality here would fail on every future field.
    expect(await authenticate(request, env)).toMatchObject({ id: OPERATOR, source: "session" });
  });

  it("401s with WWW-Authenticate when nothing is presented", async () => {
    const res = await SELF.fetch(DOC);

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="knag"');
  });
});

describe("secretEquals", () => {
  it("matches only on equality", async () => {
    expect(await secretEquals("hunter2", "hunter2")).toBe(true);
    expect(await secretEquals("hunter2", "hunter3")).toBe(false);
  });

  it("does not throw on differing lengths", async () => {
    // Digesting first is what makes this safe: timingSafeEqual throws on unequal
    // lengths, and the length itself would otherwise leak.
    expect(await secretEquals("a", "a-much-longer-secret-value")).toBe(false);
  });

  it("is false when either side is missing", async () => {
    // Fail closed. An unconfigured KNAG_BEARER_TOKEN must reject every bearer, not
    // accept every bearer.
    expect(await secretEquals(undefined, "x")).toBe(false);
    expect(await secretEquals("x", undefined)).toBe(false);
    expect(await secretEquals("", "")).toBe(false);
  });
});

// ── Log out and device revocation (#125) ─────────────────────────────────────
//
// 🔴 The property under test throughout is that a revoked credential stops working on
// the *next request*, not that a row vanished from a table. A test that asserts the
// DELETE returned 204 and stops there would pass against an implementation that
// deletes the wrong row, so every case here re-presents the cookie afterwards.

const LOGOUT = "https://knag.test/api/logout";
const SESSIONS = "https://knag.test/api/sessions";

/** A live session cookie, labelled so the list has something to distinguish rows by. */
async function session(label: string): Promise<string> {
  return await operatorSession(label);
}

function asSession(url: string, raw: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(url, { ...init, headers: { Cookie: `${SESSION_COOKIE}=${raw}` } });
}

type Listed = { id: string; label: string | null; is_current: boolean };

async function listed(raw: string): Promise<Listed[]> {
  const res = await asSession(SESSIONS, raw);
  return ((await res.json()) as { sessions: Listed[] }).sessions;
}

describe("GET /api/sessions", () => {
  it("refuses anonymous callers", async () => {
    expect((await SELF.fetch(SESSIONS)).status).toBe(401);
  });

  it("lists live devices by label, and marks which one is asking", async () => {
    const phone = await session("iphone");
    const laptop = await session("mac");

    const rows = await listed(laptop);
    const labels = rows.map((r) => r.label);

    expect(labels).toContain("iphone");
    expect(labels).toContain("mac");
    expect(rows.find((r) => r.label === "mac")?.is_current).toBe(true);
    expect(rows.find((r) => r.label === "iphone")?.is_current).toBe(false);
    void phone;
  });

  it("🔴 never puts the token hash in the body", async () => {
    const raw = await session("iphone");
    const hash = await hashToken(raw);

    const body = await (await asSession(SESSIONS, raw)).text();

    // The id is a surrogate precisely so this holds. If it ever fails, the revocation
    // endpoint has become a credential-disclosure endpoint.
    expect(body).not.toContain(hash);
    expect(body).not.toContain(raw);
  });

  it("is first-class for a bearer, which simply has no session of its own", async () => {
    await session("iphone");

    const res = await SELF.fetch(SESSIONS, { headers: { Authorization: `Bearer ${BEARER}` } });
    const rows = ((await res.json()) as { sessions: Listed[] }).sessions;

    expect(res.status).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
    // Not a special case: a bearer holds no session, so no row is "current".
    expect(rows.every((r) => !r.is_current)).toBe(true);
  });
});

describe("POST /api/logout", () => {
  it("🔴 makes the cookie stop working on the next request", async () => {
    const raw = await session("iphone");
    expect((await asSession(DOC, raw)).status).toBe(200);

    const res = await asSession(LOGOUT, raw, { method: "POST" });
    expect(res.status).toBe(204);

    expect((await asSession(DOC, raw)).status).toBe(401);
  });

  it("clears the cookie with attributes that match the one it is replacing", async () => {
    const raw = await session("iphone");

    const header = (await asSession(LOGOUT, raw, { method: "POST" })).headers.get("Set-Cookie");

    // A browser matches a deletion cookie on name and Path. Get Path wrong and the
    // original survives, so the user appears to log out and then does not.
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Path=/");
  });

  it("leaves other devices alone", async () => {
    const phone = await session("iphone");
    const laptop = await session("mac");

    await asSession(LOGOUT, phone, { method: "POST" });

    expect((await asSession(DOC, laptop)).status).toBe(200);
  });

  it("🔴 tells a bearer it has nothing to log out, rather than rejecting it", async () => {
    const res = await SELF.fetch(LOGOUT, {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}` },
    });

    // 400, not 401. The bearer is authenticated fine; it holds no session. A 401 would
    // send an agent off to re-authenticate against a problem re-authenticating cannot
    // fix, and KNAG_BEARER_TOKEN is revoked by rotating the secret instead.
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("KNAG_BEARER_TOKEN");
  });

  it("refuses anonymous callers", async () => {
    expect((await SELF.fetch(LOGOUT, { method: "POST" })).status).toBe(401);
  });
});

describe("DELETE /api/sessions/<id>", () => {
  it("🔴 revokes another device, and that device is 401 on its next request", async () => {
    const phone = await session("iphone");
    const laptop = await session("mac");

    const target = (await listed(laptop)).find((r) => r.label === "iphone");
    const res = await asSession(`${SESSIONS}/${target?.id}`, laptop, { method: "DELETE" });

    expect(res.status).toBe(204);
    expect((await asSession(DOC, phone)).status).toBe(401);
    expect((await asSession(DOC, laptop)).status).toBe(200);
  });

  it("clears the cookie when the row revoked is the caller's own", async () => {
    const raw = await session("iphone");
    const mine = (await listed(raw)).find((r) => r.is_current);

    const res = await asSession(`${SESSIONS}/${mine?.id}`, raw, { method: "DELETE" });

    // Otherwise the browser keeps sending a credential whose row is gone, which reads
    // as "the button did nothing" until the next reload.
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await asSession(DOC, raw)).status).toBe(401);
  });

  it("404s an id that matched nothing, so a typo is not a silent success", async () => {
    const raw = await session("iphone");

    const res = await asSession(`${SESSIONS}/not-a-real-id`, raw, { method: "DELETE" });

    expect(res.status).toBe(404);
  });

  it("refuses anonymous callers", async () => {
    const raw = await session("iphone");
    const mine = (await listed(raw)).find((r) => r.is_current);

    const res = await SELF.fetch(`${SESSIONS}/${mine?.id}`, { method: "DELETE" });

    expect(res.status).toBe(401);
    // And the session it named is still usable, so the refusal was real.
    expect((await asSession(DOC, raw)).status).toBe(200);
  });
});

describe("DELETE /api/sessions — sign out everywhere", () => {
  it("🔴 revokes every other device but keeps the caller signed in", async () => {
    const phone = await session("iphone");
    const ipad = await session("ipad");
    const laptop = await session("mac");

    const res = await asSession(SESSIONS, laptop, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect((await asSession(DOC, phone)).status).toBe(401);
    expect((await asSession(DOC, ipad)).status).toBe(401);
    // The panic button is for a lost phone. Ejecting you from the device in your hand
    // while you are using it is worse than the problem.
    expect((await asSession(DOC, laptop)).status).toBe(200);
  });

  it("takes everything for a bearer, which has no session to spare", async () => {
    const phone = await session("iphone");
    const laptop = await session("mac");

    const res = await SELF.fetch(SESSIONS, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${BEARER}` },
    });

    expect(res.status).toBe(200);
    expect((await asSession(DOC, phone)).status).toBe(401);
    expect((await asSession(DOC, laptop)).status).toBe(401);
  });

  it("refuses anonymous callers", async () => {
    const raw = await session("iphone");

    expect((await SELF.fetch(SESSIONS, { method: "DELETE" })).status).toBe(401);
    expect((await asSession(DOC, raw)).status).toBe(200);
  });
});
