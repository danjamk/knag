/**
 * Sync policy — when to poll, and when a remote update may be applied.
 *
 * 🔴 Pure functions, no DOM, no fetch. Everything in here is a decision, and the
 * decisions are the part that can be wrong in ways nobody notices: an interval tier
 * that never backs off quietly burns the free tier, and a dirty guard that lets one
 * case through corrupts an edit in progress. `app.ts` supplies the state and performs
 * the effects; this module only decides.
 *
 * Spec §6 (sync), §14.4 (polling budget).
 */

/** Poll tiers, in milliseconds. Spec §14.4. */
export const POLL_ACTIVE_MS = 4_000;
export const POLL_IDLE_MS = 15_000;
export const POLL_STALE_MS = 60_000;

/** Tier boundaries, measured from the last local activity. */
export const ACTIVE_WINDOW_MS = 2 * 60_000;
export const IDLE_WINDOW_MS = 15 * 60_000;

export type PollState = {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /**
   * Milliseconds since the last local **activity** — an edit, a page load, or the
   * window regaining focus.
   *
   * 🔴 Not "since the last edit", which is what this was first written as and what
   * spec §14.4's table literally says. A tab that has been opened but not typed in
   * then has no edit to measure from, lands in the slowest tier, and takes a full
   * minute to notice anything — so a second device looks broken, and a change made
   * on the device you *are* typing on appears to sync one way only, because the
   * other tab is still on 60s.
   *
   * Opening a document is an act of attention. Treating it as activity is what makes
   * device-switching feel live, and the backoff still applies two minutes later.
   */
  msSinceActivity: number;
};

/**
 * How long to wait before the next poll, or `null` to stop polling entirely.
 *
 * 🔴 The free tier is a design input, not an afterthought (spec §14.4). A flat 4s
 * poll on one tab left open all day is ~21.6k requests; three devices blow through
 * the 100k/day ceiling on polling alone. Backing off to 60s after fifteen idle
 * minutes is what keeps the realistic worst case near 4k/day.
 *
 * Hidden stops rather than slows. A backgrounded tab has nobody looking at it, and
 * the immediate refetch on `visibilitychange` covers the moment it matters.
 */
export function pollInterval(state: PollState): number | null {
  if (!state.visible) return null;
  if (state.msSinceActivity < ACTIVE_WINDOW_MS) return POLL_ACTIVE_MS;
  if (state.msSinceActivity < IDLE_WINDOW_MS) return POLL_IDLE_MS;
  return POLL_STALE_MS;
}

export type EditorState = {
  /** Local changes not yet acknowledged by the server. */
  dirty: boolean;
  /** The textarea currently has focus. */
  focused: boolean;
};

/** What to do with a freshly fetched document. */
export type RemoteDisposition =
  /** Repaint. Nothing on screen is worth protecting. */
  | "apply"
  /** Repaint, then put the caret back where it was. */
  | "restore-caret"
  /** Queue it. There are unsaved keystrokes and the save has to resolve first. */
  | "hold";

/**
 * What to do with a freshly fetched document (spec §6).
 *
 * 🔴 **Only unsaved keystrokes hold an update back.** This used to refuse while dirty
 * *or* focused, and the focused half caused the bug it was meant to prevent (#62).
 *
 * The reasoning behind it was right: assigning a textarea's value resets the selection,
 * so a poll landing between two keystrokes throws the caret to the end of the document,
 * and a cursor that jumps mid-keystroke is how an app gets abandoned.
 *
 * The mistake was the remedy. Refusing meant the update sat in a queue with no expiry
 * and no visible signal — and because **a browser restores focus to the last-focused
 * element when you return to a window**, `focused` was true again before the first poll
 * after you picked the device back up. So the page went stale exactly when you came
 * back to it, which is the moment sync exists to get right, and stayed stale until you
 * happened to click somewhere else.
 *
 * Focus alone is not a reason to withhold someone's own data. It is a reason to put the
 * caret back afterwards, which `app.ts` already does after every structural edit.
 *
 * Dirty still holds, and that one is not negotiable: applying a remote body over
 * unsaved keystrokes discards them, and the pending save's 409 is what resolves it.
 */
export function dispositionFor(state: EditorState): RemoteDisposition {
  if (state.dirty) return "hold";
  if (state.focused) return "restore-caret";
  return "apply";
}
