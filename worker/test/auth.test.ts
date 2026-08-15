import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OWNER, SESSION_COOKIE, authenticate, hashToken, secretEquals } from "../src/auth.js";

// Matches vitest.config.ts.
const PASSPHRASE = "test-passphrase-do-not-use-in-production";
const BEARER = "test-bearer-do-not-use-in-production";

const LOGIN = "https://knag.test/api/login";
const DOC = "https://knag.test/api/doc";

function login(payload: unknown, url = LOGIN): Promise<Response> {
  return SELF.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** The raw cookie value out of a Set-Cookie header, for reuse as a credential. */
function cookieValue(res: Response): string {
  const header = res.headers.get("Set-Cookie") ?? "";
  return header.slice(header.indexOf("=") + 1, header.indexOf(";"));
}

describe("POST /api/login", () => {
  it("mints a session on the right passphrase", async () => {
    const res = await login({ passphrase: PASSPHRASE });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=`);
  });

  it("sets the cookie attributes the PWA depends on", async () => {
    const cookie = (await login({ passphrase: PASSPHRASE })).headers.get("Set-Cookie") ?? "";

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
    const local = await login({ passphrase: PASSPHRASE }, "http://localhost/api/login");
    expect(local.headers.get("Set-Cookie")).not.toContain("Secure");

    const remote = await login({ passphrase: PASSPHRASE }, "http://knag.test/api/login");
    expect(remote.headers.get("Set-Cookie")).toContain("Secure");
  });

  it("stores only the hash of the cookie value", async () => {
    const raw = cookieValue(await login({ passphrase: PASSPHRASE }));

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

  it("records an optional device label, capped", async () => {
    await login({ passphrase: PASSPHRASE, device_label: "iphone" });
    const row = await env.DB.prepare("SELECT device_label FROM sessions").first<{
      device_label: string;
    }>();
    expect(row?.device_label).toBe("iphone");

    await login({ passphrase: PASSPHRASE, device_label: "x".repeat(500) });
    const long = await env.DB.prepare(
      "SELECT device_label FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).first<{ device_label: string }>();
    expect(long?.device_label.length).toBe(64);
  });

  it("sweeps expired sessions on login", async () => {
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, created_at, expires_at, device_label) VALUES (?, ?, ?, ?)",
    )
      .bind("stale", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z", "ghost")
      .run();

    await login({ passphrase: PASSPHRASE });

    const row = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE token_hash = ?")
      .bind("stale")
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("failed login", () => {
  // Every path returns the identical opaque 401. An endpoint that distinguishes its
  // failure modes helps enumerate its own state (spec §4.2).
  const cases: Array<[string, unknown]> = [
    ["wrong passphrase", { passphrase: "not-it" }],
    ["no passphrase field", { device_label: "iphone" }],
    ["non-string passphrase", { passphrase: 12345 }],
    ["empty passphrase", { passphrase: "" }],
    ["null body", null],
  ];

  for (const [name, payload] of cases) {
    it(`401s opaquely on ${name}`, async () => {
      const res = await login(payload);

      expect(res.status).toBe(401);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });
  }

  it("401s on a malformed body without leaking the parse error", async () => {
    const res = await SELF.fetch(LOGIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("creates no session on any failure", async () => {
    for (const [, payload] of cases) await login(payload);

    const row = await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("405s a GET rather than treating it as a login attempt", async () => {
    const res = await SELF.fetch(LOGIN);

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

describe("the session cookie as a credential", () => {
  it("authenticates /api/doc", async () => {
    const raw = cookieValue(await login({ passphrase: PASSPHRASE }));

    const res = await SELF.fetch(DOC, { headers: { Cookie: `${SESSION_COOKIE}=${raw}` } });

    expect(res.status).toBe(200);
  });

  it("authorizes a write, recorded as pwa rather than agent", async () => {
    const raw = cookieValue(await login({ passphrase: PASSPHRASE }));

    const res = await SELF.fetch(DOC, {
      method: "PUT",
      headers: { Cookie: `${SESSION_COOKIE}=${raw}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "from the phone", base_version: 1 }),
    });

    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT source FROM documents WHERE id = 1").first<{
      source: string;
    }>();
    expect(row?.source).toBe("pwa");
  });

  it("survives alongside other cookies in the header", async () => {
    const raw = cookieValue(await login({ passphrase: PASSPHRASE }));

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
    const raw = cookieValue(await login({ passphrase: PASSPHRASE }));

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

    const row = await env.DB.prepare("SELECT source FROM documents WHERE id = 1").first<{
      source: string;
    }>();
    expect(row?.source).toBe("agent");
  });

  it("wins over a session cookie when both are presented", async () => {
    const raw = cookieValue(await login({ passphrase: PASSPHRASE }));
    const request = new Request(DOC, {
      headers: { Authorization: `Bearer ${BEARER}`, Cookie: `${SESSION_COOKIE}=${raw}` },
    });

    expect(await authenticate(request, env)).toEqual({ id: OWNER, source: "bearer" });
  });

  it("falls through to the cookie when the bearer is wrong", async () => {
    const raw = cookieValue(await login({ passphrase: PASSPHRASE }));
    const request = new Request(DOC, {
      headers: { Authorization: "Bearer wrong", Cookie: `${SESSION_COOKIE}=${raw}` },
    });

    expect(await authenticate(request, env)).toEqual({ id: OWNER, source: "session" });
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
    // Fail closed. An unconfigured KNAG_PASSPHRASE must reject every login, not
    // accept every login.
    expect(await secretEquals(undefined, "x")).toBe(false);
    expect(await secretEquals("x", undefined)).toBe(false);
    expect(await secretEquals("", "")).toBe(false);
  });
});
