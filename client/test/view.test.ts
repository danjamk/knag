import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Block, parse, serialize, setText, toggle } from "../../worker/src/blocks.js";
import { VIEW_KEY, linkify, readView, rows, writeView } from "../src/view.js";

describe("rows (spec §7)", () => {
  it("emits exactly one row per block, in order", () => {
    const body = "- [ ] a\n\n```\ncode\n```\nplain";
    const blocks = parse(body);

    expect(rows(blocks).map((r) => r.kind)).toEqual(["checkbox", "blank", "fence", "text"]);
  });

  it("renders a fenced block as one row carrying the whole block", () => {
    const [row] = rows(parse("```js\none\ntwo\n```"));

    expect(row?.kind).toBe("fence");
    expect(row?.text).toBe("```js\none\ntwo\n```");
  });

  it("shows the task text for a checkbox, not the raw line", () => {
    const [row] = rows(parse("  - [x] buy milk"));

    expect(row).toMatchObject({ kind: "checkbox", text: "buy milk", checked: true });
  });

  it("marks unchecked boxes unchecked and leaves non-checkboxes without the field", () => {
    expect(rows(parse("- [ ] a"))[0]?.checked).toBe(false);
    expect(rows(parse("plain"))[0]?.checked).toBeUndefined();
  });

  it("keeps blank blocks as rows rather than filtering them out", () => {
    // 🔴 The whole reason the mapping is the identity. Skipping blanks makes a row's
    // position stop matching its block index, and everything downstream — toggle,
    // reorder, clear — indexes by position.
    expect(rows(parse("a\n\n\nb"))).toHaveLength(4);
  });

  it("gives every row an index equal to its own position", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: "binary" }), (body) => {
        const result = rows(parse(body));
        result.forEach((row, position) => {
          expect(row.index).toBe(position);
        });
      }),
      { numRuns: 500 },
    );
  });

  it("indexes the block a row was built from, for arbitrary documents", () => {
    // The property that makes tap-to-toggle safe: row N's index selects block N.
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: "binary" }), (body) => {
        const blocks = parse(body);
        for (const row of rows(blocks)) {
          expect(blocks[row.index]?.kind).toBe(row.kind);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("toggling by row index", () => {
  it("rewrites only the tapped block and leaves the rest byte-for-byte", () => {
    const body = "- [ ] a   \n\n```\n- [ ] not a task\n```\n\t* [X] c\t";
    const blocks = parse(body);
    const list = rows(blocks);

    // The last checkbox is row 3 and block 3, but *line 5* — the fence collapsed
    // three lines into one block. Rows are not lines, and I got this index wrong by
    // hand while writing the test, which is the entire case for `rows()` being the
    // identity mapping rather than something a human has to keep in their head.
    expect(list).toHaveLength(4);
    const target = list[3] as { index: number; kind: string };
    expect(target).toMatchObject({ index: 3, kind: "checkbox" });
    expect(blocks[3]?.startLine).toBe(5);

    const edited = blocks.map((b, i) => (i === target.index ? toggle(b) : b));

    expect(serialize(edited)).toBe("- [ ] a   \n\n```\n- [ ] not a task\n```\n\t* [ ] c\t");
  });

  it("never lets a row index select a non-checkbox as a checkbox", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: "binary" }), (body) => {
        const blocks = parse(body);
        for (const row of rows(blocks)) {
          if (row.kind !== "checkbox") continue;
          // Toggling what the row points at must be legal — `toggle` throws otherwise,
          // which is how a drifted index would surface.
          expect(() => toggle(blocks[row.index] as Block)).not.toThrow();
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("view preference (spec §8)", () => {
  function store(initial?: string): { store: Map<string, string>; api: Storage } {
    const map = new Map<string, string>();
    if (initial !== undefined) map.set(VIEW_KEY, initial);
    return {
      store: map,
      api: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
      } as Storage,
    };
  }

  it("defaults to the list view", () => {
    expect(readView(store().api)).toBe("list");
  });

  it("round-trips a saved preference", () => {
    const s = store();
    writeView(s.api, "raw");
    expect(readView(s.api)).toBe("raw");
  });

  it("treats anything unrecognised as list", () => {
    expect(readView(store("nonsense").api)).toBe("list");
    expect(readView(store("").api)).toBe("list");
  });

  it("survives storage being absent entirely", () => {
    expect(readView(undefined)).toBe("list");
    expect(() => writeView(undefined, "raw")).not.toThrow();
  });

  it("survives storage that throws", () => {
    // 🔴 Not hypothetical. Safari throws rather than returning null when storage is
    // blocked — private browsing, or a home-screen PWA whose storage was evicted. An
    // uncaught throw here runs during boot and blanks the whole app, turning a
    // preference lookup into a total outage.
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;

    expect(readView(hostile)).toBe("list");
    expect(() => writeView(hostile, "raw")).not.toThrow();
  });
});

describe("which rows are editable (spec §7)", () => {
  it("marks checkbox and text rows editable, fences and blanks not", () => {
    const blocks = parse("- [ ] a\nplain\n\n```\ncode\n```");
    const editable = Object.fromEntries(rows(blocks).map((r) => [r.kind, r.editable]));

    // Fences span lines and a single-line editor would flatten them; blanks have
    // nothing to edit. Raw view owns both.
    expect(editable).toEqual({ checkbox: true, text: true, blank: false, fence: false });
  });

  it("strips the display-only carriage return from a CRLF document", () => {
    // Invisible in an input, but present — so it would be edited by accident and
    // land back in the document mangled. `setText` re-appends the block's own ending.
    const [checkbox, text] = rows(parse("- [ ] a\r\nplain\r\n"));

    expect(checkbox?.text).toBe("a");
    expect(text?.text).toBe("plain");
  });

  it("round-trips an unedited row back to the identical document", () => {
    // Tapping a row and pressing Enter without typing must be a no-op, including on
    // CRLF and on lines with trailing whitespace.
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: "binary" }), (bodyText) => {
        const blocks = parse(bodyText);
        const next = rows(blocks).reduce(
          (acc, row) =>
            row.editable
              ? acc.map((b, i) => (i === row.index ? { ...b, raw: setText(b, row.text) } : b))
              : acc,
          blocks,
        );
        expect(serialize(next)).toBe(bodyText);
      }),
      { numRuns: 500 },
    );
  });
});

describe("linkify (spec §7)", () => {
  const parts = (text: string) => linkify(text).map((s) => (s.link ? `[${s.value}]` : s.value));

  it("🔴 concatenates back to the input, for arbitrary text", () => {
    // The invariant that matters. A linkifier that eats or trims a character makes
    // the row display something the document does not contain.
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: "binary" }), (text) => {
        expect(linkify(text).map((s) => s.value).join("")).toBe(text);
      }),
      { numRuns: 2000 },
    );
  });

  it("concatenates back for text that actually contains URLs", () => {
    const withUrls = fc
      .array(
        fc.oneof(
          fc.constantFrom("https://example.com", "http://a.b/c?d=e#f", "https://x.com/(y)"),
          fc.constantFrom(" ", "see ", ".", " and ", "(", ")", ""),
        ),
        { maxLength: 12 },
      )
      .map((xs) => xs.join(""));

    fc.assert(
      fc.property(withUrls, (text) => {
        expect(linkify(text).map((s) => s.value).join("")).toBe(text);
      }),
      { numRuns: 2000 },
    );
  });

  it("returns one plain segment when there is no URL", () => {
    expect(linkify("just some text")).toEqual([{ link: false, value: "just some text" }]);
  });

  it("finds a URL anywhere in the row", () => {
    expect(parts("see https://example.com now")).toEqual(["see ", "[https://example.com]", " now"]);
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(parts("read https://example.com.")).toEqual(["read ", "[https://example.com]", "."]);
    expect(parts("a https://example.com, and b")).toEqual([
      "a ",
      "[https://example.com]",
      ", and b",
    ]);
  });

  it("keeps a closing bracket that the URL opened", () => {
    // Wikipedia-style. Dropping it silently produces a link to the wrong page.
    expect(parts("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "[https://en.wikipedia.org/wiki/Foo_(bar)]",
    ]);
  });

  it("drops a closing bracket the URL did not open", () => {
    expect(parts("(https://example.com)")).toEqual(["(", "[https://example.com]", ")"]);
  });

  it("handles several URLs in one row", () => {
    expect(parts("https://a.com and https://b.com")).toEqual([
      "[https://a.com]",
      " and ",
      "[https://b.com]",
    ]);
  });

  it("🔴 does not linkify anything but http and https", () => {
    // A `javascript:` or `data:` URL rendered as an anchor is a click away from
    // executing in the page. The document is written by an agent too.
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "www.example.com",
    ]) {
      expect(linkify(hostile)).toEqual([{ link: false, value: hostile }]);
    }
  });

  it("does not treat markup in the text as markup", () => {
    // Belt and braces: the caller sets textContent, but the segments must carry the
    // characters through untouched rather than escaping or dropping them.
    const nasty = '<img src=x onerror="alert(1)">';
    expect(linkify(nasty)).toEqual([{ link: false, value: nasty }]);
  });
});
