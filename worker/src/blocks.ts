/**
 * The block parser. Rows are blocks, not lines.
 *
 * 🔴 This module exists **exactly once** and is imported by both the Worker (for
 * clear-completed) and the client (to render rows). That is the entire reason this
 * project has a build step (spec §2). Two implementations of a byte-preservation
 * contract is the likeliest way knag corrupts a document, and the damning part is
 * that each one's round-trip test passes while they disagree with each other.
 *
 * 🔴 It must stay environment-agnostic — pure string handling, no `crypto`, no DOM,
 * no bindings. It is typechecked under both tsconfigs, and the client's has no
 * Workers types while the Worker's has no DOM.
 *
 * The invariant everything else rests on:
 *
 *     serialize(parse(x)) === x        for every x
 *
 * It holds because `raw` is a verbatim slice of the source and serialization is a
 * join. Nothing here reconstructs a line from parsed fields — `toggle()` is the one
 * exception, and it rebuilds only the single line it was handed.
 *
 * Spec §14.1 (block model), §14.2 (checkbox grammar).
 */

export type BlockKind = "checkbox" | "text" | "fence" | "blank";

export type Block = {
  kind: BlockKind;
  /** Exact source lines, joined with `\n`, unmodified. The only thing serialized. */
  raw: string;
  /** Zero-based, inclusive. */
  startLine: number;
  /** Zero-based, inclusive. Equals `startLine` for everything but a fence. */
  endLine: number;

  /** Fence blocks only. Set when the fence ran to EOF without a closing marker. */
  unterminated?: true;

  /** Checkbox blocks only — leading whitespace, preserved verbatim. */
  indent?: string;
  /** Checkbox blocks only — `-` or `*`. Never normalized. */
  marker?: string;
  /** Checkbox blocks only. `[x]` and `[X]` are both checked. */
  checked?: boolean;
  /** Checkbox blocks only — everything after the bracket, trailing space included. */
  text?: string;
  /** Checkbox blocks only — `"\r"` on a CRLF document, else `""`. See `withoutCR`. */
  eol?: string;
};

/**
 * The checkbox grammar, exactly as specified. `-[ ]` is not a checkbox; neither is
 * `- []`, `- [y]`, or `- [ ]x`. Being strict here is what stops the parser claiming
 * ownership of a line it would then rewrite.
 */
export const CHECKBOX = /^(\s*)([-*])\s\[([ xX])\]\s(.*)$/;

/** A fence opens where the first non-whitespace is three or more backticks or tildes. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Split on `\n` only, never on `\r\n`.
 *
 * 🔴 This is what makes CRLF survive serialization for free. A `\r` stays as the last
 * character of its line, gets carried inside `raw`, and reappears when the lines are
 * rejoined with `\n`. Splitting on `\r\n` would mean tracking each line's ending and
 * reassembling them, which is a second place to get it wrong.
 */
function splitLines(body: string): string[] {
  return body.split("\n");
}

/**
 * Strip a trailing carriage return before matching.
 *
 * 🔴 Not cosmetic. **`.` does not match `\r` in JavaScript** — `\r` is a line
 * terminator, so `(.*)$` cannot reach past one. Applied to a raw CRLF line, both
 * grammars above simply fail to match: every checkbox parses as `text` and every
 * fence as a run of unrelated lines.
 *
 * That failure is invisible to a round-trip test, because `raw` is a verbatim slice
 * whatever the block's `kind` turns out to be — serialization stays byte-perfect
 * while nothing renders as a checkbox and clear-completed removes nothing. It was
 * caught by the block-model assertions, not the property test.
 *
 * The `\r` is carried on the block as `eol` so `toggle()` can put it back.
 */
function withoutCR(line: string): { content: string; eol: string } {
  return line.endsWith("\r")
    ? { content: line.slice(0, -1), eol: "\r" }
    : { content: line, eol: "" };
}

/**
 * Does `line` close a fence opened with `open`?
 *
 * Same character, and at least as long — CommonMark's rule, and the reason ```` ``` ````
 * does not close a ```` ```` ```` fence. Only whitespace may follow, so a line like
 * ```` ```js ```` opens rather than closes.
 */
function closesFence(line: string, open: string): boolean {
  const match = FENCE.exec(withoutCR(line).content);
  if (!match) return false;
  const [, , run, rest] = match;
  if (!run || run[0] !== open[0] || run.length < open.length) return false;
  return (rest ?? "").trim() === "";
}

/** Parse a document body into blocks. Never throws; every input is a valid document. */
export function parse(body: string): Block[] {
  const lines = splitLines(body);
  const blocks: Block[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const { content, eol } = withoutCR(line);
    const fence = FENCE.exec(content);

    if (fence) {
      const open = fence[2] as string;
      let end = i;
      let terminated = false;

      // Scan for the close. Running off the end is not an error — an unclosed fence
      // must not swallow the rest of the document into one unreorderable blob, so
      // EOF closes it and the block says so.
      for (let j = i + 1; j < lines.length; j++) {
        if (closesFence(lines[j] as string, open)) {
          end = j;
          terminated = true;
          break;
        }
        end = j;
      }

      blocks.push({
        kind: "fence",
        raw: lines.slice(i, end + 1).join("\n"),
        startLine: i,
        endLine: end,
        ...(terminated ? {} : { unterminated: true as const }),
      });
      i = end;
      continue;
    }

    const checkbox = CHECKBOX.exec(content);
    if (checkbox) {
      const [, indent, marker, box, text] = checkbox;
      blocks.push({
        kind: "checkbox",
        raw: line,
        startLine: i,
        endLine: i,
        indent: indent ?? "",
        marker: marker ?? "-",
        checked: box !== " ",
        text: text ?? "",
        eol,
      });
      continue;
    }

    blocks.push({
      // Whitespace-only counts as blank so spacing is its own row and survives a
      // reorder. `raw` still holds the whitespace, so nothing is normalized.
      kind: line.trim() === "" ? "blank" : "text",
      raw: line,
      startLine: i,
      endLine: i,
    });
  }

  return blocks;
}

/**
 * Blocks back to a document body.
 *
 * The whole contract in one line: concatenate the verbatim slices. Never rebuild a
 * block from its parsed fields.
 */
export function serialize(blocks: Block[]): string {
  return blocks.map((b) => b.raw).join("\n");
}

/**
 * Flip a checkbox, returning a new block. Rebuilds **only** this line — never a
 * document-wide regex, which would rewrite every matching line in the document
 * including ones inside fences.
 *
 * Checking writes a lowercase `x` because there is no prior case to preserve.
 * Unchecking writes a space, discarding whether it had been `x` or `X`, which is the
 * only information a toggle is allowed to lose.
 */
export function toggle(block: Block): Block {
  if (block.kind !== "checkbox") {
    throw new Error(`toggle() expects a checkbox block, got ${block.kind}`);
  }

  const checked = !block.checked;
  const box = checked ? "x" : " ";

  return {
    ...block,
    checked,
    raw: `${block.indent}${block.marker} [${box}] ${block.text}${block.eol ?? ""}`,
  };
}

/**
 * The blocks `clear-completed` removes: checked checkboxes, at any indentation level,
 * and nothing else (spec §14.2).
 */
export function isCompleted(block: Block): boolean {
  return block.kind === "checkbox" && block.checked === true;
}
