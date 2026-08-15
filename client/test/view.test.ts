import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Block, parse, serialize, toggle } from "../../worker/src/blocks.js";
import { VIEW_KEY, readView, rows, writeView } from "../src/view.js";

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
