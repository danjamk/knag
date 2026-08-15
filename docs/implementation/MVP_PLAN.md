# knag MVP — implementation plan

**Status:** Active
**Created:** 2026-08-14
**Spec:** [../spec.md](../spec.md) — this plan does not restate it

## What this adds that the spec does not

Spec §13 is an ordered *sequence*. This is the plan against it: what "done" means
per phase, which phases gate and which run in parallel, honest sizing, and what
is blocked on Cloudflare provisioning. Each phase below is one GitHub issue.

**Read the spec for the what. Read this for the when and the how-do-we-know.**

## Phase → issue

Tracked on the **knag Roadmap** board (project #4).

| Phase | Issue | Size |
|---|---|---|
| 1 · Document API | [#2](https://github.com/danjamk/knag/issues/2) | 1–2d |
| 2 · Auth | [#3](https://github.com/danjamk/knag/issues/3) | 1–2d |
| 3 · Provision dev + cookie clock | [#4](https://github.com/danjamk/knag/issues/4) | ½d + 7d wait |
| 4 · Raw view PWA | [#5](https://github.com/danjamk/knag/issues/5) | 1–2d |
| 5 · Polling + dirty guard | [#6](https://github.com/danjamk/knag/issues/6) | 1d |
| 6 · Revisions + coalescing | [#7](https://github.com/danjamk/knag/issues/7) | 1d |
| 7 · Block parser | [#8](https://github.com/danjamk/knag/issues/8) | 1–2d |
| 8 · List view | [#9](https://github.com/danjamk/knag/issues/9) rows · [#10](https://github.com/danjamk/knag/issues/10) tap-to-edit · [#11](https://github.com/danjamk/knag/issues/11) copy/linkify | 3–4d total |
| 9 · Clear completed | [#12](https://github.com/danjamk/knag/issues/12) | ½d |
| 10 · Drag reorder | [#13](https://github.com/danjamk/knag/issues/13) | ½d |
| 11 · MCP server | [#14](https://github.com/danjamk/knag/issues/14) | 1–2d |
| 12 · History + diff | [#15](https://github.com/danjamk/knag/issues/15) | 1–2d |

Phase 8 is three issues because 3–4 days breaks the ~1–2 day sizing rule in
`docs/guides/github-issues.md`. The split follows the seams already identified
below.

**Suggested order, which is not the phase order:** #2 → #3 → #4 (start the
clock) → #8 in parallel with the wait, since the block parser has no
dependencies, is the highest-risk code here, and gates #9, #12 and #13.

---

## The scheduling constraint that drives everything

Spec §13 step 2 says the session cookie must be verified to survive **a week of
iOS inactivity** before building on top of it. That is seven days of wall clock,
and it is the only irreducible delay in the project.

The naive reading — finish step 2, wait a week — is wrong. So is ignoring it
until step 4, which is what the spec's ordering implies and which risks
discovering the problem after the list view, drag reorder, and clear-completed
are all built on a session that dies.

**The plan: get to a deployed dev environment with working login as early as
possible, install it on the phone, and let the clock run in the background while
building continues.**

```
P1 ──▶ P2 ──▶ P3 (deploy dev, install on iPhone, log in)
                    │
                    ├── clock starts ──────────────────── day 7: verify ──┐
                    │                                                      │
                    └──▶ P4 ──▶ P5 ──▶ P6 ──▶ P7 ──▶ P8 …                 │
                                                                           │
                             if the cookie died, re-architect here ◀───────┘
```

If the cookie dies at day 7, two phases of work are affected instead of eight.
The fallback is a refresh-on-load token rotation, which is a change to `auth.ts`
and the client's boot path — contained, but not free.

## Provisioning gate

| Phases | Needs Cloudflare? |
|---|---|
| P1, P2 | **No.** Miniflare does not care that the D1 id is a placeholder. Fully local, fully testable. |
| P3 onward | Yes — dev D1, two secrets, a deployed Worker. |

So P1 and P2 can start immediately and in any order relative to provisioning.

---

## Phase 1 — Document API with optimistic concurrency

**Spec:** §5 (`GET`/`PUT /api/doc`), §14.5 (first boot), §3 (coalescing)
**Size:** 1–2 days · **Blocks:** everything · **Local only**

The concurrency semantics are the foundation. Get them right before any UI, and
before there is any client whose bugs could be mistaken for server bugs.

**Done when:**
- [x] `GET /api/doc` returns `{ body, version, updated_at }` and sets `ETag: "<version>"`
- [x] `If-None-Match` with the current version returns **304** and an empty body
- [x] `PUT` with a matching `base_version` applies, bumps, returns `{ version }`
- [x] `PUT` with a stale `base_version` returns **409** carrying the current `{ body, version }` — never merges, never overwrites
- [x] A no-op write (identical body) bumps nothing and creates no revision
- [x] A missing row reads as empty body at version 0; `PUT` with `base_version: 0` initialises it
- [x] All SQL is in `store.ts`; no statement and no literal `1` anywhere else
- [x] `worker/test/api.test.ts` covers every line above against real D1

**Watch for:** the 409 body is not a courtesy — the agent contract (§10) depends
on it carrying enough to re-apply intent without a second round trip.

**Decided during implementation:**

- **`/api/doc` authenticates now**, rather than waiting for P2. `authenticate()`
  already resolves bearer, and CLAUDE.md's "every route resolves a principal" is
  not a rule a route gets to join later. P2 adds the cookie path underneath it
  and changes nothing here.
- **`source` is derived from the principal, not read from the request body.**
  Spec §5 amended.
- **Writes are a conditional `UPDATE ... WHERE version = ?`, not read-then-write.**
  The read decides what to *report*; the UPDATE decides what *happens*, so two
  saves landing together cannot both apply.
- **1 MiB cap → 413.** Not in the issue. ~200× the expected document, and the
  alternative is finding the limit at D1, against the only copy.
- **`worker/test/setup.ts` now resets per test.** pool-workers 0.18 dropped the
  automatic isolated-storage stack the scaffold assumed, so every test was
  inheriting the previous one's document — in a suite about versioning. Caught by
  seven failures that all looked like logic bugs.

---

## Phase 2 — Auth: passphrase, cookie, bearer

**Spec:** §4, §4.1, §4.2 · **ADR:** [ADR-001](../adr/ADR-001-passphrase-auth.md)
**Size:** 1–2 days · **Depends:** P1 · **Local only**

**Done when:**
- [x] `POST /api/login` takes a passphrase and an optional `device_label`
- [x] On match: 32 random bytes minted, SHA-256 stored in `sessions`, raw value set as a **server-set** cookie — `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=31536000`
- [x] `authenticate()` returns `Principal | null`; every route keys off `principal.id`
- [x] Bearer works on **every** `/api/*` route, not just the agent ones
- [x] Passphrase and bearer both compared with `timingSafeEqual` over digests — no `===` anywhere
- [x] Expired sessions swept on login
- [x] Failed login returns an opaque 401 and logs the source IP
- [x] `worker/test/auth.test.ts` covers all of it and runs alone under `pnpm test:security`

**Watch for:** the cookie must be **server-set**. A client-set cookie is capped
at 7 days of inactivity by Safari ITP, which fails the very thing P3 exists to
test.

**Decided during implementation:**

- **`Secure` is omitted over plain `http:` on loopback only.** Safari will not
  store a `Secure` cookie on `http://localhost` and `wrangler dev` serves exactly
  that, so without the exception the PWA cannot be developed locally on the
  browser it targets. Unreachable in any deployed environment. Spec §5 records it.
- **Expiry is enforced in the `WHERE` clause of the session lookup**, not by the
  caller. The sweep only runs on login, so an expired row can sit in the table for
  a year — a lookup that returned it and trusted a caller to compare dates would
  be a session that never actually ends.
- **Bearer is checked before the cookie.** A browser carrying both should not have
  its cookie silently beat a header the caller deliberately set.
- **No logout.** Not in the issue, and ADR-001 already accepts that revocation
  means rotating the passphrase. A `clearSessionCookie` helper was written and
  then deleted rather than shipped unused.
- **One task cannot be pinned by a test:** "no `===` anywhere" is invisible to the
  suite, because swapping `secretEquals` for `===` is functionally identical and
  every test still passes. Enforced by grep in review instead — currently 13 `===`
  in `auth.ts`/`index.ts`, all on paths, methods and types, none on a credential.

---

## Phase 3 — Provision dev, deploy, start the clock

**Spec:** §15 · **ADR:** [ADR-002](../adr/ADR-002-two-accounts-and-migrations.md)
**Size:** half a day, then 7 days of waiting that block nothing
**Depends:** P2 · **First phase that touches Cloudflare**

The point of this phase is not the deployment. It is starting the ITP clock.

**Done when:**
- [x] `CF_ACCOUNT_ID_DEV` set in `.env`; `make preflight` passes
- [x] `wrangler d1 create knag-dev`, id pasted into `wrangler.jsonc`
- [x] `make migrate ENV=dev` applied
- [x] `KNAG_PASSPHRASE` and `KNAG_BEARER_TOKEN` set as dev secrets — **different values from whatever prod will use**
- [x] `make deploy ENV=dev` succeeds; `make health ENV=dev` matches the checkout
- [x] Added to the iPhone home screen, logged in once
- [x] **Date recorded in this file** so day 7 is unambiguous
- [ ] **Day 7: reopen without touching it in between, confirm still logged in**

**Clock started:** `2026-08-15`  ·  **Verify on:** `2026-08-22`

**Dev URL:** https://knag-dev.fractional-lab5.workers.dev
**Dev D1:** `knag-dev` · `ac5d4b49-4556-43bd-abd1-151b01027c4f`

The session that starts the clock, read off the live database rather than assumed:

```
device_label  iphone
created_at    2026-08-15T13:40:23.553Z
expires_at    2027-08-15T13:40:23.553Z    exactly one year
hash_len      64                          SHA-256 hex — the raw token is not stored
```

🔴 **Do not open knag on the iPhone before 2026-08-22.** Opening it resets the
inactivity window, and the whole point is to prove the cookie survives one
untouched. Use the laptop if you need to poke at it.

**Watch for:** the dev Worker is on `*.workers.dev` with no WAF rate-limit rule
in front of it. Dev holds test content only.

**Decided during implementation:**

- **A minimal login screen shipped here, not in P4.** This phase's task list said
  "logged in once" while the only issue building a way to log in was the next one —
  an ordering error in this plan. `/api/login` existed and nothing on the phone
  could call it, so the clock could not start. What shipped is a passphrase field
  and an authed/unauthed toggle; no textarea, no debounce, no service worker. P4
  inherits it rather than building it, and its own task list already listed it.
- **The authed check probes `GET /api/doc`** rather than adding `/api/me`. 200 or
  401 already answers the question; a second endpoint would be a second answer.
- **The D1 binding stays `DB`.** `wrangler d1 create` suggests naming the binding
  after the database (`knag_dev`), which would make it differ between dev and prod
  and force every `env.DB` in the tree to know which environment it is in.

---

## Phase 4 — Raw view PWA

**Spec:** §8, §9 · **Size:** 1–2 days · **Depends:** P2 (P3 in parallel)

A textarea and a save. At this point knag is already useful and already replaces
the transfer use case.

**Done when:**
- [ ] Full-bleed monospace `<textarea>`, entire document unmodified
- [ ] **Round-trips byte-for-byte** — no trimming, no whitespace normalization, no line-ending rewriting
- [ ] Saves on 800ms debounce after typing stops, and immediately on blur
- [ ] Login screen when unauthenticated
- [ ] `manifest.json` with 192/512 icons, `display: standalone`, matching `theme_color`
- [ ] Service worker caches the **shell only** — never a document response

---

## Phase 5 — Polling and the dirty guard

**Spec:** §6, §14.4 · **Size:** 1 day · **Depends:** P4

**Done when:**
- [ ] Adaptive interval: 4s recent-edit → 15s idle 2–15min → 60s idle >15min → stopped when hidden
- [ ] Immediate refetch on `visibilitychange` → visible and on `window.focus`
- [ ] `If-None-Match` sent; a 304 skips the dirty-guard path entirely
- [ ] **A remote update is never applied while the editor is dirty or focused** — queued, applied on blur
- [ ] Two-device test: one left open overnight, the 409 path confirmed by hand

**Watch for:** this phase contains the only catastrophic data-loss path in the
product. The two-device test is not optional and cannot be replaced by a unit
test.

---

## Phase 6 — Revisions and coalescing

**Spec:** §3 · **Size:** 1 day · **Depends:** P1

**Done when:**
- [ ] A save within 10 minutes of the newest **unsealed** revision updates it in place
- [ ] Otherwise inserts a new revision
- [ ] Sealed revisions are never coalesced into
- [ ] Full snapshots, not diffs
- [ ] Tested at the boundary — 9 minutes coalesces, 11 does not

---

## Phase 7 — Block parser

**Spec:** §14.1, §14.2 · **Size:** 1–2 days · **Depends:** none (do it early)

🔴 **The highest-risk code in the project.** It exists once, in
`worker/src/blocks.ts`, imported by both the Worker and the client. Nothing in
the list view may be built before its round-trip test passes.

**Done when:**
- [x] `parse()` returns blocks with `kind`, `raw`, `startLine`, `endLine`, and the checkbox fields
- [x] A fence opens on ` ``` ` or `~~~` and closes at the matching fence **or at EOF**, marked `unterminated: true`
- [x] `serialize(parse(x)) === x` — **property-based over generated input**, not a handful of examples
- [x] Round-trip holds for trailing newlines, CRLF, unclosed fences, and mixed indentation
- [x] Checkbox grammar exactly `/^(\s*)([-*])\s\[([ xX])\]\s(.*)$/` — `-[ ]` is not a checkbox
- [x] Indentation, `*` vs `-`, `[x]` vs `[X]`, and trailing whitespace all preserved through a toggle
- [x] Toggling rebuilds only the one line, never a document-wide regex

**Decided during implementation:**

- **The test was written before the parser.** This is the likeliest path to a
  corrupted document in the project, and a test written afterward tends to agree
  with whatever the implementation happens to do. It caught a real bug on the
  first run.
- 🔴 **`.` does not match `\r` in JavaScript**, so a raw CRLF line fails both
  grammars outright — every checkbox parses as `text`, every fence dissolves.
  **The round-trip property cannot see this**: `raw` is a verbatim slice whatever
  `kind` says, so bytes stay perfect while classification is entirely wrong, and
  clear-completed would silently remove nothing on a CRLF document. Caught by the
  block-model assertions, not the property. `withoutCR` strips it; `eol` carries
  it; spec §14.2 records it.
- **`fast-check` added as a dev dependency.** The issue asks for property-based
  testing, and `fc.string()` would essentially never emit a fence or a checkbox —
  so the generators are built from an alphabet of real line shapes. Shrinking is
  the reason it is not a hand-rolled loop: a 200-line counterexample is useless, a
  2-line one is a bug report. Dev-only; nothing ships to the Worker.
- **A double toggle of `[X]` yields `[x]`, and cannot do otherwise.** Unchecking
  writes a space over the only place that case was recorded. Asserted as an
  example rather than papered over in the property.
- **Blank and text blocks are one per line; only fences span lines.** Spec §14.1
  singles out fences as the multi-line case.
- **The cross-boundary import is verified, not assumed.** Both tsconfigs
  typecheck `blocks.ts` and esbuild inlines it into `public/app.js` — checked with
  a temporary import, which was then reverted. #9 inherits a proven path rather
  than discovering a broken one.

---

## Phase 8 — List view

**Spec:** §7 · **Size:** 3–4 days — **the largest phase; split if it grows**
**Depends:** P4, P7

**Done when:**
- [ ] Rows render from blocks: checkbox, text, fence-as-one-row, blank
- [ ] Checked items stay in place — no auto-sink
- [ ] Tap-to-edit becomes a single-line `<input>`; commits on blur or Enter, Escape reverts
- [ ] Per-row copy button, always visible, strips the `- [ ] ` prefix
- [ ] URLs linkified, open in a new tab
- [ ] Usable at 380px — grip and copy ~28px, text flexes and truncates rather than wrapping
- [ ] Toggle to raw view, persisted per device in `localStorage`

**Split candidates if this runs long:** rows + checkboxes · tap-to-edit ·
copy/linkify/polish.

---

## Phase 9 — Clear completed

**Spec:** §5, §14.2 · **Size:** half a day · **Depends:** P6, P7

**Done when:**
- [ ] Seals the newest revision, inserts a `clear_completed` revision with the pre-clear body, writes `cleared_items`, then updates `documents` — **in one D1 batch**
- [ ] Removes only blocks where `kind === 'checkbox' && checked`, at any indentation
- [ ] Returns `{ version, cleared_count }`
- [ ] Footer button; confirms only above ~10 blocks

**Watch for:** a partial clear that seals a revision but loses the `cleared_items`
write is worse than no clear at all. Test the ordering, not just the result.

---

## Phase 10 — Drag reorder

**Spec:** §7 · **Size:** half a day · **Depends:** P8

**Done when:**
- [ ] SortableJS **vendored and pinned** in `public/vendor/`, not from a CDN
- [ ] `handle: '.grip'` — the grip is the only drag initiator
- [ ] Operates on the **block** array; a fence moves as one unit
- [ ] Blank lines survive a reorder

---

## Phase 11 — MCP server

**Spec:** §10, §14.6 · **Standard:** `claude-shared/docs/standards/mcp.md`
**Size:** 1–2 days · **Depends:** P1, P2, P9

**Done when:**
- [ ] Streamable HTTP at `POST /mcp`, **a new server instance per request**
- [ ] Four tools: `knag_read`, `knag_write`, `knag_clear`, `knag_history`
- [ ] Annotations on every tool — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title` — asserted in tests
- [ ] Server `instructions` carry the agent contract (§10) once
- [ ] 401 with `WWW-Authenticate: Bearer` on failure
- [ ] A 409 reaches the agent as a structured error with the current version and body — never an HTTP 500
- [ ] **`Origin` is logged, not blocked** (mcp.md §8)
- [ ] Connected from a real client and exercised end to end

---

## Phase 12 — History and diff

**Spec:** §5, §14.3 · **Size:** 1–2 days · **Depends:** P6

**Done when:**
- [ ] `GET /api/history?since=&until=` returns revisions plus per-adjacent-pair `appeared` / `disappeared` line sets
- [ ] `cleared_items` in range returned as the authoritative done-record
- [ ] Bare dates resolve to local-midnight boundaries in `KNAG_TZ` via `Intl.DateTimeFormat` — **never manual offset arithmetic**
- [ ] Day grouping is by local date, not UTC
- [ ] Tested across a DST boundary

---

## Out of scope

Spec §12's **Out** list is load-bearing and is not re-opened here. §17 records
what a larger future would break; it is not MVP work.

## Deferred, tracked, not forgotten

- WAF rate-limit rule on `POST /api/login` — dashboard config, needed before prod
- 192/512 icons from `djk-brand`
- Prod provisioning + `CF_ACCOUNT_ID_PROD` + the custom domain
- Re-apply branch protection with `--checks check`
