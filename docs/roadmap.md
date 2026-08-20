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

**Where it stands, 2026-08-19.** Phases 1, 3 and half of 2 and 4 have shipped —
0.9.0 through 0.11.1, and prod is live on the same build as dev. What is left in
1.0 is **#114** (a device test, not a branch), **#113** and **#115** (both waiting on
the editor being the daily surface for a couple of weeks — their own issues say
so), and phases 4 and 5, which now have a design.

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
and was not before the split. The finding survives and the fix did not: the answer is a
cap on how long any one file runs, not one split. Recorded with the numbers on the issue.
The mechanism — an empty `✘ [ERROR]` and a crash log containing no error — is still
unexplained.

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
expand/contract across two releases, not one additive column. Recorded on the
issue.

---

## The release shape

Set 2026-08-19. The version numbers are meant to say something:

| | What it is | Phases |
|---|---|---|
| **1.0** | **One page, finished.** Everything the single-document product should be | 0–5 |
| **1.1** | A handful of pages | 6–7 |
| **1.2** | Multi-user | 8 |

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

### Phase 2 · Earn the editor, then delete the row list — ~~#119~~, #114, #113

🔴 **#113 is the hinge of the roadmap.** Two editing surfaces exist during the
transition ([ADR-007](adr/ADR-007-one-editing-surface.md) §7), and every UI item
below is written once after the row list goes and twice before it.

Its precondition is stated on the ADR — *the replacement gets used against the
real page before the old one is deleted* — and the outstanding items on that
list are exactly two:

| | |
|---|---|
| **#119** | The wipe does not animate in the editing surface. `animateWipe` resolves `li[data-index]` inside `[data-rows]`, which `paint()` empties in editor view. The surface is missing the product's signature moment. |
| **#114** | Autocorrect-off-inside-fences is still provisional, pending one control test on a device. |

Three PRs. #113 alone, because a ~400-line deletion deserves to be reviewable by
itself. Natural **0.9.0**.

### Phase 3 · Copy, settled — #115, ~~#118~~

🔴 **Corrected 2026-08-19: #118 did not depend on #115, and shipped alone in
0.10.0.** This phase originally said the two were one branch because "the button
has to put *something* on the clipboard". That reasoning does not survive #118's
own issue, which says a whole-page copy is *"the only one with no room for
interpretation: it carries the page, markers and all"* — the answer is forced by
round-tripping, not by #115.

**#115 is parked, and not because it is hard.** Its own first task says
*"use both for a week and notice whether it ever bites — do not decide from the
armchair."* The editing surface shipped 2026-08-18. There is nothing to build
that answers a question about how a gesture feels; what #115 gained from 0.10.0
is that there are now three paths to rule on and the third is already decided.

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

### Phase 6 · A handful of pages — #123 · **ships 1.1**

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

### Phase 7 · Recovery and history — #91 · **ships 1.1**

Designed per-page, **once** — which is why it sits here rather than in 1.0. See
the release shape above: the bring-back and the agent-readable history already
work, so what this revisits is the screen, and a screen designed for one page and
then redesigned for several is the waste finding 1 exists to avoid.

**And it is a screen, not a dialog** ([§7](design/holistic-response.md)) — a place
you go and come back from, reached from the ledge, opening on *yesterday* rather
than today. Its action says `add 3 to the page`, never "restore", because the page
does not go back to how it was and that is the one thing it cannot be ambiguous
about.

### Phase 8 · Multi-user — #122 · **ships 1.2**

Last, deliberately — and the reason is not difficulty. The spike is reading and
measuring, and it can float earlier in any week that wants a break from
building.

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
