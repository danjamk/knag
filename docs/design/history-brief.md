# Brief — recovery and history (#91)

**For the Claude Design session.** You have the repo. This points rather than restates.

One feature, one question, and a constraint you are being asked to argue with on purpose
rather than tiptoe around.

---

## 1 · The question

**How far back can you reach, and how much effort does reaching cost?**

Wiping is free because nothing is lost — that is the centre of the product. But *free*
and *effortless* are not the same promise, and today they diverge sharply:

| | Retrievable how | For how long |
|---|---|---|
| The `wiped 6 · bring back` line | one tap, no thought | **until the next local midnight** |
| The record itself | ask Claude via `knag_history` | indefinitely; `cleared_items` is uncapped |

The gap came from how the paper version actually worked. The old sheet went in the office
bin **uncrumpled**, and got fished back out over the following week to check what had been
on it. The reaching-back window is *days*, and the act is **looking**, not querying.

knag's one-tap window closes tonight. After that, retrieval means opening a conversation
and describing what you are looking for — a different and much higher-effort act than a
glance. Nothing is lost; something is nonetheless out of reach.

---

## 2 · What changed since this issue was written

#91 was logged when knag had one page and no templates. Three things have shipped since,
and each moves the question. **This section is the reason the brief exists rather than
just the issue.**

**Pages exist (1.1.0).** There are up to nine, capped and never scrolling, and there is
deliberately **no index** — a control that switches between pages, never a screen that
lists them. History is now per-page: `knag:last-wipe` was one localStorage key and is now
`knag:last-wipe:{pageId}`. Any surface you design inherits that question — is history
*this page's*, or all of them? A single answer that ignores pages will be redesigned.

**Templates exist, and they change what a wipe means (1.1.1).** On a page with a template,
the whole-page wipe does not empty the page — it **lays the template back down**. The
control even reads `reset page` rather than `wipe page`. So "bring back" after a reset is
restoring lines *on top of* a template, not restoring an emptied page. The copy that works
for one may be wrong for the other, and this is new since #91 was written.

**The ledge exists (#139)**, a second tier on the bar opened on demand — which is where
§7 originally said history would be reached from.

**#149 turned list-shaped surfaces into panes.** §7 wrote history as a full **screen**.
Devices then became a *pane* of the settings dialog, and §3d was amended to say
list-shaped surfaces inherit the pane. **History is therefore a pane, not a screen.** The
roadmap carried both statements for a day; that is corrected. Manage-pages is the built
example to look at.

---

## 3 · The three decisions

From the issue, unchanged in substance:

1. **What is the record *for*?** Regret in ten minutes ("I wiped that by mistake"), or
   "what did I actually get done last week", or both? These want different surfaces and
   possibly different windows. Answering this first is most of the work.

2. **Is the answer a number, an agent affordance, or a surface?**
   - *A number*: `offerExpiresAt` in `client/src/restore.ts` is `setHours(24, 0, 0, 0)`.
     Changing one constant widens the one-tap window to whatever you say. Cheapest
     possible answer, and it may be the right one.
   - *An agent affordance*: `knag_history` **already defaults to the last seven days** and
     already returns an exact per-day `cleared` list. The data problem is solved. What is
     unsolved is that reaching it means opening a conversation.
   - *A surface*: the expensive answer, and the one that argues with §12 — see below.

3. **If a surface: reconcile with brand §10 and spec §12, or amend them on purpose.**

---

## 4 · 🔴 The constraint, stated so you can disagree with it

Brand §10 says **there is no history browser.** Spec §12's Out list says any UI implying a
second document exists is out. A history pane is arguably the exact thing both forbid.

That constraint is not obviously wrong and it is not sacred. It is the thing to argue with
**deliberately** rather than by accident — which is precisely why this is a design bundle
and not a branch. If the answer is a surface, say what §10 and §12 should now read, and
say why the line moved. An amendment made on purpose is fine; one made by not noticing is
how the Out list stops meaning anything.

The Out list is load-bearing here for a specific reason: search, tags and folders are all
on it, and a history browser is the surface most likely to make search feel necessary.

---

## 5 · What exists today, mechanically

Do not redesign what already works:

- **The recovery line** — `wiped 6 · bring back`, amber, in the footer. One tap. Its
  action is additive: it puts lines back on the page rather than reverting the page, and
  it **survives editing** — type after a wipe, then tap it, and you keep both. That is
  deliberate and tested; writing the snapshot back would discard the edit, which is a
  worse data-loss path than the one the undo exists to prevent.

- 🔴 **`bring back` now has to undo two different kinds of wipe** (#173, fixed
  2026-08-21). A sweep *deletes* lines; a whole-page wipe on a page with a template
  *replaces* the body. The undo of a deletion is putting lines back; the undo of a
  replacement is taking the template off **and** putting lines back. This was a real bug —
  every checked-off standing item came back duplicated — and it is worth knowing because
  it is the shape of the problem: one affordance, two meanings, one label.
- **`knag_history`** — per-day entries carrying `appeared`, `disappeared` and `cleared`.
  `cleared` is the authoritative done-record and is exact; the line diff is a set
  difference and is blind to a duplicate line being removed. Capped at 500 revisions with
  a `truncated` flag rather than a silently partial answer.
- **Two wipe scopes** — `completed` (the daily sweep, runs several times a day, never
  resets to a template) and `all` (the whole page; a reset where a template exists).
- **`wiped_count` counts what left**, including on a reset where lines immediately come
  back. A count of what *remains* would report a reset as having done nothing. Flagged
  because whatever surface you design will display this number and the semantics are not
  obvious.

## 6 · Non-negotiables

The house rules, all enforced by tests:

- **Every colour is a token**, in the two `:root` blocks at the top of `public/index.html`
  and nowhere else. Two boards — **Slate** and **Whiteboard**. `--amber` is the machine
  voice and the **only** colour in the interface; everything else is chalk, ink or a
  hairline. A third colour means something upstream went wrong.
- **Two faces, two speakers.** Familjen Grotesk for everything the user wrote, DM Mono for
  everything the app says about itself. A history pane is mostly the app speaking *about*
  lines the user wrote, which is a real typographic problem worth solving deliberately.
- **One animation, and the wipe is it.** A state change is not an animation: anything on
  `--state-duration` is a control arriving at its new state. A pane opening is a state
  change.
- **The display never diverges from the bytes** ([ADR-004](../adr/ADR-004-display-matches-the-bytes.md)).
  No rendered markdown. Recovered lines are the bytes that left.
- **Mobile-first** — a phone, keyboard up, a thumb reaching from the bottom edge.

## 7 · What a good answer looks like

Not a mockup of a screen. A ruling on §3.1, then whichever of §3.2's three shapes follows
from it, at the fidelity that shape needs — a changed constant needs a sentence and a
number; a pane needs tokens, composition and copy.

And if the honest answer is **"widen the constant and build nothing"**, that is a real
answer and the cheapest correct one. Say so plainly. #91 has been open a while precisely
because nobody has ruled on what the record is for.
