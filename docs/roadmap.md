# knag roadmap

**Status:** Active
**Created:** 2026-08-19
**Supersedes:** [MVP_PLAN.md](implementation/completed/MVP_PLAN.md), which ran the
build phase (#2–#15) and is complete.

The **knag Roadmap** board (project #4) is the record of *what* and *where each
card sits*. This is the record of **why in this order**. When the two disagree,
the board wins on status and this wins on sequence — and one of them is wrong,
so fix it.

## How this is used

Grooming has exactly one rule: **Prioritized holds the current phase. When it
clears, promote the next one.** Nothing else decides what to pick up.

This replaces the MVP plan's `#2 → #3 → #4 → #8`, which was true until it was
not and stayed written down for a while afterwards.

**Where it stands, 2026-08-24.** 1.2.0 is merged (#189) and **Phase 7 is done** — the
history pane, the glyph, and the `bring back` verb all shipped. A few days of using it on
a phone and through the connector produced eight issues, #190–#197, none from the suite —
the same pattern 1.0.1 recorded below. They are grouped as **Phase 8** in three
releases, and **multi-user moves back one slot to Phase 9**. The reasoning is in the
phase; the short version is that every one of them is a daily friction and the biggest
of them (#190) hands the multi-user spike a real per-account setting to reason about
instead of a hypothetical one.

**Where it stands, 2026-08-20.** Phases 0 through 5 have shipped and so has Phase 3 —
0.9.0 through 1.0.1, prod and dev on the same build, and the landing page live. **#114 is
settled** (a device test, not a branch), **#113 is done — the row list is deleted**, and
**#115 is ruled — leave both** (see Phase 3). **Nothing is left inside 1.0.**

✅ **1.0 is this, and it is now finished rather than merely claimed.** It was held back
for one reason — the shape still had two editing surfaces in it, and 1.0 is a claim about
shape rather than a count of closed issues. The hinge has turned, and Phase 3 clearing is
what makes the claim literally true.

🔴 **1.0.1 is the record of what a first hour of real use finds.** Six items, none from
the suite; two were defects, and one of them — the page wipe releasing its animation
before the repaint — meant the `fall` timing's held empty board had never once run since
it shipped in 0.13.0. It had been carried on #121 as a tuning question against
`--page-travel`. **Read that as evidence about the suite, not about the wipe**: every
defect this project has shipped was found by a person on a device, and this one hid for
a release behind a plausible wrong diagnosis.

🔴 **The design session answered, and it reordered phase 4.** The holistic pass
came back on 2026-08-19 and is recorded in
[design/holistic-response.md](design/holistic-response.md). It introduced one piece
of work that did not exist — **the ledge** (#139), a second tier on the bar —
subsumed #120 into it, designed #132 outright, and put both ahead of #121. The
reason is one sentence: *motion work on a bar that is about to change composition
gets done twice.*

🔴 **#107 is open and #74 did not close it.** The instrumentation eliminated four
hypotheses. The third occurrence pointed at *position*; the fourth refuted it —
`editor.spec.ts`, seventh of thirteen — and moved the finding to **duration**:
every dead-server failure landed in whichever file was slowest at the time. The
answer was to make no file slow. `editor.spec.ts` was split three ways in 0.11.1.

🔴 **That did not remove the condition — it moved it.** The first *local* reproduction,
on 2026-08-19, died on `sync.spec.ts`, which at 43s is now the longest file in the suite
and was not before the split. Two more followed within a day, always on the same file, and
one of them blocked a release.

**Contained rather than fixed, 2026-08-20.** The mechanism — an empty `✘ [ERROR]` and a
crash log containing no error — is still unexplained, and guessing at it had cost three
suite runs and a release. So the runner now **retries a dead-server file once**, loudly and
counted, and keeps the run's output and how far into the file it got in
`test-results/dead-server/`. CI uploads that on green runs too, because with the retry the
commonest occurrence *is* a green run.

That is a deliberate change of stance. A red build was the right answer while nobody knew
what this was — it was the only way to see it. It is the wrong answer now: the classifier
identifies it confidently, and a red build for a known infrastructure defect trains
everybody to re-run reds, which is how a real failure eventually gets re-run instead of
read.

**The next few occurrences are the experiment, and they are now free.** The evidence
records seconds-to-death, which separates the two explanations that have been confused
twice: a server that dies twelve seconds into every file is a different defect from one
that dies near the end of whichever file runs longest.

---

## The two findings that set the order

Both came out of re-reading [spec §17](spec.md) on 2026-08-19, and both cut
against the intuition that big architectural features should be pulled forward.

### 1. The insurance on multi-user and multi-page is already paid

§17 took it in 2026-08. All SQL is behind `store.ts`, handlers key off
`principal.id`, `DOC_ID` is a constant rather than a literal `1`. Adding
`page_id` or `owner_id` is one file plus a migration, whenever it is wanted.

🔴 **So doing #122 or #123 early buys nothing structurally.** The de-risking
happened at design time; that was the point of the chokepoints. Sequence them on
product value.

There is exactly one real ordering dependency and it is narrow: **wipe, history
and the recovery line all acquire a per-page dimension**, so #91 (recovery and
history UX) is designed once if it comes after #123 and twice if it comes
before. That is why #123 precedes #91 below and nothing else moved.

### 2. §17 is optimistic about one migration, and the schema disagrees

§17 says a few pages is `page_id INTEGER NOT NULL DEFAULT 1`, additive, one
`UPDATE` to backfill. True for `revisions`. **Not true for `documents`:**

```sql
id INTEGER PRIMARY KEY CHECK (id = 1)
```

SQLite has no `ALTER TABLE ... DROP CONSTRAINT`. Removing that `CHECK` is a full
table rebuild, which is destructive, and `make migrate` runs *before*
`make deploy` — so the deployed Worker runs against the new schema in the gap
([ADR-002](adr/ADR-002-two-accounts-and-migrations.md) §3). #123 is therefore
expand/contract, not one additive column. Recorded on the issue.

🔴 **And it is three releases, not the two written here** — found on 2026-08-21 while
running the contract half. The expand release dual-writes `documents`, so it is still
writing when the drop migration runs; the write has to stop in a release of its own,
carrying no migration at all. ADR-002 §3 has the worked example.

---

## The release shape

Set 2026-08-19. The version numbers are meant to say something:

| | What it is | Phases |
|---|---|---|
| **1.0** | **One page, finished.** Everything the single-document product should be | 0–5 |
| **1.1** | A handful of pages | 6 |
| **1.2** | **The history UX** | 7 |
| **1.2.1** | Two fixes from use, no design input | 8a |
| **1.3** | **The phone pass** — the ledge, the checkbox, dev's own icon | 8b |
| **1.4** | The first server-side setting, and pages in an order | 8c |
| **1.5** | Multi-user | 9 |

🔴 **Amended 2026-08-24: three releases of use-findings before multi-user.** A week of
real use produced #190–#197, and holding them behind a spike-and-ADR phase would be the
§12 failure one more time — the same argument that moved #91 out of 1.1 and then history
out of 1.3. The split into three follows one line: **what needs no design ships as a
patch; what needs one design brief ships together; what adds to the schema ships last.**
Six of the eight need a design answer, and sent as one brief that is one round trip
rather than six — which is the whole reason 8b is a group and not a queue.

The numbers say what they should. 1.2.1 is fixes only. 1.3 and 1.4 each add to the
interface — a ledge that opens the other way is a change to the bar, and a setting the
agent reads is new surface — so they are minors, per the rule `make info` exists to
enforce.

🔴 **Split 2026-08-22: 1.2 is history, 1.3 is multi-user.** They were one release
because they were one phase-pair, and that stopped being true when multi-user was
decided on 2026-08-21: it is friends and family, invite-only, free-tier-bound, and it
wants an admin view. That is its own release rather than a co-passenger, and holding a
finished, tested history pane until it exists is the failure §12 exists to name — the
same argument that moved #91 out of 1.1 in the first place, applied one release later.

The number is not cosmetic either. A new pane is a **minor** by semver, so history could
not ship as a 1.1.x without the version under-describing the largest interface addition
since 1.0 — and `make info` exists precisely so a version can be trusted.

🔴 **Amended 2026-08-20: 1.1 is pages, and only pages.** #91 was in 1.1 for one reason —
so history would be designed *once, after pages exist* — and it keeps that entirely by
being designed next rather than shipped now. What it does not have is a design: its own
body opens with *"Design TBD. Logged so it is not forgotten; nothing here is decided,"*
two of its three tasks are decisions, and one of them argues with §12's "no history
browser" head-on.

Holding a finished, verified, dogfooded feature for an undesigned one is the failure §12
exists to name. Pages shipped; history gets a design bundle.

**1.0 is "as far as we can go on one document"**, not "feature complete" and not a
promise about quality — it is the point at which adding anything more means adding a
second document, which is a different product shape.

🔴 **This resolves a tension, and the resolution is worth stating.** Finding 1 above says
#91 should come *after* #123 or it gets designed twice, since recovery and history acquire
a per-page dimension. That would pull #91 out of 1.0. It does: **#91 ships in 1.1, not
1.0.** The one-tap bring-back already works and history is already readable through the
agent — what #91 revisits is the *screen*, and a screen designed for one page and then
redesigned for several is exactly the waste finding 1 warns about.

So 1.0 does not mean every open issue is closed. It means the single-document product is
done, which is a claim about shape rather than about a count.

## The phases

### Phase 0 · Clear the runway — #107, ~~#74~~ · *mostly done*

Test infrastructure, no product change, no release.

`browser/sync.spec.ts` has flaked twice with a dead dev server, cost two false
reds, and one of them **held up a release**. Every phase below ends in a PR that
has to go green, so fixing it once pays back on all of them. #74 is the same
area — two majors of miniflare installed at once, one an alpha, nobody chose it.

**Updated 2026-08-19, after the first pass at #107.** It shipped instrumentation
rather than a fix and did not close, which was the right outcome: the probe
eliminated four hypotheses with data — the file's own traffic (both failures
killed a server twelve seconds old), leaked live processes (`workerd` climbs to
18 but every one is a *zombie*, holding a PID slot and nothing else), a retained
port, and memory. It also found and fixed a real one: wrangler's observability
trace store grows unbounded and had reached 66MB locally, which is why #107
"never reproduced locally" — it does, once a working tree ages.

The lesson worth carrying: an instrument must not add a pipe to the path it
measures. Capturing output through `tee` took the flake from two occurrences in
weeks to six CI runs out of six; a file redirect went green.

🔴 **#74 shipped and did not close #107.** The theory was that they were one
issue — a dev server dying while printing an *empty* `✘ [ERROR]` and recording
nothing in its own log is what an alpha runtime does, and #74 unified the two
miniflare majors onto one. It did not stop the failures. What did was the fourth
occurrence pointing at **duration** rather than identity or position, and the
answer to that was splitting `editor.spec.ts` three ways in 0.11.1 so no file runs
long enough to be the one that dies. #107 stays open, back in Backlog, and closes
on evidence — see the header.

**#4 is running.** It is wall-clock, not work: the iOS cookie clock needs seven
days of *not* touching the phone. Started 2026-08-19 on the iPad against **dev**,
which is the only device-and-environment pair nobody uses, and it runs to
2026-08-27. Prod is the dogfood on every device and a different cookie jar, so
using it freely does not disturb the measurement. 🔴 **Keep migrations additive
until then** — `deploy-dev.yml` redeploys the subject on every merge to `main`, and
a destructive migration would end the test silently by making the iPad ask for a
passphrase, which reads as an ITP failure rather than a self-inflicted one.

### Phase 1 · Sessions you can revoke — ~~#125~~ · ✅ **done, 0.9.0**

**The only security item on the board, and it has no workaround.** `SESSION_TTL_SECONDS`
is a year on purpose — re-auth is what kills daily use
([ADR-001](adr/ADR-001-passphrase-auth.md), spec §4) — but `findLiveSession` matches only
`token_hash` and `expires_at`, so a session has no relationship to the passphrase that
created it.

🔴 **Rotating `KNAG_PASSPHRASE` leaves every existing cookie live for its full year.** A
lost phone is a year of access, and the only remedy today is `DELETE FROM sessions` typed
by hand against the one copy of the document. There is no log out at all.

Placed here, ahead of the editor work, for three reasons and not for severity theatre —
this is one person's todo list, not a breach:

- **It is independent.** Server-side plus one Settings section. Nothing in it gets cheaper
  after #113, so it does not benefit from waiting, and nothing else is blocked by it.
- **It is small** — one additive migration (a surrogate `id`, because `token_hash` is the
  SHA-256 of a live credential and must never appear in a response body), two store
  functions, three routes, one Settings section.
- 🔴 **#122 is dead without it.** "Invite friends to try it" is not a thing you can offer
  when access cannot be withdrawn. Whatever the auth spike decides, being able to revoke is
  the floor.

It also resolves the open question in #92 — log out is not part of About, it is this — so
#92 keeps its later slot with the rest of the Settings work rather than moving up.

### Phase 2 · Earn the editor, then delete the row list — ~~#119~~, ~~#114~~, ~~#113~~ · ✅ **done, 1.0.0**

🔴 **#113 was the hinge of the roadmap, and it turned on 2026-08-20.** Two editing
surfaces existed during the transition ([ADR-007](adr/ADR-007-one-editing-surface.md)
§7), and every UI item below would have been written once after the row list went and
twice before it.

Its precondition was stated on the ADR — *the replacement gets used against the real page
before the old one is deleted* — and it was met the way the ADR intended: by the operator
saying the editor had stopped feeling like the new thing, not by a date.

**What the deletion cost and returned:** 1,726 lines out, 505 in, `caret.ts` gone
entirely, and 6.4kb off the minified bundle. That last number is smaller than #113
guessed at ("some of the +85 KB") and the reason is worth keeping: CodeMirror *is* the
+85 KB, and it stays. What came back was the row model wrapped around it.

The outstanding items on the precondition list were:

| | |
|---|---|
| **#119** | The wipe does not animate in the editing surface. `animateWipe` resolves `li[data-index]` inside `[data-rows]`, which `paint()` empties in editor view. The surface is missing the product's signature moment. |
| ~~**#114**~~ | ✅ **Settled on device, 2026-08-20.** The control test failed — autocapitalize does not fire in this surface at all — so §6 was re-argued rather than inherited. Its conclusion survives for a plainer reason than the one it gave: the risk it named does not occur. |

Three PRs. #113 alone, because a ~400-line deletion deserves to be reviewable by
itself. Natural **0.9.0**.

### Phase 3 · Copy, settled — ~~#115~~, ~~#118~~ · ✅ **done, 2026-08-20**

🔴 **Corrected 2026-08-19: #118 did not depend on #115, and shipped alone in
0.10.0.** This phase originally said the two were one branch because "the button
has to put *something* on the clipboard". That reasoning does not survive #118's
own issue, which says a whole-page copy is *"the only one with no room for
interpretation: it carries the page, markers and all"* — the answer is forced by
round-tripping, not by #115.

**#115 was parked, and not because it was hard.** Its own first task said
*"use both for a week and notice whether it ever bites — do not decide from the
armchair."* The editing surface shipped 2026-08-18. There was nothing to build
that answers a question about how a gesture feels; what #115 gained from 0.10.0
is that there were three paths to rule on and the third was already decided.

🔴 **Ruled 2026-08-20: leave both, and nothing changes.** Arrange's copy is a
whole-row verb and copies what the row displays; an editor selection copies document
text, which is not a policy but what a selection is. Both paths were used against a real
page and the disagreement never surfaced — which is the answer the experiment was set up
to produce, not an absence of one.

It was ruled *now* rather than left running because it is a **single-document** question
and Phase 6 is next: once there are several pages, copy acquires a cross-page paste and
this gets designed twice. That is finding 1 again — the same one that moved #91 out of
1.0 — and the cheapest place to spend it is before the shape changes.

**Phase 3 clearing is what makes 1.0's claim literally true**: the single-document
product is done, with no open item inside it.

### Phase 4 · The bar, the wipe and the sheet — #139, #121, #132, ~~#92~~, ~~#120~~

**The design session answered on 2026-08-19** and the phase was rebuilt around what
came back. Everything below is specified in
[design/holistic-response.md](design/holistic-response.md), and the numbers there
are the numbers to apply.

Three PRs, and the order is not arbitrary:

| | | |
|---|---|---|
| **#139** | **The ledge** — a second tier on the bar, opened on demand, plus the bar's diet (§3a). Closes #120 | first |
| **#121** | The wipe — `sweep` daily, `fall` for the page, sound behind a switch | after #139 |
| **#132** | Settings becomes preferences — two groups, six rows, no scroll | after both |

🔴 **The ledge is first because every other surface needs somewhere to live.** It
is tokens plus one container, it subsumes #120 entirely and most of #132, and
motion work on a bar that is about to change composition gets done twice.

**#92 shipped in 0.11.0 and the response reverses half of it.** The 44px touch
target was right and stays; the four type tokens it dragged up go back (§3a), and
About is deleted outright (§7e). Neither is a mistake being corrected — a hit
target and the ink inside it were conflated, and the sheet's rule now excludes
anything without a current value. Both are recorded on the issues.

Ship #121's motion alone if the sound needs a week of living with. The sound's
length is computed from the motion tokens rather than fixed, so it costs nothing
to maintain once it exists.

### Phase 5 · Show it — #90 · **ships 1.0**

After #121, so the landing page has the good wipe to demonstrate. That is #121's
own argument for existing.

**The line and the hero are decided** ([§8](design/holistic-response.md)): the page
says **"Throwing it away is the feature."**, the board arrives full and the wipe
runs once on scroll-into-view rather than on load, and it is **slate only** — which
answers decision 3 on the issue. The brief's own framing (*a behavior, not an app,
not a task list*) was ruled a sentence for us rather than for the reader and moves
to the top of [philosophy.md](philosophy.md).

**This is 1.0.** A landing page is the point at which this stops being a thing you
use and becomes a thing you show people, and it is the last item that belongs to
the single-document product.

### Phase 6 · A handful of pages — ~~#123~~ · ✅ **done, 1.1.0 → 1.1.3**

✅ **Closed 2026-08-21.** It took four releases rather than the one the phase assumed:
1.1.0 (schema, MCP, switcher), 1.1.1 (templates corrected — they are a page's *reset*
state, not a seed for new pages, which was a misreading of #123 found by using it),
1.1.2 (stop writing the shadow) and 1.1.3 (drop it). The two extra were both discovered
in flight rather than planned, and both are recorded where they will be read again —
templates in the CHANGELOG, the release schedule in ADR-002 §3.

🔴 **Split into four on 2026-08-20, and the split is the finding.** #123 was ten tasks
across schema, store, three routes, MCP, the switcher, manage-pages, templates and two
spec sections — and one of those pieces cannot ship in the same release as the others,
so the boundary existed whether or not it was named.

| | | |
|---|---|---|
| #152 | the page dimension behind the API | ✅ |
| #153 | MCP takes an optional page, by name | ✅ |
| #154 | `/api/pages`, the switcher, manage-pages, templates | ✅ |
| #155a | **stop writing** `documents` — no migration | ✅ 1.1.2 |
| #155b | **contract** — drop `documents` | ✅ 1.1.3 |

Two things in #123's own task list turned out to be wrong and are corrected in the
children: MCP cannot default to "the current page" (the Worker has no current page — it
is a per-device idea and a bearer token carries no device), and the switcher did not need
a design session, because [§7](design/holistic-response.md) had already specified it.

Ships independently of auth; §17 is explicit that it "can ship long before
tenancy does". Before #91, per finding 1.

**Designed in [§7](design/holistic-response.md).** The selector is a drop-up from
the tier-1 slot the ledge frees, and the manage-pages screen ships **in the same
PR** — it is where the destructive per-page verbs live, so shipping the selector
alone means new · rename · delete land in the sheet first and move later.

🔴 **The rule that keeps this from becoming a file manager: knag has no index.**
There is no screen that lists your pages, only a control that switches between
them, and it is never the thing you land on. Launch opens the last page you were
on. The list is **capped at nine and never scrolls** — a tripwire, not a limit.
Search arrives the moment the list stops fitting, then folders because search
implies a namespace, then a home screen because a namespace needs a root; all
three are on [§12](spec.md)'s Out list, and the cap is the one decision that keeps
them unnecessary rather than merely forbidden.

### Phase 7 · Recovery and history — ~~#91~~ · ✅ **done, 1.2.0**

Designed per-page, **once** — which is why it sits here rather than in 1.0. See
the release shape above: the bring-back and the agent-readable history already
work, so what this revisits is the screen, and a screen designed for one page and
then redesigned for several is the waste finding 1 exists to avoid.

✅ **The bundle came back, 2026-08-21** —
[design/history-response.md](design/history-response.md). It is the ruling; the build works
from it. Three things it decided that the phase did not know:

- **A surface, not a widened constant.** `offerExpiresAt` stays at local midnight, because
  *the constant says how long and the problem is which one* — by tomorrow yesterday's sweep
  sits behind three newer wipes whatever the number says.
- **It argues with the Out list and wins on a distinction**: *a list of lines is a document;
  a list of wipes is chrome about actions.* Rows are wipes, one wipe's lines at a time, so
  no view ever shows a week of lines and search never has anything to be for. Replacement
  text for brand §10 and spec §12 is in the response.
- **`carbon` is retired** — done separately and first, ahead of the pane.

🔴 **Moved out of 1.1 on 2026-08-20, and the reason it was here is untouched by that.**
The condition was "after pages exist", and pages now do. It was also the one phase whose
likeliest shape argues with the Out list, which is why it wanted a bundle rather than a
branch — and the bundle did argue with it, on purpose, rather than routing around it.

🔴 **Reshaped by #149, and this paragraph is the amendment.** §7 wrote history as a
full **screen** reached from the ledge. Then devices became a *pane* of the settings
dialog and §3d was amended to say list-shaped surfaces inherit the pane — so history is a
**pane**, not a screen. Carry that into the design brief rather than rediscovering it.

🔴 **This page said both for a day**, keeping §7's "it is a screen, not a dialog"
alongside the amendment that replaced it. Corrected 2026-08-21. A brief assembled from the
stale half would have asked for the wrong surface, which is the failure mode the
*Keeping this true* section at the bottom exists to catch.

What survives from §7, because #149 touched the container and not the content: it is **a
place you go and come back from**, and its action is never called "restore" — because the
page does not go back to how it was, and that is the one thing it cannot be ambiguous
about.

🔴 **Two details of §7 the response supersedes**, recorded so the older document is not
read as current. It opens on **today, newest first, grouped by day** rather than on
yesterday; and the action is `bring back` on a sweep and `put the page back` on a reset,
rather than `add 3 to the page`. The second is downstream of #173: a reset's undo has to
take the template off as well as put the lines back, which is a bigger operation and reads
as one.

### Phase 8 · What a week of use found — #190–#197 · **ships 1.2.1, 1.3, 1.4**

Eight issues from a few days of using 1.2 on a phone, an iPad and through the connector.
None came from the suite, which is the finding 1.0.1 already recorded and which this
phase confirms rather than repeats. What is new is the *shape* of the list: six of the
eight need a design answer, and every answer is small — a number, a copy line, a yes/no,
one artwork variant. That shape is what sets the order.

**The sequencing lever is the design session.** Sent one issue at a time, six design
questions are six round trips. Sent as one brief they are one. So the phase is cut into
what can go *before* the brief, what waits *on* it, and what is bigger than it.

#### 8a · Patch — ~~#191~~, #194, #202, with #107 · **1.2.1**

No feature, no schema, no design. #191 is a bug visible in every Claude session — the
connector shows the wrong icon because `/favicon.ico` answers with the PWA shell and a
200, the same SPA-fallback failure ADR-005 §4 documents. #194 is an hour of copy: every
preference is per device and the sheet does not say so. #107 was already Prioritized and
is still the only thing making CI lie; it rides along rather than blocking.

🔴 **#202 joined on 2026-08-25, and 8a is where the PR-grouping rule below comes from.**
#191 and #194 shipped as two PRs sharing one version bump and one CHANGELOG block. That
cost two ten-minute browser runs, a stacked branch, and a merge conflict when the first
squash rewrote the lines the second was sitting on — three CI cycles for 120 lines. The
browser job is the whole ten minutes and it is serial by design (#69), so #202 shards it
across runners and skips it for docs-only changes; every phase after this one pays the
same ten minutes on every push until it lands.

#### 8b · The phone pass — #192 → #197, #193, #196 · **1.3**

One design brief, then four issues, in this order:

1. **#192, the ledge opens above the bar.** Fixes a hazard — the wipe control landing
   under the pointer that just opened the ledge — and, in the same PR, the jammed labels
   on a phone: they overlap because of a 44px margin that was standing in for this fix.
2. **#197, the ledge is too small on a phone.** After #192, by the rule this page already
   records: *work on a bar that is about to change composition gets done twice.* Measure
   the row once the dead margin is gone.
3. **#193, the checkbox gets a 44px target.** The daily one. The hit-area half needs no
   design; it ships in the same PR as the left-padding number.
4. **#196, dev gets its own icon and manifest name.** Artwork from the same brief. The
   code can merge any time; 🔴 **the iPad reinstall waits until after 2026-08-27** or
   the ITP test (#4) ends with a self-inflicted result that reads as a cookie failure.

The brief asks for exactly: ledge opens upward (yes/no), ledge label and glyph size (two
numbers), editor left padding (one number), the dev mark (one variant) — and, for 8c, the
`agent ›` surface and the drag affordance in manage-pages. One bundle; nothing after it is
blocked.

#### 8c · The schema — #190, then #195 · **1.4**

Both add to D1, both additive, so the ITP rule on dev does not bind them.

**#190 first.** Operator instructions appended to the MCP server's `instructions` string
— the highest-value item on the list, because it improves every agent conversation, and
the **first server-side setting** the product has had. Build it so #122 can add an owner
column later; do not wait on the multi-user decision to build it.

**#195 last.** Pages in a manual, server-side order. Lowest urgency on the list — nine
pages max, creation order is tolerable — and the biggest cost: a migration, a route and a
drag surface in a pane that is not Arrange.

### Phase 9 · Multi-user — #122 · **ships 1.5**

Last, deliberately — and the reason is not difficulty. The spike is reading and
measuring, and it can float earlier in any week that wants a break from
building.

🔴 **Moved back one slot on 2026-08-24, from Phase 8.** Not because it lost priority but
because #190 lands first: the spike will have to decide where a per-account setting lives,
and it is better to decide that against a real one than a hypothetical one. Everything
below is unchanged.

🔴 **A pilot spends invitations, and you only get to invite someone for the first
time once.** Inviting friends to a product whose wipe does not animate and which
still carries a vestigial row list wastes them. Phases 1–5 are what make the
invitation worth sending.

Note also that #122 is scoped as **spike and ADR, not build**. It is
[ADR-001](adr/ADR-001-passphrase-auth.md)'s stated trigger firing — *a second
human, not a feature count* — and §17 already decided the first move is an auth
spike rather than a schema change.

**The design session recommends an email link** and argues it against the
alternatives in [§7](design/holistic-response.md): the login surface stays one
field, the identifier is one nobody can lose, recovery *is* the login flow, and it
costs exactly one added state. An identity provider puts another company's logo on
the only screen that is not the page. Two questions the spike has to answer: does
the link land you on **the page** rather than a "logged in" screen, and does an
existing session survive a new link on the same device — it must, or every
re-login costs a device row.

---

## Not scheduled

Still on the [§12](spec.md) Out list and not moved by anything here: search,
tags, attachments, offline editing, WebSockets, native apps, rich formatting
([ADR-004](adr/ADR-004-display-matches-the-bytes.md)).

Multiple documents and multi-user are on that list too, and stay there until
#123 and #122 respectively produce a decision worth reversing it for.

---

## Keeping this true

A roadmap that goes stale is the thing this one replaced, so:

- **A phase closes when its issues close.** Say so here, in one line, rather
  than leaving the phase reading as pending.
- **Re-read it when something reorders.** A phase that moved for a reason is
  worth a sentence; a phase that moved for no reason is a sign the sequence was
  wrong.
- **If it has not been touched in two releases, it is probably wrong.**
  `make info` answers "what shipped"; nothing answers "is this still the plan"
  except reading it.
- **A release group ships as one PR when its items are each under half a day and
  none needs its own review.** CHANGELOG bullets stay separate; the bump lands once;
  CI runs once. Two small PRs sharing a version bump is how 8a produced a stacked
  branch, a merge conflict and three browser runs for 120 lines (2026-08-25). The
  house rule against giant PRs still holds — it is about what can be *reviewed*,
  and two hour-long changes in one diff can be. Applied ahead: 8b ships #192 and
  #197 together (both are the ledge, and #197 measures after #192 anyway), #193 and
  #196 on their own; 8c ships #190 and #195 separately, because each adds schema.
