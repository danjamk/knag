import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { inherit, joinEndings, remapEndings, splitEndings, type Endings } from "../src/eol.js";

/** Round-trip a body through the split, unchanged. */
function through(body: string): string {
  const { text, endings } = splitEndings(body);
  return joinEndings(text, endings);
}

describe("splitEndings / joinEndings", () => {
  // 🔴 The same bar `blocks.test.ts` sets, and for the same reason: this sits between the
  // document and the only copy of it. A generator that only emits document-shaped input
  // encodes assumptions; this one encodes none.
  it("round-trips completely arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400, unit: "binary" }), (body) => {
        expect(through(body)).toBe(body);
      }),
      { numRuns: 2000 },
    );
  });

  it("round-trips document-shaped input, LF and CRLF alike", () => {
    const line = fc.constantFrom("- [ ] a", "- [x] b", "  - [ ] c", "* d", "\te", "f   ", "", "```");
    const document = fc
      .tuple(fc.array(line, { maxLength: 30 }), fc.boolean(), fc.boolean())
      .map(([lines, crlf, trailing]) => {
        const body = lines.join("\n") + (trailing ? "\n" : "");
        return crlf ? body.replace(/\n/g, "\r\n") : body;
      });
    fc.assert(
      fc.property(document, (body) => {
        expect(through(body)).toBe(body);
      }),
      { numRuns: 2000 },
    );
  });

  // The point of the whole module: what reaches the editor has no carriage returns in it.
  it("never hands a CRLF to the editor", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400, unit: "binary" }), (body) => {
        expect(splitEndings(body).text).not.toContain("\r\n");
      }),
      { numRuns: 2000 },
    );
  });

  it.each([
    ["all LF", "a\nb\nc\n"],
    ["all CRLF", "a\r\nb\r\nc\r\n"],
    ["mixed, which must survive", "a\r\nb\nc\r\n"],
    ["no trailing newline", "a\r\nb"],
    ["empty", ""],
    ["just a newline", "\n"],
    ["just a carriage return", "\r"],
    ["a lone CR mid-line is content", "a\rb\n"],
    ["a doubled CR keeps one as content", "a\r\r\n"],
    ["CRLF on a blank line", "\r\n\r\n"],
  ])("round-trips %s", (_label, body) => {
    expect(through(body)).toBe(body);
  });

  it("records the endings a mixed document actually has", () => {
    const { text, endings } = splitEndings("a\r\nb\nc\r\n");
    expect(text).toBe("a\nb\nc\n");
    expect([...endings].sort()).toEqual([0, 2]);
  });

  // 🔴 A trailing \r on the final element has no newline after it to describe. Treating it
  // as an ending would invent a \n on the way back — the round-trip property catches this,
  // but only as a mystery, so it is pinned here by name.
  it("treats a trailing CR with no newline after it as content", () => {
    const { text, endings } = splitEndings("a\r");
    expect(text).toBe("a\r");
    expect(endings.size).toBe(0);
  });
});

describe("remapEndings", () => {
  const set = (...lines: number[]): Endings => new Set(lines);

  it("leaves an edit confined to one line alone", () => {
    // Typing inside line 1 of "a\r\nb\nc\r\n".
    expect([...remapEndings(set(0, 2), { from: 1, to: 1, inserted: [] })].sort()).toEqual([0, 2]);
  });

  it("keeps the break after the edited line when its own line is edited", () => {
    // Typing inside line 0, which itself ends CRLF.
    expect([...remapEndings(set(0, 2), { from: 0, to: 0, inserted: [] })].sort()).toEqual([0, 2]);
  });

  it("shifts everything after an inserted line", () => {
    // Enter at the end of line 0: one line becomes two, new break is LF.
    expect([...remapEndings(set(0, 2), { from: 0, to: 0, inserted: [false] })].sort()).toEqual([
      1, 3,
    ]);
  });

  it("inherits on a split, so a CRLF line yields two CRLF lines", () => {
    const endings = set(0, 2);
    const breaks = inherit(endings, 0, 1);
    expect(breaks).toEqual([true]);
    expect([...remapEndings(endings, { from: 0, to: 0, inserted: breaks })].sort()).toEqual([
      0, 1, 3,
    ]);
  });

  it("destroys the breaks inside a deleted range and keeps the one after it", () => {
    // "a\r\nb\r\nc\r\nd\n" — delete lines 0..2 down to one line.
    expect([...remapEndings(set(0, 1, 2), { from: 0, to: 2, inserted: [] })].sort()).toEqual([0]);
  });

  it("leaves endings before the edit untouched", () => {
    expect([...remapEndings(set(0, 5), { from: 3, to: 4, inserted: [] })].sort()).toEqual([0, 4]);
  });

  it("does not invent an ending where there was none", () => {
    expect([...remapEndings(set(), { from: 1, to: 3, inserted: [false, false] })]).toEqual([]);
  });

  // The property that matters more than any single case: an edit inside one line cannot
  // change any other line's ending. That is principle 3 for this module.
  it("never disturbs a line the edit did not touch", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { maxLength: 12 }),
        fc.integer({ min: 0, max: 40 }),
        (lines, edited) => {
          const before: Endings = new Set(lines);
          const after = remapEndings(before, { from: edited, to: edited, inserted: [] });
          for (const line of lines) expect(after.has(line)).toBe(before.has(line));
          expect(after.size).toBe(before.size);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("the whole trip", () => {
  // What the adapter will actually do, end to end, with no CodeMirror in sight.
  it("preserves untouched endings across an edit", () => {
    const body = "alpha\r\nbeta\ngamma\r\n";
    const { text, endings } = splitEndings(body);

    // Replace line 1 ("beta") with "BETA" — the edit CodeMirror would report as
    // from: 1, to: 1 with no new breaks.
    const edited = text.split("\n");
    edited[1] = "BETA";
    const next = remapEndings(endings, { from: 1, to: 1, inserted: [] });

    expect(joinEndings(edited.join("\n"), next)).toBe("alpha\r\nBETA\ngamma\r\n");
  });

  it("keeps a CRLF document CRLF when you press Enter in it", () => {
    const body = "one\r\ntwo\r\n";
    const { text, endings } = splitEndings(body);

    // Enter at the end of line 0.
    const lines = text.split("\n");
    lines.splice(1, 0, "");
    const next = remapEndings(endings, { from: 0, to: 0, inserted: inherit(endings, 0, 1) });

    expect(joinEndings(lines.join("\n"), next)).toBe("one\r\n\r\ntwo\r\n");
  });
});
