/**
 * Drives the probe in WebKit and reports. WebKit because iOS mandates it - a green
 * result in Chromium would be a report about a browser knag never runs on.
 *
 *   node docs/spikes/110-headless.mjs
 *
 * 🔴 The drill that matters is #4: Backspace over a selection spanning three rows. That
 * single keystroke is what destroyed the contenteditable spike in ADR-006 - two text
 * spans in one row, a third span outside the model, inlined font styles - and it all
 * rendered perfectly. If CodeMirror survives it byte-exact, that is the finding.
 */

import { webkit } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const page_url = "file://" + join(here, "110-codemirror-probe.html");

const results = [];
function check(label, ok, note = "") {
  results.push({ label, ok, note });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}${note ? `  — ${note}` : ""}`);
}

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(page_url);
await page.waitForFunction(() => typeof window.__probe === "object");

const P = () => page.evaluate(() => window.__probe.doc());
const source = await page.evaluate(() => window.__probe.source);

console.log("\n── 1. Round trip ────────────────────────────");
check(
  "default lineSeparator round-trips",
  await page.evaluate(() => window.__probe.roundTripDefault),
  "CRLF is dropped if this is red",
);
check(
  "lineSeparator pinned to \\n round-trips",
  await page.evaluate(() => window.__probe.roundTripPinned),
);
check("live document === source at load", await page.evaluate(() => window.__probe.matchesSource()));

console.log("\n── 2. Checkbox widgets ────────────────────");
const boxes = await page.evaluate(() => window.__probe.boxCount());
check("three checkbox controls rendered", boxes === 3, `found ${boxes}`);

const beforeToggle = await P();
await page.evaluate(() => window.__probe.toggleFirstBox());
const afterToggle = await P();
let diffs = 0;
for (let i = 0; i < Math.max(beforeToggle.length, afterToggle.length); i += 1) {
  if (beforeToggle[i] !== afterToggle[i]) diffs += 1;
}
check("toggling rewrites exactly one character", diffs === 1, `${diffs} chars changed`);
check(
  "toggle produced [x] in the right place",
  afterToggle.includes("- [x] call the accountant"),
);
await page.evaluate(() => window.__probe.toggleFirstBox());
check("toggling back restores the source byte-exactly", (await P()) === source);

console.log("\n── 3. Cross-row selection ─────────────────");
// Lines 3-5: the two checkboxes and the nested one. Absolute offsets from the source.
const start = source.indexOf("- [ ] call the accountant");
const end = source.indexOf("* star bullet");
await page.evaluate(([a, b]) => window.__probe.select(a, b), [start, end]);
const seenSel = await page.evaluate(() => window.__probe.seen());
check("a selection spanned more than one line", seenSel.multilineSelection === true);

// What a cross-row copy actually yields. Reported rather than graded: it is a product
// decision, not a defect. knag's per-row copy strips the `- [ ] ` prefix today, and a
// selection copy carries it — the two would disagree, and that has to be decided.
await page.evaluate(() => {
  document
    .querySelector(".cm-content")
    .dispatchEvent(new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }));
});
const copied = (await page.evaluate(() => window.__probe.seen())).crossRowCopyText;
check("cross-row copy produced text", copied.length > 0, `${copied.length} chars`);
console.log("   clipboard would hold:");
for (const line of copied.split("\n")) console.log(`     |${line}`);

console.log("\n── 4. Backspace over a 3-row selection ────");
console.log("   (the keystroke that destroyed the contenteditable spike)");
await page.keyboard.press("Backspace");
const afterBackspace = await P();
// 🔴 Asserted as an exact identity, not as "the integrity checks stayed green". This
// drill deletes the nested-indent hazard line on purpose, so those checks are supposed
// to go red here — a harness that reported that as a defect would be reporting on
// itself. Source-minus-the-selected-range is the stronger claim anyway: it catches a
// single stray byte anywhere in the document, which is the whole failure mode.
check(
  "result is exactly source minus the selected range",
  afterBackspace === source.slice(0, start) + source.slice(end),
);
check("no markup or inline styles entered the document", !/<[a-z]|font-family/i.test(afterBackspace));

console.log("\n── 5. Undo ───────────────────────────────");
await page.keyboard.press("Meta+z");
check("undo restored the document byte-exactly", (await P()) === source);
// Safe now, and only now: the document is identical to source again, so anything red
// after this point is the editor's doing rather than the drill's.
const stillRed = await page.evaluate(() => window.__probe.clearFailures());
check("every integrity check green once the document is back", stillRed.length === 0, stillRed.join(", ") || "none");

console.log("\n── 6. Typing ────────────────────────────");
// 🔴 At the END of the tab line, not after the tab. Typing *into* a hazard line and
// then asserting that line is unchanged is a contradiction, and it produced a false red
// twice before this comment existed. Appending still exercises the thing worth
// exercising — typing immediately adjacent to a tab — while leaving every check
// meaningful.
const tabLine = "\ttab indented line";
const tabPos = source.indexOf(tabLine) + tabLine.length;
await page.evaluate((p) => window.__probe.select(p, p), tabPos);
await page.keyboard.type("XYZ");
const afterType = await P();
check("typing inserted exactly what was typed", afterType.includes("\ttab indented lineXYZ"));
check(
  "the tab beside it is still a tab",
  (await page.evaluate(() => window.__probe.failures())).length === 0,
  (await page.evaluate(() => window.__probe.failures())).join(", ") || "none",
);
await page.keyboard.press("Meta+z");
check("undo after typing restores the source byte-exactly", (await P()) === source);

console.log("\n── 7. Paste of rich text ──────────────────");
await page.evaluate((p) => window.__probe.select(p, p), 0);
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData("text/plain", "pasted line one\npasted line two\n");
  dt.setData("text/html", '<b style="font-family: Comic Sans">pasted <i>line</i> one</b>');
  document
    .querySelector(".cm-content")
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(50);
const afterPaste = await P();
check("paste inserted the plain-text form", afterPaste.startsWith("pasted line one\npasted line two\n"));
check("no HTML or font styling entered the document", !/<[a-z]|font-family|Comic/i.test(afterPaste));

await page.evaluate(() => window.__probe.clearFailures());

console.log("\n── 8. Editing the CRLF line ───────────────");
// 🔴 Pinning `lineSeparator` makes a pristine document round-trip, which is NOT the
// same as handling CRLF. With "\n" as the only separator, a "\r" is an ordinary
// character sitting at the end of the line's content — so the caret can be placed
// AFTER it. If typing at what looks like the end of the line puts text past the
// carriage return, the CR lands mid-line and the document is quietly malformed.
const crLine = "CRLF line\r";
const crEnd = source.indexOf(crLine) + crLine.length;
await page.evaluate((p) => window.__probe.select(p, p), crEnd);
await page.keyboard.type("XYZ");
const afterCr = await P();
check(
  "typing at end of a CRLF line keeps the CR last",
  afterCr.includes("CRLF lineXYZ\r\n"),
  afterCr.includes("CRLF line\rXYZ") ? "CR is now MID-LINE" : "",
);

// The BUTTON, which restores the document. Sections 7 and 8 left a paste and three
// typed characters in place, and Arrange must be judged against a known document.
await page.locator("[data-reset]").click();
check("reset restored the source before the mode test", (await P()) === source);

console.log("\n── 9. Arrange, the sort mode ──────────────");
// 🔴 The check that matters is the NO-OP trip. Dragging working is visible in seconds
// and was never the risk; two renderings quietly disagreeing about the document is.
await page.locator("[data-arrange]").click();
const rowCount = await page.locator("ul.arrange li").count();
check("Arrange rendered one row per block", rowCount > 0, `${rowCount} rows`);
check("the editor is gone while arranging", (await page.locator(".cm-content").count()) === 0);

await page.locator("[data-arrange]").click();
check("a trip through Arrange with no drag is byte-identical", (await P()) === source);
check(
  "the probe agrees it round-tripped",
  (await page.evaluate(() => window.__probe.seen())).arrangeRoundTrip === true,
);
check("the editor came back", (await page.locator(".cm-content").count()) === 1);

// Now actually reorder: move the first block to the end, the way a drag would.
await page.locator("[data-arrange]").click();
await page.evaluate(() => {
  const list = document.querySelector("ul.arrange");
  list.append(list.querySelector("li"));
});
await page.locator("[data-arrange]").click();
const reordered = await P();
check("reorder preserved every byte", reordered.length === source.length, `${reordered.length} vs ${source.length}`);
check("the moved block is no longer first", !reordered.startsWith("Thursday"));
check("the moved block is still present", reordered.includes("Thursday"));
check(
  "the fence did not come apart",
  reordered.includes("```js\nconst x = 1;\n```"),
);

await page.locator("[data-reset]").click();

console.log("\n── 10. Input at the widget boundary ───────");
// 🔴 Raised by an outside review: CodeMirror has a known issue where IME composition
// adjacent to a widget can break, because `cm-widgetBuffer` nodes are reconstructed
// mid-composition — and knag's checkbox widgets sit at the head of the most-edited
// lines in the document. Real composition is a device concern and the page carries a
// drill for it; what is testable here is the boundary itself.
const cbLine = "- [ ] call the accountant";
const boundary = source.indexOf(cbLine) + "- [ ] ".length;
await page.evaluate((p) => window.__probe.select(p, p), boundary);
await page.keyboard.type("NOW ");
const afterBoundary = await P();
check("text lands after the prefix, not inside it", afterBoundary.includes("- [ ] NOW call the accountant"));
check("the prefix is byte-intact", !afterBoundary.includes("- [ ]NOW") && !afterBoundary.includes("-[ ]"));
check("all three checkboxes still render", (await page.evaluate(() => window.__probe.boxCount())) === 3);
check(
  "no integrity check went red",
  (await page.evaluate(() => window.__probe.failures())).length === 0,
  (await page.evaluate(() => window.__probe.failures())).join(", ") || "none",
);

console.log("\n── 11. Page errors ──────────────────────");
check("no uncaught errors", errors.length === 0, errors.join(" | ") || "none");

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "✓" : "✗"} ${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length) {
  console.log("failed: " + failed.map((f) => f.label).join("; "));
  process.exit(1);
}
