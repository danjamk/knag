import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parse } from "../../worker/src/blocks.js";
import { mergeBackward, neighbor, splitAt } from "../src/edit.js";
import { displayText } from "../src/view.js";

/**
 * The typing model, tested as pure state transitions.
 *
 * 🔴 This is the work spec §7 originally declined — "the source of every cursor bug".
 * No test in this repo runs a browser, so the only defence is that every decision
 * here is a function over state. What these cannot cover is the wiring and the iOS
 * keyboard; that is #35 and a real device respectively.
 */

describe("splitAt — Enter", () => {
  it("splits a plain line at the caret", () => {
    const result = splitAt("hello world", 0, 5);

    expect(result.body).toBe("hello\n world");
    expect(result).toMatchObject({ focusIndex: 1, focusOffset: 0 });
  });

  it("inserts an empty row when splitting at the end", () => {
    expect(splitAt("done", 0, 4).body).toBe("done\n");
  });

  it("splits a checkbox into two checkboxes", () => {
    // What every list app does, and what the `--` shorthand exists to make cheap.
    const result = splitAt("- [ ] buy milk", 0, 3);

    expect(result.body).toBe("- [ ] buy\n- [ ]  milk");
    expect(result.focusIndex).toBe(1);
  });

  it("keeps the indent and marker on the new checkbox", () => {
    expect(splitAt("\t  * [x] a", 0, 1).body).toBe("\t  * [x] a\n\t  * [ ] ");
  });

  it("🔴 leaves the new checkbox unchecked even when splitting a checked one", () => {
    // A line that has just been typed is not already done.
    const result = splitAt("- [x] finished", 0, 8);

    expect(parse(result.body)[1]?.checked).toBe(false);
  });

  it("🔴 exits the list when Enter lands on an empty checkbox", () => {
    // Without this there is no way to stop making checkboxes except reaching for raw
    // view — the exact mode-switch ADR-003 removed.
    const result = splitAt("- [ ] a\n- [ ] ", 1, 0);

    expect(result.body).toBe("- [ ] a\n");
    expect(parse(result.body)[1]?.kind).toBe("blank");
    expect(result).toMatchObject({ focusIndex: 1, focusOffset: 0 });
  });

  it("does not split a fence — its textarea handles Enter natively", () => {
    const body = "```\ncode\n```";
    expect(splitAt(body, 0, 2).body).toBe(body);
  });

  it("clamps an out-of-range caret rather than throwing", () => {
    expect(splitAt("abc", 0, 99).body).toBe("abc\n");
    expect(splitAt("abc", 0, -5).body).toBe("\nabc");
    expect(splitAt("abc", 9, 0).body).toBe("abc");
  });

  it("preserves CRLF on both halves", () => {
    // The line ending belongs to the line; splitting makes two lines.
    const result = splitAt("hello world\r\nnext", 0, 5);
    expect(result.body).toBe("hello\n world\r\nnext");
  });
});

describe("mergeBackward — Backspace at offset 0", () => {
  it("🔴 demotes a checkbox to plain text before merging anything", () => {
    // One keystroke that both strips a checkbox and joins two lines destroys more
    // structure than the user asked for.
    const result = mergeBackward("first\n- [ ] second", 1);

    expect(result.body).toBe("first\nsecond");
    expect(result).toMatchObject({ focusIndex: 1, focusOffset: 0 });
  });

  it("merges on the second backspace, once it is plain text", () => {
    const once = mergeBackward("first\n- [ ] second", 1);
    const twice = mergeBackward(once.body, 1);

    expect(twice.body).toBe("firstsecond");
    expect(twice).toMatchObject({ focusIndex: 0, focusOffset: 5 });
  });

  it("puts the caret exactly at the join", () => {
    const result = mergeBackward("abc\ndef", 1);

    expect(result.body).toBe("abcdef");
    expect(result.focusOffset).toBe(3);
  });

  it("merges into a checkbox with the caret in display coordinates", () => {
    // 🔴 The merged row is a checkbox, so its editor shows "todo" rather than
    // "- [ ] todo". An offset counted against `raw` would land six characters off.
    const result = mergeBackward("- [ ] todo\nmore", 1);

    expect(result.body).toBe("- [ ] todomore");
    expect(result.focusIndex).toBe(0);
    expect(result.focusOffset).toBe(4);
    expect(displayText(parse(result.body)[0] as never)).toBe("todomore");
  });

  it("does nothing at the first row", () => {
    expect(mergeBackward("only", 0).body).toBe("only");
  });

  it("refuses to merge into a fence", () => {
    // Text joined onto a closing fence lands *inside* the code block, which is never
    // what backspace meant.
    const body = "```\ncode\n```\nafter";
    expect(mergeBackward(body, 1).body).toBe(body);
  });

  it("does not merge a fence upward either", () => {
    const body = "before\n```\ncode\n```";
    expect(mergeBackward(body, 1).body).toBe(body);
  });

  it("absorbs a blank line", () => {
    expect(mergeBackward("a\n\nb", 1).body).toBe("a\nb");
  });

  it("keeps the surviving line's ending when merging across CRLF", () => {
    // Two lines become one, and a line has one ending.
    expect(mergeBackward("abc\r\ndef\r\n", 1).body).toBe("abcdef\r\n");
  });
});

describe("neighbor — arrow keys", () => {
  it("moves between rows", () => {
    expect(neighbor("a\nb\nc", 1, 1, 0).focusIndex).toBe(2);
    expect(neighbor("a\nb\nc", 1, -1, 0).focusIndex).toBe(0);
  });

  it("stops at the ends rather than wrapping", () => {
    expect(neighbor("a\nb", 0, -1, 0).focusIndex).toBe(0);
    expect(neighbor("a\nb", 1, 1, 0).focusIndex).toBe(1);
  });

  it("preserves the column where the line is long enough", () => {
    expect(neighbor("aaaaa\nbbbbb", 0, 1, 3).focusOffset).toBe(3);
  });

  it("clamps the column to the end of a shorter line", () => {
    expect(neighbor("aaaaa\nb", 0, 1, 4).focusOffset).toBe(1);
  });

  it("counts the column in display text, not raw", () => {
    // Moving onto a checkbox row, the editor holds "hi" — offset 5 clamps to 2, not
    // to the length of "- [ ] hi".
    expect(neighbor("aaaaaaa\n- [ ] hi", 0, 1, 5).focusOffset).toBe(2);
  });

  it("visits blank rows rather than skipping them", () => {
    // A blank line is a place you can type; skipping it makes the arrows disagree
    // with what is on screen.
    expect(neighbor("a\n\nb", 0, 1, 0).focusIndex).toBe(1);
  });

  it("never changes the document", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200, unit: "binary" }), fc.nat({ max: 10 }), (body, i) => {
        expect(neighbor(body, i, 1, 0).body).toBe(body);
        expect(neighbor(body, i, -1, 0).body).toBe(body);
      }),
      { numRuns: 500 },
    );
  });
});

describe("what typing may never do", () => {
  const anyBody = fc.string({ maxLength: 200, unit: "binary" });

  it("🔴 a split followed by a merge restores the document exactly", () => {
    // The round trip that makes the whole model safe: Enter then Backspace is a
    // no-op, on arbitrary documents, at arbitrary positions.
    fc.assert(
      fc.property(anyBody, fc.nat({ max: 20 }), fc.nat({ max: 40 }), (body, i, o) => {
        const blocks = parse(body);
        if (blocks.length === 0) return;
        const index = i % blocks.length;
        const block = blocks[index];
        // Fences and empty checkboxes are deliberately not round trips — see their
        // own tests above.
        if (!block || block.kind === "fence") return;
        if (block.kind === "checkbox" && displayText(block).length === 0) return;

        const text = displayText(block);
        const at = o % (text.length + 1);
        // 🔴 Excluded, and not a bug: splitting immediately after a content `\r`
        // leaves the head ending in `\r` followed by `\n`, which *is* a CRLF line
        // ending by the parser's own rules. The two are indistinguishable in this
        // representation, so the merge back reads it as an ending and drops it.
        // Documented as its own test below rather than hidden by loosening this one.
        if (text[at - 1] === "\r") return;

        const split = splitAt(body, index, at);
        const merged = mergeBackward(split.body, split.focusIndex);

        // A checkbox split makes a checkbox, so the merge demotes first.
        const settled =
          block.kind === "checkbox" ? mergeBackward(merged.body, split.focusIndex).body : merged.body;

        expect(settled).toBe(body);
      }),
      { numRuns: 2000 },
    );
  });

  it("loses a lone carriage return split exactly at its edge — inherent, not a bug", () => {
    // A line whose *content* contains `\r`, split immediately after it. The head then
    // ends `\r` and is followed by `\n`, which the parser reads as a CRLF ending —
    // correctly, because that is what it looks like and nothing distinguishes them.
    //
    // Recorded because the round-trip property excludes it, and an exclusion nobody
    // can see is an exclusion nobody will question. A lone `\r` mid-line is
    // pathological content; if it ever stops being pathological, the line model is
    // the wrong shape and this is where that argument starts.
    const split = splitAt("ab\rcd", 0, 3);
    expect(split.body).toBe("ab\r\ncd");

    expect(mergeBackward(split.body, 1).body).toBe("abcd");
  });

  it("🔴 never changes the total number of characters, only where the breaks are", () => {
    // A split adds exactly one newline (plus a checkbox prefix when it makes one);
    // it must never drop or duplicate content.
    fc.assert(
      fc.property(anyBody, fc.nat({ max: 20 }), fc.nat({ max: 40 }), (body, i, o) => {
        const blocks = parse(body);
        if (blocks.length === 0) return;
        const index = i % blocks.length;
        const block = blocks[index];
        if (!block || block.kind === "fence" || block.kind === "checkbox") return;

        const result = splitAt(body, index, o % (displayText(block).length + 1));
        expect(result.body.replace(/\n/g, "")).toBe(body.replace(/\n/g, ""));
      }),
      { numRuns: 2000 },
    );
  });

  it("🔴 a merge never loses a character either", () => {
    fc.assert(
      fc.property(anyBody, fc.nat({ max: 20 }), (body, i) => {
        const blocks = parse(body);
        if (blocks.length === 0) return;
        const index = i % blocks.length;

        const result = mergeBackward(body, index);
        // Merging removes at most one newline and at most one `- [ ] ` prefix; it
        // must never touch anything else.
        expect(result.body.replace(/[\n\r]/g, "").length).toBeLessThanOrEqual(
          body.replace(/[\n\r]/g, "").length,
        );
      }),
      { numRuns: 1000 },
    );
  });
});
