import { describe, expect, it } from "vitest";
import { goneCount, insertLines, offerExpiresAt, restoredBody } from "../src/restore.js";

/**
 * Undoing a wipe (#59).
 *
 * The whole feature rests on one property: **restore puts the wiped lines back into the
 * page as it is now, and never writes the snapshot back over it.** Writing the snapshot
 * back is the obvious implementation, and it discards everything typed since the wipe —
 * a worse data-loss path than the one this exists to prevent.
 *
 * Every test below is either that property or an edge that would quietly violate it.
 */

const restore = (preWipe: string, postWipe: string, current: string): string =>
  restoredBody({ preWipe, postWipe, current });

describe("wipe-completed", () => {
  const PRE = "keep me\n- [x] done one\n- [ ] not done\n- [x] done two";
  const POST = "keep me\n- [ ] not done";

  it("puts the checked lines back where they were", () => {
    expect(restore(PRE, POST, POST)).toBe(PRE);
  });

  it("preserves the exact bytes, including indentation and case", () => {
    // A restore that tidies is a restore that changed the document. `- [X]` stays
    // uppercase and the leading spaces stay leading spaces.
    const pre = "a\n  - [X] nested done \nb";
    const post = "a\nb";

    expect(restore(pre, post, post)).toBe(pre);
  });

  it("🔴 keeps a line typed after the wipe", () => {
    // The property the whole feature rests on. Writing the snapshot back would return
    // PRE and lose "typed later" entirely.
    const current = "keep me\n- [ ] not done\ntyped later";

    expect(restore(PRE, POST, current)).toBe(
      "keep me\n- [x] done one\n- [ ] not done\n- [x] done two\ntyped later",
    );
  });

  it("keeps an edit made to a surviving line", () => {
    const current = "keep me\n- [ ] not done any more, actually";

    // The edited line is not an anchor for anything, so the removed blocks still land
    // around it correctly and the edit is untouched.
    expect(restore(PRE, POST, current)).toBe(
      "keep me\n- [x] done one\n- [ ] not done any more, actually\n- [x] done two",
    );
  });
});

describe("wipe-all", () => {
  // 🔴 The case the original design got wrong. It proposed reading `cleared_items`,
  // which by decision holds the *finished* lines only — so the unchecked ones would
  // have been silently dropped. Deriving from the snapshot is what covers them.
  const PRE = "milk\n- [x] eggs\n- [ ] bread\n- [ ] jam";

  it("brings back the unfinished lines too, not just the checked ones", () => {
    expect(restore(PRE, "", "")).toBe(PRE);
  });

  it("puts the old page above whatever was typed after it", () => {
    // The wiped list was there first, and the new note came after. Order follows that.
    expect(restore(PRE, "", "something new")).toBe(`${PRE}\nsomething new`);
  });
});

describe("restoring twice", () => {
  const PRE = "keep me\n- [x] done one\n- [ ] not done";
  const POST = "keep me\n- [ ] not done";

  it("does not duplicate anything", () => {
    const once = restore(PRE, POST, POST);
    expect(restore(PRE, POST, once)).toBe(once);
  });

  it("still restores a legitimately repeated line the right number of times", () => {
    // 🔴 Count-based, not presence-based. A page may hold the same line twice on
    // purpose — a presence test would refuse to bring back the second one, which is a
    // silent loss dressed up as idempotence.
    const pre = "- [x] milk\n- [x] milk\nkeep";
    const post = "keep";

    const once = restore(pre, post, post);
    expect(once).toBe(pre);
    expect(restore(pre, post, once)).toBe(once);
  });
});

describe("a page that moved on", () => {
  const PRE = "alpha\n- [x] gone\nbeta";
  const POST = "alpha\nbeta";

  it("appends when the line it followed has since been deleted", () => {
    // Position is a best effort; content is not. Dropping the line because its anchor
    // vanished would be the exact failure this feature exists to prevent.
    const current = "beta";

    expect(restore(PRE, POST, current)).toBe("beta\n- [x] gone");
  });

  it("restores to the top of a page whose first line is gone", () => {
    const pre = "- [x] first\nalpha";
    const post = "alpha";

    expect(restore(pre, post, "something else")).toBe("- [x] first\nsomething else");
  });

  it("keeps a run of adjacent wiped lines in order", () => {
    const pre = "top\n- [x] one\n- [x] two\n- [x] three\nbottom";
    const post = "top\nbottom";

    expect(restore(pre, post, post)).toBe(pre);
  });

  it("does nothing when the wipe removed nothing", () => {
    expect(restore("a\nb", "a\nb", "a\nb\nc")).toBe("a\nb\nc");
  });

  it("restores into a page that was emptied after the wipe", () => {
    expect(restore(PRE, POST, "")).toBe("- [x] gone");
  });
});

describe("blocks that are not single lines", () => {
  it("brings a fenced block back whole", () => {
    // A fence is one block spanning several lines. Restoring it line by line would
    // reassemble it wrongly, or split it around an anchor.
    const pre = "before\n```\ncode line\n- [x] not a task\n```\nafter";
    const post = "before\nafter";

    expect(restore(pre, post, post)).toBe(pre);
  });

  it("does not treat a checkbox inside a fence as a wiped item", () => {
    const pre = "```\n- [x] not a task\n```";

    // Nothing was wiped, so nothing comes back — and the fence is left exactly alone.
    expect(restore(pre, pre, pre)).toBe(pre);
  });
});

describe("how long the offer lasts", () => {
  // The brand's phrasing is "rest of the day". These pin what that means, because an
  // undo that quietly outlives its welcome is an undo that brings back a page you
  // deliberately moved on from.

  it("expires at the next local midnight, not 24 hours later", () => {
    const afternoon = new Date(2026, 7, 16, 15, 30, 0);

    expect(offerExpiresAt(afternoon)).toBe(new Date(2026, 7, 17, 0, 0, 0, 0).getTime());
  });

  it("gives a wipe just before midnight only the minutes it has left", () => {
    // 🔴 The case a `+ 24h` implementation gets wrong, and the one that matters: an
    // offer made at 23:58 should not still be standing at lunchtime tomorrow.
    const almostMidnight = new Date(2026, 7, 16, 23, 58, 0);

    const expires = offerExpiresAt(almostMidnight);
    expect(expires).toBe(new Date(2026, 7, 17, 0, 0, 0, 0).getTime());
    expect(expires - almostMidnight.getTime()).toBeLessThan(3 * 60 * 1000);
  });

  it("is always in the future, at every hour of the day", () => {
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(2026, 7, 16, hour, 0, 0);
      expect(offerExpiresAt(at), `hour ${hour}`).toBeGreaterThan(at.getTime());
    }
  });

  it("lands on a day boundary rather than a fixed offset across a DST change", () => {
    // 8 March 2026 is a US spring-forward date. A day is 23 hours here, so adding
    // 86_400_000 would expire an hour into the next day rather than at its start.
    const springForward = new Date(2026, 2, 8, 12, 0, 0);
    const expires = new Date(offerExpiresAt(springForward));

    expect(expires.getHours()).toBe(0);
    expect(expires.getDate()).toBe(9);
  });
});

describe("undoing a template reset (#173)", () => {
  // 🔴 The whole-page wipe stopped emptying the page in 1.1.1 and started laying the
  // page's template down instead. That broke `restore.ts`'s founding assumption — that
  // the post-wipe body is a subsequence of the pre-wipe one — and the symptom was every
  // standing item coming back twice: once checked from the restore, once unchecked from
  // the template.
  //
  // These pin the grocery flow the feature was designed around, because that is the flow
  // that produced the bug and no synthetic case would have found it.
  const TEMPLATE = "- [ ] milk\n- [ ] eggs\n- [ ] bread";
  // Shopping done: the standing items checked off, two one-offs added for the week.
  const SHOPPED = "- [x] milk\n- [x] eggs\n- [ ] bread\n- [x] birthday candles\n- [ ] foil";

  it("🔴 brings the page back without duplicating a single line", () => {
    const restored = restoredBody({ preWipe: SHOPPED, postWipe: TEMPLATE, current: TEMPLATE });

    // Byte-exact and in the original order, not merely "contains the right lines".
    expect(restored).toBe(SHOPPED);
  });

  it("🔴 keeps what was typed after the reset — merge-on-edit is not sacrificed", () => {
    // The property the sweep path already had, now holding for a reset too. Writing the
    // snapshot back would pass the test above and lose this line, which is the trade this
    // module exists to refuse.
    const afterReset = `${TEMPLATE}\n- [ ] batteries`;

    const restored = restoredBody({ preWipe: SHOPPED, postWipe: TEMPLATE, current: afterReset });

    expect(restored).toBe(`${SHOPPED}\n- [ ] batteries`);
  });

  it("takes the template back off when the page was empty before the reset", () => {
    // Nothing was removed and the template was added, so the undo is purely a removal.
    // The early return used to fire on `removed.length === 0` and would have left the
    // template sitting there.
    expect(restoredBody({ preWipe: "", postWipe: TEMPLATE, current: TEMPLATE })).toBe("");
  });

  it("is idempotent — a second tap changes nothing", () => {
    const once = restoredBody({ preWipe: SHOPPED, postWipe: TEMPLATE, current: TEMPLATE });
    const twice = restoredBody({ preWipe: SHOPPED, postWipe: TEMPLATE, current: once });

    expect(twice).toBe(once);
  });

  it("leaves a line the template shares with the pre-wipe page exactly once", () => {
    // `- [ ] bread` is unchecked in both, so it is not something the reset *added* and
    // must not be stripped. The count guard already handled the restore side; this pins
    // the removal side, which is new.
    const restored = restoredBody({ preWipe: SHOPPED, postWipe: TEMPLATE, current: TEMPLATE });

    expect(restored.split("\n").filter((line) => line === "- [ ] bread")).toHaveLength(1);
  });
});

describe("goneCount (#91)", () => {
  const TEMPLATE = "- [ ] milk\n- [ ] eggs\n- [ ] bread";
  const SHOPPED = "- [x] milk\n- [x] eggs\n- [ ] bread\n- [x] birthday candles\n- [ ] foil";

  it("🔴 counts what did not come straight back, not what the wipe touched", () => {
    // The server records five lines removed, which is true about the operation. Two of
    // them — bread by identity, and nothing else — survive; the template puts milk and
    // eggs back in a different state, so those *did* leave.
    expect(goneCount(SHOPPED, TEMPLATE)).toBe(4);
  });

  it("equals the whole page when the wipe leaves nothing", () => {
    expect(goneCount(SHOPPED, "")).toBe(5);
  });

  it("is zero when the page already was its template", () => {
    // Resetting a page that is already its own baseline removes nothing, and the line
    // should say so rather than reporting the size of the page.
    expect(goneCount(TEMPLATE, TEMPLATE)).toBe(0);
  });

  it("counts a duplicate line once per copy lost, because it is a multiset", () => {
    expect(goneCount("a\na\nb", "a\nb")).toBe(1);
    expect(goneCount("a\na\nb", "b")).toBe(2);
  });

  it("is zero on an empty page", () => {
    expect(goneCount("", "")).toBe(0);
  });
});

describe("insertLines (#91)", () => {
  it("appends at the end, in order — content over position", () => {
    expect(insertLines("today\n- [ ] one", ["a note", "- [ ] two"])).toBe(
      "today\n- [ ] one\na note\n- [ ] two",
    );
  });

  it("🔴 is count-idempotent, so a second tap changes nothing", () => {
    const once = insertLines("today", ["a note"]);
    expect(insertLines(once, ["a note"])).toBe(once);
  });

  it("puts back both copies of a line the page legitimately held twice", () => {
    // Presence would refuse the second one. The count is what makes it right.
    expect(insertLines("", ["dup", "dup"])).toBe("dup\ndup");
  });

  it("tops up rather than duplicating when the page already holds one copy", () => {
    expect(insertLines("dup", ["dup", "dup"])).toBe("dup\ndup");
  });

  it("restores onto an empty page without a leading blank line", () => {
    // `parse("")` yields one blank block, so the naive version returns "\nrestored".
    expect(insertLines("", ["restored"])).toBe("restored");
  });

  it("preserves the bytes exactly, including indentation and markers", () => {
    const awkward = "\t- [x] indented \n  * star marker";
    expect(insertLines("", awkward.split("\n"))).toBe(awkward);
  });
});
