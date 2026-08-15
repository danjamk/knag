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
- [x] Full-bleed monospace `<textarea>`, entire document unmodified
- [x] **Round-trips byte-for-byte** — no trimming, no whitespace normalization, no line-ending rewriting
- [x] Saves on 800ms debounce after typing stops, and immediately on blur
- [x] Login screen when unauthenticated
- [x] `manifest.json` with 192/512 icons, `display: standalone`, matching `theme_color`
- [x] Service worker caches the **shell only** — never a document response

**Decided during implementation:**

- **The shell's textarea attributes are pinned by a test**, not just a comment.
  `wrap="off"`, `spellcheck`, `autocapitalize`, `autocorrect` — losing any of them
  breaks no build, throws nothing, and renders identically while letting iOS
  rewrite the document. `vitest.config.ts` reads `public/index.html` in Node and
  passes it as `TEST_SHELL`, the same trick already used for migrations, because
  Miniflare does not serve the `assets` binding in tests.
- 🔴 **The first version of that test was theatre.** `toContain('wrap="off"')`
  matched the CSS comment that *mentions* the attribute, so deleting the real one
  left it green. Caught by deleting the attribute and watching nothing fail. The
  assertion is now scoped to the `<textarea>` tag itself. **Assertions about an
  element must be scoped to that element** — a whole-file `toContain` is a
  substring search, not a test.
- **`visibilitychange` saves, not just `blur`.** iOS does not reliably fire blur
  when the app is backgrounded or swiped away, which is the exact way this app
  gets closed on the device it was built for.
- **Icons are generated, not designed.** `scripts/make-icons.py` draws a peg on a
  wall. There is no brand asset for knag yet and the manifest was pointing at two
  404s — iOS silently substitutes a screenshot of the page, which reads as a bug
  on the home screen. Replace when real artwork exists; nothing depends on how it
  looks.
- **On 409 the server's copy wins and the local edit is lost.** Deliberate and
  temporary: it is survivable only because this is one user on an 800ms debounce.
  P5 adds the dirty guard. What is *never* done is retrying with the stale body —
  that is the catastrophic path, and the 409 carries the current body so a retry
  is unnecessary.

**Not covered by any test:** the textarea's behaviour in Safari itself. The
attributes are pinned and the API round-trip is covered, but whether iOS actually
honours them needs a device. Manual check is in the issue.

---

## Phase 5 — Polling and the dirty guard

**Spec:** §6, §14.4 · **Size:** 1 day · **Depends:** P4

**Done when:**
- [x] Adaptive interval: 4s recent-edit → 15s idle 2–15min → 60s idle >15min → stopped when hidden
- [x] Immediate refetch on `visibilitychange` → visible and on `window.focus`
- [x] `If-None-Match` sent; a 304 skips the dirty-guard path entirely
- [x] **A remote update is never applied while the editor is dirty or focused** — queued, applied on blur
- [ ] Two-device test: one left open overnight, the 409 path confirmed by hand

**Decided during implementation:**

- **The decisions live in `client/src/sync.ts`, pure and tested.** Inside event
  handlers they would be untestable, and both fail silently when wrong: an interval
  tier that never backs off quietly burns the free tier, and a dirty guard with one
  case missing corrupts an edit in progress. `client/test/` runs in the same
  workers pool because the module has no DOM — the day a client test needs a
  document, that stops being true and the config needs splitting into projects.
- **The guard covers *focused*, not only *dirty*.** Assigning `textarea.value`
  resets the selection, so a poll landing between two keystrokes throws the caret
  to the end of the document even when nothing has been typed in this focus yet.
  Guarding on `dirty` alone lets that through, and it is invisible in review.
- **A queued update is held, never dropped.** Dropping it means the device silently
  stops converging.
- **On blur, a dirty save goes first and the queue is not applied.** If the
  document moved on underneath us, the save's 409 carries a copy at least as new as
  anything queued — so applying the queue first would render something already
  stale. `render()` clears the queue for the same reason.
- **Boundaries belong to the slower tier.** Exactly two minutes idle backs off to
  15s. Defensible either way; the test exists so it is not accidental.
- **A failed poll is silent.** The next one is seconds away and the save path
  reports its own failures — a toast per dropped poll on a flaky connection is
  noise, not information.

**Deployed to dev 2026-08-15.** Bundle 3.5kb → 5.6kb.

🔴 **The two-device test is outstanding and cannot be replaced by a unit test.**
The suite pins the decisions; it cannot pin what the caret does in Safari.

### Two bugs the manual test found that 150 passing tests did not

Reported as "sync only works after a page reload, and only one way". One root
cause each, both mine, both invisible to the suite because neither is a decision
the pure functions make.

- **The service worker was cache-first with a hand-bumped constant.** `CACHE`
  was a literal with a comment saying it "has to change whenever the shell
  changes" — and nothing made it change. Every deploy left the browser running
  the *previous* `app.js` until a manual reload, so #6's polling appeared absent.
  **A design that depends on remembering to bump a literal is a design that
  fails.** Now network-first with cache fallback: the cache exists so the app
  opens offline, not so it can serve last week's code. Correctness no longer
  depends on the constant at all.
- **The poll tier was measured from the last *edit*.** A tab opened but not typed
  in had no edit to measure from, landed in the 60s tier, and looked broken next
  to the device being typed on — which reads exactly as "syncs one way". Now
  measured from **activity**: an edit, a page load, or the window regaining focus.
  Opening a document is an act of attention. The backoff still applies two minutes
  later.

The budget test was also modelling the wrong day — it counted one editing session
and ignored that every refocus restarts the fast tier, reporting roughly half the
real traffic. Corrected to 30 bursts/day: ~3,450 per device, ~10,350 across three,
against a 100k ceiling. **A budget test that models the wrong usage pattern is
worse than none, because it reads as headroom that is not there.**

**Watch for:** this phase contains the only catastrophic data-loss path in the
product. The two-device test is not optional and cannot be replaced by a unit
test.

---

## Phase 6 — Revisions and coalescing

**Spec:** §3 · **Size:** 1 day · **Depends:** P1

**Done when:**
- [x] A save within 10 minutes of the newest **unsealed** revision updates it in place
- [x] Otherwise inserts a new revision
- [x] Sealed revisions are never coalesced into
- [x] Full snapshots, not diffs
- [x] Tested at the boundary — 9 minutes coalesces, 11 does not

**Decided during implementation:**

- **A revision snapshots the state *after* the write.** `version` is the version
  the body became, so the log answers "what did the document look like at version
  N" and the live row is simply the newest such state.
- **Migration 0002 seeds a baseline revision from the current document, sealed.**
  Without it, the one state never recoverable from the log is the state at the
  moment the log was introduced — the first write after this ships snapshots its
  own result. Sealed because an unsealed baseline would be coalesced into by the
  very next save and lose exactly what it exists to preserve. Additive-only; the
  deployed Worker does not read this table, so the migrate→deploy gap is
  uneventful.
- **`created_at` is not bumped on coalesce.** The window runs from when the burst
  started, not the last keystroke — otherwise continuous typing holds one revision
  open indefinitely and the log never gains an entry. Pinned by a test.
- **The window boundary is exclusive**: ten minutes on the nose inserts. Either
  choice is defensible; the test exists so it is not accidental.
- **The revision write follows the CAS, never batched with it.** D1's `batch` is a
  transaction but not a *conditional* one — the revision would apply even when the
  UPDATE matched zero rows, recording a state that never existed. The cost is a
  torn write if D1 fails between the two, which surfaces as a 500 rather than a
  silent gap.
- **`is_sealed = 0` lives in the WHERE clause**, not in a caller's check — the
  same shape as session expiry in P2, and for the same reason.

**Applied to dev 2026-08-15.** The baseline captured version 5 (45 bytes), sealed.
`make backup ENV=dev` first, then migrate, then deploy — the ADR-002 order, run for
real rather than rehearsed.

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

Split into three issues, as anticipated below.

**#9 — rows and checkboxes:**
- [x] Rows render from blocks: checkbox, text, fence-as-one-row, blank
- [x] `- [x]` rows render checked, struck through, dimmed
- [x] Checked items stay in place — no auto-sink
- [x] Toggling rewrites `[ ]`↔`[x]` in place and saves immediately
- [x] Toggle to raw view, persisted per device in `localStorage`

**#10 — tap-to-edit:**
- [x] Tapping row text becomes a single-line `<input>`
- [x] Commits on blur or Enter; Escape reverts without saving
- [x] Rebuilds only the one block; every other block keeps its `raw` verbatim
- [x] Editing a checkbox row preserves indent, marker, and check state

**#11 — copy, linkify, 380px polish:**
- [x] Per-row copy button using `navigator.clipboard.writeText`
- [x] Copy strips the `- [ ] ` prefix; a fenced block copies whole
- [x] URLs linkified anywhere in a row, opening in a new tab
- [x] Usable at 380px — grip and copy 28px fixed, text flexes
- [x] Long text truncates with ellipsis rather than wrapping
- [x] Clear-completed button in the footer (done in #12)

**Decided during #11:**

- 🔴 **`linkify` returns segments, never markup.** The obvious implementation
  replaces matches with an `<a>` string and assigns `innerHTML`, which makes every
  note an injection vector — and this document is written by an agent as well as by
  a human. The caller builds real nodes and sets `textContent` per segment.
- 🔴 **`http`/`https` only.** `javascript:`, `data:`, `vbscript:` and `file:` stay
  plain text. Widening the pattern to any scheme immediately reds that test.
- **Segments must concatenate back to the input exactly**, asserted as a property
  over arbitrary text and over generated URL-bearing text. A linkifier that eats or
  trims one character makes the row display something the document does not contain.
- **Trailing punctuation comes off the link; a closing bracket only if nothing
  opened it.** `https://…/Foo_(bar)` keeps its paren — dropping it links to the
  wrong page — while `(https://…)` does not.
- **Tapping a link navigates rather than opening the editor.** A row that is nothing
  but a URL can therefore only be edited from raw view, which is the right trade: a
  bare URL row is a bookmark, not prose.
- **The grip ships here, inert.** #13 wires SortableJS to it. Building the row
  layout once rather than twice is why the four targets land together.
- **Blank rows get a grip too.** They are blocks and they reorder like blocks —
  spacing that cannot be moved is spacing that fights you.
- **Truncate rather than wrap.** A wrapping row stops the list being scannable, and
  the full text is one tap away in the editor and always present in raw view — so
  nothing is hidden, only deferred. **This is the most likely thing in the UI to be
  wrong for real use; it is a deliberate spec §7 call, not an accident.**
- **A failed copy says so on the button.** `navigator.clipboard` rejects outside a
  secure context or an untrusted gesture, and a copy that silently does nothing is
  discovered at paste time.

**Decided during #10:**

- **`Block` gained a `box` field** — the literal `" "`, `"x"` or `"X"`. Rebuilding
  from `checked` alone would normalize `[X]` to `[x]` **every time someone fixed a
  typo in the text beside it**: a silent rewrite of a line the user did not touch.
- **`setText` returns a raw line, not a `Block`.** The caller serializes and
  reparses, and the reparse decides the new kind — typing `- [ ] ` in front of a
  plain line makes it a checkbox, emptying a line makes it blank. Returning a
  `Block` would mean guessing the kind here and being wrong somewhere.
- **Fences are not tap-editable.** They span lines and a single-line field would
  flatten them; `setText` throws rather than accepting one. Raw view owns multi-line.
- **The trailing `\r` is stripped for display and re-appended on commit.** It is
  invisible in an input but present, so it would be edited by accident.
- **The commit path reparses instead of reusing the block captured on tap.** A
  remote update can land while the field is open, and editing a stale block writes
  back a line from a document that no longer exists.
- **Opening the editor sets `focused`**, so the dirty guard blocks a poll from
  repainting the row list and destroying the field under the cursor.
- **An edit that changes nothing repaints and saves nothing** — tapping a row and
  pressing Enter is a no-op, asserted as a property over arbitrary documents.

**Decided during #9:**

- 🔴 **One row per block, always — the mapping is the identity function.** The
  tidier-looking version filters blank blocks out, which makes a row's position
  stop matching its block index. Everything downstream indexes by position: tap
  row 4, toggle block 4. With blanks skipped those are different lines and the app
  silently edits the wrong one. Blanks render as thin spacers instead, which also
  keeps them draggable so spacing survives a reorder. **This is the parser's "rows
  are not lines" problem one layer up.**
- **I miscounted a block index by hand three times while writing tests for this**,
  which is the argument for the identity mapping rather than against it. A property
  test now asserts `row.index === position` and that `blocks[row.index].kind`
  matches, over arbitrary documents.
- **`body` is the single source of truth for both views.** The textarea holds it in
  raw view and the rows derive from it in list view, but neither is authoritative —
  otherwise the two drift and a view switch saves whichever happened to be stale.
  `save()` sends `body`, never `editor.value`.
- **`textContent`, never `innerHTML`.** The document is authored by a human *and*
  by an agent; one `<img onerror>` in a note would otherwise execute.
- **A toggle saves immediately, not on the debounce.** It is a complete intent, and
  spec §6 lists it alongside reorder and clear.
- **`readView` catches rather than checks.** Safari *throws* from `localStorage`
  when storage is blocked — private browsing, or an evicted PWA — and an uncaught
  throw during boot blanks the whole app. Tested against a storage that throws.
- **An out-of-range or non-checkbox index repaints instead of guessing.** The box
  has already flipped visually, and leaving it flipped would show a state the
  document does not have.

---

## Phase 9 — Clear completed

**Spec:** §5, §14.2 · **Size:** half a day · **Depends:** P6, P7

**Done when:**
- [x] Seals the newest revision, inserts a `clear_completed` revision with the pre-clear body, writes `cleared_items`, then updates `documents` — **in one D1 batch**
- [x] Removes only blocks where `kind === 'checkbox' && checked`, at any indentation
- [x] Returns `{ version, cleared_count }`
- [x] Footer button; confirms only above ~10 blocks

**Watch for:** a partial clear that seals a revision but loses the `cleared_items`
write is worse than no clear at all. Test the ordering, not just the result.

**Decided during implementation:**

- 🔴 **Every statement carries the same `version = ?` guard, and the CAS is last.**
  D1's `batch()` is a transaction but not a *conditional* one, so a mismatched
  `base_version` would still seal a revision and write `cleared_items` for a sweep
  that never happened — the authoritative done-record claiming items were finished
  while they sit unchecked in the document. Guarding every statement on the
  pre-clear version fixes it: statements 1–3 do not touch `version`, so all four
  observe the same value, and nothing can interleave inside a transaction.
- 🔴 **`last_insert_rowid()` does not work inside a D1 batch.** It does not observe
  an INSERT from an earlier statement in the same batch — it returned a revision id
  from a *previous request*, silently pointing every cleared item at the wrong row.
  Rows from the earlier statement *are* visible to a subquery, so `(SELECT max(id)
  FROM revisions)` resolves correctly. Caught by asserting the foreign key rather
  than the row count.
- **The `clear_completed` revision is sealed too.** It is the newest revision after
  the batch, and an unsealed one would be coalesced into by the next save inside the
  ten-minute window — overwriting the pre-clear body it exists to preserve.
- **Nothing to clear is a 200 with `cleared_count: 0`.** The caller asked for the
  checked items to be gone and they are; bumping a version for a no-op would also
  invalidate every other client's `base_version` for nothing.
- **The parse lives in the route, the ordering in the store.** The store owns SQL,
  the route owns what "completed" means.
- **The client never computes the post-clear body.** It asks the server and re-reads.
  Two implementations of "what counts as completed" is the same mistake as two
  parsers.
- **The clear button is hidden in raw view** — raw is the escape hatch for bulk
  edits, and sweeping from it would act on a document being rewritten by hand.

**On testing the guard:** the early `base_version` check catches every stale request
before the batch, which also hid the per-statement guard from every test. Neutering
the guard left all 14 tests green. The path that reaches it is **two concurrent
clears against the same base version** — a clear racing a *write* leaves which call
loses up to the scheduler, so the loser's side effects only get inspected on some
runs. With the guard neutered that test now shows 4 `cleared_items` instead of 2:
a complete phantom sweep.

---

## Phase 10 — Drag reorder

**Spec:** §7 · **Size:** half a day · **Depends:** P8

**Done when:**
- [x] SortableJS **pinned**, not from a CDN — as an npm dependency, see below
- [x] `handle: '.grip'` — the grip is the only drag initiator
- [x] Operates on the **block** array; a fence moves as one unit
- [x] Blank lines survive a reorder
- [x] Saves immediately on drop

**Decided during implementation:**

- **SortableJS is a pinned npm dependency bundled by esbuild, not a committed
  `public/vendor/sortable.min.js`.** A deviation from the spec's letter, taken for
  its own stated reason: the rule exists so the service worker's shell promise
  stays true, and bundling satisfies that as completely — the library ends up
  inside `app.js`, already in the shell cache. What the committed blob lacks is an
  **integrity hash and anything that can audit it**; `pnpm-lock.yaml` has both. And
  "prefer the boring tool" points at npm, since hand-copying a minified file into
  the repo is the unusual move. Spec §7 amended.
- 🔴 **`pnpm build` now minifies.** Bundling SortableJS unminified took the shell
  from 17kB to 97kB. It was never minified — that simply did not matter until the
  first real dependency arrived. 45.9kB now, and the free tier is a design input.
- **`onEnd` reparses and reorders the block array rather than reading the DOM.**
  The library has already rearranged the rows; trusting that as the new truth would
  mean the document is defined by whatever the drag left behind.
- **Out-of-range indices are a no-op, not a throw.** The caller is a drag library
  reporting DOM positions, and a repaint racing a drop should do nothing rather
  than raise inside an event handler.
- **`delayOnTouchOnly`** — touch needs a moment to distinguish a drag from a
  scroll; a mouse does not, and adding the delay there just feels broken.
- **A reorder is a permutation and nothing else**, asserted as a property: the
  multiset of `raw` values is identical before and after, and moving a block back
  reproduces the document byte for byte.

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
