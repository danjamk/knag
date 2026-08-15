import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CHECKBOX, type Block, parse, serialize, toggle } from "../src/blocks.js";

/**
 * The block parser's test suite.
 *
 * 🔴 Written before the parser, deliberately. This module is the likeliest path to a
 * corrupted document in the whole project, and a test written afterward tends to
 * agree with whatever the implementation happens to do. Every expectation here comes
 * from spec §14.1 and §14.2, not from reading blocks.ts.
 */

// ── Generators ───────────────────────────────────────────────────────────────
//
// fc.string() would essentially never emit a fence, a checkbox, or a CRLF, so the
// interesting inputs have to be built from an alphabet of line shapes that actually
// occur in this document. Shrinking is why this is fast-check rather than a
// hand-rolled loop: a 200-line counterexample is useless, a 2-line one is a bug
// report.

const indent = fc.constantFrom("", " ", "  ", "\t", "   \t ");
const marker = fc.constantFrom("-", "*");
const box = fc.constantFrom(" ", "x", "X");
const trailing = fc.constantFrom("", " ", "   ", "\t");
const words = fc.constantFrom("", "buy milk", "a", "call ben", "[x] not a box", "```");

const checkboxLine = fc
  .tuple(indent, marker, box, words, trailing)
  .map(([i, m, b, w, t]) => `${i}${m} [${b}] ${w}${t}`);

/** Deliberately checkbox-*shaped* but not checkboxes. `-[ ]` has no space. */
const nearMissLine = fc.constantFrom(
  "-[ ] no space after marker",
  "- [] empty brackets",
  "- [y] wrong char",
  "+ [ ] wrong marker",
  "-  [ ] two spaces after marker",
  "- [ ]no space after bracket",
  "[ ] no marker at all",
);

const fenceLine = fc
  .tuple(indent, fc.constantFrom("```", "~~~", "````", "~~~~"), fc.constantFrom("", "js", "ts"))
  .map(([i, f, info]) => `${i}${f}${info}`);

const plainLine = fc.constantFrom("hello", "  indented text", "", "   ", "\t", "# heading", "---");

const anyLine = fc.oneof(checkboxLine, nearMissLine, fenceLine, plainLine);

/** A whole document. CRLF is applied to the joined string, as a real editor would. */
const document = fc
  .tuple(fc.array(anyLine, { maxLength: 30 }), fc.boolean(), fc.boolean())
  .map(([lines, crlf, trailingNewline]) => {
    const body = lines.join("\n") + (trailingNewline ? "\n" : "");
    return crlf ? body.replace(/\n/g, "\r\n") : body;
  });

// ── The property that matters ────────────────────────────────────────────────

describe("round trip", () => {
  it("serialize(parse(x)) === x for arbitrary documents", () => {
    fc.assert(
      fc.property(document, (body) => {
        expect(serialize(parse(body))).toBe(body);
      }),
      { numRuns: 2000 },
    );
  });

  it("holds for completely arbitrary strings, not only document-shaped ones", () => {
    // The generator above encodes assumptions about what a document looks like. This
    // one encodes none — it is the check that those assumptions were not load-bearing.
    fc.assert(
      fc.property(fc.string({ maxLength: 400, unit: "binary" }), (body) => {
        expect(serialize(parse(body))).toBe(body);
      }),
      { numRuns: 2000 },
    );
  });

  it("covers every byte of the source exactly once, in order", () => {
    // Round-trip alone can be satisfied by a parser that loses a line and duplicates
    // another. Line accounting cannot.
    fc.assert(
      fc.property(document, (body) => {
        const blocks = parse(body);
        const lineCount = body.split("\n").length;

        let expected = 0;
        for (const b of blocks) {
          expect(b.startLine).toBe(expected);
          expect(b.endLine).toBeGreaterThanOrEqual(b.startLine);
          expected = b.endLine + 1;
        }
        expect(expected).toBe(lineCount);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("round trip — the specific shapes the spec calls out", () => {
  const cases: Array<[string, string]> = [
    ["empty document", ""],
    ["single newline", "\n"],
    ["trailing newline", "buy milk\n"],
    ["no trailing newline", "buy milk"],
    ["many trailing newlines", "a\n\n\n\n"],
    ["CRLF throughout", "- [ ] a\r\n- [x] b\r\n"],
    ["mixed CRLF and LF", "a\r\nb\nc\r\n"],
    ["lone carriage returns", "a\rb"],
    ["unclosed fence", "text\n```js\ncode\nmore code"],
    ["closed fence", "```\ncode\n```\nafter"],
    ["tilde fence", "~~~\ncode\n~~~"],
    ["fence containing the other marker", "```\n~~~\n```"],
    ["indented fence", "  ```\n  code\n  ```"],
    ["mixed indentation", "- [ ] a\n\t- [ ] b\n    - [ ] c"],
    ["trailing whitespace everywhere", "- [ ] a   \n  \nb\t\n"],
    ["only whitespace", "   \n\t\n"],
    ["unicode", "- [x] café 😀 — em dash\n"],
    ["a lone fence marker", "```"],
    ["nothing but newlines", "\n\n\n"],
  ];

  for (const [name, body] of cases) {
    it(name, () => {
      expect(serialize(parse(body))).toBe(body);
    });
  }
});

// ── Block model ──────────────────────────────────────────────────────────────

describe("block model (spec §14.1)", () => {
  it("makes a fenced block one block spanning many lines", () => {
    // The failure this prevents: rows indexed into the line array scramble the
    // document on the first reorder involving a code block.
    const blocks = parse("before\n```js\nline one\nline two\n```\nafter");

    expect(blocks.map((b) => b.kind)).toEqual(["text", "fence", "text"]);
    expect(blocks[1]?.raw).toBe("```js\nline one\nline two\n```");
    expect(blocks[1]?.startLine).toBe(1);
    expect(blocks[1]?.endLine).toBe(4);
  });

  it("closes an unclosed fence at EOF and marks it unterminated", () => {
    const blocks = parse("```\ncode\nmore");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("fence");
    expect(blocks[0]?.unterminated).toBe(true);
  });

  it("does not mark a closed fence unterminated", () => {
    expect(parse("```\ncode\n```")[0]?.unterminated).toBeUndefined();
  });

  it("does not close a backtick fence with a tilde fence", () => {
    const blocks = parse("```\n~~~\n```");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("fence");
    expect(blocks[0]?.unterminated).toBeUndefined();
  });

  it("treats each blank line as its own block so spacing survives a reorder", () => {
    const blocks = parse("a\n\n\nb");

    expect(blocks.map((b) => b.kind)).toEqual(["text", "blank", "blank", "text"]);
  });

  it("treats a whitespace-only line as blank", () => {
    expect(parse("   \t  ")[0]?.kind).toBe("blank");
  });

  it("gives each non-fence line its own block", () => {
    expect(parse("a\nb\nc")).toHaveLength(3);
  });
});

// ── Checkbox grammar ─────────────────────────────────────────────────────────

describe("checkbox grammar (spec §14.2)", () => {
  it("is exactly the documented regex", () => {
    expect(CHECKBOX.source).toBe("^(\\s*)([-*])\\s\\[([ xX])\\]\\s(.*)$");
  });

  it("parses the fields", () => {
    const [block] = parse("  * [X] call ben  ");

    expect(block).toMatchObject({
      kind: "checkbox",
      indent: "  ",
      marker: "*",
      checked: true,
      text: "call ben  ",
    });
  });

  it("reads both [x] and [X] as checked, and [ ] as unchecked", () => {
    expect(parse("- [x] a")[0]?.checked).toBe(true);
    expect(parse("- [X] a")[0]?.checked).toBe(true);
    expect(parse("- [ ] a")[0]?.checked).toBe(false);
  });

  it("accepts an empty task text", () => {
    expect(parse("- [ ] ")[0]?.kind).toBe("checkbox");
  });

  const notCheckboxes: Array<[string, string]> = [
    ["-[ ] no space after the marker", "-[ ] buy milk"],
    ["empty brackets", "- [] buy milk"],
    ["an unrecognised box character", "- [y] buy milk"],
    ["a + marker", "+ [ ] buy milk"],
    ["two spaces after the marker", "-  [ ] buy milk"],
    ["no space after the bracket", "- [ ]buy milk"],
    ["no marker", "[ ] buy milk"],
  ];

  for (const [name, line] of notCheckboxes) {
    it(`rejects ${name}`, () => {
      expect(parse(line)[0]?.kind).toBe("text");
    });
  }

  it("recognises a checkbox on a CRLF line", () => {
    // 🔴 The regression that motivated `withoutCR`. `.` does not match `\r` in
    // JavaScript, so `(.*)$` cannot reach past one and a raw CRLF line fails the
    // grammar outright — every checkbox in a CRLF document parses as `text`.
    //
    // Round-trip cannot catch this. `raw` is a verbatim slice whatever `kind` says,
    // so serialization stays byte-perfect while nothing renders as a checkbox and
    // clear-completed silently removes nothing.
    const [block] = parse("- [x] a\r\nnext");

    expect(block).toMatchObject({ kind: "checkbox", checked: true, text: "a", eol: "\r" });
  });

  it("recognises a fence on CRLF lines, and closes it", () => {
    const blocks = parse("```\r\ncode\r\n```\r\nafter");

    expect(blocks.map((b) => b.kind)).toEqual(["fence", "text"]);
    expect(blocks[0]?.unterminated).toBeUndefined();
  });

  it("does not treat a checkbox inside a fence as a checkbox", () => {
    const blocks = parse("```\n- [ ] not a task, it is sample code\n```");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("fence");
  });
});

// ── Toggle ───────────────────────────────────────────────────────────────────

describe("toggle (spec §14.2)", () => {
  function toggledLine(line: string): string {
    const block = parse(line)[0] as Block;
    return toggle(block).raw;
  }

  it("flips the bracket and nothing else", () => {
    expect(toggledLine("- [ ] buy milk")).toBe("- [x] buy milk");
    expect(toggledLine("- [x] buy milk")).toBe("- [ ] buy milk");
  });

  it("preserves indentation, marker, and trailing whitespace", () => {
    expect(toggledLine("\t  * [ ] nested item   ")).toBe("\t  * [x] nested item   ");
  });

  it("preserves the case of an existing X when unchecking", () => {
    // [X] and [x] both mean checked and the original case survives a write, so
    // unchecking a [X] must not silently normalise anything else on the line.
    expect(toggledLine("- [X] done")).toBe("- [ ] done");
  });

  it("uses lowercase x when checking, since there is no case to preserve", () => {
    expect(toggledLine("- [ ] a")).toBe("- [x] a");
  });

  it("survives CRLF", () => {
    const block = parse("- [ ] a\r\nnext")[0] as Block;
    expect(toggle(block).raw).toBe("- [x] a\r");
  });

  it("round-trips through a double toggle, byte for byte", () => {
    // Boxes are `[ ]` and `[x]` here, not `[X]`. Unchecking writes a space, which
    // destroys the record of which case the document used — so `[X]` legitimately
    // comes back as `[x]` and cannot do otherwise: the only place that case was
    // stored is the character the toggle just overwrote. That is the one thing a
    // toggle is allowed to lose, and it is asserted as an example below rather than
    // papered over here.
    const lowerBoxLine = fc
      .tuple(indent, marker, fc.constantFrom(" ", "x"), words, trailing)
      .map(([i, m, b, w, t]) => `${i}${m} [${b}] ${w}${t}`);

    fc.assert(
      fc.property(lowerBoxLine, (line) => {
        const once = toggle(parse(line)[0] as Block);
        const twice = toggle(parse(once.raw)[0] as Block);
        expect(twice.raw).toBe(line);
      }),
      { numRuns: 1000 },
    );
  });

  it("loses only the box case across a double toggle of [X]", () => {
    const once = toggle(parse("  * [X] a  ")[0] as Block);
    expect(once.raw).toBe("  * [ ] a  ");

    const twice = toggle(parse(once.raw)[0] as Block);
    expect(twice.raw).toBe("  * [x] a  ");
  });

  it("changes exactly one character of the line", () => {
    fc.assert(
      fc.property(checkboxLine, (line) => {
        const after = toggle(parse(line)[0] as Block).raw;
        expect(after).toHaveLength(line.length);

        const differing = [...line].filter((c, i) => c !== after[i]);
        expect(differing).toHaveLength(1);
      }),
      { numRuns: 1000 },
    );
  });

  it("leaves the rest of the document untouched when one block is toggled", () => {
    // "Never reconstruct a block from its parsed fields except the one being edited."
    const body = "- [ ] a   \n```\n- [ ] b\n```\n\t* [X] c\t";
    const blocks = parse(body);

    // The last checkbox is on LINE 4 but is BLOCK 2, because the fence collapses
    // three lines into one block. Indexing a row by its line number is precisely the
    // bug this module exists to make impossible, so the test states the distinction
    // instead of hard-coding either number.
    expect(blocks).toHaveLength(3);
    const target = blocks[2] as Block;
    expect(target.startLine).toBe(4);

    const edited = blocks.map((b) => (b === target ? toggle(b) : b));

    expect(serialize(edited)).toBe("- [ ] a   \n```\n- [ ] b\n```\n\t* [ ] c\t");
  });

  it("throws rather than guessing when handed a non-checkbox", () => {
    expect(() => toggle(parse("plain text")[0] as Block)).toThrow();
  });
});
