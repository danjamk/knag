# The prompt

Paste into the Claude Design session. It has the repo, so this points rather than explains;
`docs/design/history-brief.md` is the brief it refers to.

---

One feature this time, not a holistic pass: **recovery and history** (#91). The brief is
**`docs/design/history-brief.md`**.

**Start with §4**, because it is the part I cannot rule on alone. Brand §10 says there is
no history browser and spec §12's Out list says any UI implying a second document exists is
out. The likeliest shape for this feature is exactly that thing. I would rather you argue
with the constraint deliberately than route around it — and if the answer is that the
constraint is right and the feature should be a changed constant rather than a surface,
that is a real answer and I want it stated plainly.

The problem in one line: **wiping is free because nothing is lost, but the one-tap
`bring back` expires at local midnight, and after that retrieval means opening a
conversation.** The paper version this replaced went in the bin uncrumpled and got fished
back out over the following week. Days, not hours — and *looking*, not querying.

§3 is the decision I actually need: **what is the record for?** Regret in ten minutes, or
"what did I get done last week", or both. Everything downstream follows from that, and
nobody has ruled on it, which is why this issue has been open since before 1.0.

Three things have shipped since #91 was written and each one moves the question — §2 has
them:

- **Pages exist.** Up to nine, no index, and history is per-page now. A design that ignores
  that gets redesigned.
- **Templates exist**, and they changed what a wipe *means*: on a page with a template the
  whole-page wipe lays the template back down rather than emptying, and the control reads
  `reset page`. So "bring back" after a reset restores lines *on top of* a template. That
  is new and I do not think the existing copy survives it.
- **#149 made list-shaped surfaces panes.** §7 of your last response wrote history as a
  full screen from the ledge. It is a **pane**. Manage-pages is the built example.

Two things about how this lands:

- 🔴 **Mobile-first**, not responsive-down-from-desktop. Phone, keyboard up, thumb from the
  bottom edge.
- **Tokens we can apply in an afternoon** — every colour and size lives in the two `:root`
  blocks in `public/index.html`, enforced by a test. Amber is the machine voice and the only
  colour. Two faces: Familjen Grotesk for what the user wrote, DM Mono for what the app says
  about itself — and a history pane is mostly the app speaking *about* lines the user wrote,
  which I think is a genuine typographic problem rather than a detail.

🔴 **One thing found while writing this brief**, in §5: `bring back` is a single label
over two different operations now. Undoing a *sweep* means putting deleted lines back;
undoing a whole-page *reset* means taking the template off and putting the lines back. It
shipped broken — every checked-off standing item came back twice — and is fixed. I mention
it because the one-tap undo already carries more meaning than its four characters admit,
and whatever you design sits next to it.

One flag on the data, in §5: **`wiped_count` counts what left**, so a reset on a
twenty-five-line page with a twenty-line template reports `wiped 25` and twenty lines come
straight back. A count of what remains would report a reset as having done nothing. Whatever
surface you design will display that number, and I am not sure the semantics survive being
looked at.
