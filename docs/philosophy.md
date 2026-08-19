# knag — philosophy

**Status:** living. Records the tradition the design converges on, and the
reasons knag ended up elsewhere. [§12](spec.md#12-scope) decides scope and the
ADRs decide behaviour; where an argument below has no decision upstream of it,
it says so. A new decision belongs in an ADR, and this is where the argument
for one starts.

Sources are named inline. Nothing here depends on having read the books.

## 1. The position

**knag makes throwing things away feel good.** The nag is the tension, the wipe
is the release, the record is what makes the release free.

That sits at one end of a long argument in time management about what to do
with a list that can always grow. Two of the four systems below answer with a
boundary — the **closed list**. knag answers differently: the page stays open,
and gets thrown away.

What follows is convergence, not descent. None of these four appears anywhere
else in this repo, and knag takes no mechanic from any of them — all four are
refused. Their use is that each one names a failure knag also had to solve, and
the reasons knag solved it differently are the reasons a feature request loses.

## 2. The lineage

### Mark Forster — the closed list

*Do It Tomorrow and Other Secrets of Time Management* (Hodder & Stoughton,
2006) is the nearest thing to an ancestor. Forster's distinction is between a
list that can always be added to and one with a line ruled at the bottom, so
nothing further can go on it. His mechanic is a day offset: today you work a
list ruled off yesterday, and new arrivals land on tomorrow's.

The argument underneath it is the part that matters. An open list has no
completion state, so the satisfaction of marking everything off is not
available at any level of discipline — not as a motivation problem, a
prioritisation problem, or a tooling problem.

**knag takes** the diagnosis whole. A list that can always grow is a list that
can never close, and the missing completion state is the actual defect.

**knag refuses** the ruled line. The page is open all day; you add to it while
you are looking at it, which is most of what a legal pad is for. knag closes
the list at the **wipe** rather than at the start of the day — a line drawn
*across* rather than *under*.

The cost of that inversion is real and belongs in the open: knag has no
completion condition. You can never finish the page. What it has instead is a
release that does not require the list to have been finished, which is why the
whole-page wipe deliberately takes work that was never done.

### Ryder Carroll — migration, and friction as a filter

The Bullet Journal's mechanic for carrying work forward is rewriting it by
hand. The friction is the feature:

> If an entry isn't worth the effort to rewrite, then it's probably not that
> important. Get rid of it.

> The purpose of Migrating is to distill the things that are truly worth the
> effort, so we can become aware of our own patterns and habits, and to
> separate the signal from the noise.

**knag takes** the premise that a list needs a recurring moment of judgment,
and that without one it quietly becomes an archive of things you have decided
not to do.

**knag refuses** the friction, and this is the sharpest disagreement here.
Carroll makes discarding cheap by making *keeping* expensive. knag makes
discarding cheap by making *discarding* free — the sealed pre-wipe revision is
what removes the hesitation, so nothing is spent on wiping a line you were not
sure about. Both routes end at a page you are willing to look at again. They
disagree about which end of the act should hurt.

The bet underneath knag's choice is falsifiable, so state it plainly: **people
do not keep dead lists because they have failed to evaluate them. They keep
them because discarding feels like loss.** Remove the loss and the evaluation
stops being work that has to be scheduled. If that is wrong — if a
frictionless wipe produces a page that is cycled rather than read — then the
nag → wipe loop is not working, and the fix is upstream of any feature.

### Ivy Lee — six things, in order

The method: at the end of the day, write down the handful of things that matter
tomorrow in priority order, and work them in that order. The origin story —
Charles Schwab paying $25,000 for it at Bethlehem Steel in 1918 — is repeated
everywhere and sourced almost nowhere. Treat it as folklore; the method
survives its anecdote.

**knag takes** close to nothing from Lee, and the entry is here because the
resemblance gets asserted. What survives is a negative claim knag agrees with:
a list is worked, not sorted.

**knag refuses** every part of it that is machinery — the count, the ordering,
the priority. Principle 2 holds: no required structure, and the checkbox is the
one optional convention.

### Oliver Burkeman — finitude

*Four Thousand Weeks: Time Management for Mortals* (2021) supplies an argument
rather than a mechanic. The first of its ten tools is a fixed-volume approach:

> Keep two lists — one open and one closed. The open list is for everything on
> your plate, the closed list has ten tasks on it, at most. You can't add a new
> task to the closed list until one is completed.

Same vocabulary as Forster, and no claim is made here about which way the
influence ran. What Burkeman adds is the case that finitude is not a defect to
be engineered around. A system that promises you will eventually get to
everything is lying, and the lie is what turns a backlog into debt.

**knag takes** the framing. The Out list is a statement about finitude before
it is a statement about scope.

**knag refuses** the two-list structure, on the grounds that a second list is a
second document, and there is one page.

## 3. What knag adds

None of the four has a record you can query. Paper's record is the previous
page — still legible, and unusable at volume. Carroll's Index and a shelf of
filled notebooks are the honest ceiling, and answering "what did I finish in
March" means reading March. So migration, the ruled line and the cap all move
the judgment call *before* the page turns, because afterwards the record is
intact and unreachable.

knag is a board with a memory, and the consequence runs the other way:

> The difference from a real board — and the whole point — is that a real
> board has no memory. knag wipes and keeps the receipt.

— `README.md`. Because the receipt is reachable, the judgment can happen after
the wipe instead of before it, or never. That is what the four could not do,
and what every one of their mechanics is a workaround for.

Two details make the record load-bearing rather than decorative, and both are
already decided in spec §5:

- `cleared_items` holds what was **finished**, never what was merely removed.
  It is the authoritative answer to "what did I get done", which is why a
  wipe-all's unfinished lines are excluded from it on purpose.
- Neither recovery path reads `cleared_items` — it holds only the finished
  lines, so restoring from it would silently drop the rest. The one-tap
  bring-back is client-side, from the pre- and post-wipe bodies the app already
  holds; behind it, the sealed pre-wipe revision is the durable copy. Both
  re-insert into the page as it is now rather than writing the old body back.

Take either away and the wipe stops being free, at which point knag is a worse
legal pad.

## 4. The daily fresh list is a habit, not a feature

The tradition above is organised around days. Forster's list is ruled off
yesterday; Carroll migrates monthly and logs daily; Lee writes tomorrow's six
tonight. knag has none of it. Principle 1 — *"One document. No days, no
rollover, no multiple notes."* And §12 puts **rollover** and **day boundaries**
in Out as two separate entries, which is what "load-bearing" means here.

knag affords the daily fresh list without implementing it:

- **Nothing is automatic.** There is no cron trigger and no scheduled handler
  in the Worker. A wipe is always a human tap or an explicit `knag_wipe`. "A
  clean board every morning" describes what the user does, not what the app
  does.
- **The carry-forward mechanic is staying put.** Checked rows dim, strike, and
  stay — *"Checked items stay in place. No auto-sink"* (spec §7). Nothing is
  ever moved between days or lists by the software, because there is nowhere to
  move it to. The nag is that the line is still there, in your own words, from
  three weeks ago.
- **No clock decides anything about the page.** `KNAG_TZ` is a read-path
  concern: it resolves bare dates to local-midnight boundaries and groups
  results by local date for `/api/history` and `knag_history` (§14.3). The
  bring-back offer expires at the *device's* next local midnight, because it
  asks whether the person holding the phone still thinks of the wipe as
  something they just did. Neither creates a day boundary on the page.

The claim is that the ritual is the valuable part and the calendar is the part
that rots. A daily note per day is fifteen hundred documents in four years and
a search box to find any of them. One page, wiped when you decide, is the same
ritual with none of the filing.

## 5. What this predicts

The use of a philosophy is that it answers requests before they arrive. Each of
these is a real-sounding ask, the reason it loses, and where that reason is
decided.

| Request | Answer | Decided |
|---|---|---|
| Auto-wipe every morning at 6am | The wipe is the release. Arriving at a board you did not clear is a different feeling entirely — nearer to amnesia. | Not in §12; this is a product claim, not a scope rule. Argued here. |
| A daily note, or today's page vs. yesterday's | Rollover and day boundaries. The request that most sounds like the philosophy and most contradicts it. | §12, principle 1 |
| Move checked items to the bottom | The nag is proximity. Sinking them is a partial wipe the app performs on the user's behalf. | spec §7 |
| Cap the page, or warn at N lines | Burkeman's cap is a good idea on paper and a scold in software. The page nags by existing; a counter nags by judging. | Not decided; argued here |
| Archive instead of wipe | That is what the wipe already is. A second verb would imply the first one destroys something. | Not decided; argued here |
| Due dates, priorities, tags | The list is short because it is wiped, not because it is sorted. | §12 |
| A "what did I finish this week" view | Legitimate, and already answerable via `knag_history`. The absence of a screen is unbuilt, not refused. | No objection |

## 6. Revisit when

- **The page accumulates lines nobody rereads.** Old is the nag working;
  ignored is not. If wiping becomes a reflex that clears rows without anyone
  having looked at them, the free wipe is not producing judgment and Carroll's
  friction was doing something the record does not.
- **A wipe is regretted after the bring-back has lapsed, more than once.** The
  offer dies at the device's next local midnight, which gives a wipe at 23:55
  about five minutes. If regret keeps arriving later than that, the durable
  record is not reachable enough — a history-screen problem, not a policy one.
- **The word "philosophy" starts appearing in support of a feature on the Out
  list.** This document exists to make that argument harder, not easier.

## Sources

- Mark Forster, *Do It Tomorrow and Other Secrets of Time Management*, Hodder &
  Stoughton, 2006. Paraphrased above rather than quoted; the closed-list
  argument runs through the book rather than sitting in one line.
- Ryder Carroll, "Migration 101", bulletjournal.com — both quotes. See also
  *The Bullet Journal Method*, Portfolio, 2018.
- Oliver Burkeman, *Four Thousand Weeks: Time Management for Mortals*, Farrar,
  Straus and Giroux, 2021 — "Ten Tools for Embracing Your Finitude", tool 1.
- The Ivy Lee method has no primary source worth citing. Attributed to Ivy
  Ledbetter Lee, c. 1918, and repeated most influentially by James Clear.
