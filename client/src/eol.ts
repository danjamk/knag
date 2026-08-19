/**
 * Line endings, kept outside the editor.
 *
 * 🔴 Why this module exists. CodeMirror's document is line-based and LF-only: it splits
 * on `\n`, `\r\n` and `\r` and rejoins with `\n`, so a carriage return does not survive a
 * round trip. Pinning `EditorState.lineSeparator` to `"\n"` looks like the fix and is not
 * one — a lone `\r` then becomes an ordinary character at the end of the line's content,
 * so the caret can sit *past* it and typing at what looks like the end of the line
 * produces `CRLF line\rXYZ\n`, with the carriage return stranded mid-line. It renders
 * perfectly and corrupts on save, which is the exact failure principle 3 exists to
 * prevent. Measured in `docs/spikes/110-findings.md` on the `spike/110-codemirror`
 * branch, which is where that file lives — it is a probe, not repo documentation.
 *
 * So the editor never sees a `\r`. The document is split into LF-only text plus the set
 * of lines whose break was CRLF; the set is carried alongside and mapped through every
 * edit; the two are rejoined on the way out. `worker/src/blocks.ts` already does the same
 * thing one line at a time — it strips the trailing `\r` and carries it as `eol` — and
 * this is that idea applied to the whole document.
 *
 * 🔴 Pure on purpose, and it holds no CodeMirror types. The mapping is *policy* — what a
 * split inherits, what a delete destroys — and policy that can only be tested through a
 * browser is policy nobody tests. The CodeMirror binding is a thin adapter that turns a
 * transaction into a `LineEdit` and calls `remapEndings`.
 */

/** Zero-based indices of lines whose following newline was a CRLF. */
export type Endings = ReadonlySet<number>;

/**
 * Split a document into the text the editor sees and the endings it must not know about.
 *
 * 🔴 A trailing `\r` on the **final** element is content, not an ending. `"a\r"` has no
 * newline after it, so there is no break to describe, and treating it as one would invent
 * a `\n` on the way back. Only a line followed by a newline can carry an ending.
 *
 * One `\r` is stripped, never a run: `"a\r\r\n"` keeps its first carriage return as
 * content and records the ending, which is exactly what `blocks.ts` does with the same
 * input. The result is that arbitrary bytes round-trip, including the malformed ones.
 */
export function splitEndings(body: string): { text: string; endings: Set<number> } {
  const lines = body.split("\n");
  const endings = new Set<number>();
  const last = lines.length - 1;
  for (let i = 0; i < last; i += 1) {
    const line = lines[i] as string;
    if (line.endsWith("\r")) {
      lines[i] = line.slice(0, -1);
      endings.add(i);
    }
  }
  return { text: lines.join("\n"), endings };
}

/** Rejoin. `joinEndings(...splitEndings(x))` is `x`, for every `x`. */
export function joinEndings(text: string, endings: Endings): string {
  const lines = text.split("\n");
  let out = "";
  for (let i = 0; i < lines.length; i += 1) {
    out += lines[i] as string;
    if (i < lines.length - 1) out += endings.has(i) ? "\r\n" : "\n";
  }
  return out;
}

/**
 * One edit, described in lines rather than offsets.
 *
 * `from` and `to` are line indices in the document **before** the edit, and the edit is
 * contained within them — from the start of `from` to somewhere inside `to`. That is
 * exactly what CodeMirror's `doc.lineAt(fromA)` and `doc.lineAt(toA)` report, so the
 * adapter is a translation rather than a calculation.
 */
export type LineEdit = {
  from: number;
  to: number;
  /**
   * The endings of the breaks *between* the replacing lines — one entry per break, so
   * length is (replacing lines - 1) and an edit that adds no lines passes `[]`.
   *
   * The caller decides these because only the caller knows where the text came from: a
   * paste carries its own endings, while pressing Enter inherits (see `inherit`).
   */
  inserted: readonly boolean[];
};

/**
 * Move the endings across an edit.
 *
 * 🔴 The ending belongs to the **break after** a line, not to the line, and that is the
 * whole of the logic. A break survives if the edit did not consume it:
 *
 * - breaks before `from` are untouched
 * - breaks inside the replaced range are destroyed with it
 * - the break after `to` survives — the edit stopped inside `to`, not past its end — and
 *   lands on whatever is now the last replacing line
 * - everything after shifts by the change in line count
 */
export function remapEndings(endings: Endings, edit: LineEdit): Set<number> {
  const replacing = edit.inserted.length + 1;
  const last = edit.from + replacing - 1;
  const delta = last - edit.to;

  const next = new Set<number>();
  for (const line of endings) {
    if (line < edit.from) next.add(line);
    else if (line === edit.to) next.add(last);
    else if (line > edit.to) next.add(line + delta);
    // from <= line < to: the break was inside the replaced range. Gone with it.
  }
  for (let i = 0; i < edit.inserted.length; i += 1) {
    if (edit.inserted[i]) next.add(edit.from + i);
  }
  return next;
}

/**
 * What new breaks inherit when the caller has nothing better — pressing Enter, mostly.
 *
 * Inheriting from the line being split is the least surprising rule available: splitting a
 * CRLF line in a CRLF document yields two CRLF lines, and the document does not silently
 * become mixed because someone pressed Enter. Text arriving from outside (a paste) knows
 * its own endings and must not use this.
 */
export function inherit(endings: Endings, line: number, breaks: number): boolean[] {
  return Array.from({ length: breaks }, () => endings.has(line));
}
