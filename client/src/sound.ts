/**
 * The wipe's sound (#121).
 *
 * 🔴 **Synthesised, never a file.** Nothing lands in `public/`, nothing has to be added to
 * `SHELL` in `public/sw.js`, no cold offline start plays silence, and the sound is tuned
 * by editing numbers rather than by re-exporting an asset. That is not a convenience —
 * an audio asset is a thing that can be missing, and a wipe that is silent because a
 * cache is cold is indistinguishable from one that is silent because it is off.
 *
 * 🔴 **The iOS silent switch mutes Web Audio and there is no honest way around it.** So
 * this is a bonus on top of motion that already carries the moment, never the moment
 * itself. If the sound is the only thing that made a wipe feel like a release, the wipe
 * is wrong. The switch is not worked around and should not be.
 *
 * One sound, the same restraint that gives the product one animation and one colour. It
 * is off by default (`view.ts`, `readSound`).
 */

import type { WipeTimings } from "./editor.js";

/**
 * When the knock lands, in milliseconds from the first line starting to move.
 *
 * 🔴 **The sound is not a fixed length — it is derived from the motion.** A fixed 340ms
 * sound against a wipe whose length depends on how many lines are going means the knock
 * lands mid-motion on a long list and after silence on a short one, and the mismatch
 * shows up on the very first real wipe.
 *
 *     knockAt = duration + stagger × (n − 1) + collapse
 *
 * The noise band opens as the first line starts moving and closes exactly when the last
 * gap finishes closing, with the knock on that same frame — so the sound ends when the
 * board does. A four-line sweep and a nine-line page wipe are then the same event at two
 * lengths rather than two sounds.
 *
 * It also means the audio needs no maintenance: retune a motion token and this follows.
 */
export function knockAt(timings: WipeTimings, lines: number): number {
  const spread = timings.stagger * Math.max(0, lines - 1);
  return timings.duration + spread + timings.collapse;
}

/**
 * Whether a wipe of this shape is long enough to be worth hearing.
 *
 * 🔴 This is how `prefers-reduced-motion` silences the sound, and it does it without a
 * media query or a special case. The query already rewrites every motion token to 1ms, so
 * the formula above yields a few milliseconds — a sound too short to be anything but a
 * click. Refusing to play it is the correct behaviour rather than an exception, and it
 * means someone who asked for less motion is not handed the one thing louder.
 */
const AUDIBLE_MS = 120;

/** The one sound, at two settings. Same synth, same sweep; the ending is what differs. */
type Voice = {
  /** Lowpass sweep, top and bottom, in Hz. */
  f0: number;
  f1: number;
  /** Noise gain, well under a notification. */
  gain: number;
  /** The knock: a sine that falls to two thirds of itself as it decays. */
  knockF: number;
  knockDur: number;
  knockGain: number;
  /** The noise never runs shorter than this, so a one-line wipe still has a body. */
  floor: number;
};

/**
 * Two voices, and the difference is scale rather than character.
 *
 * The page wipe is one removal of one thing, so its knock is lower and later and its
 * sweep closes further down. It is the same sound at a second setting — the audio
 * counterpart of the page wipe being a second timing rather than a second animation.
 */
const VOICES: Record<"daily" | "page", Voice> = {
  daily: { f0: 1100, f1: 170, gain: 0.085, knockF: 128, knockDur: 110, knockGain: 0.13, floor: 240 },
  page: { f0: 1200, f1: 110, gain: 0.1, knockF: 96, knockDur: 200, knockGain: 0.16, floor: 420 },
};

type Ctor = new () => AudioContext;

let context: AudioContext | undefined;

function audio(): AudioContext | undefined {
  const ctor =
    (globalThis as { AudioContext?: Ctor; webkitAudioContext?: Ctor }).AudioContext ??
    (globalThis as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!ctor) return undefined;

  try {
    context ??= new ctor();
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    // A browser that refuses to build one is a browser that does not get the bonus.
    return undefined;
  }
}

/**
 * Create or resume the context **inside the tap**, before anything is awaited.
 *
 * 🔴 iOS unlocks audio on a user gesture and the unlock does not survive an `await`.
 * `requestWipe` flushes the pending save before it animates, so by the time the sound
 * would start the gesture is over and the context is still suspended — the first wipe
 * after a page load would be silent and every one after it fine, which is the most
 * confusing possible bug to be handed.
 *
 * So the button handlers call this synchronously and `play` uses what it left behind.
 * Called only when the preference is on: a context nobody asked for is a wakelock-adjacent
 * thing to create on a phone.
 */
export function unlock(): void {
  audio();
}

/**
 * One sound at the start of the wipe, ending exactly when the board does.
 *
 * Never one per line — that is a rattle, and this product has one of everything.
 */
export function play(kind: "daily" | "page", at: number): void {
  if (at < AUDIBLE_MS) return;

  const ac = audio();
  if (!ac) return;

  const voice = VOICES[kind];
  const t = ac.currentTime;
  const knock = at / 1000;
  const length = Math.max(voice.floor, at) / 1000;

  try {
    const out = ac.createGain();
    out.connect(ac.destination);

    // A noise band that opens as the first line moves and closes as the last gap does.
    // The `sin(πx)` envelope is what keeps it from starting and stopping with a click of
    // its own — a burst of raw noise has two transients nobody asked for.
    const samples = Math.floor(ac.sampleRate * length);
    const buffer = ac.createBuffer(1, samples, ac.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i += 1) {
      const x = i / samples;
      channel[i] = (Math.random() * 2 - 1) * Math.pow(Math.sin(Math.PI * x), 0.8);
    }

    const source = ac.createBufferSource();
    source.buffer = buffer;

    const lowpass = ac.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(voice.f0, t);
    lowpass.frequency.exponentialRampToValueAtTime(voice.f1, t + length);

    const gain = ac.createGain();
    gain.gain.value = voice.gain;

    source.connect(lowpass).connect(gain).connect(out);
    source.start(t);
    source.stop(t + length);

    // 🔴 The ending, and the reason this voice was chosen over one that simply fades. A
    // falling noise band with no last moment *stops* rather than finishes, which is why
    // it feels short even when it is not. The knock lands on the frame the collapse
    // completes, so the sound and the gap closing are one event.
    const decay = voice.knockDur / 1000;
    const osc = ac.createOscillator();
    const knockGain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(voice.knockF, t + knock);
    osc.frequency.exponentialRampToValueAtTime(voice.knockF * 0.66, t + knock + decay);
    knockGain.gain.setValueAtTime(voice.knockGain, t + knock);
    knockGain.gain.exponentialRampToValueAtTime(0.0001, t + knock + decay);
    osc.connect(knockGain).connect(out);
    osc.start(t + knock);
    osc.stop(t + knock + decay + 0.02);
  } catch {
    // Every node above can throw on a context the platform decided to tear down. The
    // wipe is the moment; this is the bonus, and a bonus never takes the moment with it.
  }
}

/** Test seam. The module holds one context for the life of the tab, which tests do not. */
export function resetForTests(): void {
  context = undefined;
}
