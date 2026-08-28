import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID, listPages, readPage, writePage } from "../src/store.js";
import { OPERATOR } from "./users.js";

/**
 * `/api/pages` — create, rename, template, retire (#154).
 *
 * 🔴 **The rule this file defends is that nothing here removes a row.** Deleting a page
 * is what makes "delete does not confirm" either honest or a lie, and there is no undo
 * screen to fall back on (#91 is still ahead). Every delete assertion below checks the
 * revisions as well as the page.
 */

const BEARER = "test-bearer-do-not-use-in-production";
const authed = { Authorization: `Bearer ${BEARER}` };
const PAGES = "https://knag.test/api/pages";

const V1 = 1;

function req(url: string, method: string, payload?: unknown): Promise<Response> {
  return SELF.fetch(url, {
    method,
    headers: { ...authed, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function create(name: string, extra: Record<string, unknown> = {}) {
  return await req(PAGES, "POST", { name, ...extra });
}

describe("auth", () => {
  it("401s every method before doing anything", async () => {
    for (const [method, url] of [
      ["GET", PAGES],
      ["POST", PAGES],
      ["PATCH", `${PAGES}/1`],
      ["DELETE", `${PAGES}/1`],
    ] as const) {
      const res =
        method === "GET"
          ? await SELF.fetch(url)
          : await SELF.fetch(url, { method, body: "{}" });
      expect(res.status, method).toBe(401);
    }
  });
});

describe("listing", () => {
  it("returns the default page and nothing else on a fresh database", async () => {
    const res = await SELF.fetch(PAGES, { headers: authed });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pages: [{ id: DEFAULT_PAGE_ID, name: "today", has_template: false }],
    });
  });

  it("🔴 carries no counts, no timestamps, no bodies", async () => {
    // §7's rule for the selector: anything else you add is a column, and a column is a
    // file manager. The cheapest place to hold that line is a response that cannot carry
    // the data — `has_template` is a boolean the last row needs, not a column.
    const { pages } = (await (await SELF.fetch(PAGES, { headers: authed })).json()) as {
      pages: Array<Record<string, unknown>>;
    };
    expect(Object.keys(pages[0] ?? {}).sort()).toEqual(["has_template", "id", "name"]);
  });
});

describe("creating", () => {
  it("adds a page and returns it", async () => {
    const res = await create("shopping");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "shopping" });
    expect(await listPages(env, OPERATOR)).toHaveLength(2);
  });

  it("starts empty unless a template is named", async () => {
    const res = await create("shopping");
    const { id } = (await res.json()) as { id: number };
    expect((await readPage(env, OPERATOR, id))?.body).toBe("");
  });

  it("🔴 starts empty even when another page has a template", async () => {
    // A template is a page's *reset state*, not a seed for other pages (#165). 1.1.0
    // shipped the second reading, which made the wipe less useful on exactly the pages
    // that need it most — and made a new page inherit a body nobody asked it to.
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "## work\n\n## home\n", baseVersion: V1, source: "pwa" });
    await req(`${PAGES}/${DEFAULT_PAGE_ID}`, "PATCH", { template: "save" });

    const { id } = (await (await create("tuesday")).json()) as { id: number };
    expect((await readPage(env, OPERATOR, id))?.body).toBe("");
  });

  it("🔴 refuses a duplicate name, case-insensitively", async () => {
    await create("shopping");
    const res = await create("SHOPPING");

    // #153 resolves the agent's `page` by name. Two pages a lookup cannot tell apart
    // would make a whole-document write ambiguous against the only copy of a document.
    expect(res.status).toBe(409);
    expect(await listPages(env, OPERATOR)).toHaveLength(2);
  });

  it("refuses a name that is empty, too long, or more than one line", async () => {
    for (const name of ["", "   ", "x".repeat(33), "two\nlines"]) {
      expect((await create(name)).status, JSON.stringify(name)).toBe(400);
    }
  });

  it("🔴 collapses whitespace, so two names cannot look identical", async () => {
    // 🔴 Not a principle-3 violation. "Nothing is normalized" is about the *document*
    // — bytes in, bytes out — and a page name is an identifier. `my  list` and `my list`
    // render identically in the switcher and would be two different pages, which is a
    // trap for a person and worse for an agent resolving by name (#153).
    const res = await create("  my   list  ");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "my list" });

    // And the collapsed form is what the uniqueness index then sees.
    expect((await create("my list")).status).toBe(409);
  });

  it("counts length after collapsing, not before", async () => {
    // 32 characters of name plus padding is a name, not an over-long one.
    const res = await create(`  ${"x".repeat(32)}  `);
    expect(res.status).toBe(201);
  });

  it("🔴 stops at nine, which is the tripwire", async () => {
    for (let n = 2; n <= 9; n++) {
      expect((await create(`page ${n}`)).status).toBe(201);
    }
    expect(await listPages(env, OPERATOR)).toHaveLength(9);

    const res = await create("the tenth");
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("9 pages"),
    });
  });
});

describe("renaming", () => {
  it("changes the name the agent resolves by", async () => {
    const { id } = (await (await create("shoping")).json()) as { id: number };

    const res = await req(`${PAGES}/${id}`, "PATCH", { name: "shopping" });

    expect(res.status).toBe(200);
    expect((await readPage(env, OPERATOR, id))?.name).toBe("shopping");
  });

  it("refuses a name another live page already holds", async () => {
    await create("shopping");
    const { id } = (await (await create("work")).json()) as { id: number };

    expect((await req(`${PAGES}/${id}`, "PATCH", { name: "shopping" })).status).toBe(409);
    expect((await readPage(env, OPERATOR, id))?.name).toBe("work");
  });
});

describe("templates", () => {
  it("saves the current body, and clears it again", async () => {
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: "standing items\n", baseVersion: V1, source: "pwa" });

    await req(`${PAGES}/${DEFAULT_PAGE_ID}`, "PATCH", { template: "save" });
    expect((await listPages(env, OPERATOR))[0]?.has_template).toBe(true);

    await req(`${PAGES}/${DEFAULT_PAGE_ID}`, "PATCH", { template: "clear" });
    expect((await listPages(env, OPERATOR))[0]?.has_template).toBe(false);
  });

  it("rejects anything but save or clear", async () => {
    expect((await req(`${PAGES}/${DEFAULT_PAGE_ID}`, "PATCH", { template: "yes" })).status).toBe(400);
  });
});

describe("🔴 the template is what a wipe returns the page to", () => {
  // The grocery case, which is the whole feature: twenty standing items, you add to
  // them, you shop, you wipe, and the twenty come back unchecked.
  const STANDING = ["- [ ] milk", "- [ ] eggs", ""].join("\n");
  const SHOPPING = ["- [x] milk", "- [x] eggs", "- [x] birthday candles", ""].join("\n");

  async function withTemplate() {
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: STANDING, baseVersion: V1, source: "pwa" });
    await req(`${PAGES}/${DEFAULT_PAGE_ID}`, "PATCH", { template: "save" });
    const page = await readPage(env, OPERATOR, DEFAULT_PAGE_ID);
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: SHOPPING, baseVersion: page?.version ?? 0, source: "pwa" });
    return (await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.version ?? 0;
  }

  async function wipeAll(version: number) {
    return await SELF.fetch("https://knag.test/api/doc/clear-completed", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: version, scope: "all" }),
    });
  }

  it("🔴 resets to the template, byte for byte", async () => {
    const version = await withTemplate();

    expect((await wipeAll(version)).status).toBe(200);

    // Byte for byte, including the trailing newline. A template is a saved body and
    // nothing else, so a reset that normalised anything would be the feature being
    // subtly wrong in a way nothing on screen would show.
    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.body).toBe(STANDING);
  });

  it("brings the standing items back unchecked", async () => {
    const version = await withTemplate();
    await wipeAll(version);

    const body = (await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.body ?? "";
    expect(body).toContain("- [ ] milk");
    expect(body).not.toContain("- [x] milk");
    // And the thing that was only on the list this once is gone.
    expect(body).not.toContain("birthday candles");
  });

  it("still reports what left, not what remains", async () => {
    const version = await withTemplate();

    const res = await wipeAll(version);

    // Everything on the page went and the template was laid down after. A count of what
    // *remains* would report a reset as having done nothing at all.
    //
    // Four, not three: the body ends in a newline, so `parse` yields a trailing blank
    // block and it is a line like any other. That is pre-existing and matches the count
    // inside the control — `wipe page 4` is what you read before you tap it.
    expect(await res.json()).toMatchObject({ wiped_count: 4, cleared_count: 3 });
  });

  it("🔴 the daily sweep never resets", async () => {
    const version = await withTemplate();

    const res = await SELF.fetch("https://knag.test/api/doc/clear-completed", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: version, scope: "completed" }),
    });
    expect(res.status).toBe(200);

    // `completed` means "clear what is done" and runs several times a day. Making it
    // restore lines too would mean a page you swept at noon grew back by itself.
    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.body).toBe("");
  });

  it("empties a page that has no template, as before", async () => {
    await writePage(env, { ownerId: OPERATOR, pageId: DEFAULT_PAGE_ID, body: SHOPPING, baseVersion: V1, source: "pwa" });
    const version = (await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.version ?? 0;

    await wipeAll(version);

    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.body).toBe("");
  });

  it("🔴 resets the page it was asked about, not the one with the template", async () => {
    const version = await withTemplate();
    const other = (await (await create("shopping")).json()) as { id: number };
    await writePage(env, { ownerId: OPERATOR, pageId: other.id, body: "- [x] something\n", baseVersion: V1, source: "pwa" });

    await SELF.fetch("https://knag.test/api/doc/clear-completed", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: V1 + 1, scope: "all", page: other.id }),
    });

    // The other page has no template, so it empties — and today, which does, is untouched.
    expect((await readPage(env, OPERATOR, other.id))?.body).toBe("");
    expect((await readPage(env, OPERATOR, DEFAULT_PAGE_ID))?.version).toBe(version);
  });
});

describe("deleting", () => {
  it("takes the page out of the list", async () => {
    const { id } = (await (await create("shopping")).json()) as { id: number };

    const res = await req(`${PAGES}/${id}`, "DELETE");

    expect(res.status).toBe(200);
    expect((await listPages(env, OPERATOR)).map((p) => p.name)).toEqual(["today"]);
    expect(await readPage(env, OPERATOR, id)).toBeNull();
  });

  it("🔴 keeps every revision it ever had — deletion is not loss", async () => {
    const { id } = (await (await create("shopping")).json()) as { id: number };
    await writePage(env, { ownerId: OPERATOR, pageId: id, body: "- [x] milk\n", baseVersion: V1, source: "pwa" });

    const before = await env.DB.prepare("SELECT count(*) AS n FROM revisions WHERE page_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(before?.n).toBeGreaterThan(0);

    await req(`${PAGES}/${id}`, "DELETE");

    // The revision log is the undo, and that is the sentence that lets the delete control
    // skip a confirmation dialog (principle 4, ADR-003 §5). A hard delete would make it
    // false at exactly the moment it matters, with no undo screen to fall back on.
    const after = await env.DB.prepare("SELECT count(*) AS n FROM revisions WHERE page_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);

    // And recovering it is clearing one column. Asserted so nobody "tidies up" by adding
    // a cascade.
    await env.DB.prepare("UPDATE pages SET deleted_at = NULL WHERE id = ?").bind(id).run();
    expect((await readPage(env, OPERATOR, id))?.body).toBe("- [x] milk\n");
  });

  it("🔴 frees the name, because the unique index is partial", async () => {
    const { id } = (await (await create("shopping")).json()) as { id: number };
    await req(`${PAGES}/${id}`, "DELETE");

    // Delete `shopping` and never be able to make one again would read as a bug, and
    // there is no screen that would explain it.
    expect((await create("shopping")).status).toBe(201);
  });

  it("🔴 refuses the default page", async () => {
    const res = await req(`${PAGES}/${DEFAULT_PAGE_ID}`, "DELETE");

    // Structural rather than policy: the default page is what a request naming no page
    // resolves to, what every MCP tool writes to, and what §14.5's defensive read answers
    // for. "There is always a page" is cheaper to keep than three fallbacks are to get
    // right.
    expect(res.status).toBe(409);
    expect(await readPage(env, OPERATOR, DEFAULT_PAGE_ID)).not.toBeNull();
  });

  it("404s a page that is already gone", async () => {
    const { id } = (await (await create("shopping")).json()) as { id: number };
    await req(`${PAGES}/${id}`, "DELETE");

    expect((await req(`${PAGES}/${id}`, "DELETE")).status).toBe(404);
  });
});

describe("a retired page", () => {
  it("🔴 is invisible to the agent, and to every route", async () => {
    const { id } = (await (await create("shopping")).json()) as { id: number };
    await req(`${PAGES}/${id}`, "DELETE");

    // It must not be reachable by id either — a client holding a stale id gets a 404 and
    // falls back, rather than quietly writing into a page the user deleted.
    expect((await SELF.fetch(`https://knag.test/api/doc?page=${id}`, { headers: authed })).status).toBe(404);
  });
});
