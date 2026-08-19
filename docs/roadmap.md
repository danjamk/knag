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

## The phases

### Phase 0 · Clear the runway — #107, #74

Test infrastructure, no product change, no release.

`browser/sync.spec.ts` has flaked twice with a dead dev server, cost two false
reds, and one of them **held up a release**. Every phase below ends in a PR that
has to go green, so fixing it once pays back on all of them. #74 is the same
area — two majors of miniflare installed at once, one an alpha, nobody chose it.

**Also start #4 now.** It is wall-clock, not work: the iOS cookie clock needs
seven days of *not* touching the phone. It has been deferred since 2026-08-15
and should be running in the background underneath every phase here, not
scheduled into one.

### Phase 1 · Earn the editor, then delete the row list — #119, #114, #113

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

### Phase 2 · Copy, settled — #115 + #118, one branch

#118 cannot ship without #115's answer, because the button has to put *something*
on the clipboard. Shipping a third copy path while the existing two disagree is
how you end up with three that disagree.

Cheaper after Phase 1: two paths left (Arrange, editor) rather than three.

### Phase 3 · The wipe, made good — #120, #92, #121

**Open this phase with one request to the design session**, covering wipe motion,
wipe sound, where #120's control goes, and #90's landing-page brief — which is
written and already waiting. One session, four answers. Design decisions come
from there and not from here; motion is named explicitly in `CLAUDE.md`.

#120 and #92 both edit the Settings dialog — #120 removes its `Page` section —
so they pair. #121 lands after #113 so the animation is written once, against one
surface.

### Phase 4 · Show it — #90

After #121, so the landing page has the good wipe to demonstrate. That is #121's
own argument for existing. Plausible **1.0**: a landing page is the point at
which this is a thing you show people.

### Phase 5 · A handful of pages — #123

Ships independently of auth; §17 is explicit that it "can ship long before
tenancy does". Before #91, per finding 1.

### Phase 6 · Recovery and history — #91

Designed per-page, once.

### Phase 7 · Multi-user — #122

Last, deliberately — and the reason is not difficulty. The spike is reading and
measuring, and it can float earlier in any week that wants a break from
building.

🔴 **A pilot spends invitations, and you only get to invite someone for the first
time once.** Inviting friends to a product whose wipe does not animate and which
still carries a vestigial row list wastes them. Phases 1–4 are what make the
invitation worth sending.

Note also that #122 is scoped as **spike and ADR, not build**. It is
[ADR-001](adr/ADR-001-passphrase-auth.md)'s stated trigger firing — *a second
human, not a feature count* — and §17 already decided the first move is an auth
spike rather than a schema change.

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
