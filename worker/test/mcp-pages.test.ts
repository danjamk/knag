import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, createPage, readDefaultPage, readPage, writePage } from "../src/store.js";

/**
 * The MCP `page` parameter (#153), driven over real JSON-RPC.
 *
 * 🔴 **Two failure modes, and both are the same failure.** An agent's whole-document
 * write landing on a page nobody named destroys that page while preserving every byte of
 * it, so neither "defaults to the current page" nor "falls back when the name is wrong"
 * is survivable. Everything here is about which page the bytes went to.
 *
 * Its own file rather than an addition to `mcp.test.ts`, which is at forty tests.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const MCP = "https://knag.test/mcp";
const ACCEPT = "application/json, text/event-stream";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

let nextId = 1;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await SELF.fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "Content-Type": "application/json",
      Accept: ACCEPT,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  // A tool failure is an `isError` result, never an HTTP error — an agent that gets a
  // 500 has nothing to self-correct from.
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: ToolResult; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

const V1 = 1;

async function shopping(body = "- [ ] milk\n") {
  const page = await createPage(env, { name: "shopping", body, source: "pwa" });
  return page;
}

describe("naming a page", () => {
  it("reads the one you named, not the default", async () => {
    await shopping();
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "today's things\n", baseVersion: V1, source: "pwa" });

    const result = await call("knag_read", { page: "shopping" });

    expect(result.structuredContent).toMatchObject({ body: "- [ ] milk\n", page: "shopping" });
  });

  it("resolves case-insensitively, because a person typed it", async () => {
    await shopping();

    // The name arrives from a human's prompt, not from a picker. `Shopping` and
    // `shopping` are the same page to the person who wrote either one, and the unique
    // index is NOCASE so this can never have two answers.
    expect((await call("knag_read", { page: "SHOPPING" })).structuredContent).toMatchObject({
      page: "shopping",
    });
  });

  it("writes to the one you named, and leaves the other alone", async () => {
    const other = await shopping();

    const result = await call("knag_write", {
      body: "- [ ] milk\n- [ ] eggs\n",
      base_version: V1,
      page: "shopping",
    });

    expect(result.isError).toBeFalsy();
    expect((await readPage(env, other.id))?.body).toBe("- [ ] milk\n- [ ] eggs\n");
    expect((await readDefaultPage(env)).body).toBe("");
  });

  it("wipes the one you named, and leaves the other alone", async () => {
    const other = await shopping("- [x] milk\n- [ ] eggs\n");
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "- [x] keep me\n", baseVersion: V1, source: "pwa" });

    const result = await call("knag_wipe", { base_version: V1, page: "shopping" });

    expect(result.structuredContent).toMatchObject({ wiped_count: 1, page: "shopping" });
    expect((await readPage(env, other.id))?.body).toBe("- [ ] eggs\n");
    // The default page had a checked line too. A wipe that took it would be the exact
    // failure this parameter exists to prevent.
    expect((await readDefaultPage(env)).body).toBe("- [x] keep me\n");
  });

  it("reports history for the one you named", async () => {
    await shopping();
    const result = await call("knag_history", { page: "shopping" });

    expect(result.structuredContent).toMatchObject({ page: "shopping" });
    expect(result.content[0]?.text).toContain('"shopping"');
  });
});

describe("a name that is not a page", () => {
  it("🔴 errors rather than falling back to the default", async () => {
    await shopping();

    const result = await call("knag_read", { page: "shoping" });

    // The typo is the realistic case, and the dangerous one: a silent fall back would
    // have this read today's page and the next write replace it with a shopping list.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no page named "shoping"');
  });

  it("names the pages that do exist, because a wrong name is usually nearly right", async () => {
    await shopping();

    const text = (await call("knag_read", { page: "nope" })).content[0]?.text ?? "";

    expect(text).toContain('"today"');
    expect(text).toContain('"shopping"');
    // 🔴 And there is no tool that lists pages — knag has no index, deliberately. The
    // error *is* the listing, which is the only place an agent can learn the names.
    expect(text).toContain("Nothing was read or written");
  });

  it("🔴 writes nothing at all when the name is wrong", async () => {
    await shopping();
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "do not touch\n", baseVersion: V1, source: "pwa" });

    const result = await call("knag_write", {
      body: "clobbered",
      base_version: 2,
      page: "typo",
    });

    expect(result.isError).toBe(true);
    // Resolution happens before the write, so a miss is inert. Resolving after would
    // make an unrecognised name a coin flip on which page got the body.
    expect((await readDefaultPage(env)).body).toBe("do not touch\n");
  });

  it("🔴 wipes nothing at all when the name is wrong", async () => {
    await shopping();
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "- [x] done\n", baseVersion: V1, source: "pwa" });

    const result = await call("knag_wipe", { base_version: 2, page: "typo" });

    expect(result.isError).toBe(true);
    expect((await readDefaultPage(env)).body).toBe("- [x] done\n");
  });
});

describe("omitting the page", () => {
  it("🔴 behaves exactly as it did before pages existed", async () => {
    // §17's rule: an optional parameter added later is backward-compatible, a required
    // one breaks every deployed Claude Code config the moment this ships — and those
    // configs live on machines nobody is going to edit.
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "the default\n", baseVersion: V1, source: "pwa" });

    const read = await call("knag_read");
    expect(read.structuredContent).toMatchObject({ body: "the default\n", page: "today" });

    const wrote = await call("knag_write", { body: "still the default\n", base_version: 2 });
    expect(wrote.isError).toBeFalsy();
    expect((await readDefaultPage(env)).body).toBe("still the default\n");
  });

  it("🔴 never means `the page you were last looking at`", async () => {
    const other = await shopping();

    // The Worker has no current page. "Current" lives in a browser's localStorage and a
    // bearer token carries no device, so there is nothing here that could make an
    // agent's write follow a phone — asserted so nobody adds one.
    await writePage(env, { pageId: other.id, body: "just written\n", baseVersion: V1, source: "pwa" });

    const read = await call("knag_read");
    expect(read.structuredContent).toMatchObject({ page: "today" });
  });
});

describe("the tool schemas", () => {
  it("🔴 declare `page` as optional on all four", async () => {
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "Content-Type": "application/json",
        Accept: ACCEPT,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }),
    });
    const listed = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }> };
    };

    for (const tool of listed.result.tools) {
      expect(tool.inputSchema.properties, tool.name).toHaveProperty("page");
      // 🔴 The assertion that matters. Required would break every existing config, and
      // it is one keystroke away at all times.
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain("page");
    }
    expect(listed.result.tools).toHaveLength(4);
  });
});
