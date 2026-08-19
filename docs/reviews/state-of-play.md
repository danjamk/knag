# knag — state of play

> 🔴 **Answered, and the world it describes is gone.** The question this brief asks
> — §12 Q2, *"is CodeMirror 6 the right instinct or are we pattern-matching on plain
> text too eagerly?"* — was answered **yes**, probed for a day, and shipped in v0.8.0.
> The decision is [ADR-007](../adr/ADR-007-one-editing-surface.md); this is the brief
> that produced it, kept because the reasoning is why the decision is shaped the way it
> is.
>
> **Read it for the argument, not for the state of the code.** It describes one form
> control per row, cross-row selection as impossible, and a 63 KB client. All three are
> now false. The row model it describes is on its way out
> ([#113](https://github.com/danjamk/knag/issues/113)).

**A standalone brief for outside review.** Written 2026-08-18. Assumes no access to the
code, the repo, or the prior conversation. Everything needed to form an opinion is here.

**What we want from you:** knag works, is used daily, and has driven itself into a corner
on the one thing that matters most — ordinary text editing. We want the corner named
correctly, the constraints challenged where they deserve it, and options we have not
thought of. Contradicting the decisions recorded below is the point of sending it to you,
not a violation of the brief.

---

## 1. The product in one page

**knag makes throwing things away feel good.**

One plain-text page. Always live. Edited from a phone, a laptop, or by an AI agent over
MCP. It replaces the legal pad you keep next to the keyboard. It is explicitly *not* a
note system, not a task manager, not a second brain.

Three parts, and each one serves the others:

- **The nag** is the tension. A list nags by *existing*, not by notifying. You open it and
  the line is still there, in your own words, from three weeks ago.
- **The wipe** is the release. One tap clears the finished rows — or the whole page.
- **The record** is what makes the release free. Every wipe is recoverable; every save is
  logged. Without it, throwing away a half-finished list is a small act of anxiety and you
  hesitate over every line. With it, you wipe without thinking.

There is one page. There is no search, no tags, no folders, no due dates, no
notifications, no rollover, no daily notes. That list is deliberate and load-bearing — the
product's thesis is that a list stays short because it gets *wiped*, not because it gets
*organized*.

### The five principles, verbatim from the spec

1. **One document.** No days, no rollover, no multiple notes.
2. **No required structure.** Checkbox syntax is the one optional convention.
3. **Nothing is normalized.** Bytes in, bytes out. Indentation, blank lines, trailing
   whitespace, CRLF, and `*` vs `-` markers all survive a round trip.
4. **Deletion is not loss.** The log holds everything.
5. **The brain is not involved.** No external syncing.

Principle 3 is enforced by a property-based test (`serialize(parse(x)) === x` over
generated documents) and has held absolutely since day one.

### The document, concretely

The page is a plain string. This is a realistic one:

~~~text
Thursday

- [ ] call the accountant
- [x] renew the domain
  - [ ] and update the DNS record
- * check on the shed

Notes from standup — https://example.com/notes
  indented thought that is not a list item

```js
const x = 1;
```

~~~

Everything in that block is bytes on the page. There is no front matter, no metadata, no
IDs, no structure the file does not literally contain.

---

## 2. What is built and working today

| | |
|---|---|
| **One live page** | Plain text, in a single database row. Optimistic concurrency on every write. |
| **Multi-device sync** | Polled with adaptive backoff, ETag-gated. Phone, iPad, laptop stay in step. A device left open for three days cannot clobber the page — it gets a 409 and re-reads. |
| **Checkboxes** | `- [ ] milk` is a real, tappable checkbox at any indentation. Checked rows dim and strike **and stay in place** — no auto-sink. That is the nag working. |
| **Wipe** | `wipe 6` clears the finished rows in one tap, no confirm. A `wiped 6 · bring back` line sits above the footer until the next wipe. A separate control wipes the *whole* page, confirmed by repetition rather than a dialog. |
| **Arrange** | An explicit mode. Rows go read-only, large drag grips appear, each row gains a delete control, and tapping rows picks several at once for bulk copy/delete. Drag-to-reorder works on touch and desktop. |
| **Agent access** | An MCP server on the same host. Four tools: read, write, wipe, history. Claude edits the same page the human does. |
| **History** | Every save is logged and coalesced; wiped items are recorded separately as "what actually got finished". Readable via the agent; there is no history *screen* yet. |
| **PWA** | Installs to the iOS home screen and the Mac dock. Service worker caches the shell. Offline is *detected and announced* — editing is refused rather than silently lost. |
| **Two boards** | **Slate** (chalk on a blackboard, default) and **Whiteboard** (marker on dry-erase). Amber is the only accent colour in the entire interface. |

**Assessment from the owner, unprompted:** the sweep and the sort "are actually quite
sweet. Very pleasing and easy." The nag → wipe loop works. Nothing in this section is
under review.

### Scale and stack, for calibration

Cloudflare Worker + SQLite (D1), TypeScript throughout, **no framework**. One HTML file,
one bundled client script (63 KB minified), one Worker entry point. Roughly 3,200 lines of
client TypeScript and 2,800 of Worker TypeScript. ~430 unit tests running against real D1
plus a Playwright/WebKit browser suite. It is a personal project built by one person with
an AI pair over about a week of evenings and weekends.

The stated engineering posture is **"prefer the boring tool; new dependencies need a
reason."** The largest client dependency today is a 40 KB drag-and-drop library.

---

## 3. How the editor is built — the part that matters

This is the mechanism the whole question turns on, so it is worth being precise.

**The page is parsed into *blocks*, not lines.** A block is one of four kinds: `checkbox`,
`text`, `blank`, or `fence` (a fenced code block, which is one block spanning several
lines). Each block keeps its exact source text verbatim. Serializing is
`blocks.map(b => b.raw).join('\n')` — the parser never rebuilds a line from parsed fields
except for the one block being edited.

**One block renders as one row, and each row is its own form control.**

```
┌──────────────────────────────────────────────────────┐
│ ☐  [ textarea: "call the accountant"            ]    │   ← checkbox row
├──────────────────────────────────────────────────────┤
│    [ textarea: "Notes from standup — https://…" ] ↗  │   ← text row + link button
├──────────────────────────────────────────────────────┤
│    [ textarea: "```\nconst x = 1;\n```"         ]    │   ← fence row (multi-line)
└──────────────────────────────────────────────────────┘
```

Every text row is an auto-growing `<textarea rows="1">`. It is **live** — always editable,
no tap-to-activate step. The checkbox beside it is a real `<input type="checkbox">`, always
tappable, even mid-typing.

**Row boundaries are made to behave like line boundaries by intercepting keys:**

| Key | Behaviour |
|---|---|
| `Enter` at end of row | new empty row below, focused |
| `Enter` mid-row | split the block in two |
| `Enter` on a checkbox/bullet | continue the list with the same marker |
| `Backspace` at position 0 | merge into the previous row, caret at the join |
| `←` at start / `→` at end | cross to the adjacent row |
| `↑` / `↓` at a visual-line boundary | cross to the adjacent row, **same pixel column** |

That last one required writing a caret-geometry module that measures text in a hidden
mirror element, because a character offset is not a column in a proportional typeface.

**The DOM is already a projection of the model.** The edit functions (`splitAt`,
`mergeBackward`, `neighbor`) are pure — string and index in, new string and caret position
out, no DOM. Every structural edit re-renders the whole row list from the document string
and then restores the caret. Ordinary typing deliberately does *not* re-render, because
rebuilding a row on every keystroke resets the caret.

**There is also a raw view**: the whole document in one full-bleed textarea. It lives
behind Settings → View → raw. It round-trips byte-for-byte and is documented as "the escape
hatch."

---

## 4. The constraint stack

Five decisions bind the UX. Each is recorded, argued, and currently in force.

**A. Nothing is normalized (principle 3).** Bytes in, bytes out, enforced by property test.
The reason is the agent contract: an AI writing to the page writes plain text and knows
exactly what it will get back. *Not under review — this is the product.*

**B. The display never diverges from the bytes (ADR-004).** No rendered bold, no styled
headings, no bullet where the file says `-`. The stated test for any new rendering: **can
the file be reconstructed byte-for-byte from what is on screen?** Checkboxes pass — the row
is a lossless projection of `- [ ] text` and toggling rewrites exactly the character
between the brackets. Linkified URLs pass — the URL text is still there in full. Rendered
markdown fails.

**C. One editing mode; typing is primary (ADR-003).** The first build shipped two co-equal
views — a list view and a raw view — with a toggle. Real use killed it:

> my first big issue is raw vs. list. I really think we need something that is seamless and
> easy. one mode primarily... i want to be in checkbox mode all the time, but still being
> able to edit.

The failure was not that either view was bad. **The product is a legal pad, and a legal pad
has no modes.** ADR-003 reversed the design: every row became a live input, raw view was
demoted from a peer to an escape hatch, and the "fiddly cursor work" the spec had
explicitly declined got done. *This decision is validated by use and is not the problem.*

**D. Cross-row selection stays out of the editor (ADR-006).** See §5 — this is the corner.

**E. The Out list.** search · tags · multiple documents · attachments · offline editing ·
multi-user · sharing · rollover · day boundaries · rich formatting. The spec says: *"If a
weekend turns into two, something from that list came back."*

---

## 5. The problem, stated precisely

### The report

> Right now it seems that I cannot do a multi-line select.

and, earlier and more completely:

> Here was my hope... that there was no raw mode. the whole thing acted like a note pad
> everyone is used to... you type, edit, etc. like a normal text editor. it has a few
> render concepts... well basically only one... checkboxes. But otherwise, a normal text
> editor — select, cut, paste, etc. — just like google docs and slack. When you shift into
> sort mode, something special happens — you can drag lines, delete lines, copy lines. that
> is pretty cool. very nice on devices and desktop. The idea that I cannot copy multi-lines
> in the foundational edit mode — is friction.

Dragging across several lines, or holding shift and pressing down, selects nothing past the
row it started in. Select-a-paragraph-and-copy — a thing people do without thinking — does
not work.

### The causal chain

This is not a bug in a handler. It is the direct, unavoidable consequence of a chain of
individually reasonable decisions:

```
  Checkboxes must be real tappable controls, live while typing
      ↓
  Each line needs its own DOM structure: a control + its text
      ↓
  Text must be editable in place, with no tap-to-activate step (ADR-003)
      ↓
  Each line's text is therefore its own form control (<textarea>)
      ↓
  A DOM Selection cannot span two form controls — a platform rule, not a bug
      ↓
  No selection can cross a line boundary
      ↓
  No select / copy / cut across lines — table stakes for "a normal text editor"
```

Sweeping and sorting push the same way independently: both are per-block operations, so
both want blocks to be individually addressable DOM units.

**The underlying tension, stated generally:** the three features that make knag good —
checkboxes as controls, sweep, drag-to-sort — all want the document *decomposed into
per-line UI units*. Plain text editing wants the document to be *one contiguous editable
run*. Those are in direct opposition.

Every product that solves both — Bear, Obsidian, Notion, Slack's composer, Google Docs —
resolves it the same way: **one contenteditable surface, an intercepted input layer, and a
model that owns the truth.** knag took the other resolution (per-line form controls)
because it is cheap, safe, and keeps the browser's native text editing intact inside each
row. It is now hitting the wall that choice implies.

### The owner's own read, which we think is correct

> I think the checkbox rendering, sweeping and sorting created a technical implementation
> that then conflicted with the simplicity of foundational text editing. We used to have
> raw/list view to handle these. But I did not like that.

### The second-order cost: undo

Less discussed and possibly a bigger daily friction. **There is no client-side undo.** Each
row's textarea has the browser's own undo stack, so `⌘Z` works *within one row* — until any
structural edit or any incoming sync re-renders the list, at which point every stack in the
document is destroyed. There is a server-side revision log (which is the *documented* undo,
and is what makes destructive actions safe to offer without confirmation), but nothing in
the editor answers `⌘Z` the way a text editor does.

---

## 6. What has been tried, and what each attempt taught

**Attempt 1 — two views with a toggle.** Shipped in the first build. Killed by real use;
see constraint C. **Lesson: a mode question asked every time the app opens is the worst UX
defect the product has had.**

**Attempt 2 — a spike on one `contenteditable` container with rows as children.** A
standalone diagnostic page holding a deliberately awkward document (blank line, leading
indent, trailing spaces, a `*` marker that must never become `-`), reporting live whether
the DOM still holds one row per line and whether the document rebuilt from the DOM matches
what is on screen. Tested on desktop and on a real iPhone.

- ✅ **Selection is free.** It spans rows natively, with correct line breaks, including iOS
  long-press and drag handles. No synthetic overlay, no custom touch code.
- ❌ **Letting the browser apply an edit destroys the document.** One Backspace across three
  rows, in WebKit, produced: two text spans in one row, a third span *outside the model
  entirely*, inlined computed font styles (formatting this document has no way to
  represent), and content from an indented line and a `*` bullet now sitting inside a
  **checkbox** row — so it would have saved carrying a `- [ ] ` prefix it never had.

🔴 **It all rendered perfectly.** Nothing looked wrong. The corruption would only appear on
save, in a store holding the only copy of the page.

**Lesson, and it is the load-bearing one:** the architecture is not in question — the
*browser cannot be allowed to mutate the DOM*. Which is exactly what ProseMirror, Lexical
and Slate all conclude, and why they exist.

*Sub-lesson worth passing on:* the first version of that probe reported clean, twice. Its
reconstruction routine read only the first text span in a row, and the round-trip check
agreed with it because both sides lost the same text. **A self-consistent check over an
incomplete read is not a check.**

**Attempt 3 — meet the need in Arrange instead (the patch that is shipped).** Selecting
several rows in the sort mode and copying or deleting them together. Whole-row granularity,
works on touch and desktop, does not touch the editing model. It is genuinely useful.

It is also *not the thing that was asked for* — it is in a different mode, at a coarser
granularity, and it introduced a **second, unrelated meaning of "selected"** into a product
whose whole argument is that it has no modes to think about.

**And it shipped invisible.** A picked row was marked by a background shift alone, at a
contrast ratio of **1.14** where 3.0 is the accessibility floor. Tapping rows did exactly
what it was meant to and gave back no evidence, so the feature read as broken and was
reported as "I cannot do a multi-line select." Twelve tests passed because every one of
them asserted the CSS class rather than whether it could be seen. *Lesson: a UI state that
cannot be perceived did not ship.*

---

## 7. What is *not* the problem

Worth ruling out explicitly, because these are the obvious things to reach for and they are
all red herrings here.

- **Formatting demand is low.** The stated desire is *checkboxes and free-form text*. Not
  bold, not headings, not tables. Rich-text machinery is not what is needed. This matters a
  great deal for which components are appropriate.
- **ADR-004 (display matches the bytes) is not in the way.** It forbids rendered markdown.
  Nobody is asking for rendered markdown. Checkboxes already pass its test as a lossless
  projection. It could stay exactly as written and the editing problem would be unchanged.
- **ADR-003's *intent* is not in the way.** "One mode, typing is primary" was validated by
  real use and is the right call. It is ADR-003's *mechanism* — one form control per row —
  that forbids selection. The intent survives a change of mechanism; in fact a change of
  mechanism would serve the intent better.
- **It is not a missing keyboard handler.** Arrow keys, split, merge, and column-preserving
  vertical motion were all built and all work. The selection limit is a platform rule about
  form controls, and no amount of handler work moves it.
- **Raw view is not the answer, and its use is the diagnostic.** ADR-003 set the trigger
  itself: *"if raw view starts being used daily rather than rarely, the row model is the
  wrong shape and this decision should be reopened rather than patched."* It is now being
  reached for to select text. The trigger has fired.

---

## 8. The three hard problems any real fix must solve

If the editor becomes one intercepted surface, these are what the row model was buying, and
they must be paid for. Listed in descending order of risk.

**1. IME, autocorrect and dictation — the one that can kill it.** The product deliberately
turns autocorrect and autocapitalize *on*, on the reasoning that autocorrect is the user
typing through their keyboard, not the app rewriting bytes. On iOS that means composition
events, and `beforeinput` with `insertCompositionText` **cannot reliably be cancelled** —
preventing default mid-composition breaks the keyboard. This is the single largest body of
code in every editor framework, and **iOS Safari is the one target that must not break**
(the product is phone-first; iOS mandates WebKit). **This has never been tested.** The
spike never typed with autocorrect on, never used dictation, never used an IME.

**2. Undo.** Nothing exists today (see §5). A model-driven editor needs its own operation
history with coalescing and `historyUndo`/`historyRedo` interception.

**3. Paste.** A textarea flattens pasted HTML to plain text for free. Model-driven means
intercepting the paste, taking `text/plain`, splitting on newlines, and applying it as a
multi-block edit while preserving bytes. Tractable, and the least scary of the three.

Beyond those: drag-and-drop into the editor, and deciding what `⌘A` means (there is a
stated requirement that it should mean "this line", not "the whole document").

---

## 9. Options currently on the table

**A — Status quo.** Arrange multi-select is the answer at row granularity; raw view is the
escape hatch for everything else. Cost: zero. Cost of *not* fixing it: the friction is in
the most-used interaction in the product, and it is the thing the owner notices.

**B — Reduce raw view's friction instead of changing the editor. 🔴 Rejected 2026-08-18, and
recorded rather than deleted because it is the option most likely to be re-proposed.** The
design was: raw already gives native selection over the whole document, on every platform,
today, and the objection was never that it does not work — it is that reaching it costs a
gear icon, a dialog, a toggle, and remembering to switch back, and it is sticky once you
are in it. One gesture, non-sticky, auto-returning, entering with the caret already on the
line you were looking at, is **hours, not weeks**.

The owner rejected it before it was priced, on this reasoning:

> If B is a toggle of raw vs a render mode... I do not think it is worth it. our time would
> be better spent elsewhere.

That is consistent with ADR-003's actual finding and is why the option is dead rather than
deferred. **ADR-003 did not conclude that the toggle was clumsy — it concluded that a mode
existing at all was the defect.** B makes the mode cheap; it does not remove it, and the
product's whole claim is that a legal pad has no modes. Buying a cheaper version of the
thing that was already identified as the problem is not a partial fix, it is a nicer
symptom.

**The consequence for the reader: there is no cheap consolation prize.** The real question
is C vs D.

**C — Build the intercepted input layer by hand.** Map every `beforeinput` input type to a
model operation; build model-offset ↔ DOM-Range mapping in both directions across checkbox
islands; replace the textareas with one contenteditable; then pay for undo, composition,
paste, and the tail. Estimated at **one to three weeks with an unbounded tail**, gated
behind a ~1 day probe of problem #1. For calibration: the spec's own scope rule is *"if a
weekend turns into two, something came back from the Out list."* This is an order of
magnitude past that.

**D — Adopt an open-source editor component.** Solves undo, IME and paste because that is
the entire value proposition of such a library. Cost: the largest dependency in a project
whose stated stack is "no framework" and whose rule is "prefer the boring tool."

**Not yet properly evaluated, and we would like your view on it:** option D's *counter*
-argument. Text editing on iOS Safari — composition, selection, undo, mobile carets — is
precisely the domain where hand-rolling is the *un*-boring choice. It is arguable that the
boring tool for a text editor **is** an editor library, and that "no framework" was a rule
adopted for a project that did not yet know it was building an editor.

---

## 10. Components we are aware of but have not researched

Listed to be explicit about our starting knowledge and its limits. **None of these has been
evaluated.** Corrections and additions are actively wanted.

| | Shape | First-glance fit |
|---|---|---|
| **CodeMirror 6** | Plain-text, line-based editor. Document *is* a string of lines. Widget/line decorations. Explicit mobile and IME support. | The document model appears to match knag's exactly — bytes and lines, not a rich-text tree. This is the one we would research first. |
| **Lexical** (Meta) | Extensible editor framework with a plain-text mode; strong mobile/IME story. | Plausible. Heavier conceptual surface than the problem needs. |
| **ProseMirror** | Schema-based structured rich text. | Solves the right problems, but is shaped for rich documents knag does not have. |
| **Slate** | React-based. | Ruled out on the React dependency alone; also has a reputation for iOS trouble. |
| **Tiptap / Milkdown** | ProseMirror wrappers, markdown-WYSIWYG oriented. | Aimed at rendered formatting, which knag explicitly does not want. |

Open questions on any of them: **bundle size** against a 63 KB client that is service-worker
cached and served on a free tier; whether **byte-exact round-tripping** survives (trailing
whitespace, CRLF, `*` vs `-`, unclosed code fences); whether checkboxes can be rendered as
controls without the display diverging from the bytes; and how **drag-to-reorder** coexists
with it — noting that Arrange is *already* a separate mode with its own rendering, so it
could plausibly keep the current row DOM entirely while only the editing surface changes.

---

## 11. What we would challenge, if the constraints were off

Offered as our own starting position, not as a conclusion. Argue with it.

1. **ADR-003's mechanism, not its intent.** "One mode, typing first" is right and proven.
   "One form control per row" is an implementation detail that has quietly become the
   product's ceiling. Separating those two is probably the single most useful reframe
   available.

2. **The "no framework" rule may be inverted here.** See §9. It was a sound rule for a
   CRUD app on a Worker. It may be the wrong rule for the text-editing surface
   specifically, and the two can be judged separately.

3. **Two meanings of "selected" is a smell.** Arrange's picked rows and the editor's text
   selection are different concepts with different granularity in different modes. If the
   editor gains real selection, does Arrange's picking become redundant — or does it stay
   because whole-row operations genuinely want whole-row targets?

4. **Raw view's continued existence is evidence, not a feature.** It is the place the row
   model sends you when it cannot express the document. If the editing surface is fixed,
   raw view should probably be *deleted* rather than kept, because a mode that exists "just
   in case" is exactly what ADR-003 removed.

5. **Undo deserves to be on the list as a first-class problem.** It has been treated as a
   sub-item of the editor rewrite. It may be a larger everyday friction than cross-row
   selection and it has never been separately prioritised.

6. **Nothing about the nag → wipe loop, the sweep, the sort, the record, the agent access
   or the single page is under review.** Those work. Any proposal that trades them away for
   editing fidelity is answering the wrong question.

---

## 12. Questions we would like you to answer

1. **Is the causal chain in §5 correct and complete?** Is there a way to keep tappable
   checkbox controls *and* native cross-row selection that we have not seen — a gutter
   overlay, an inline widget, a hybrid where the focused region differs from the rest?

2. **Which component, if any, would you reach for** given: plain text only, byte-exact
   round-tripping non-negotiable, phone-first, iOS Safari mandatory, ~63 KB current client
   budget, one part-time developer? Is CodeMirror 6 the right instinct or are we
   pattern-matching on "plain text" too eagerly?

3. **How would you sequence this?** The planned gate is a ~1 day probe of whether iOS
   composition can be intercepted — but **that gate was designed for option C**, where we
   write the composition handling ourselves. Under D it arguably dissolves, since handling
   composition is the library's core competency, and the day would be better spent probing
   byte-exact round-tripping, checkbox widgets and bundle size instead. Which is the right
   falsifying experiment?

4. **Was rejecting option B right?** It was killed on the argument that ADR-003's finding
   was *a mode existing at all*, not *the toggle being clumsy* — so a one-tap, non-sticky,
   auto-returning raw view buys a cheaper version of the identified problem rather than a
   partial fix. Is that reasoning sound, or does a mode that costs one tap and returns
   itself stop reading as a mode in practice?

5. **What are we not seeing?** The decisions here were made in sequence by one person and
   an AI pair, each defensible in isolation. The most useful thing you can tell us is which
   one was the wrong turn, and how far back it was.

---

## Appendix — the decision record, in one table

| Decision | Status | Bearing on this question |
|---|---|---|
| Nothing is normalized (principle 3) | In force, property-tested | Non-negotiable. Any component must round-trip bytes exactly. |
| Display never diverges from the bytes | In force | Not the constraint in the way. Checkboxes and links already pass its test. |
| One editing mode, typing primary | In force, validated by use | Intent survives. Mechanism is the problem. |
| One form control per row | Implementation of the above | **This is the corner.** |
| Cross-row selection stays out of the editor | In force, and now being reopened | The spike disproved the naive version, not the approach. |
| Reorder / delete behind an explicit Arrange mode | In force, works well | Could keep its own rendering independent of the editing surface. |
| Raw view as an escape hatch | In force | Its use is the agreed signal that the row model is wrong. |
| No framework; prefer the boring tool | In force | The rule most likely to deserve a carve-out. |
| The Out list (search, tags, multi-doc, …) | In force | Not under review. |
