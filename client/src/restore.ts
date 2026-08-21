import { parse } from "../../worker/src/blocks.js";

/**
 * Undoing a wipe (#59).
 *
 * 🔴 **Restore re-inserts into the page as it is now. It never writes back the
 * snapshot.** Writing the pre-wipe body back is the obvious implementation and it
 * discards every edit made since the wipe — which turns the safety net into a second,
 * worse data-loss path than the one it exists to prevent. Everything below is in
 * service of that one sentence.
 *
 * Pure, and its own module, so the hard part is decided and tested before any of it is
 * wired to a button.
 */

/**
 * When the undo stops being offered — the brand's "rest of the day".
 *
 * The **device's** local midnight, not `KNAG_TZ`. `/api/history` reasons in the
 * configured zone because it reports on the past and has to file an edit onto the day
 * it happened; this is about whether the person holding the phone still thinks of the
 * wipe as something they just did. Those are different questions and a device that has
 * travelled should follow the traveller.
 *
 * `setHours(24, …)` rather than adding 86_400_000: a day is not always 24 hours, and on
 * a spring-forward morning the arithmetic version expires an hour late. In the one zone
 * where local midnight does not exist at all, this lands on 01:00 — an hour of extra
 * grace on an affordance whose whole job is grace, which is the harmless direction.
 */
export function offerExpiresAt(now: Date): number {
  const midnight = new Date(now.getTime());
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

/**
 * What was removed, and where it sat.
 *
 * `anchor` is the block that preceded it and survived — the thing to put it back
 * *after*. `null` means it was at the top of the page.
 */
type Removed = { raw: string; anchor: string | null };

/**
 * Which blocks the wipe took, in order, each with the surviving block it followed — and
 * whether the wipe **deleted** or **replaced**.
 *
 * A deletion leaves the rest byte-identical, so the post-wipe page is a subsequence of
 * the pre-wipe one and a single greedy walk identifies the gaps. Matching on `raw` rather
 * than on parsed structure keeps this honest about indentation, trailing whitespace and
 * CRLF, all of which survive a wipe and all of which have to survive a restore.
 *
 * 🔴 **That subsequence property stopped being universal in 1.1.1** (#165, #173). A
 * whole-page wipe on a page that has a template lays the template *down* rather than
 * emptying, and a template is an arbitrary body — `- [x] milk` and `- [ ] milk` are
 * different bytes, so the walk matches nothing and reports the whole page as removed.
 * Re-inserting that on top of the template duplicated every standing item that had been
 * checked off, on the first tap, with no editing involved.
 *
 * `replaced` is how the caller tells the two apart, and it is a fact about the walk
 * rather than a guess about intent: it is true when the walk finished without consuming
 * all of `post`, which can only happen if the wipe put something on the page that was not
 * on it before.
 */
function removedBlocks(pre: string[], post: string[]): { removed: Removed[]; replaced: boolean } {
  const removed: Removed[] = [];
  let anchor: string | null = null;
  let p = 0;

  for (const block of pre) {
    if (p < post.length && post[p] === block) {
      // Survived. It becomes the anchor for anything removed after it.
      anchor = block;
      p++;
    } else {
      removed.push({ raw: block, anchor });
    }
  }

  return { removed, replaced: p < post.length };
}

/**
 * Every block of a replaced page, anchored to the block that preceded it *in the pre-wipe
 * page*.
 *
 * The walk anchors to the last **survivor**, which is right for a deletion and useless
 * for a replacement — there are no survivors, so every anchor would be `null` and the
 * whole page would go back in a heap at the top. On a replacement the pre-wipe order is
 * exactly the thing being restored, so each block is anchored to its own predecessor.
 */
function replacedBlocks(pre: string[]): Removed[] {
  // `?? null` for `noUncheckedIndexedAccess`; `i > 0` already guarantees the element.
  return pre.map((raw, i) => ({ raw, anchor: i === 0 ? null : (pre[i - 1] ?? null) }));
}

/**
 * What the wipe *added* — the blocks a replacement put on the page that were not on it
 * before, as a multiset difference so a template line that genuinely was already there
 * is not counted as new.
 *
 * These are the lines the undo has to take back off. 🔴 Nothing typed *after* the wipe
 * can appear here, because this is computed from the post-wipe snapshot rather than from
 * the page as it is now — which is precisely what lets the undo remove the template
 * without touching an edit, and is why merge-on-edit survives this change intact.
 */
function addedBlocks(pre: string[], post: string[]): string[] {
  const budget = new Map<string, number>();
  for (const block of pre) budget.set(block, (budget.get(block) ?? 0) + 1);

  const added: string[] = [];
  for (const block of post) {
    const left = budget.get(block) ?? 0;
    if (left > 0) budget.set(block, left - 1);
    else added.push(block);
  }

  return added;
}

/**
 * Remove each of `blocks` from `list` once, where it is still there.
 *
 * "Once" matters: a page may legitimately hold the same line twice and only the copy the
 * wipe put there should go. A line typed after the reset that happens to be
 * byte-identical to a template line is indistinguishable from the template's own copy —
 * one of the two goes and the bytes cannot say which. That is a real cost, and it is
 * smaller than leaving a visible duplicate on every single reset, which is the bug.
 */
function stripOnce(list: string[], blocks: string[]): string[] {
  const out = [...list];
  for (const block of blocks) {
    const at = out.indexOf(block);
    if (at !== -1) out.splice(at, 1);
  }
  return out;
}

/**
 * `parse("")` yields a single blank block, so an empty page would otherwise look like a
 * page containing one empty line — and a wipe-all would appear to have left something
 * behind.
 */
function blocksOf(body: string): string[] {
  return body === "" ? [] : parse(body).map((block) => block.raw);
}

function countOf(list: string[], value: string): number {
  return list.reduce((n, item) => (item === value ? n + 1 : n), 0);
}

/**
 * Put the wiped blocks back into the current page.
 *
 * `preWipe` and `postWipe` bracket what the wipe did; `current` is the page now, which
 * may have been edited on this device or another one since.
 *
 * Each removed block goes back **after the surviving block it used to follow**, which
 * is what makes it land in the right place even though every index has shifted. A block
 * whose anchor is gone — because that line was deleted since — goes to the end rather
 * than being dropped: a restore that silently loses a line is the failure this whole
 * feature exists to prevent, and the wrong *position* is a far smaller cost than the
 * wrong *content*.
 *
 * 🔴 **Idempotent.** A block is skipped when the current page already holds it at least
 * as many times as the pre-wipe page did. That is what stops a second restore
 * duplicating everything, and it is deliberately count-based rather than
 * presence-based: a page may legitimately contain the same line twice, and a
 * presence test would refuse to bring back the second one.
 */
export function restoredBody(input: { preWipe: string; postWipe: string; current: string }): string {
  const pre = blocksOf(input.preWipe);
  const post = blocksOf(input.postWipe);
  const walk = removedBlocks(pre, post);

  // 🔴 A replacement (a template reset) and a deletion (a sweep, or a wipe to empty)
  // need different undos, and **only the replacement branch is new** — for a deletion
  // `walk.replaced` is false, `added` is empty, `stripOnce` is a copy, and everything
  // below runs exactly as it did. That containment is deliberate: the sweep path is the
  // one with a release of real use behind it.
  const removed = walk.replaced ? replacedBlocks(pre) : walk.removed;
  const added = walk.replaced ? addedBlocks(pre, post) : [];

  // Both empty means the wipe did nothing this can reverse. Note it is *both*: resetting
  // an already-empty page to a template removes nothing and adds the template, and the
  // undo of that is taking the template back off.
  if (removed.length === 0 && added.length === 0) return input.current;

  const result = stripOnce(blocksOf(input.current), added);

  // Where the next block goes when its anchor has already been used, so a run of
  // blocks removed together goes back in the order it left.
  const cursor = new Map<string | null, number>();

  for (const block of removed) {
    if (countOf(result, block.raw) >= countOf(pre, block.raw)) continue;

    let at: number;
    const resume = cursor.get(block.anchor);

    if (resume !== undefined) {
      at = resume;
    } else if (block.anchor === null) {
      // It was at the top of the page, and still belongs there.
      at = 0;
    } else {
      const anchorAt = result.indexOf(block.anchor);
      // Anchor gone. Append rather than guess — see the note above.
      at = anchorAt === -1 ? result.length : anchorAt + 1;
    }

    result.splice(at, 0, block.raw);
    cursor.set(block.anchor, at + 1);
  }

  return result.join("\n");
}
