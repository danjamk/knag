import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, readDefaultPage, writePage } from "../src/store.js";

// Matches vitest.config.ts. The suite authenticates as the agent because the
// session-cookie half of auth arrives with issue #3 — bearer is first-class on every
// /api/* route, not an agent afterthought (spec §4.1), so this is the real path.
const BEARER = "test-bearer-do-not-use-in-production";
const URL = "https://knag.test/api/doc";

const authed = { Authorization: `Bearer ${BEARER}` };

function get(headers: HeadersInit = {}): Promise<Response> {
  return SELF.fetch(URL, { headers: { ...authed, ...headers } });
}

function put(payload: unknown, headers: HeadersInit = {}): Promise<Response> {
  return SELF.fetch(URL, {
    method: "PUT",
    headers: { ...authed, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

// The migration seeds (1, '', 1, now, 'system'), so every test starts from version 1
// with an empty body. isolatedStorage undoes each test's writes afterward.
const SEEDED_VERSION = 1;

describe("auth", () => {
  it("401s with WWW-Authenticate when no credential is presented", async () => {
    const res = await SELF.fetch(URL);

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="knag"');
  });

  it("401s on a wrong bearer token", async () => {
    const res = await get({ Authorization: "Bearer not-the-token" });

    expect(res.status).toBe(401);
  });

  it("401s the write path too, before any body parsing", async () => {
    const res = await SELF.fetch(URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x", base_version: SEEDED_VERSION }),
    });

    expect(res.status).toBe(401);
    expect((await readDefaultPage(env)).body).toBe("");
  });
});

describe("GET /api/doc", () => {
  it("returns body, version and updated_at with a matching ETag", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({ body: "", version: SEEDED_VERSION });
    expect(typeof doc.updated_at).toBe("string");
    expect(res.headers.get("ETag")).toBe(`"${SEEDED_VERSION}"`);
  });

  it("405s an unsupported method and says what is allowed", async () => {
    const res = await SELF.fetch(URL, { method: "POST", headers: authed });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, PUT");
  });
});

describe("If-None-Match", () => {
  it("304s with an empty body when the version matches", async () => {
    const res = await get({ "If-None-Match": `"${SEEDED_VERSION}"` });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    // A revalidating client must not lose the version it is holding.
    expect(res.headers.get("ETag")).toBe(`"${SEEDED_VERSION}"`);
  });

  it("200s when the version is stale", async () => {
    const res = await get({ "If-None-Match": '"0"' });

    expect(res.status).toBe(200);
  });

  it("honours a weak tag and a wildcard", async () => {
    expect((await get({ "If-None-Match": `W/"${SEEDED_VERSION}"` })).status).toBe(304);
    expect((await get({ "If-None-Match": "*" })).status).toBe(304);
  });

  it("matches any entry in a list", async () => {
    const res = await get({ "If-None-Match": `"99", "${SEEDED_VERSION}"` });

    expect(res.status).toBe(304);
  });
});

describe("PUT /api/doc", () => {
  it("applies a matching base_version and bumps once", async () => {
    const res = await put({ body: "hello", base_version: SEEDED_VERSION });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: SEEDED_VERSION + 1 });
    expect(res.headers.get("ETag")).toBe(`"${SEEDED_VERSION + 1}"`);

    const doc = await readDefaultPage(env);
    expect(doc.body).toBe("hello");
    expect(doc.version).toBe(SEEDED_VERSION + 1);
  });

  it("records the source as the principal, not as anything the caller claimed", async () => {
    // Deliberately lying in the request body. Spec §5 sketches `source` as a field;
    // it is derived from the credential instead, so this must be ignored.
    await put({ body: "written by an agent", base_version: SEEDED_VERSION, source: "system" });

    const row = await env.DB.prepare("SELECT source FROM pages WHERE id = ?")
      .bind(DEFAULT_PAGE_ID)
      .first<{ source: string }>();
    expect(row?.source).toBe("agent");
  });
});

describe("conflict", () => {
  it("409s a stale base_version and carries enough to re-apply", async () => {
    await put({ body: "first", base_version: SEEDED_VERSION });

    const res = await put({ body: "stale overwrite", base_version: SEEDED_VERSION });

    expect(res.status).toBe(409);
    // The agent contract re-applies intent from exactly this payload. Version alone
    // would cost a second round trip; a retry with the stale body is the data loss
    // this endpoint exists to prevent.
    expect(await res.json()).toMatchObject({
      error: "version_conflict",
      body: "first",
      version: SEEDED_VERSION + 1,
    });
  });

  it("never overwrites and never merges", async () => {
    await put({ body: "the real content", base_version: SEEDED_VERSION });
    await put({ body: "a week-old iPad", base_version: SEEDED_VERSION });

    const doc = await readDefaultPage(env);
    expect(doc.body).toBe("the real content");
    expect(doc.version).toBe(SEEDED_VERSION + 1);
  });

  it("lets exactly one of two simultaneous requests win", async () => {
    const [a, b] = await Promise.all([
      put({ body: "from the phone", base_version: SEEDED_VERSION }),
      put({ body: "from the mac", base_version: SEEDED_VERSION }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    // One bump, not two — the loser must not have applied on top.
    expect((await readDefaultPage(env)).version).toBe(SEEDED_VERSION + 1);
  });

  it("lets exactly one of two writes that both read the same version win", async () => {
    // 🔴 Two requests through SELF.fetch do NOT reach this state — the runtime
    // serializes them, so the second one's *read* already sees the bump and it
    // conflicts before the UPDATE is ever reached. That test therefore pins the
    // base_version check and says nothing about the compare-and-swap.
    //
    // Called directly, the two awaits interleave: both read version 1, both proceed
    // past the base check, and the `AND version = ?` in the UPDATE is the only thing
    // standing between here and a silent overwrite. Weaken that clause and this test
    // returns two `applied` — verified, not assumed.
    const [a, b] = await Promise.all([
      writePage(env, { pageId: DEFAULT_PAGE_ID, body: "from the phone", baseVersion: SEEDED_VERSION, source: "pwa" }),
      writePage(env, { pageId: DEFAULT_PAGE_ID, body: "from the mac", baseVersion: SEEDED_VERSION, source: "agent" }),
    ]);

    expect([a.status, b.status].sort()).toEqual(["applied", "conflict"]);
    expect((await readDefaultPage(env)).version).toBe(SEEDED_VERSION + 1);
  });
});

describe("no-op writes", () => {
  beforeEach(async () => {
    await put({ body: "unchanged", base_version: SEEDED_VERSION });
  });

  it("bumps nothing and leaves updated_at alone", async () => {
    const before = await readDefaultPage(env);

    const res = await put({ body: "unchanged", base_version: before.version });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: before.version });

    const after = await readDefaultPage(env);
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("creates no revision", async () => {
    // Queried directly rather than through store.ts on purpose: a test that asks the
    // module under test whether it behaved cannot catch the module lying.
    //
    // This asserted `count === 0` when #2 wrote it, which was vacuous — nothing wrote
    // revisions yet. #7 made it real and made it fail, which is what it was for.
    const count = async () =>
      (await env.DB.prepare("SELECT count(*) AS n FROM revisions").first<{ n: number }>())?.n;
    const before = await count();

    await put({ body: "unchanged", base_version: SEEDED_VERSION + 1 });

    expect(await count()).toBe(before);
  });
});

describe("first boot (spec §14.5)", () => {
  it("accepts base_version 0 against the empty seeded row", async () => {
    const res = await put({ body: "first ever line", base_version: 0 });

    expect(res.status).toBe(200);
    expect((await readDefaultPage(env)).body).toBe("first ever line");
  });

  it("rejects base_version 0 once there is something to lose", async () => {
    await put({ body: "real content", base_version: SEEDED_VERSION });

    const res = await put({ body: "clobber", base_version: 0 });

    expect(res.status).toBe(409);
    expect((await readDefaultPage(env)).body).toBe("real content");
  });

  it("reads a missing row as empty at version 0, and initialises it", async () => {
    // The defensive path: the migration seeds the row, so this is only reachable if
    // the migration was skipped. Empty must never be confused with a failed read.
    // 🔴 `pages`, because that is what `readPage` reads. While the shadow still existed
    // this could have been written against `documents` and would have passed without ever
    // making the row missing — the defensive path untested, the test green. `documents`
    // is gone as of #155, so the trap is closed, but the reason is worth keeping.
    await env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(DEFAULT_PAGE_ID).run();

    expect(await readDefaultPage(env)).toMatchObject({ body: "", version: 0 });

    const res = await put({ body: "recovered", base_version: 0 });

    expect(res.status).toBe(200);
    expect(await readDefaultPage(env)).toMatchObject({ body: "recovered", version: 1 });
  });
});

describe("byte preservation", () => {
  // Principle 3 of the product, not a style preference: bytes in, bytes out.
  const gnarly = "  leading\r\n\ttab\n\n\n* star\n- dash\ntrailing   \n\n😀 é\n";

  it("round-trips whitespace, CRLF, markers and unicode untouched", async () => {
    await put({ body: gnarly, base_version: SEEDED_VERSION });

    const doc = (await (await get()).json()) as { body: string };
    expect(doc.body).toBe(gnarly);
  });
});

describe("request validation", () => {
  it("400s a body that is not JSON", async () => {
    const res = await SELF.fetch(URL, {
      method: "PUT",
      headers: { ...authed, "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
  });

  it("400s a missing or non-string body", async () => {
    expect((await put({ base_version: SEEDED_VERSION })).status).toBe(400);
    expect((await put({ body: 42, base_version: SEEDED_VERSION })).status).toBe(400);
    expect((await put({ body: null, base_version: SEEDED_VERSION })).status).toBe(400);
  });

  it("accepts an empty string, which is a valid document", async () => {
    await put({ body: "something", base_version: SEEDED_VERSION });

    const res = await put({ body: "", base_version: SEEDED_VERSION + 1 });

    expect(res.status).toBe(200);
    expect((await readDefaultPage(env)).body).toBe("");
  });

  it("400s a base_version that is not a non-negative integer", async () => {
    expect((await put({ body: "x" })).status).toBe(400);
    expect((await put({ body: "x", base_version: "1" })).status).toBe(400);
    expect((await put({ body: "x", base_version: 1.5 })).status).toBe(400);
    expect((await put({ body: "x", base_version: -1 })).status).toBe(400);
  });

  it("413s a body past the size cap", async () => {
    const res = await put({ body: "x".repeat(1_048_577), base_version: SEEDED_VERSION });

    expect(res.status).toBe(413);
    expect((await readDefaultPage(env)).body).toBe("");
  });
});

describe("writePage (store)", () => {
  it("reports a no-op distinctly from an applied write", async () => {
    const applied = await writePage(env, { pageId: DEFAULT_PAGE_ID,
      body: "x",
      baseVersion: SEEDED_VERSION,
      source: "pwa",
    });
    expect(applied.status).toBe("applied");

    const noop = await writePage(env, { pageId: DEFAULT_PAGE_ID,
      body: "x",
      baseVersion: SEEDED_VERSION + 1,
      source: "pwa",
    });
    expect(noop.status).toBe("noop");
  });
});
