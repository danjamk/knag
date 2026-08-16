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
 * Which blocks the wipe took, in order, each with the surviving block it followed.
 *
 * A wipe only ever deletes whole blocks and leaves the rest byte-identical, so the
 * post-wipe page is a subsequence of the pre-wipe one and a single greedy walk
 * identifies the gaps. Matching on `raw` rather than on parsed structure keeps this
 * honest about indentation, trailing whitespace and CRLF, all of which survive a wipe
 * and all of which have to survive a restore.
 */
function removedBlocks(pre: string[], post: string[]): Removed[] {
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

  return removed;
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
  const removed = removedBlocks(pre, post);

  if (removed.length === 0) return input.current;

  const result = blocksOf(input.current);

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
