/**
 * knag — the PWA.
 *
 * Scaffold state: proves the bundle pipeline and nothing else. The raw view arrives
 * with build-order step 3, polling with step 4, the list view with step 7
 * (docs/spec.md §13).
 *
 * 🔴 The reason this file is TypeScript and gets bundled at all: it will import
 * `worker/src/blocks.ts` — the same module the Worker uses for clear-completed. One
 * parser, not two. Two implementations of a byte-preservation contract is the most
 * likely path to a corrupted document, and each one's round-trip test passes while
 * they disagree with each other. See spec §2.
 */

const el = document.querySelector<HTMLElement>("[data-status]");
if (el) {
  const res = await fetch("/health");
  const info = (await res.json()) as { version: string };
  el.textContent = info.version;
}

export {};
