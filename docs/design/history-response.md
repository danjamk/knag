# Design response — recovery and history (#91)

**From the Claude Design session, 2026-08-21.** Response to
[history-brief.md](history-brief.md). Recorded here the way
[holistic-response.md](holistic-response.md) is: this is the ruling, and the build works
from it.

> **The record is for what you did not do, and what you wrote down.**
>
> A finished task is a report, and a report is a question — the agent answers those better
> than any list. A note, or a task you never got to, is a lookup. **Lookup is the part the
> app owes you.**

Verdict: **a surface** — not a widened constant — **and §10 and §12 move on purpose.**

---

## §3.1 · What the record is for

The paper evidence in the brief is not ambiguous. The sheet came out of the bin to check
what had been on it — one line, recalled over days. That is not a report, and nobody was
reading last Tuesday for pleasure.

And **the page is not a task list.** It holds notes — a company name, a measurement, a
number somebody said on the phone — and a note has no done state. Nothing about a note is
ever a retrospective. It is on the page or it is gone, which makes the note the thing with
the most to lose from a wipe and the least to gain from a summary.

Both purposes are real, but they differ in the one way that decides the surface. A
retrospective is **synthesis** over a week. A recovery is **lookup** of a line.
Conversation is good at synthesis and bad at lookup, because a lookup makes you describe
the thing you are trying to find — *and if you could describe it you would not need it.*
That asymmetry is where the split goes, and it is a fact about the two acts rather than a
preference about surfaces.

So retrieval belongs in the app, and its unit is days. The retrospective stays in
`knag_history`, where it is already better than any list would be — a week of lines shown
to you is work, a week of lines summarised for you is an answer. **Search stays there too,
and that is a ruling rather than a deferral.**

### Two wipes, and only one of them is a loss

The two scopes are not two sizes of the same event, and the surface should stop treating
them as if they were.

- **The sweep takes only what you ticked.** Every line it removes is a line you told it to
  remove, and the record it leaves is a done-record. Retrieval value: low, and not zero —
  you tick the wrong box sometimes — but the everyday sweep is a release, not a risk.
- **The whole-page wipe takes everything else with it.** Notes, half-thoughts, the tasks
  you never got to. That is the loss-shaped event in this product, and it is the one the
  surface exists for.

So the row copy names it, and the count that matters is on it rather than on the sweep.

🔴 **What the surface must not grow to do this is a filter.** A filter is one step from
search and it would be the first control in the product that asks the reader to narrow
something. It is not needed, because the lines carry their own state and the two boards
already draw it: inside one wipe, ticked lines are dim and struck, and a note or an undone
task is full chalk. **The bright lines are the ones you came for.** Contrast does the
filtering, for free, using a rule the system already has.

## §3.2 · The cheap answer, rejected plainly

Leave `setHours(24, 0, 0, 0)` exactly as it is. Not because widening it is expensive, but
because it answers the wrong half of the question: **the constant says how long, and the
problem is which one.**

The recovery line is a single offer about the most recent wipe, and the sweep runs several
times a day. By tomorrow morning, yesterday's 16:20 sweep sits behind three newer wipes no
matter what the constant says. Widening it also makes the line lie: it is transient chrome
that arrives after an action, and at sixty hours old `wiped 6 · bring back` claims a
currency it does not have.

The line is correctly scoped to the wipe you just did. **Days-not-hours is a different
affordance, not a longer version of that one.**

## §4 · The constraint, argued rather than avoided

The constraint is **right about the mechanism and wrong about the noun.**

Right about the mechanism, and the brief states it better than the rule does: a browser
makes a corpus, a corpus makes search feel necessary, and search is on the Out list. Any
surface that puts a week of lines on screen at once has already conceded that argument,
whatever it is called.

Wrong about the noun, and the proof has been shipped for a year. The recovery line **is** a
surface about history, and it implies no second document — because it is about a *wipe*,
not about *lines*. It says an action happened, gives its size, and offers to undo it.
Nobody has ever read it as a place their lines live.

That is the whole distinction, and it holds weight:

> **A list of lines is a document; a list of wipes is chrome about actions.**

One wipe's lines are not a corpus, because a wipe is small by construction — it is what
left the page in one press.

So the surface is **the recovery line in the plural.** Rows are wipes. Lines appear one
wipe at a time and never all at once, which means no view in the product ever shows a week
of lines, which means search never has anything to be for. **The cap is structural rather
than a policy someone has to keep defending.**

### The line moves — proposed replacement text

**brand §10** — replaces *"there is no history browser"*, and retires the word `carbon`:

> There is no search, and no view of the page's lines that is not about a wipe. There is
> history: a list of wipes, newest first, this page only, seven days deep. A row is an
> action and its size; a row opens onto the lines that one wipe took and offers them back.
> No view ever shows more than one wipe's lines at a time. The day a surface here lists
> lines independently of the wipe that took them, it has become the browser this rule
> forbade.

**spec §12** — the Out list keeps every entry, and gains a test:

> Still out: search, tags, folders, an index of pages, and any UI implying a second
> document exists.
>
> A surface that lists wipes is not a second document — it is chrome about an action, the
> same kind of thing as the recovery line. A surface that lists lines is. The test is the
> cap: history shows one wipe's lines at a time and never aggregates them, and that is what
> keeps search out of the app. Searching the record is the agent's job and stays the
> agent's job.

## The surface · history

It is called **history** — plainly, since that is what it is, and since `carbon` is
retired.

The pane is **unchanged in shape by the rename**: a pane of the settings dialog, the same
shape as devices and manage-pages — bottom-anchored, `max-height: min(72vh, 560px)`, a
back control instead of a close, its own scroll. Reached from the ledge — *the rung you
reach for on purpose is exactly the right height for the record* — and the recovery line's
count is a second door to the same pane, which costs no new chrome because the words are
already there.

Opening it is a state change on `--state-duration`, and so is opening a row. **The wipe
stays the only animation.**

Rows, newest first, grouped by day:

```
history · today
  14:20 · wiped 6                    ›
  11:40 · wiped page · 9 gone        ›
  08:04 · reset · 5 gone             ›
yesterday
  17:12 · wiped 4                    ›
  08:02 · reset · 2 gone             ›

seven days here · ask your agent for older
```

An open row shows that one wipe's lines, as they left — checkbox and strike intact.

**The empty case:** a page never wiped shows the seam note and nothing else. There is
nothing to say about an empty record.

## Who answers what

The seam is not app-versus-agent by importance. It is **navigating versus asking**, and
each side gets the questions it can actually answer.

| The app · navigate and restore | The agent · search and synthesise |
|---|---|
| I wrote a task down three days ago and never did it — bring it back to today. | Can you find the notes I made about the loft? |
| I ticked that off by mistake this morning. | I wrote down a company name last week — what was it? |
| The page got wiped before I copied that number out. | What did I actually get done last week? |
| | Which workouts did I do this month, and how often did I skip the second set? |

Read the left column and the pane designs itself: every one is a known day and a remembered
shape, answered by scrolling back a little and tapping. Read the right column and no pane
helps — you do not know which day, and half of them are questions about a pattern rather
than a line.

The workout case is the clearest statement of the split anywhere in this brief: **the page
is the input surface, the wipe is the commit, and the analysis never wants to be a
screen.**

## 🔴 The one thing the design session asked to have confirmed

Quoted, because it is the only blocking question in the bundle:

> `cleared` is exact and authoritative for ticked lines, and the line diff is blind to a
> duplicate being removed — which is fine for tasks and lossy for notes, where a note wiped
> by a whole-page wipe arrives as `cleared` only if the wipe recorded it. If "find the note
> I wrote about X" is now a first-class use, the wipe record has to carry *every* line a
> whole-page wipe took, not only the ticked ones. Worth checking against `clearedLines` in
> `worker/src/index.ts` before any of this is designed further — it currently maps the
> completed blocks under both scopes, and if that is what ships to `cleared_items`, then
> notes are not in the record at all and no surface and no agent can find them.

### Confirmed — and the design session was right. The data problem is **not** solved.

Checked against a real wipe rather than by reading, and the first answer written here was
wrong and had to be replaced. **This is the one item that blocks the build.**

The mechanism is as the design session described, and the deliberate part is deliberate:
`worker/src/index.ts` passes `clearedLines: completed.map(...)` under **both** scopes, so a
note taken by a whole-page wipe never reaches `cleared_items`. The code says why, and the
reason is good — that table answers *"what did I get done"*, and recording never-done lines
would corrupt the one record `/api/history` treats as authoritative.

The tempting rebuttal is that the wipe seals a revision holding the whole pre-wipe body, so
the lines must surface as `disappeared`. **They do not.** A wipe snapshots the *pre*-wipe
body, which is identical to the revision before it, so its diff is empty by construction —
and the post-wipe state does not enter the log at all until the next ordinary save, where
those lines finally show up as `disappeared` **on an unrelated later revision**.

A page wipe of a page holding a note, a done task and an undone task returns exactly this:

```json
{ "event_type": "wipe_all", "appeared": [], "disappeared": [], "cleared_count": 1 }
```

with `cleared` holding only `- [x] done thing`. The note and the undone task appear
nowhere in the response. They exist only inside that revision's **body**, and
`/api/history` does not return bodies.

🔴 **So the response's own costing — *"`/api/history?days=7`, per page. Exists. The data
problem was solved before the brief was written"* — is false for exactly the rows the
surface exists for.** The sweep row is fine and reads from `cleared`. The whole-page row,
which the response itself calls *"the loss-shaped event in this product"*, has no data
behind it.

**This has to be decided before the pane is built**, and it is a log-shape question rather
than a UI one. The options are recorded in the issue; none of them is free, and the cheapest
correct one is probably that a wipe should also record the state it left, so the diff falls
out of the log the way every other diff does.

## The typographic problem, which is a real one

The answer is not a blend. **It is a stack, and no element is ever both voices.**

- **The machine gets the frame.** Day labels, times, counts, verbs: DM Mono,
  `--size-machine`, `--dim`, `--track-machine`.
- **The lines get chalk.** Familjen Grotesk at `--size-row`, in row geometry, with the
  checkbox and the strike exactly as they left — because
  [ADR-004](../adr/ADR-004-display-matches-the-bytes.md) says the display never diverges
  from the bytes, and a line that left checked left checked.

Two consequences worth stating, since they are the ones a build gets wrong:

1. Nothing is paraphrased and **nothing is truncated** — a line wraps here as it wraps on
   the page. An ellipsis is the app editing the user's words to fit its own frame, which is
   the exact failure the two-voice rule exists to prevent.
2. A mono timestamp never sits on the same line as chalk text. The frame is above, the
   words are below.

🔴 **Amber marks the offer, not the record.** Rows are dim; the open row's head goes to
`--ink`; only `bring back` is amber, underlined, the same button the footer already has. A
pane of amber rows would make the record look like the machine shouting, and **the record
is the quietest thing in the product.**

## The number, and the label over two operations

The flag in the brief is right — the semantics do not survive being looked at. **But the
fault is in the display, not the log.**

Keep `wiped_count` as it is. A log should record what the wipe did, and what the wipe did
was take twenty-five lines off the page. Display something else:

> **`gone`** — the multiset difference of the page before and after: the lines that left
> and did not come straight back.

On a sweep `gone === wiped_count` and nothing anywhere changes. On a reset of a
twenty-five-line page onto a twenty-line template it reads `reset · 5 gone` instead of
`wiped 25`, which is true. It is not a new concept either: `restore.ts` already computes
both sides of that subtraction in `removedBlocks` and `addedBlocks`. **It is a length.**

Which means the shipped copy changes. Two operations get two labels, and the difference
between the labels is exactly the difference between the operations — *a sweep hands you
lines, a reset hands you the page*:

| Scope | Line |
|---|---|
| sweep | `wiped 6 · bring back` |
| whole-page wipe, no template | `wiped page · 9 gone · put the page back` |
| reset onto a template | `reset · 5 gone · put the page back` |

The same line serves both scopes. `bring back` keeps its meaning **and its tests**.

`put the page back` is four words for the operation #173 uncovered: take the template off,
put the lines back. **It is longer than `bring back` on purpose.** The reset is the bigger
undo and should read as the bigger undo.

## Pages, and what a restore from history actually costs

The record is **this page's, always**, and the head says which page. There is no combined
view, because a record across nine pages is an index and there is deliberately no index.
Across pages is a question, and questions go to the agent — the same seam as the
retrospective, in the same place.

Two honest costs, both worth paying:

1. Today's most recent wipe still has its snapshot in `knag:last-wipe:{pageId}`, so **that**
   restore stays positional and anchored exactly as it is now.
2. Older rows restore from `cleared`, which carries lines and not anchors, so those land at
   the end of the page. **Content over position** — the same ruling `restore.ts` already
   made for a vanished anchor, and a line you were looking for is not less useful at the
   bottom.

Every restore stays additive and count-idempotent, so a second tap is safe and a restore
never discards an edit. That is already true, and it is what makes putting back a single
line cheap: one tap, one line, dims with the same tick that confirms a copy.

## What it costs to build

- ~~**`/api/history?days=7`, per page. Exists.** The data problem was solved before the
  brief was written.~~ 🔴 **Not true for whole-page rows** — see the blocking question
  above. The sweep row reads from `cleared` and is fine; the page-wipe row has no data
  behind it and the log has to change first.
- **The pane:** markup beside the two existing panes, one render function, and roughly 130
  lines of CSS that **names no value the two `:root` blocks do not already have**.
  ✅ Verified: `--size-machine`, `--size-row`, `--dim`, `--ink`, `--amber`,
  `--track-machine`, `--track-chalk` and `--state-duration` are all defined today.
- **Copy:** `gone` in the pane and in the recovery line, and `put the page back` on the
  reset branch.
- **One new pure function** — `insertLines(current, lines)`, count-idempotent appends, for
  restores with no snapshot behind them. `restoredBody` is untouched, **which keeps the
  path with real use behind it out of this change.**

## 🔴 The tripwire

One thing history must never grow: **a row for anything that is not a wipe, and a field to
narrow the rows with.**

The moment it lists edits it is a revision log, and a revision log of a page you rewrite
all day is a corpus; the moment it has a field, the corpus has a search box. **Wipes only,
and no filter.** That is the tripwire, and it belongs next to the nine-page cap.
