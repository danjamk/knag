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

/** Tier boundaries, measured from the last local edit. */
export const ACTIVE_WINDOW_MS = 2 * 60_000;
export const IDLE_WINDOW_MS = 15 * 60_000;

export type PollState = {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** Milliseconds since the last local edit. `Infinity` if there has not been one. */
  msSinceEdit: number;
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
  if (state.msSinceEdit < ACTIVE_WINDOW_MS) return POLL_ACTIVE_MS;
  if (state.msSinceEdit < IDLE_WINDOW_MS) return POLL_IDLE_MS;
  return POLL_STALE_MS;
}

export type EditorState = {
  /** Local changes not yet acknowledged by the server. */
  dirty: boolean;
  /** The textarea currently has focus. */
  focused: boolean;
};

/**
 * May a freshly fetched document replace what is on screen?
 *
 * 🔴 **No, while the editor is dirty or focused.** This is one of the two rules
 * spec §6 says prevent the only real bugs, and the reason it covers *focused* and
 * not just *dirty* is the cursor: replacing a textarea's value resets the selection,
 * so a poll landing between two keystrokes throws the caret to the end of the
 * document. A cursor that jumps mid-keystroke is how an app gets abandoned.
 *
 * Refusing here does not discard the update — the caller queues it and applies it on
 * blur.
 */
export function mayApplyRemote(state: EditorState): boolean {
  return !state.dirty && !state.focused;
}
