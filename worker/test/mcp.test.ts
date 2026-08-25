import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth.js";
import {
  AGENT_INSTRUCTIONS,
  DEFAULT_PAGE_ID,
  readDefaultPage,
  writePage,
  writeSetting,
} from "../src/store.js";

/**
 * The MCP server (spec §10, §14.6), driven over real JSON-RPC through `SELF.fetch`.
 *
 * Nothing here calls a tool handler directly. The things most likely to break are the
 * transport, the auth gate and the annotations — none of which a direct call exercises,
 * and all of which surface to an agent as a silent empty tool list rather than an error.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const PASSPHRASE = "test-passphrase-do-not-use-in-production";
const MCP = "https://knag.test/mcp";

/** 🔴 Both types, or the transport 406s. Accept is a list and both are required. */
const ACCEPT = "application/json, text/event-stream";

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function post(body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return SELF.fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "Content-Type": "application/json",
      Accept: ACCEPT,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

let nextId = 1;

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<JsonRpc> {
  const res = await post({ jsonrpc: "2.0", id: nextId++, method, params });
  expect(res.status, `${method} returned ${res.status}`).toBe(200);
  return (await res.json()) as JsonRpc;
}

/**
 * Call a tool and return its result.
 *
 * 🔴 Asserts the HTTP status is 200 even for a failed tool. A tool failure is an
 * `isError` *result*, never an HTTP error — an agent that gets a 500 has nothing to
 * self-correct from (mcp.md §6).
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const response = await rpc("tools/call", { name, arguments: args });
  expect(response.error, `${name} returned a protocol error`).toBeUndefined();
  return response.result as unknown as ToolResult;
}

type ToolSpec = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

async function tools(): Promise<ToolSpec[]> {
  const listed = await rpc("tools/list");
  return (listed.result as { tools: ToolSpec[] }).tools;
}

async function toolNamed(name: string): Promise<ToolSpec> {
  const found = (await tools()).find((tool) => tool.name === name);
  expect(found, `${name} is not registered`).toBeDefined();
  return found as ToolSpec;
}

/** The migration seeds (1, '', 1, now, 'system'). */
const SEEDED_VERSION = 1;

async function loginCookie(): Promise<string> {
  const res = await SELF.fetch("https://knag.test/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: PASSPHRASE, device_label: "browser" }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

describe("auth", () => {
  it("401s with WWW-Authenticate when no credential is presented", async () => {
    // A silent empty tool list is the hardest MCP failure to diagnose. The 401 is what
    // makes a client say "authenticate" instead (mcp.md §8).
    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);

    // 🔴 Asserted by shape, not by string. As of ADR-005 this 401 comes from the
    // OAuth provider rather than knag's `unauthorized()`, and it carries the RFC 9728
    // pointer that lets a connector *start* the handshake instead of merely failing —
    // which is the difference between "add the URL and it works" and the registration
    // error that opened #64. The realm is the provider's and carries no meaning; the
    // metadata URL is the part a client acts on.
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('resource_metadata="https://knag.test/.well-known/');
  });

  it("401s on a wrong bearer token", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: "Bearer not-the-token" },
    );

    expect(res.status).toBe(401);
  });

  it("🔴 refuses a valid session cookie — /mcp is bearer only", async () => {
    // Every other route accepts the cookie. This one must not, and it is a security
    // decision rather than an oversight: mcp.md §8's argument for logging `Origin`
    // instead of blocking it rests on /mcp granting no ambient authority. A cookie IS
    // ambient authority, and accepting it here would quietly invalidate that reasoning.
    const cookie = await loginCookie();
    expect(cookie).toContain(`${SESSION_COOKIE}=`);

    // Same cookie, proven live on a route that does accept it.
    const doc = await SELF.fetch("https://knag.test/api/doc", { headers: { Cookie: cookie } });
    expect(doc.status).toBe(200);

    const res = await SELF.fetch(MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, Cookie: cookie },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
  });

  it("does not block a foreign Origin", async () => {
    // 🔴 claude.ai's web app POSTs here from the browser with Origin: https://claude.ai.
    // A 403 kills the tool-list refresh and reads to the user as "server unavailable".
    // pagevault shipped that block and reverted it within the hour (mcp.md §8).
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Origin: "https://claude.ai" },
    );

    expect(res.status).toBe(200);
  });
});

describe("initialize", () => {
  it("reports the server and negotiates a protocol version", async () => {
    const response = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });

    const result = response.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      instructions?: string;
    };

    expect(result.serverInfo.name).toBe("knag");
    expect(result.serverInfo.version).toBe("0.0.0-test");
    expect(result.protocolVersion).toBeTruthy();
  });

  it("carries the agent contract in instructions", async () => {
    // mcp.md §5: the cross-cutting rules are stated once, here, rather than copied into
    // every description. If this string goes missing, nothing fails — the agent just
    // quietly stops knowing the rules.
    const response = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    const instructions = (response.result as { instructions?: string }).instructions ?? "";

    expect(instructions).toContain("READ IMMEDIATELY BEFORE WRITING");
    expect(instructions).toContain("RE-READ AND RE-APPLY");
    expect(instructions).toContain("REPORT THE DIFF");
    expect(instructions).toContain("Byte-preserve");
  });

  it("carries the voice, so an agent does not narrate in a different one", async () => {
    const response = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    const instructions = (response.result as { instructions?: string }).instructions ?? "";

    expect(instructions).toContain("wiped 6");
    expect(instructions).toContain("exclamation marks");
    expect(instructions).toContain("Successfully cleared 6 completed items!");
  });

  it("🔴 appends the operator's text under a fixed heading, and nothing when blank", async () => {
    // #190. What the contract cannot know — what each page is for, the house style,
    // standing rules — is the operator's to write, and it rides in the same string so
    // every client sees it. Read per request: an edit reaches the next `initialize`.
    const init = {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    };
    const instructionsOf = (r: JsonRpc) =>
      (r.result as { instructions?: string }).instructions ?? "";

    // Blank: the contract and nothing else — no empty heading.
    expect(instructionsOf(await rpc("initialize", init))).not.toContain("The operator adds:");

    await writeSetting(
      env,
      AGENT_INSTRUCTIONS.key,
      "`today` is the daily list; `shopping` is groceries. Never add to today unasked.",
    );
    const instructions = instructionsOf(await rpc("initialize", init));

    // After the contract, not before it or inside it.
    const heading = instructions.indexOf("The operator adds:");
    expect(heading).toBeGreaterThan(instructions.indexOf("REPORT THE DIFF"));
    expect(instructions.slice(heading)).toContain("Never add to today unasked.");

    // Whitespace-only is blank.
    await writeSetting(env, AGENT_INSTRUCTIONS.key, "   \n  ");
    expect(instructionsOf(await rpc("initialize", init))).not.toContain("The operator adds:");
  });

  it("🔴 advertises the mark at an absolute URL on this origin", async () => {
    // `IconSchema.src` is "URL or data URI" and says nothing about what a relative path
    // resolves against. The client fetching it is Claude, not a browser sitting on this
    // origin, so `/icons/…` would be a bet on someone else's base URL — and a connector
    // icon that 404s is indistinguishable from having shipped none.
    const response = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    const icons =
      (response.result as { serverInfo: { icons?: Array<Record<string, unknown>> } }).serverInfo
        .icons ?? [];

    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(String(icon.src).startsWith(new URL(MCP).origin), String(icon.src)).toBe(true);
      expect(icon.mimeType).toBe("image/png");
    }
  });

  it("🔴 names the ground each icon is drawn for, not the ink", async () => {
    // `theme: "dark"` means "designed to sit on a dark background" — so it is the slate
    // board. Backwards, and a dark connector list gets an amber block on a near-white
    // tile, which is exactly the placeholder-looking result the icon exists to avoid.
    const response = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    const icons =
      (response.result as { serverInfo: { icons?: Array<Record<string, unknown>> } }).serverInfo
        .icons ?? [];

    const byTheme = Object.fromEntries(icons.map((icon) => [icon.theme, String(icon.src)]));
    expect(byTheme.dark).toContain("slate");
    expect(byTheme.light).toContain("whiteboard");
  });
});

describe("tools/list", () => {
  it("registers exactly the four tools, and no more", async () => {
    expect((await tools()).map((tool) => tool.name).sort()).toEqual([
      "knag_history",
      "knag_read",
      "knag_wipe",
      "knag_write",
    ]);
  });

  it("gives every tool a title, a description and an output schema", async () => {
    for (const tool of await tools()) {
      expect(tool.title, `${tool.name} has no title`).toBeTruthy();
      expect(tool.outputSchema, `${tool.name} has no outputSchema`).toBeDefined();
      // The description is the cheapest quality lever in an MCP server and the place
      // most of them lose (mcp.md §3). A one-liner does not clear the bar.
      expect((tool.description ?? "").length, `${tool.name} has a thin description`)
        .toBeGreaterThan(200);
    }
  });

  it("🔴 annotates every tool, honestly", async () => {
    // Asserted rather than merely set: hosts drive auto-approve off readOnlyHint and
    // retry warnings off destructiveHint, and an annotation that drifts from what the
    // tool does is worse than an absent one (mcp.md §4).
    const expected = {
      knag_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      knag_history: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      knag_write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      knag_wipe: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    };

    for (const [name, hints] of Object.entries(expected)) {
      const tool = await toolNamed(name);
      expect(tool.annotations, name).toMatchObject({ ...hints, openWorldHint: false });
    }
  });

  it("🔴 never marks a versioned write idempotent", async () => {
    // A second identical call does not repeat the effect — it conflicts. Hosts read
    // this hint to decide whether a blind retry is safe, and a blind retry is exactly
    // what the agent contract forbids.
    for (const name of ["knag_write", "knag_wipe"]) {
      expect((await toolNamed(name)).annotations?.idempotentHint, name).toBe(false);
    }
  });

  it("names the read-before-write rule inside the tools that enforce it", async () => {
    // mcp.md §5 keeps security-critical rules named in the tool as well as in the
    // server instructions, so trimming a description cannot silently drop a guardrail.
    expect((await toolNamed("knag_write")).description).toContain("Read immediately before");
    expect((await toolNamed("knag_read")).description).toContain("before every knag_write");
  });
});

describe("knag_read", () => {
  it("returns the page verbatim, with the version to write against", async () => {
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: "  indented\n\nlast", baseVersion: SEEDED_VERSION, source: "pwa" });

    const result = await call("knag_read");

    expect(result.structuredContent).toEqual({
      body: "  indented\n\nlast",
      version: 2,
      updated_at: expect.any(String),
      // 🔴 Echoed back so a write can name the page it read (#153). The agent contract
      // asks for a diff after every write, and "the page" stops being an answer once
      // there are several.
      page: "today",
    });
  });

  it("returns prose beside the structured payload", async () => {
    const result = await call("knag_read");

    expect(result.structuredContent).toBeDefined();
    expect(result.content[0]?.text).toContain("version 1");
  });
});

describe("knag_write", () => {
  it("replaces the page and reports the new version", async () => {
    const result = await call("knag_write", { body: "written by an agent", base_version: SEEDED_VERSION });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ version: 2, changed: true });
    // Asserted against D1, not against the tool's own report.
    expect((await readDefaultPage(env)).body).toBe("written by an agent");
  });

  it("records the write as coming from the agent", async () => {
    await call("knag_write", { body: "agent wrote this", base_version: SEEDED_VERSION });

    const row = await env.DB.prepare("SELECT source FROM pages WHERE id = 1").first<{
      source: string;
    }>();
    expect(row?.source).toBe("agent");
  });

  it("preserves bytes exactly, including CRLF and trailing whitespace", async () => {
    const awkward = "- [ ] one \r\n\r\n\tindented\t\n";

    await call("knag_write", { body: awkward, base_version: SEEDED_VERSION });

    expect((await readDefaultPage(env)).body).toBe(awkward);
  });

  it("reports an identical body as no change", async () => {
    await call("knag_write", { body: "same", base_version: SEEDED_VERSION });
    const second = await call("knag_write", { body: "same", base_version: 2 });

    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toMatchObject({ version: 2, changed: false });
  });

  it("🔴 returns a conflict as an isError result, not a protocol error", async () => {
    await call("knag_write", { body: "winner", base_version: SEEDED_VERSION });

    const loser = await call("knag_write", { body: "loser", base_version: SEEDED_VERSION });

    expect(loser.isError).toBe(true);
    expect((await readDefaultPage(env)).body).toBe("winner");
  });

  it("🔴 carries the current version AND body in the conflict", async () => {
    // Without the body the agent needs a second round trip, and the agent contract's
    // "re-apply your intent" becomes impossible to follow from the error alone.
    await call("knag_write", { body: "the current page", base_version: SEEDED_VERSION });

    const loser = await call("knag_write", { body: "stale", base_version: SEEDED_VERSION });
    const text = loser.content[0]?.text ?? "";

    expect(text).toContain("version_conflict");
    expect(text).toContain("base_version: 2");
    expect(text).toContain("the current page");
  });

  it("accepts an empty page", async () => {
    await call("knag_write", { body: "something", base_version: SEEDED_VERSION });
    const result = await call("knag_write", { body: "", base_version: 2 });

    expect(result.isError).toBeFalsy();
    expect((await readDefaultPage(env)).body).toBe("");
  });

  it("rejects a missing argument as a result, not a crash", async () => {
    const response = await rpc("tools/call", { name: "knag_write", arguments: { body: "x" } });

    // Either shape is acceptable to an agent; a 500 is not.
    const failed =
      response.error !== undefined || (response.result as ToolResult | undefined)?.isError === true;
    expect(failed).toBe(true);
    expect((await readDefaultPage(env)).body).toBe("");
  });
});

describe("knag_wipe", () => {
  const PAGE = "keep me\n- [x] done one\n- [ ] not done\n  - [X] nested done";

  beforeEach(async () => {
    await writePage(env, { pageId: DEFAULT_PAGE_ID, body: PAGE, baseVersion: SEEDED_VERSION, source: "pwa" });
  });

  it("removes checked items at any indentation and leaves the rest", async () => {
    const result = await call("knag_wipe", { base_version: 2 });

    expect(result.structuredContent).toMatchObject({ wiped_count: 2, version: 3 });
    expect((await readDefaultPage(env)).body).toBe("keep me\n- [ ] not done");
  });

  it("writes the done-record, which is what makes the wipe safe", async () => {
    await call("knag_wipe", { base_version: 2 });

    const { results } = await env.DB.prepare("SELECT line_text FROM cleared_items ORDER BY id").all<{
      line_text: string;
    }>();
    expect(results.map((row) => row.line_text)).toEqual(["- [x] done one", "  - [X] nested done"]);
  });

  it("says wiped N in the machine voice", async () => {
    const result = await call("knag_wipe", { base_version: 2 });

    expect(result.content[0]?.text).toContain("wiped 2");
  });

  it("reports zero rather than erroring when nothing is checked", async () => {
    await call("knag_wipe", { base_version: 2 });
    const again = await call("knag_wipe", { base_version: 3 });

    expect(again.isError).toBeFalsy();
    // 🔴 The empty path still returns structuredContent. Omitting it on a declared
    // outputSchema is a protocol error in the SDK's validator (mcp.md §6).
    expect(again.structuredContent).toMatchObject({ wiped_count: 0 });
  });

  it("returns a conflict as a result and changes nothing", async () => {
    const result = await call("knag_wipe", { base_version: SEEDED_VERSION });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("version_conflict");
    expect((await readDefaultPage(env)).body).toBe(PAGE);
  });

  it("empties the page on scope all", async () => {
    const result = await call("knag_wipe", { base_version: 2, scope: "all" });

    expect(result.structuredContent).toMatchObject({ wiped_count: 4, cleared_count: 2 });
    expect((await readDefaultPage(env)).body).toBe("");
  });

  it("🔴 does not claim unfinished lines as things that got done", async () => {
    // The page has four lines and two checked. An agent reporting "wiped 4" as an
    // achievement would be overstating what the user finished, and `cleared_items` —
    // which /api/history treats as authoritative — must not absorb the other two.
    const result = await call("knag_wipe", { base_version: 2, scope: "all" });

    const { results } = await env.DB.prepare("SELECT line_text FROM cleared_items").all<{
      line_text: string;
    }>();
    expect(results).toHaveLength(2);
    expect(result.content[0]?.text).toContain("2 of them done");
  });

  it("defaults to completed when no scope is given", async () => {
    await call("knag_wipe", { base_version: 2 });

    expect((await readDefaultPage(env)).body).toBe("keep me\n- [ ] not done");
  });

  it("reports zero on an already-empty page rather than wiping nothing loudly", async () => {
    await call("knag_wipe", { base_version: 2, scope: "all" });
    const again = await call("knag_wipe", { base_version: 3, scope: "all" });

    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toMatchObject({ wiped_count: 0 });
  });

  it("tells the agent that scope all takes unfinished work", async () => {
    // The tool description is the only place an agent learns this is not the safe
    // default. A wipe-all that reads as equivalent to wipe-completed is how an agent
    // throws away a week of someone's list while following instructions.
    const tool = await toolNamed("knag_wipe");

    expect(tool.description).toContain("never finished");
    expect(tool.inputSchema?.properties).toHaveProperty("scope");
  });
});

describe("knag_history", () => {
  it("answers the same question as GET /api/history", async () => {
    // 🔴 Both surfaces call `loadHistory`, so this pins that they still do. A second
    // implementation would drift silently and nobody would know which was right.
    const viaTool = await call("knag_history", { since: "2026-03-08", until: "2026-03-08" });

    const viaHttp = await SELF.fetch(
      "https://knag.test/api/history?since=2026-03-08&until=2026-03-08",
      { headers: { Authorization: `Bearer ${BEARER}` } },
    );

    // `page` is the tool's own addition — an agent needs to know which page it is
    // looking at, and the browser already knows. Everything `loadHistory` produced has
    // to match, which is what this test is actually for.
    const { page, ...shared } = viaTool.structuredContent as Record<string, unknown>;
    expect(shared).toEqual(await viaHttp.json());
    expect(page).toBe("today");
  });

  it("🔴 returns structured content for an empty range", async () => {
    const result = await call("knag_history", { since: "2020-01-01", until: "2020-01-07" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ days: [], truncated: false });
    expect(result.content[0]?.text).toContain("nothing between");
  });

  it("reports what changed, grouped by local day", async () => {
    await writePage(
      env,
      { pageId: DEFAULT_PAGE_ID, body: "alpha", baseVersion: SEEDED_VERSION, source: "pwa" },
      new Date("2026-03-08T13:00:00.000Z"),
    );
    await writePage(
      env,
      { pageId: DEFAULT_PAGE_ID, body: "alpha\nbravo", baseVersion: 2, source: "agent" },
      new Date("2026-03-09T04:00:00.000Z"), // 23:00 local on the 8th
    );

    const result = await call("knag_history", { since: "2026-03-08", until: "2026-03-08" });
    const days = (result.structuredContent as { days: Array<{ date: string }> }).days;

    expect(days.map((day) => day.date)).toEqual(["2026-03-08"]);
    expect(result.content[0]?.text).toContain("23:00 agent +1");
  });

  it("defaults to a range rather than requiring one", async () => {
    const result = await call("knag_history");

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveProperty("timezone", "America/Chicago");
  });

  it("returns a bad date as a correctable result, never a 500", async () => {
    const result = await call("knag_history", { since: "yesterday" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid since");
  });

  it("returns an inverted range as a correctable result", async () => {
    const result = await call("knag_history", { since: "2026-03-09", until: "2026-03-07" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid range");
  });
});
