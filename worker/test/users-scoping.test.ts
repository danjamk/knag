import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp.js";
import {
  AGENT_INSTRUCTIONS,
  DEFAULT_PAGE_ID,
  createPage,
  defaultPageFor,
  deletePage,
  findUser,
  listLiveSessions,
  listPages,
  readPage,
  readSetting,
  writePage,
} from "../src/store.js";
import { OPERATOR, member } from "./users.js";

/**
 * Two people, which is the first time any owner predicate can be wrong (#230).
 *
 * 🔴 **Every assertion here would pass on a store with no owner filter at all** if there
 * were one person — which is exactly why there are two. Nothing in the app can invite a
 * second person yet (#232 does), so the second person is made here, by the store, and
 * that is deliberate: shipping the schema without exercising it is shipping an untested
 * schema with a green suite in front of it. pages-scoping.test.ts made the same argument
 * for the second *page* (#152).
 *
 * The failure mode these pin is not an error. It is one person reading another's page.
 * So every route is asked to cross, and the answer has to be the 404 a page that does
 * not exist would get — never the other person's body, and never a different status
 * that would confirm the page is there.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const asOperator = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };
const API = "https://knag.test/api";

function as(cookie: string): Record<string, string> {
  return { Cookie: cookie, "Content-Type": "application/json" };
}

describe("the second person", () => {
  it("arrives with their own empty `today`, and sees only that", async () => {
    const { user, cookie } = await member();

    const res = await SELF.fetch(`${API}/pages`, { headers: as(cookie) });
    const { pages } = (await res.json()) as { pages: Array<{ id: number; name: string }> };
    expect(pages).toHaveLength(1);
    expect(pages[0]?.name).toBe("today");
    expect(pages[0]?.id).not.toBe(DEFAULT_PAGE_ID);

    // Two people, two pages both called `today` — the name index is per owner (0009).
    expect((await listPages(env, OPERATOR)).map((p) => p.name)).toEqual(["today"]);
    expect((await defaultPageFor(env, user.id)).id).toBe(pages[0]?.id);
  });

  it("🔴 a request that names no page lands on *their* default, never the seed row", async () => {
    const { user, cookie } = await member();
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "operator's list\n", baseVersion: 1, source: "pwa" });

    const read = await SELF.fetch(`${API}/doc`, { headers: as(cookie) });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { body: string; id: number }).body).toBe("");

    const write = await SELF.fetch(`${API}/doc`, {
      method: "PUT",
      headers: as(cookie),
      body: JSON.stringify({ body: "friend's list\n", base_version: 1 }),
    });
    expect(write.status).toBe(200);

    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.body).toBe("operator's list\n");
    expect((await defaultPageFor(env, user.id)).body).toBe("friend's list\n");
  });
});

describe("🔴 every route refuses to cross, with the 404 a missing page would get", () => {
  it("GET /api/doc?page=", async () => {
    const { cookie } = await member();
    const res = await SELF.fetch(`${API}/doc?page=${DEFAULT_PAGE_ID}`, { headers: as(cookie) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No such page" });
  });

  it("PUT /api/doc", async () => {
    const { cookie } = await member();
    const res = await SELF.fetch(`${API}/doc`, {
      method: "PUT",
      headers: as(cookie),
      body: JSON.stringify({ body: "overwritten", base_version: 1, page: DEFAULT_PAGE_ID }),
    });
    expect(res.status).toBe(404);
    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.body).toBe("");
  });

  it("POST /api/doc/clear-completed", async () => {
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "- [x] done\n", baseVersion: 1, source: "pwa" });
    const { cookie } = await member();
    const res = await SELF.fetch(`${API}/doc/clear-completed`, {
      method: "POST",
      headers: as(cookie),
      body: JSON.stringify({ base_version: 2, page: DEFAULT_PAGE_ID }),
    });
    expect(res.status).toBe(404);
    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.body).toBe("- [x] done\n");
  });

  it("GET /api/history?page=", async () => {
    const { cookie } = await member();
    const res = await SELF.fetch(`${API}/history?page=${DEFAULT_PAGE_ID}`, { headers: as(cookie) });
    expect(res.status).toBe(404);
  });

  it("PATCH and DELETE /api/pages/<id>", async () => {
    const { cookie } = await member();
    const rename = await SELF.fetch(`${API}/pages/${DEFAULT_PAGE_ID}`, {
      method: "PATCH",
      headers: as(cookie),
      body: JSON.stringify({ name: "stolen" }),
    });
    // The rename path reports "may already exist" as a 409 because it cannot tell gone
    // from taken; what matters is that nothing moved.
    expect([404, 409]).toContain(rename.status);
    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.name).toBe("today");

    const template = await SELF.fetch(`${API}/pages/${DEFAULT_PAGE_ID}`, {
      method: "PATCH",
      headers: as(cookie),
      body: JSON.stringify({ template: "save" }),
    });
    expect(template.status).toBe(404);

    const del = await SELF.fetch(`${API}/pages/${DEFAULT_PAGE_ID}`, { method: "DELETE", headers: as(cookie) });
    expect(del.status).toBe(404);
    expect(await readPage(env, OPERATOR, DEFAULT_PAGE_ID)).not.toBeNull();
  });

  it("PUT /api/pages/order cannot include somebody else's page", async () => {
    const { user, cookie } = await member();
    const mine = (await defaultPageFor(env, user.id)).id;
    const res = await SELF.fetch(`${API}/pages/order`, {
      method: "PUT",
      headers: as(cookie),
      body: JSON.stringify({ ids: [DEFAULT_PAGE_ID, mine] }),
    });
    expect(res.status).toBe(409);
  });

  it("the nine-page cap is per person", async () => {
    const { user, cookie } = await member();
    for (let i = 1; i < 9; i++) {
      await createPage(env, { ownerId: OPERATOR, name: `op ${i}`, source: "pwa" });
    }
    expect(await listPages(env, OPERATOR)).toHaveLength(9);

    const res = await SELF.fetch(`${API}/pages`, {
      method: "POST",
      headers: as(cookie),
      body: JSON.stringify({ name: "mine" }),
    });
    expect(res.status).toBe(201);
    expect(await listPages(env, user.id)).toHaveLength(2);
  });

  it("the default page that cannot be deleted is each person's own oldest", async () => {
    const { user } = await member();
    const theirs = (await defaultPageFor(env, user.id)).id;
    const extra = await createPage(env, { ownerId: user.id, name: "extra", source: "pwa" });

    expect(await deletePage(env, user.id, theirs)).toBe("refused_default");
    expect(await deletePage(env, user.id, extra.id)).toBe("deleted");
    expect(await deletePage(env, user.id, DEFAULT_PAGE_ID)).toBe("not_found");
  });
});

describe("sessions and settings are per person", () => {
  it("the device list shows only your own devices, and you cannot revoke another's", async () => {
    const { cookie } = await member();
    const operatorSessions = await listLiveSessions(env, OPERATOR);
    // The operator's live rows are whatever earlier logins in this test left; the member
    // must not see them either way.
    const res = await SELF.fetch(`${API}/sessions`, { headers: as(cookie) });
    const { sessions } = (await res.json()) as { sessions: Array<{ id: string; is_current: boolean }> };
    expect(sessions.map((s) => s.id)).toEqual([expect.stringMatching(/^member-/)]);
    expect(sessions[0]?.is_current).toBe(true);

    // The operator, by bearer, sees none of the member's rows and cannot revoke them.
    const mine = await SELF.fetch(`${API}/sessions`, { headers: asOperator });
    const list = (await mine.json()) as { sessions: Array<{ id: string }> };
    expect(list.sessions.map((s) => s.id)).toEqual(operatorSessions.map((s) => s.public_id));

    const revoke = await SELF.fetch(`${API}/sessions/${sessions[0]?.id}`, {
      method: "DELETE",
      headers: asOperator,
    });
    expect(revoke.status).toBe(404);
    expect(await SELF.fetch(`${API}/doc`, { headers: as(cookie) })).toHaveProperty("status", 200);
  });

  it("agent instructions are the caller's own", async () => {
    const { user, cookie } = await member();
    const url = `${API}/settings/agent-instructions`;
    await SELF.fetch(url, { method: "PUT", headers: asOperator, body: JSON.stringify({ text: "operator's" }) });
    await SELF.fetch(url, { method: "PUT", headers: as(cookie), body: JSON.stringify({ text: "friend's" }) });

    expect(await (await SELF.fetch(url, { headers: asOperator })).json()).toEqual({ text: "operator's" });
    expect(await (await SELF.fetch(url, { headers: as(cookie) })).json()).toEqual({ text: "friend's" });
    expect(await readSetting(env, user.id, AGENT_INSTRUCTIONS.key)).toBe("friend's");

    // 🔴 The legacy `settings` table is no longer written (#234, release two of three:
    // stop writing the old). 1.7.0 mirrored the operator's text here; this release does
    // not, and the one after drops the table. A row appearing here again means the
    // mirror write came back and the contract migration would land under a live writer.
    const legacy = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(AGENT_INSTRUCTIONS.key)
      .first<{ value: string }>();
    expect(legacy).toBeNull();
  });

  it("a revoked person's session stops resolving, without touching the row", async () => {
    const { user, cookie } = await member();
    expect((await SELF.fetch(`${API}/doc`, { headers: as(cookie) })).status).toBe(200);

    await env.DB.prepare("UPDATE users SET revoked_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), user.id)
      .run();

    expect((await SELF.fetch(`${API}/doc`, { headers: as(cookie) })).status).toBe(401);
    expect(await findUser(env, user.id)).toBeNull();
  });
});

describe("MCP acts as the person behind the token", () => {
  const ACCEPT = "application/json, text/event-stream";

  async function readAs(id: number, page?: string): Promise<{ body: string; page: string } | null> {
    const request = new Request("https://knag.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "knag_read", arguments: page === undefined ? {} : { page } },
      }),
    });
    const res = await handleMcp(request, env, { id, role: "member", source: "bearer" });
    const json = (await res.json()) as {
      result?: { isError?: boolean; structuredContent?: { body: string; page: string } };
    };
    return json.result?.isError ? null : (json.result?.structuredContent ?? null);
  }

  it("🔴 reads the caller's default page, and cannot name another person's", async () => {
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "operator's\n", baseVersion: 1, source: "pwa" });
    await createPage(env, { ownerId: OPERATOR, name: "secret", body: "hidden\n", source: "pwa" });
    const { user } = await member();

    expect((await readAs(user.id))?.body).toBe("");
    expect((await readAs(OPERATOR))?.body).toBe("operator's\n");
    // A page that exists, by name, for somebody else: the error names *their own* pages.
    expect(await readAs(user.id, "secret")).toBeNull();
  });
});
