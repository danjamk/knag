import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LAST_SEEN_STALE_MS, SESSION_COOKIE } from "../src/auth.js";
import { INVITE_TTL_MS } from "../src/login.js";
import {
  MAX_USERS,
  createUser,
  defaultPageFor,
  findUserAny,
  listLiveSessions,
  writePage,
  writeSetting,
} from "../src/store.js";
import { OPERATOR, OPERATOR_EMAIL, lastMail, linkIn, loginViaMail, member } from "./users.js";

/**
 * The operator's routes (#232, ADR-008 §3, §4, §8, §11, §12): invite, change email,
 * revoke, delete, and the table.
 *
 * 🔴 Three things are pinned here that would each fail silently:
 *
 * - A member gets the **same 404** as a route that does not exist. Not a 403 — that
 *   would confirm there is something to be forbidden from.
 * - The invite mail carries a **link and no code**. A code is bound to the browser that
 *   asked, and the browser that asked was the operator's.
 * - A hard delete leaves **no row in any table** for that id. The list of tables is
 *   written out rather than derived, so adding a table with an owner and forgetting it
 *   here is a red test rather than a row that outlives its person.
 */

const API = "https://knag.test/api";
const BEARER = "test-bearer-do-not-use-in-production";
const asOperator = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };

function as(cookie: string): Record<string, string> {
  return { Cookie: cookie, "Content-Type": "application/json" };
}

async function invite(email: string, headers: Record<string, string> = asOperator): Promise<Response> {
  return await SELF.fetch(`${API}/users`, { method: "POST", headers, body: JSON.stringify({ email }) });
}

type Stats = {
  id: number;
  email: string | null;
  role: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  devices: number;
  pages: number;
  sittings: number;
  agent_sittings: number;
  wipes: number;
  items_done: number;
};

async function table(): Promise<{ users: Stats[]; max: number; window_days: number }> {
  const res = await SELF.fetch(`${API}/users`, { headers: asOperator });
  expect(res.status).toBe(200);
  return (await res.json()) as { users: Stats[]; max: number; window_days: number };
}

describe("GET /api/me", () => {
  it("says who the caller is — the bearer is the operator", async () => {
    const res = await SELF.fetch(`${API}/me`, { headers: asOperator });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: OPERATOR, role: "operator", email: null });
  });

  it("a member sees their own role and address", async () => {
    const { user, cookie } = await member("pat@example.com");
    const res = await SELF.fetch(`${API}/me`, { headers: as(cookie) });
    expect(await res.json()).toEqual({ id: user.id, role: "member", email: "pat@example.com" });
  });

  it("401 with nothing", async () => {
    expect((await SELF.fetch(`${API}/me`)).status).toBe(401);
  });
});

describe("🔴 the gate: a member gets the 404 a missing route gets", () => {
  it("on every method, byte for byte", async () => {
    const { cookie } = await member();
    const missing = await SELF.fetch(`${API}/nothing-here`, { headers: as(cookie) });
    const expected = { status: missing.status, body: await missing.text() };
    expect(expected.status).toBe(404);

    for (const [method, path, body] of [
      ["GET", "/users", undefined],
      ["POST", "/users", JSON.stringify({ email: "x@example.com" })],
      ["PATCH", `/users/${OPERATOR}`, JSON.stringify({ email: "x@example.com" })],
      ["DELETE", `/users/${OPERATOR}`, undefined],
      ["DELETE", `/users/${OPERATOR}?hard`, undefined],
    ] as const) {
      const res = await SELF.fetch(`${API}${path}`, { method, headers: as(cookie), ...(body ? { body } : {}) });
      expect({ status: res.status, body: await res.text() }, `${method} ${path}`).toEqual(expected);
    }
  });

  it("401 with no credential at all, like every other route", async () => {
    expect((await SELF.fetch(`${API}/users`)).status).toBe(401);
  });

  it("the operator's session passes the gate too, not only the bearer", async () => {
    const login = await loginViaMail();
    const cookie = login.headers.get("Set-Cookie")?.match(/knag_session=([^;]*)/)?.[1] ?? "";
    const res = await SELF.fetch(`${API}/users`, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/users — invite", () => {
  it("creates the person, their `today`, and sends a link that logs them in", async () => {
    const res = await invite("friend@example.com");
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as { user: { id: number; email: string; role: string } };
    expect(user.role).toBe("member");
    expect(user.email).toBe("friend@example.com");
    expect((await defaultPageFor(env, user.id)).name).toBe("today");

    const mail = lastMail();
    expect(mail?.to).toBe("friend@example.com");
    expect(mail?.subject).toContain("invited");
    expect(mail?.text).toContain("home screen");

    const landed = await SELF.fetch(`https://knag.test/login/${linkIn(mail)}`, { redirect: "manual" });
    expect(landed.status).toBe(302);
    expect(landed.headers.get("Location")).toBe("https://knag.test/");
    const session = landed.headers.get("Set-Cookie") ?? "";
    expect(session).toContain(`${SESSION_COOKIE}=`);

    const cookie = session.match(/knag_session=([^;]*)/)?.[1] ?? "";
    const me = await SELF.fetch(`${API}/me`, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(((await me.json()) as { id: number }).id).toBe(user.id);
  });

  it("🔴 the mail carries a link and no code", async () => {
    await invite("friend@example.com");
    const mail = lastMail();
    expect(mail?.text).toMatch(/\/login\/[0-9a-f]{64}/);
    expect(mail?.text).not.toMatch(/\b\d{3} \d{3}\b/);
    expect(mail?.text).not.toMatch(/code on the screen/);
  });

  it("the link is good for a week, not ten minutes", async () => {
    await invite("friend@example.com");
    const row = await env.DB.prepare("SELECT created_at, expires_at FROM login_codes ORDER BY id DESC LIMIT 1").first<{
      created_at: string;
      expires_at: string;
    }>();
    expect(Date.parse(row?.expires_at ?? "") - Date.parse(row?.created_at ?? "")).toBe(INVITE_TTL_MS);
    expect(lastMail()?.text).toContain(`${INVITE_TTL_MS / 86_400_000} days`);
  });

  it("names the operator once the operator has an address", async () => {
    await loginViaMail(); // claims the operator's address from KNAG_OPERATOR_EMAIL
    await invite("friend@example.com");
    expect(lastMail()?.text).toMatch(new RegExp(`^${OPERATOR_EMAIL} has invited you`));
  });

  it("refuses a malformed address, and an address already here", async () => {
    expect((await invite("not an address")).status).toBe(400);
    expect((await invite("friend@example.com")).status).toBe(201);
    const again = await invite("Friend@Example.com");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("Already here");
  });

  it("a revoked address is refused with the reason, so the operator knows to delete first", async () => {
    const { user } = await member("gone@example.com");
    await SELF.fetch(`${API}/users/${user.id}`, { method: "DELETE", headers: asOperator });
    const res = await invite("gone@example.com");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("revoked");
  });

  it(`🔴 MAX_USERS (${MAX_USERS}) is a tripwire: the next invite is refused, and a revoke frees a place`, async () => {
    for (let i = 1; i < MAX_USERS; i++) await createUser(env, { email: `p${i}@example.com` });
    expect((await table()).users).toHaveLength(MAX_USERS);

    const over = await invite("one-too-many@example.com");
    expect(over.status).toBe(409);
    expect(((await over.json()) as { max: number }).max).toBe(MAX_USERS);
    expect(await findUserAny(env, MAX_USERS + 1)).toBeNull();

    const someone = (await table()).users.find((u) => u.role === "member");
    await SELF.fetch(`${API}/users/${someone?.id}`, { method: "DELETE", headers: asOperator });
    expect((await invite("one-too-many@example.com")).status).toBe(201);
  });
});

describe("PATCH /api/users/<id> — change email", () => {
  it("moves the account to the new address, keeps the pages, and re-invites", async () => {
    const { user } = await member("old@example.com");
    const page = await defaultPageFor(env, user.id);
    await writePage(env, { ownerId: user.id, pageId: page.id, body: "mine\n", baseVersion: page.version, source: "pwa" });

    const res = await SELF.fetch(`${API}/users/${user.id}`, {
      method: "PATCH",
      headers: asOperator,
      body: JSON.stringify({ email: "New@Example.com" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe("new@example.com");
    expect(lastMail()?.to).toBe("new@example.com");
    expect(lastMail()?.subject).toContain("invited");

    // Same id, same page, same text — the person lost the address, not the account.
    const after = await defaultPageFor(env, user.id);
    expect(after.id).toBe(page.id);
    expect(after.body).toBe("mine\n");

    // The old address is nobody's now: asking for a mail there sends nothing.
    const before = lastMail();
    await SELF.fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "old@example.com" }),
    });
    expect(lastMail()).toBe(before);
  });

  it("the same address is a no-op with no mail; another person's is a 409", async () => {
    const { user } = await member("a@example.com");
    await member("b@example.com");
    const before = lastMail();

    const same = await SELF.fetch(`${API}/users/${user.id}`, {
      method: "PATCH",
      headers: asOperator,
      body: JSON.stringify({ email: "A@example.com" }),
    });
    expect(same.status).toBe(200);
    expect(lastMail()).toBe(before);

    const taken = await SELF.fetch(`${API}/users/${user.id}`, {
      method: "PATCH",
      headers: asOperator,
      body: JSON.stringify({ email: "b@example.com" }),
    });
    expect(taken.status).toBe(409);
    expect((await findUserAny(env, user.id))?.email).toBe("a@example.com");
  });

  it("404 for nobody, 409 for a revoked person, 400 for a bad address", async () => {
    const { user } = await member();
    const body = JSON.stringify({ email: "x@example.com" });
    expect((await SELF.fetch(`${API}/users/999`, { method: "PATCH", headers: asOperator, body })).status).toBe(404);
    expect(
      (await SELF.fetch(`${API}/users/${user.id}`, { method: "PATCH", headers: asOperator, body: JSON.stringify({ email: "" }) })).status,
    ).toBe(400);
    await SELF.fetch(`${API}/users/${user.id}`, { method: "DELETE", headers: asOperator });
    expect((await SELF.fetch(`${API}/users/${user.id}`, { method: "PATCH", headers: asOperator, body })).status).toBe(409);
  });
});

describe("DELETE /api/users/<id> — revoke", () => {
  it("🔴 kills a live session mid-poll, keeps the row and the pages", async () => {
    const { user, cookie } = await member();
    expect((await SELF.fetch(`${API}/doc`, { headers: as(cookie) })).status).toBe(200);

    const res = await SELF.fetch(`${API}/users/${user.id}`, { method: "DELETE", headers: asOperator });
    expect(res.status).toBe(204);

    expect((await SELF.fetch(`${API}/doc`, { headers: as(cookie) })).status).toBe(401);
    expect((await findUserAny(env, user.id))?.revoked_at).not.toBeNull();
    expect(await listLiveSessions(env, user.id)).toEqual([]);
    const pages = await env.DB.prepare("SELECT count(*) AS n FROM pages WHERE owner_id = ?").bind(user.id).first<{ n: number }>();
    expect(pages?.n).toBe(1);

    // And no mail reaches them: a revoked address is an unknown one to /api/login.
    const before = lastMail();
    await SELF.fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email }),
    });
    expect(lastMail()).toBe(before);
  });

  it("shows in the table as revoked, with a place freed", async () => {
    const { user } = await member();
    await SELF.fetch(`${API}/users/${user.id}`, { method: "DELETE", headers: asOperator });
    const row = (await table()).users.find((u) => u.id === user.id);
    expect(row?.revoked_at).not.toBeNull();
    expect(row?.devices).toBe(0);
  });

  it("🔴 never the operator — by id, and by self", async () => {
    const res = await SELF.fetch(`${API}/users/${OPERATOR}`, { method: "DELETE", headers: asOperator });
    expect(res.status).toBe(400);
    expect((await findUserAny(env, OPERATOR))?.revoked_at).toBeNull();
    expect((await SELF.fetch(`${API}/users/${OPERATOR}?hard`, { method: "DELETE", headers: asOperator })).status).toBe(400);
    expect(await findUserAny(env, OPERATOR)).not.toBeNull();
  });

  it("404 for nobody", async () => {
    expect((await SELF.fetch(`${API}/users/999`, { method: "DELETE", headers: asOperator })).status).toBe(404);
  });
});

describe("DELETE /api/users/<id>?hard — delete", () => {
  it("🔴 leaves no row in any table for that id", async () => {
    const { user, cookie } = await member();
    const page = await defaultPageFor(env, user.id);
    await writePage(env, { ownerId: user.id, pageId: page.id, body: "- [x] done\n", baseVersion: page.version, source: "pwa" });
    await writeSetting(env, user.id, "agent_instructions", "be brief");
    await SELF.fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email }),
    });
    const revision = await env.DB.prepare("SELECT id FROM revisions WHERE page_id = ? ORDER BY id DESC LIMIT 1")
      .bind(page.id)
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO cleared_items (revision_id, line_text, cleared_at) VALUES (?, ?, ?)")
      .bind(revision?.id, "- [x] done", new Date().toISOString())
      .run();

    const counts = async (): Promise<Record<string, number>> => {
      const q = async (sql: string): Promise<number> =>
        (await env.DB.prepare(sql).bind(user.id).first<{ n: number }>())?.n ?? 0;
      return {
        users: await q("SELECT count(*) AS n FROM users WHERE id = ?"),
        pages: await q("SELECT count(*) AS n FROM pages WHERE owner_id = ?"),
        revisions: await q("SELECT count(*) AS n FROM revisions WHERE page_id IN (SELECT id FROM pages WHERE owner_id = ?)"),
        cleared_items: await q(
          "SELECT count(*) AS n FROM cleared_items WHERE revision_id IN (SELECT r.id FROM revisions r JOIN pages p ON p.id = r.page_id WHERE p.owner_id = ?)",
        ),
        sessions: await q("SELECT count(*) AS n FROM sessions WHERE user_id = ?"),
        login_codes: await q("SELECT count(*) AS n FROM login_codes WHERE user_id = ?"),
        user_settings: await q("SELECT count(*) AS n FROM user_settings WHERE user_id = ?"),
      };
    };
    const before = await counts();
    for (const [name, n] of Object.entries(before)) expect(n, `${name} fixture`).toBeGreaterThan(0);

    const res = await SELF.fetch(`${API}/users/${user.id}?hard`, { method: "DELETE", headers: asOperator });
    expect(res.status).toBe(204);

    expect(await counts()).toEqual(Object.fromEntries(Object.keys(before).map((k) => [k, 0])));
    expect((await SELF.fetch(`${API}/doc`, { headers: as(cookie) })).status).toBe(401);
    // Gone from the table, and the address can be invited again.
    expect((await table()).users.some((u) => u.id === user.id)).toBe(false);
    expect((await invite(user.email ?? "")).status).toBe(201);
  });

  it("the operator's rows are untouched by a member's delete", async () => {
    const { user } = await member();
    const operatorPage = await defaultPageFor(env, OPERATOR);
    await writePage(env, { ownerId: OPERATOR, pageId: operatorPage.id, body: "keep\n", baseVersion: operatorPage.version, source: "pwa" });
    await SELF.fetch(`${API}/users/${user.id}?hard`, { method: "DELETE", headers: asOperator });
    expect((await defaultPageFor(env, OPERATOR)).body).toBe("keep\n");
  });
});

describe("GET /api/users — the table", () => {
  it("one row per person, the operator first, with the counts the free-tier question needs", async () => {
    const { user, cookie } = await member("pat@example.com");
    const page = await defaultPageFor(env, user.id);
    const now = new Date();
    const stale = new Date(now.getTime() - 40 * 86_400_000).toISOString();

    // Two sittings by hand, one by the agent; a wipe; two items done; and one of each
    // outside the window, which must not count.
    await env.DB.prepare(
      `INSERT INTO revisions (page_id, body, version, created_at, source, event_type) VALUES
         (?1, '', 2, ?2, 'pwa', NULL), (?1, '', 3, ?2, 'agent', NULL),
         (?1, '', 4, ?2, 'pwa', 'clear_completed'), (?1, '', 5, ?3, 'pwa', 'clear_completed')`,
    )
      .bind(page.id, now.toISOString(), stale)
      .run();
    const wipe = await env.DB.prepare("SELECT id FROM revisions WHERE page_id = ? AND event_type IS NOT NULL ORDER BY id LIMIT 1")
      .bind(page.id)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO cleared_items (revision_id, line_text, cleared_at) VALUES (?1, 'a', ?2), (?1, 'b', ?2), (?1, 'old', ?3)`,
    )
      .bind(wipe?.id, now.toISOString(), stale)
      .run();
    await SELF.fetch(`${API}/doc`, { headers: as(cookie) }); // heard from: touches last_seen_at

    const body = await table();
    expect(body.max).toBe(MAX_USERS);
    expect(body.window_days).toBe(30);
    expect(body.users.map((u) => u.role)).toEqual(["operator", "member"]);

    const pat = body.users[1];
    expect(pat).toMatchObject({
      id: user.id,
      email: "pat@example.com",
      revoked_at: null,
      devices: 1,
      pages: 1,
      sittings: 3,
      agent_sittings: 1,
      wipes: 1,
      items_done: 2,
    });
    expect(Date.parse(pat?.last_seen_at ?? "")).toBeGreaterThanOrEqual(now.getTime() - 1000);

    // 🔴 No page content, ever. The one string per row is the address.
    for (const row of body.users) {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === "string" && key !== "email" && key !== "role") expect(value, key).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    }
  });

  it("a member's numbers are their own, never the operator's", async () => {
    const { user } = await member();
    const page = await defaultPageFor(env, OPERATOR);
    await writePage(env, { ownerId: OPERATOR, pageId: page.id, body: "a\n", baseVersion: page.version, source: "pwa" });
    const rows = (await table()).users;
    expect(rows.find((u) => u.id === OPERATOR)?.sittings).toBeGreaterThan(0);
    expect(rows.find((u) => u.id === user.id)?.sittings).toBe(0);
  });
});

describe("sessions.last_seen_at", () => {
  const seen = async (publicId: string): Promise<string | null> =>
    (await env.DB.prepare("SELECT last_seen_at FROM sessions WHERE public_id = ?").bind(publicId).first<{ last_seen_at: string | null }>())
      ?.last_seen_at ?? null;

  it("is written on the first request, and not again within the hour", async () => {
    const { user, cookie } = await member();
    const id = `member-${user.id}`;
    expect(await seen(id)).toBeNull();

    await SELF.fetch(`${API}/doc`, { headers: as(cookie) });
    const first = await seen(id);
    expect(first).not.toBeNull();

    await SELF.fetch(`${API}/doc`, { headers: as(cookie) });
    await SELF.fetch(`${API}/pages`, { headers: as(cookie) });
    expect(await seen(id)).toBe(first);
  });

  it("is refreshed once it is an hour stale", async () => {
    const { user, cookie } = await member();
    const id = `member-${user.id}`;
    const old = new Date(Date.now() - LAST_SEEN_STALE_MS - 60_000).toISOString();
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE public_id = ?").bind(old, id).run();

    await SELF.fetch(`${API}/doc`, { headers: as(cookie) });
    expect(Date.parse((await seen(id)) ?? "")).toBeGreaterThan(Date.parse(old));
  });

  it("a bearer touches nothing — it has no row", async () => {
    await SELF.fetch(`${API}/doc`, { headers: asOperator });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE last_seen_at IS NOT NULL").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
