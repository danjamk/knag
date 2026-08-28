import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AGENT_INSTRUCTIONS, readSetting } from "../src/store.js";
import { OPERATOR } from "./users.js";

/**
 * `/api/settings/agent-instructions` — the one setting the server holds (#190).
 *
 * Free text the operator writes, appended to the MCP server's instructions under a fixed
 * heading (pinned in mcp.test.ts). Every other preference is localStorage; this one is
 * about the account and has to reach a bearer caller with no browser, so it lives in D1
 * behind the same principal gate as every route.
 *
 * 🔴 Never a tool. An agent editing its own instructions is not a feature, and no test
 * here or in mcp.test.ts should ever find one.
 */

const URL_ = "https://knag.test/api/settings/agent-instructions";
const BEARER = "test-bearer-do-not-use-in-production";
const authed = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };

const put = (body: unknown) =>
  SELF.fetch(URL_, { method: "PUT", headers: authed, body: JSON.stringify(body) });

describe("GET /api/settings/agent-instructions", () => {
  it("🔴 refuses an unauthenticated caller", async () => {
    // It is operator context that rides in every agent prompt — page names, standing
    // rules — and not a fact about the deployment. Nothing here answers a stranger.
    expect((await SELF.fetch(URL_)).status).toBe(401);
    expect((await SELF.fetch(URL_, { method: "PUT", body: "{}" })).status).toBe(401);
  });

  it("reads as empty text before anything is written", async () => {
    const res = await SELF.fetch(URL_, { headers: authed });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "" });
  });
});

describe("PUT /api/settings/agent-instructions", () => {
  it("stores the text and reads it back, byte for byte", async () => {
    const text = "`today` is the daily list.\n\nHouse style: lowercase, no exclamation marks.  ";
    const res = await put({ text });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text });

    expect(await readSetting(env, OPERATOR, AGENT_INSTRUCTIONS.key)).toBe(text);
    expect(await (await SELF.fetch(URL_, { headers: authed })).json()).toEqual({ text });
  });

  it("replaces rather than appends, and blank clears", async () => {
    await put({ text: "first" });
    await put({ text: "second" });
    expect(await readSetting(env, OPERATOR, AGENT_INSTRUCTIONS.key)).toBe("second");

    await put({ text: "" });
    expect(await (await SELF.fetch(URL_, { headers: authed })).json()).toEqual({ text: "" });
  });

  it("refuses anything that is not a string, as a 400 rather than a coercion", async () => {
    expect((await put({ text: 42 })).status).toBe(400);
    expect((await put({ text: null })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(
      (await SELF.fetch(URL_, { method: "PUT", headers: authed, body: "not json" })).status,
    ).toBe(400);
  });

  it("🔴 caps the length, because it rides in every conversation's prompt", async () => {
    const atCap = "x".repeat(AGENT_INSTRUCTIONS.max);
    expect((await put({ text: atCap })).status).toBe(200);

    const over = "x".repeat(AGENT_INSTRUCTIONS.max + 1);
    const res = await put({ text: over });
    expect(res.status).toBe(413);
    // And the cap refusal left the previous value standing.
    expect(await readSetting(env, OPERATOR, AGENT_INSTRUCTIONS.key)).toBe(atCap);
  });

  it("405s any other method, naming the two it takes", async () => {
    const res = await SELF.fetch(URL_, { method: "POST", headers: authed, body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, PUT");
  });
});
