import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyShorthand, leavingLines, revertShorthand, splitLine } from "../src/edit.js";

/**
 * The typing model, tested as pure state transitions.
 *
 * 🔴 This is the work spec §7 originally declined — "the source of every cursor bug".
 * No test in this repo runs a browser, so the only defence is that every decision
 * here is a function over state. What these cannot cover is the wiring and the iOS
 * keyboard; that is #35 and a real device respectively.
 */

describe("splitLine — Enter, and the rules no platform knows", () => {
  // 🔴 These are new, and they replace coverage rather than add it (#113). `splitLine`
  // was only ever tested *through* `splitAt`, the row-model adapter over it — so deleting
  // the row list would have silently left the one function the editing surface still
  // calls with no tests at all. It is called on every Enter.
  //
  // Offsets here are into the **raw** line, marker included, which is the natural unit
  // for one editing surface. The row model converted on the way in and out; nothing does
  // now.

  it("splits a plain line where the caret is", () => {
    expect(splitLine("buy milk", 3)).toEqual({ kind: "split", head: "buy", tail: " milk", caret: 0 });
  });

  it("clamps an offset past the end rather than inventing text", () => {
    expect(splitLine("ab", 99)).toEqual({ kind: "split", head: "ab", tail: "", caret: 0 });
    expect(splitLine("ab", -5)).toEqual({ kind: "split", head: "", tail: "ab", caret: 0 });
  });

  it("🔴 continues a checkbox, unchecked", () => {
    // A line that has just been typed is not already done. Splitting a *checked* line
    // still produces an unchecked one below.
    expect(splitLine("- [x] pay it", 12)).toEqual({
      kind: "split",
      head: "- [x] pay it",
      tail: "- [ ] ",
      caret: 6,
    });
  });

  it("🔴 clears the marker on Enter at an empty checkbox, rather than making another", () => {
    // The way out of a list. Without this, Enter on an empty item makes an empty item
    // forever and the only escape is backspacing a marker you did not type.
    expect(splitLine("- [ ] ", 6)).toEqual({ kind: "clear" });
    expect(splitLine("  * [ ] ", 8)).toEqual({ kind: "clear" });
  });

  it("🔴 never splits inside the marker, because the marker is one widget", () => {
    // The caret can sit at the very start of the line — before the indent — and the
    // marker is drawn as a single atomic control. Splitting inside six characters that
    // render as one thing is not something anyone asked for; you get an empty checkbox
    // above and your text below, which is what every list app does.
    expect(splitLine("- [ ] milk", 0)).toEqual({
      kind: "split",
      head: "- [ ] ",
      tail: "- [ ] milk",
      caret: 6,
    });
    expect(splitLine("- [ ] milk", 3)).toEqual({
      kind: "split",
      head: "- [ ] ",
      tail: "- [ ] milk",
      caret: 6,
    });
  });

  it("🔴 keeps the marker the line actually used, and its indentation", () => {
    // `*` is not normalised to `-`. Principle 3: bytes in, bytes out — a continued line
    // inherits the marker its neighbour was written with, whichever that was.
    expect(splitLine("  * [ ] one", 11)).toEqual({
      kind: "split",
      head: "  * [ ] one",
      tail: "  * [ ] ",
      caret: 8,
    });
  });

  it("🔴 derives the prefix from the grammar rather than counting six characters", () => {
    // `CHECKBOX` separates with `\s`, so a tab is legal in both positions and
    // `indent.length + 6` is wrong for a line nobody would think to type by hand.
    const split = splitLine("-\t[ ]\tmilk", 99);
    expect(split.kind).toBe("split");
    if (split.kind !== "split") return;
    expect(split.head).toBe("-\t[ ]\tmilk");
  });

  it("continues a bullet without duplicating its marker", () => {
    // Splitting `- milk and eggs` mid-line must not produce `- ` followed by
    // ` and eggs` with the marker written twice on a line that already has one.
    expect(splitLine("- milk and eggs", 6)).toEqual({
      kind: "split",
      head: "- milk",
      tail: "-  and eggs",
      caret: 2,
    });
  });

  it("clears an empty bullet, the same way it clears an empty checkbox", () => {
    expect(splitLine("- ", 2)).toEqual({ kind: "clear" });
  });

  it("does not continue an ordered list, deliberately", () => {
    // Continuing `1. ` means *renumbering*, which is the first edit knag would make to
    // a line the user did not ask it to touch. It is treated as ordinary text.
    expect(splitLine("1. first", 8)).toEqual({ kind: "split", head: "1. first", tail: "", caret: 0 });
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

  it("🔴 converts an en dash and an em dash too — autocorrect gets there first (#242)", () => {
    // Autocorrect is on in the editing surface on purpose (ADR-003 §6), and Apple's
    // autocorrect rewrites two hyphens into a dash character while you type. So on a Mac
    // and on iOS the space lands after the hyphens are already gone, and matching only a
    // literal `--` meant the shortcut did nothing on the two platforms knag is used on.
    //
    // 🔴 These three cases are the entire coverage this can have. Substitution happens in
    // the OS input stack, above WebKit — Playwright types characters straight into the
    // page, so a browser test types a literal `--` forever and would agree with the bug.
    expect(applyShorthand("— ", 2)).toEqual({ text: "- [ ] ", caret: 6 });
    expect(applyShorthand("– ", 2)).toEqual({ text: "- [ ] ", caret: 6 });

    // The caret offset differs — `— ` is two characters where `-- ` is three — which is
    // why the check comes from the match's own width rather than a constant.
    expect(applyShorthand("  — buy milk", 4)).toEqual({ text: "  - [ ] buy milk", caret: 8 });
    expect(applyShorthand("— buy milk", 2)).toEqual({ text: "- [ ] buy milk", caret: 6 });

    // And the same rule about the caret being anywhere else still holds.
    expect(applyShorthand("— ", 1)).toBeNull();
    expect(applyShorthand("a — b", 3)).toBeNull();
  });

  it("🔴 reverts to two hyphens whatever was typed (#242)", () => {
    // What is undone is the shortcut, not the keystrokes. Someone who typed `--` and had
    // it turned into `—` by autocorrect and then into a checkbox wanted two hyphens; a
    // revert that handed back an em dash would give them a character they never chose.
    expect(revertShorthand("- [ ] ", 6)).toEqual({ text: "-- ", caret: 3 });
    expect(revertShorthand("  - [ ] milk", 8)).toEqual({ text: "  -- milk", caret: 5 });
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
