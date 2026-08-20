import type { Page } from "@playwright/test";
import { type Knag, expect, test } from "./fixtures.js";

/**
 * The wipe's sound (#121).
 *
 * 🔴 **Nothing here listens to anything.** Whether `land` sounds like a release is a
 * judgment made on a phone with the ringer on, and no assertion can reach it. What is
 * pinned is everything around the sound that *can* be wrong silently: that it is off
 * until someone turns it on, that the context is unlocked inside the gesture rather than
 * after an await, that the knock is placed from the motion's own numbers, and that asking
 * for less motion also asks for less noise.
 *
 * The arithmetic half lives in `client/test/sound.test.ts`. This half is the wiring: that
 * the formula's answer actually reaches an oscillator, in a real page, at the right time.
 */

const MIXED = ["keep me", "- [x] done one", "- [ ] not done", "- [x] done two"].join("\n");

/**
 * A counting stand-in for Web Audio.
 *
 * Installed with `evaluate` rather than `addInitScript` because `sound.ts` looks the
 * constructor up lazily, at play time — which is itself worth knowing: it means the app
 * builds no AudioContext until the moment one is needed, and none at all for someone who
 * never turns this on.
 */
async function watchAudio(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as {
      __audio: { contexts: number; oscStarts: number[] };
      AudioContext: unknown;
    };
    g.__audio = { contexts: 0, oscStarts: [] };

    const param = () => ({
      value: 0,
      setValueAtTime: () => {},
      exponentialRampToValueAtTime: () => {},
    });

    class Node {
      isOsc = false;
      type = "";
      buffer: unknown = null;
      frequency = param();
      gain = param();
      connect(next?: Node) {
        return next ?? this;
      }
      start(at: number) {
        if (this.isOsc) g.__audio.oscStarts.push(at);
      }
      stop() {}
    }

    g.AudioContext = class {
      currentTime = 0;
      sampleRate = 44100;
      state = "running";
      destination = new Node();
      constructor() {
        g.__audio.contexts += 1;
      }
      resume() {}
      createGain() {
        return new Node();
      }
      createBiquadFilter() {
        return new Node();
      }
      createBufferSource() {
        return new Node();
      }
      createOscillator() {
        const n = new Node();
        n.isOsc = true;
        return n;
      }
      createBuffer(_channels: number, length: number) {
        return { getChannelData: () => new Float32Array(length) };
      }
    };
  });
}

const audio = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as { __audio: { contexts: number; oscStarts: number[] } }).__audio,
  );

/** Turn it on through the sheet, the way a person does. */
async function enableSound(knag: Knag): Promise<void> {
  await knag.openSettings();
  await knag.page.locator('[data-sound="on"]').click();
  await knag.page.keyboard.press("Escape");
}

const ms = (value: string) =>
  value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;

async function token(page: Page, name: string): Promise<number> {
  return ms(
    await page
      .locator("body")
      .evaluate(
        (el: { ownerDocument: { defaultView: unknown } }, prop: string) =>
          (
            el.ownerDocument.defaultView as {
              getComputedStyle: (e: unknown) => { getPropertyValue: (p: string) => string };
            }
          )
            .getComputedStyle(el)
            .getPropertyValue(prop),
        name,
      ),
  );
}

test.describe("off until you ask for it", () => {
  test("🔴 makes no sound, and builds no audio context, by default", async ({ knag }) => {
    await knag.seed(MIXED);
    await watchAudio(knag.page);

    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).toBe("keep me\n- [ ] not done");

    // Not merely silent — nothing was constructed. A product that made a noise the first
    // time you used it would be asking for something it has not earned, and an
    // AudioContext created for someone who never wanted one is not free on a phone.
    expect((await audio(knag.page)).contexts).toBe(0);
    expect((await audio(knag.page)).oscStarts).toEqual([]);
  });

  test("shows off as the active choice", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.openSettings();

    await expect(knag.page.locator('[data-sound="off"]')).toHaveAttribute("aria-pressed", "true");
    await expect(knag.page.locator('[data-sound="on"]')).toHaveAttribute("aria-pressed", "false");
  });

  test("survives a reload, like every other preference", async ({ knag }) => {
    await knag.seed(MIXED);
    await enableSound(knag);

    await knag.page.reload();
    await expect(knag.page.locator("[data-editor]")).toBeVisible();

    await knag.openSettings();
    await expect(knag.page.locator('[data-sound="on"]')).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("when it is on", () => {
  test("🔴 unlocks the context on the tap that enables it", async ({ knag }) => {
    await knag.seed(MIXED);
    await watchAudio(knag.page);
    await enableSound(knag);

    // 🔴 iOS unlocks audio on a user gesture and the unlock does not survive an `await`.
    // Turning the setting on *is* a gesture, so the context is built there — otherwise
    // the first wipe after enabling it is silent and every one after it works, which is
    // the most confusing shape a bug can have.
    expect((await audio(knag.page)).contexts).toBe(1);
  });

  test("🔴 plays one sound per wipe, never one per line", async ({ knag }) => {
    await knag.seed(MIXED);
    await watchAudio(knag.page);
    await enableSound(knag);

    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).toBe("keep me\n- [ ] not done");

    // Two lines went. One sound went with them — the same restraint that gives this
    // product one animation and one colour. Per-line would be a rattle.
    expect((await audio(knag.page)).oscStarts).toHaveLength(1);
  });

  test("🔴 places the knock from the motion's own numbers", async ({ knag }) => {
    await knag.seed(MIXED);
    await watchAudio(knag.page);
    await enableSound(knag);

    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).toBe("keep me\n- [ ] not done");

    // knockAt = duration + stagger × (n − 1) + collapse, with n = 2 checked lines.
    // Read from the tokens rather than hard-coded, so a retune moves one number in one
    // place and this still says what it means — which is the design's actual claim:
    // the sound needs no maintenance because it follows the motion.
    const expected =
      (await token(knag.page, "--wipe-duration")) +
      (await token(knag.page, "--wipe-stagger")) +
      (await token(knag.page, "--wipe-collapse"));

    const starts = (await audio(knag.page)).oscStarts;
    expect(starts).toHaveLength(1);
    const knock = starts[0] ?? 0;
    expect(knock * 1000).toBeCloseTo(expected, 5);
  });

  test("🔴 gives the page wipe the longer knock, from the page tokens", async ({ knag }) => {
    await knag.seed(MIXED);
    await watchAudio(knag.page);
    await enableSound(knag);

    await knag.openLedge();
    await knag.page.locator("[data-wipe-all]").click();
    await knag.page.locator("[data-wipe-all]").click();
    await expect.poll(() => knag.document()).toBe("");

    // Four lines this time, on the page timing. Not a second sound — the same event at a
    // second scale, which is the audio counterpart of the page wipe being a second
    // timing rather than a second animation.
    const expected =
      (await token(knag.page, "--page-duration")) +
      3 * (await token(knag.page, "--page-stagger")) +
      (await token(knag.page, "--page-collapse"));

    const starts = (await audio(knag.page)).oscStarts;
    expect(starts).toHaveLength(1);
    const knock = starts[0] ?? 0;
    expect(knock * 1000).toBeCloseTo(expected, 5);
    expect(knock * 1000).toBeGreaterThan(
      (await token(knag.page, "--wipe-duration")) + (await token(knag.page, "--wipe-collapse")),
    );
  });
});

test.describe("asking for less motion asks for less noise", () => {
  test("🔴 stays silent under prefers-reduced-motion, with no special case", async ({ knag }) => {
    await knag.page.emulateMedia({ reducedMotion: "reduce" });
    await knag.seed(MIXED);
    await watchAudio(knag.page);
    await enableSound(knag);

    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).toBe("keep me\n- [ ] not done");

    // 🔴 Not a media query in `sound.ts` and not a branch. The reduced-motion query
    // already rewrites every motion token to 1ms, so the formula yields a few
    // milliseconds and `play` refuses anything under its audible floor. Someone who
    // asked for less motion must not be handed the one thing louder — and the mechanism
    // that guarantees it is the same one that keeps the sound following the motion.
    expect((await audio(knag.page)).oscStarts).toEqual([]);

    await knag.page.emulateMedia({ reducedMotion: "no-preference" });
  });
});
