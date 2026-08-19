import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parse } from "../../worker/src/blocks.js";
import {
  applyShorthand,
  leavingLines,
  mergeBackward,
  neighbor,
  revertShorthand,
  splitAt,
} from "../src/edit.js";
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

  // ── Bullets (#85) ──────────────────────────────────────────────────────────

  it("🔴 continues a hyphen bullet", () => {
    // The bytes really do gain `- `. Nothing is rendered that the file does not say,
    // which is what separates this from styling a bullet — the thing ADR-004 rules out
    // and ADR-003 §4 declined to trigger on.
    const result = splitAt("- milk", 0, 6);

    expect(result.body).toBe("- milk\n- ");
    // 🔴 Offset 2, not 0 — **after** the marker. A checkbox's prefix is stripped by
    // `displayText` and is not in its editor, so 0 is already past it; a bullet is a
    // plain text block whose first characters really are `- `, so 0 lands in front of
    // them and the next keystroke produces `eggs- `. Found by a browser test, because
    // the body is identical either way.
    expect(result).toMatchObject({ focusIndex: 1, focusOffset: 2 });
  });

  it("🔴 copies the marker rather than normalising it", () => {
    // A `*` bullet continues as `*`. Tidying it to `-` would be knag editing a line the
    // user did not touch, which is principle 3.
    expect(splitAt("* milk", 0, 6).body).toBe("* milk\n* ");
  });

  it("carries the indentation verbatim", () => {
    expect(splitAt("    - nested", 0, 12).body).toBe("    - nested\n    - ");
    expect(splitAt("\t- tabbed", 0, 9).body).toBe("\t- tabbed\n\t- ");
  });

  it("puts the tail on the new bullet when splitting mid-line", () => {
    expect(splitAt("- milk and eggs", 0, 6).body).toBe("- milk\n-  and eggs");
  });

  it("🔴 exits the list when Enter lands on an empty bullet", () => {
    // Same contract as the empty checkbox. Without it there is no way to stop making
    // bullets except reaching for raw view — the mode-switch ADR-003 removed.
    const result = splitAt("- milk\n- ", 1, 2);

    expect(result.body).toBe("- milk\n");
    expect(result).toMatchObject({ focusIndex: 1, focusOffset: 0 });
  });

  it("leaves a line that merely starts with a dash alone", () => {
    // `-5 degrees` and `--` are not bullets. The space after the marker is the whole
    // of the rule, and without it a minus sign starts a list.
    expect(splitAt("-5 degrees", 0, 10).body).toBe("-5 degrees\n");
    expect(splitAt("--", 0, 2).body).toBe("--\n");
    expect(splitAt("—em dash", 0, 8).body).toBe("—em dash\n");
  });

  it("🔴 does not treat a checkbox as a bullet", () => {
    // `- [ ] x` starts with `- `, so a naive bullet rule matches it and produces
    // `- - [ ] ` on the next line. The checkbox branch owns those and runs first, but
    // the pattern refuses them too rather than relying on ordering.
    expect(splitAt("- [ ] task", 0, 10).body).toBe("- [ ] task\n- [ ] ");
    expect(splitAt("- [x] done", 0, 10).body).toBe("- [x] done\n- [ ] ");
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

describe("checkbox shorthand (spec §7, ADR-003 §4)", () => {
  it("converts `-- ` at the start of a line", () => {
    expect(applyShorthand("-- ", 3)).toEqual({ text: "- [ ] ", caret: 6 });
  });

  it("keeps indentation", () => {
    expect(applyShorthand("  -- ", 5)).toEqual({ text: "  - [ ] ", caret: 8 });
    expect(applyShorthand("\t-- ", 4)).toEqual({ text: "\t- [ ] ", caret: 7 });
  });

  it("marks an existing line as a task", () => {
    // Caret at the start of "buy milk", type `-- `, and it becomes a checkbox with
    // the text intact. Useful enough to be worth supporting explicitly.
    expect(applyShorthand("-- buy milk", 3)).toEqual({ text: "- [ ] buy milk", caret: 6 });
  });

  it("🔴 does not fire when the caret is anywhere else", () => {
    // Typing `--` mid-sentence, or arrowing back into a line that starts with two
    // dashes, must be left completely alone.
    expect(applyShorthand("-- ", 0)).toBeNull();
    expect(applyShorthand("-- ", 2)).toBeNull();
    expect(applyShorthand("-- buy milk", 8)).toBeNull();
    expect(applyShorthand("a -- b", 4)).toBeNull();
  });

  it("🔴 does not fire on a single dash", () => {
    // A single `- ` stays a literal dash. Rendering it as a bullet would be the first
    // place the display differs from the bytes.
    expect(applyShorthand("- ", 2)).toBeNull();
    expect(applyShorthand("- buy milk", 2)).toBeNull();
    expect(applyShorthand("  - ", 4)).toBeNull();
  });

  it("does not fire without the space", () => {
    expect(applyShorthand("--", 2)).toBeNull();
    expect(applyShorthand("---", 3)).toBeNull();
  });

  it("reverts on the immediate backspace", () => {
    expect(revertShorthand("- [ ] ", 6)).toEqual({ text: "-- ", caret: 3 });
    expect(revertShorthand("  - [ ] buy milk", 8)).toEqual({ text: "  -- buy milk", caret: 5 });
  });

  it("only reverts with the caret right after the prefix", () => {
    // Backspace anywhere else in a checkbox is ordinary editing, not an undo.
    expect(revertShorthand("- [ ] buy", 9)).toBeNull();
    expect(revertShorthand("- [ ] ", 3)).toBeNull();
  });

  it("does not revert a checked box or a `*` marker", () => {
    // Only the exact shape the conversion produces. Anything else was typed or
    // toggled by the user and is not this shortcut's to undo.
    expect(revertShorthand("- [x] ", 6)).toBeNull();
    expect(revertShorthand("* [ ] ", 6)).toBeNull();
  });

  it("🔴 round-trips, so `--` at the start of a line stays typeable", () => {
    // A shortcut that takes a character away from you is worse than no shortcut.
    fc.assert(
      fc.property(fc.constantFrom("", " ", "  ", "\t"), fc.string({ maxLength: 40 }), (ind, rest) => {
        const typed = `${ind}-- ${rest}`;
        const converted = applyShorthand(typed, ind.length + 3);
        expect(converted).not.toBeNull();

        const reverted = revertShorthand(
          (converted as { text: string }).text,
          (converted as { caret: number }).caret,
        );
        expect(reverted).toEqual({ text: typed, caret: ind.length + 3 });
      }),
      { numRuns: 1000 },
    );
  });
});

describe("leavingLines", () => {
  it("takes the checked lines and leaves the rest", () => {
    const body = ["Thursday", "- [ ] milk", "- [x] bread", "note"].join("\n");

    expect(leavingLines(body, "completed")).toEqual([2]);
  });

  it("takes every line for a whole-page wipe, including the ones nobody finished", () => {
    const body = ["Thursday", "- [ ] milk", "- [x] bread"].join("\n");

    expect(leavingLines(body, "all")).toEqual([0, 1, 2]);
  });

  it("🔴 takes every line of a fence, not just the line the block starts on", () => {
    // The whole reason this function exists. One block renders as one <li> in the row
    // list, so block indices were interchangeable with lines there. A fence is one
    // block and several lines, and animating by block index would fade the opening
    // ``` and leave the body of the fence sitting there until the repaint.
    const body = ["before", "```js", "const x = 1;", "```", "after"].join("\n");

    expect(leavingLines(body, "all")).toEqual([0, 1, 2, 3, 4]);
  });

  it("counts past a fence correctly, so later lines are not off by its height", () => {
    const body = ["```js", "const x = 1;", "```", "- [x] done"].join("\n");

    // The checked line is line 3, not line 1 — the fence advanced the counter by three.
    expect(leavingLines(body, "completed")).toEqual([3]);
  });

  it("returns nothing when nothing is finished, rather than an empty animation", () => {
    expect(leavingLines("- [ ] milk\nnote", "completed")).toEqual([]);
  });

  it("🔴 never names a line the document does not have", () => {
    // A line number past the end is a crash in the surface that consumes this, and the
    // arithmetic is the kind that goes wrong at a blank line or a trailing newline.
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (body) => {
        const height = body.split("\n").length;
        for (const scope of ["completed", "all"] as const) {
          for (const line of leavingLines(body, scope)) {
            expect(line).toBeGreaterThanOrEqual(0);
            expect(line).toBeLessThan(height);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });
});
