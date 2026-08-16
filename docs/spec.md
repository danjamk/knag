# knag — Build Spec

*Single live document, multi-device, agent-readable/writable.*

**Name:** *knag* — archaic, a peg driven into a wall to hang things on. Also
reads as "nag." Both meanings are the product. Repo `danjamk/knag`.

> **Status.** Functional intent is settled. The technical choices in §2 and §§13–15
> were revised against `~/yukon/claude-shared/docs/standards/` — see
> [§16 Deltas](#16-deltas-from-the-original-draft) for what changed and why.

---

## 1. What this is

One plain-text document. Always live. Edited from any device. The agent reads
and writes it as though it were Dan. A change log captures what appeared and
what disappeared, so the document can be swept clean without losing the record.

It replaces the legal pad when Dan is away from his desk. It is not a note
system, not a task manager, and not a second brain.

### Principles

1. **One document.** No days, no rollover, no multiple notes.
2. **No required structure.** Checkbox syntax is the one optional convention.
3. **Nothing is normalized.** Bytes in, bytes out. Indentation and blank lines
   preserved exactly.
4. **Deletion is not loss.** The log holds everything.
5. **The brain is not involved.** No reads from it, no writes to it. (See §11.)

---

## 2. Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Storage | D1 |
| Language | TypeScript everywhere — Worker and client |
| Client | PWA served from Workers Static Assets |
| Client build | `esbuild` → `public/app.js`. One command, no framework. |
| Drag | SortableJS, **vendored and pinned**, not CDN |
| Agent | MCP server, same Worker, `/mcp` |
| Auth | Shared passphrase → long-lived session cookie, or bearer token |
| Package manager | pnpm |
| Tests | vitest + `@cloudflare/vitest-pool-workers` against real D1 |

No framework. One `worker/wrangler.jsonc`, one Worker entry, one `index.html`.

### Why TypeScript and a build step, when the draft said neither

The draft's instinct — no framework, no ceremony — is right and is preserved.
But "no build step" had a consequence it didn't account for:

**The block parser (§14.1) is needed on both sides.** The server needs it for
`clear-completed`, which removes `- [x]` blocks. The client needs it to render
rows. With no build step there is no way to share a module between a TypeScript
Worker and a plain-JS page, so the parser gets written twice — two
implementations of a byte-preservation contract that must agree forever, by
hand. That is the single most likely path to a corrupted document, and the
round-trip test in §14.1 will not catch it: each parser passes its own test
while disagreeing with the other.

So: `worker/src/blocks.ts` exists exactly once. The client imports it.
`esbuild` bundles `client/src/app.ts` → `public/app.js`. That is the entire
build: one command, one dev dependency, no framework, no config file. Wrangler
already compiles the Worker's TypeScript, so the deploy path is unchanged.

TypeScript throughout is the house standard
([node.md](../../claude-shared/docs/standards/node.md)) and `pnpm check`
(typecheck + test) is the pre-PR gate and exactly what CI runs.

---

## 3. Data model

Naming follows
[database-conventions](../../claude-shared/docs/guides/database-conventions.md):
plural tables, `is_` boolean prefix, `_at` timestamps, `idx_{table}_{column}`.

```sql
-- Live state. Exactly one row.
CREATE TABLE documents (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  body       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,   -- ISO8601 UTC
  source     TEXT    NOT NULL    -- 'pwa' | 'agent' | 'system'
);

-- Append-only history, coalesced.
CREATE TABLE revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  body       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  created_at TEXT    NOT NULL,
  is_sealed  INTEGER NOT NULL DEFAULT 0,
  source     TEXT    NOT NULL,
  event_type TEXT                 -- NULL | 'clear_completed'
);

-- Explicit record of swept items, so "what did I finish" is a lookup.
CREATE TABLE cleared_items (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES revisions(id),
  line_text   TEXT    NOT NULL,
  cleared_at  TEXT    NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,  -- SHA-256 of the cookie value
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  device_label TEXT               -- 'iphone', 'ipad', 'mac' — set at login
);

CREATE INDEX idx_revisions_created_at ON revisions(created_at);
CREATE INDEX idx_cleared_items_cleared_at ON cleared_items(cleared_at);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

### Coalescing rule

On every save that changes `body`:

- If the newest revision is `is_sealed = 0` **and** `created_at` is within
  **10 minutes**, `UPDATE` it in place.
- Otherwise `INSERT` a new revision.

Full snapshots, not diffs. The document is a few KB; diffs are computed at read
time. Worst case ~6 revisions/hour.

### One chokepoint for all SQL

**No SQL outside `worker/src/store.ts`.** The single-row id is a `DOC_ID`
constant in that file, not a literal `1` scattered across handlers.

This is not abstraction for its own sake — it is the specific thing that makes
a future multi-user schema a one-file change rather than a rewrite (§17).
Deliberately **not** done now: `owner_id` columns. That would be building for a
future that may never arrive; the chokepoint makes adding them cheap if it does.

---

## 4. Auth

Single user. Do not build email infrastructure for this.

- `KNAG_PASSPHRASE` in Worker secrets. Long, random, stored in 1Password.
- Login screen: one field. On match, mint 32 bytes of random, store the SHA-256
  in `sessions`, set the raw value as a cookie.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=31536000`.
- **Server-set only.** Safari ITP caps client-set cookies at 7 days of
  inactivity; server-set `Set-Cookie` is exempt. Getting this wrong means
  re-authenticating weekly, which kills the whole thing.
- Optional `device_label` field at login so sessions are identifiable later.

**Agent path is separate.** `KNAG_BEARER_TOKEN` secret, checked as
`Authorization: Bearer <token>` on `/api/*` and `/mcp`. Different credential,
different lifecycle, revocable independently.

> A home-screen PWA on iOS has its own cookie jar, separate from Safari. The
> passphrase approach works because login happens inside the PWA. This is why
> magic links were rejected — the link opens in Safari and authenticates the
> wrong jar.

Cloudflare Access is the house default for a Worker
([cloudflare.md](../../claude-shared/docs/standards/cloudflare.md)) and is
wrong here. See [ADR-001](adr/ADR-001-passphrase-auth.md).

### 4.1 One authenticate(), returning a principal

```ts
type Principal = { id: string; source: 'session' | 'bearer' };
function authenticate(request: Request, env: Env): Promise<Principal | null>;
```

**Every route calls this and keys off `principal.id`.** No handler ever asks
"was the passphrase right." Today `id` is always `'dan'`; that is fine and it is
the point — replacing the credential scheme touches one file (§17).

**Bearer is first-class on every `/api/*` route, not an agent afterthought.** A
native wrapper (§17) authenticates from the Keychain with a header, not a
cookie. Cookie-only must never creep into a route.

### 4.2 Hardening the draft omitted

A single passphrase field on a public URL is brute-forceable, and the draft had
no answer for it.

- **Constant-time compare** for both passphrase and bearer. Hash both sides
  with SHA-256, then `crypto.subtle.timingSafeEqual` on the digests. Never `===`.
- **Rate-limit `POST /api/login`** — one Cloudflare WAF rate-limiting rule
  (the free tier includes one). Configured out of band; recorded in the README.
- **Sweep expired sessions on login.** `DELETE FROM sessions WHERE expires_at <
  ?` — one statement, no cron trigger.
- **Login failures return 401 with no detail** and are logged with the source IP.

---

## 5. API

All routes accept either the session cookie or the bearer token, resolved
through `authenticate()` (§4.1).

### `GET /health`

Unauthenticated. Returns `{ ok: true, version: "<semver>+<shortsha>" }` and
nothing about the document. Baked at deploy from `package.json` + git, so
`make health` can assert that what is live matches this checkout — the one
check that catches "deployed from the wrong branch."

### `POST /api/login`
```json
{ "passphrase": "...", "device_label": "iphone" }
```
The one unauthenticated `/api/*` route, necessarily — it is how a principal comes
into existence. On match: 200 `{ ok: true }` and a **server-set** `Set-Cookie`
(§4). `device_label` is optional and truncated at 64 characters.

Every failure — wrong passphrase, missing field, wrong type, malformed body —
returns the **same opaque 401** with the same body, and sets no cookie. The
reason is logged with the source IP, never returned. A `GET` is **405**, not a
failed login.

**`Secure` is set on every cookie except over plain `http:` on `localhost` /
`127.0.0.1`.** Safari refuses to store a `Secure` cookie there and `wrangler dev`
serves exactly that, so the exception is what makes the PWA developable locally
on the browser it targets. It is unreachable in any deployed environment —
Cloudflare terminates TLS, so a deployed request is never `http:`.

### `GET /api/doc`
```json
{ "body": "...", "version": 42, "updated_at": "2026-08-14T15:04:05Z" }
```
Sets `ETag: "<version>"`. Honours `If-None-Match` with **304** and empty body.

### `PUT /api/doc`
```json
{ "body": "...", "base_version": 42 }
```
- `base_version === documents.version` → apply, bump version, return
  `{ version, updated_at }` and the new `ETag`.
- Mismatch → **409** with the current `{ body, version, updated_at }`. Caller
  reloads. Never merge, never overwrite.
- No-op writes (body identical) bump nothing, touch `updated_at` not at all, and
  create no revision. The response is an ordinary 200 reporting the unchanged
  version — the caller's question is "what version am I on", and the answer does
  not depend on whether anything moved.
- `base_version: 0` is honoured against a missing **or empty** row (§14.5) and is
  a conflict against anything else.
- Rejected with **400**: a non-JSON body, a `body` that is not a string, a
  `base_version` that is not a non-negative integer. **413** past 1 MiB — roughly
  200× the expected document, and cheaper than discovering the limit at D1.

**`source` is not a request field.** An earlier draft of this section had the
caller declare it. It carries nothing the server does not already know — bearer
*is* `agent`, session *is* `pwa` — while handing a caller unvalidated text
headed for the only copy of the document. It is derived from `principal.source`
(§4.1); a `source` key in the request body is ignored.

### `POST /api/doc/clear-completed`
```json
{ "base_version": 42 }
```
Order of operations matters:
1. Seal the newest revision (`is_sealed = 1`) so the pre-clear state can't be
   swallowed by the coalescing window.
2. Insert a revision with `event_type = 'clear_completed'` holding the pre-clear body.
3. Write the removed lines into `cleared_items`.
4. Remove all blocks where `kind === 'checkbox' && checked === true` and update
   `documents`.

Returns `{ version, cleared_count }`.

Steps 1–4 run in a single D1 batch. A partial clear that seals a revision but
loses the `cleared_items` write is worse than no clear.

### `GET /api/history?since=&until=`
Returns revisions in range plus derived, per adjacent pair:
- `appeared`: lines in *n+1* not in *n*
- `disappeared`: lines in *n* not in *n+1*

Plus all `cleared_items` in range, which are the authoritative "done" record.
Line-set diff, not character diff. Trivial to implement, sufficient in practice.

```json
{
  "timezone": "America/Chicago",
  "since": "2026-03-08T06:00:00.000Z",
  "until": "2026-03-09T05:00:00.000Z",
  "truncated": false,
  "days": [
    { "date": "2026-03-08",
      "revisions": [
        { "id": 12, "version": 40, "created_at": "2026-03-08T13:00:00.000Z",
          "local_time": "08:00", "source": "pwa", "event_type": null,
          "appeared": ["- [ ] call the bank"], "disappeared": [],
          "cleared_count": 0 }
      ],
      "cleared": [
        { "id": 3, "revision_id": 12, "line_text": "- [x] laundry",
          "cleared_at": "2026-03-08T22:00:00.000Z", "local_time": "17:00" }
      ] }
  ]
}
```

Both parameters take a **bare date** (`2026-03-08`, resolved to local midnight in
`KNAG_TZ` per §14.3) or a **full ISO instant**. Defaults are the last seven days
to now. Malformed values and an inverted range are **400**, never an empty
result — an empty answer to a typo is indistinguishable from a quiet week.

Four things are decided rather than obvious:

- **`until` from a bare date is the *next* local midnight**, so a range is
  half-open and `since=X&until=X` returns X. The alternative makes the query a
  human actually types return nothing.
- **The first revision in range diffs against the last revision before it.** That
  row is read and never returned. Without it every range opens by reporting the
  whole document as `appeared`.
- **Bodies are never returned.** The response grows with what happened, not with
  the document.
- **A `clear_completed` entry has an empty diff by construction** — it snapshots
  the *pre*-clear body, identical to the revision before it (§14.2), and the
  swept body enters the log on the next ordinary save. `cleared_count` and the
  day's `cleared` rows are the record of what was finished; the diff is not, and
  §5 already says so.

Capped at 500 revisions per request, **keeping the newest**, with `truncated`
saying when the cap bit. `cleared_items` are uncapped — they are single lines.

Day grouping and both boundaries are local (§14.3). No parameter overrides the
zone: knag has one user in one place, and a second opinion about what "Tuesday"
means is how the same question starts having two answers.

---

## 6. Sync

Polling. No WebSockets.

- `GET /api/doc` every **4s** while `document.visibilityState === 'visible'`,
  subject to the adaptive backoff in §14.4.
- Immediate refetch on `visibilitychange` → visible, and on `window.focus`.
- Stop polling when hidden.

### Two rules that prevent the only real bugs

**Never apply a remote update while the editor is dirty or focused.** Queue it,
apply on blur. A cursor that jumps mid-keystroke is how an app gets abandoned.

**Always send `base_version`.** The failure mode this prevents: an iPad left
open for three days, typed into, saving a stale body over a week of work. This
is the one catastrophic data-loss path and it costs ten lines to close.

### Save triggers
- 800ms debounce after typing stops
- Immediately on blur
- Immediately on checkbox toggle, reorder, or clear

---

## 7. Client — list view (default)

Parse `body` into blocks (§14.1). Render each block by kind:

| Block | Rendering |
|---|---|
| `- [ ] text` | Checkbox (unchecked) + text |
| `- [x] text` | Checkbox (checked) + text, strikethrough, dimmed |
| ` ``` ` fenced block | **One row**, monospace, whole block, single copy button |
| Anything else | Plain text |
| `http(s)://…` anywhere | Linkified, opens in new tab |

**Checked items stay in place.** No auto-sink.

### Row anatomy, left to right
1. **Checkbox** — only if the block is a checkbox. Toggling rewrites
   `[ ]`↔`[x]` in place and saves.
2. **Text** — a **live input**, always editable. Not tap-to-activate.
3. **Copy button** — reorder mode only. Strips the `- [ ] ` prefix, and copies a
   fenced block whole. Those two are what it adds over the OS: long-press,
   Select All, Copy already works in any text field, so a permanent control on
   every row bought density and nothing else.

At 380px this is two targets in one row: the checkbox and the text, which takes
everything else. Copy moved into reorder mode (below) — it is a whole-row
operation, and a control on every line forever is what made the list feel
dense in use.

**Long rows wrap; they do not truncate.** An earlier draft truncated with an
ellipsis, on the reasoning that a wrapping row stops the list being scannable
and the full text is one tap away. Measured against real use, that trade is
wrong: a note reading `buy milk and also remember to…` with no way to read it
is worse than a taller row.

The row editor is therefore an auto-growing `<textarea rows="1">`, not an
`<input>` — an input is single-line by construction and cannot wrap at any
price. One row still means one block: `Enter` is intercepted and splits, and
only a *fence* textarea takes a literal newline. The textarea is there purely so
the text can wrap.

The **grip is not here** — reordering lives behind an explicit mode (below),
because a drag handle competing for the same touch as an always-live text field
is worse than one competing with a tap target. See
[ADR-003](adr/ADR-003-single-mode-editor.md).

### One mode: typing

**The editor is where you land, always.** Every text and checkbox row is a live
input, so checkboxes stay visible and tappable while you type. Row boundaries
behave like line boundaries:

| Key | Behavior |
|---|---|
| `Enter` at end of row | new empty row below, focused |
| `Enter` mid-row | split the block in two |
| `Backspace` at position 0 | merge into the previous row, caret at the join |
| `↑` / `↓` at the boundary | move focus between rows |

**Fenced blocks are an inline `<textarea>`** — one block, natively multi-line,
and the reason raw view is no longer required for anything.

An earlier draft of this section argued the opposite, on the grounds that a
multi-line row editor is "a day of fiddly work and the source of every cursor
bug." That is still true. It is accepted because the alternative — asking which
view you are in, every time the app opens — was measured against real use and
lost. The product is a legal pad, and a legal pad has no modes.
[ADR-003](adr/ADR-003-single-mode-editor.md) records the reversal.

### Checkbox shorthand

`--` followed by a space rewrites the line prefix to `- [ ] `. `Backspace`
immediately afterwards reverts it — the standard autoformat contract, and the
reason converting on space is safe rather than merely fast.

**A single `- ` stays a literal dash.** Rendering it as a bullet would be the
first place in knag where the display differs from the bytes, and principle 3
has held absolutely. The gain is cosmetic; the precedent is not.

### Spellcheck and autocorrect

**On** for text and checkbox rows, **off** inside fences.

Autocorrect is the user typing, mediated by their keyboard — principle 3 forbids
*knag* normalizing the document, not the OS keyboard doing what the user expects.
The real risk was only ever autocapitalize mangling `const` inside a code fence,
and one element per block is what makes that distinction possible. This setting
is available *because* of the single-mode redesign, not in spite of it.

### Reorder — an explicit mode

A **reorder button** swaps rows into drag mode: inputs go read-only, grips appear
at a size worth aiming at, and each row gains a **delete** control on the right.
Leaving the mode returns to typing.

A mode rather than an always-on grip because a drag handle competing for the same
touch as an always-live text field is worse than one competing with a tap target
(ADR-003). It is also the common pattern — Reminders, Mail, and every list app
that supports both editing and rearranging.

**Delete lives here**, not in the editor: with live inputs, `Backspace` already
handles joining lines, while nothing else offers a clean gesture for removing a
whole fence or a blank. **It does not confirm** — the revision log is the undo,
which is what principle 4 built it for.

SortableJS bound to the row container, `handle: '.grip'`. On drop, reorder the
**block** array, serialize, save. Fenced blocks move as one unit.

**A pinned npm dependency, bundled by esbuild** — not a CDN, and not a committed
`public/vendor/sortable.min.js` as an earlier draft of this section said.

The reason that draft gave was right and is unchanged: §9 promises the service
worker caches the shell, and a third-party script fetched at runtime makes that
promise false. Bundling satisfies it just as completely — the library ends up
inside `app.js`, which is already in the shell cache — while a committed minified
blob has one disadvantage the lockfile does not: **no integrity hash and nothing
that can audit it.** `pnpm-lock.yaml` pins the version and its checksum, and
ordinary dependency tooling can see it.

"Prefer the boring tool" points the same way. npm *is* the boring tool for a
JavaScript dependency; hand-copying a minified file into the repo is the unusual
move, and it is the same trust decision made once with less machinery around it.

Bundling SortableJS is also why `pnpm build` minifies: unminified it takes the
shell from 17kB to 97kB, and the free tier is a design input (§14.4).

### Clear completed
Single button, footer. Confirm only if clearing more than ~10 blocks.

---

## 8. Client — raw view, the escape hatch

Full-bleed monospace `<textarea>`. The entire document, unmodified. For sweeps,
bulk paste, multi-row selection, and anything the row model can't express.

**Not a peer of the editor.** An earlier draft made the two co-equal with a
toggle between them, and that mode question turned out to be the product's worst
UX problem — see [ADR-003](adr/ADR-003-single-mode-editor.md). The editor is
where you land, always; raw is somewhere you go and come back from.

It is kept rather than deleted because it is already built and tested, and it is
the honest fallback the day the row model meets something awkward. **If it starts
being used daily rather than rarely, the row model is the wrong shape** — that is
ADR-003's revisit trigger, not a reason to patch.

**Raw view must round-trip byte-for-byte.** No trimming, no whitespace
normalization, no line-ending rewriting. Code pasted in comes out identical.

---

## 9. PWA shell

Served from **Workers Static Assets** (`assets` binding in `wrangler.jsonc`),
with `run_worker_first` for `/api/*` and `/mcp`. The shell is real files in
`public/`, not template literals inside a TypeScript module.

`public/manifest.json`:
- `"display": "standalone"`
- `"theme_color"` matching the app background so iOS status bar doesn't clash
- 192px and 512px icons

Add to Home Screen on iPhone/iPad, Add to Dock on macOS Safari. No Electron —
it doesn't run on iPad regardless (iOS mandates WebKit), and the only thing it
would buy on the Mac is a global capture hotkey. Deferred.

Service worker: **network-first for the shell**, and never a document response. A
stale cached body is worse than an offline error, because it looks like the truth
and the next save would carry a `base_version` from a document that has moved on.
Offline editing is explicitly out of scope, so the cache exists to make the app
open when the network is gone — not to serve last week's code. An earlier draft
was cache-first against a hand-bumped constant; nothing made the constant change,
and every deploy served the previous bundle until a manual reload.

### Offline state

Offline **editing** is out (§12) and stays out — a queue of local edits against a
document that moved on is the one data-loss path this whole design avoids.

Offline **state** is in, and the distinction matters. Today the app fails
silently when the network goes: the poll errors into nothing and a save errors
into nothing, so the page looks live and is not. That is the worst of the three
possible behaviours. The page should say `offline` in the machine voice, hold
rows read-only, and resume on reconnect without a reload.

Refusing to edit is a stated decision, not a limitation being hidden.

### Theme

**Light, dark, or system**, persisted per device in `localStorage` alongside the
raw-view preference — UI state, not document state.

`prefers-color-scheme` is the default. The MVP hard-coded dark, which is the
right default and the wrong only option: knag gets opened outdoors and in
meetings, and a fixed dark surface is unreadable in the first and conspicuous in
the second.

---

## 10. MCP tools

Built against
[claude-shared/docs/standards/mcp.md](../../claude-shared/docs/standards/mcp.md)
— read it before step 10, not after. knag sits at the simple end of that
standard: bearer auth rather than OAuth 2.1 (single operator, no third-party
client, no consent screen), and no Resources. The rules that still apply in full
are §2 request isolation, §3 tool design, §4 annotations, §5 server instructions,
§6 structured output, and §9 security.

Mounted at `/mcp`, bearer-authenticated.

| Tool | Signature | Notes |
|---|---|---|
| `knag_read` | `() → { body, version, updated_at }` | |
| `knag_write` | `(body, base_version) → { version }` | Full replacement. 409 on mismatch. |
| `knag_clear` | `(base_version) → { version, cleared_count }` | Same path as the button. |
| `knag_history` | `(since?, until?) → revisions[], cleared[]` | With appeared/disappeared. |

One write tool, not three. The document is small enough that read-modify-write
is cheaper than inventing append/patch/delete semantics, and it covers every
case — add, check off, surgical delete, total sweep — identically.

### Agent contract

**Byte-preserve every line not explicitly targeted.** Whole-document write is a
loaded gun; the standing rule for Dan's prose applies here too. Surgical edits
only, nothing else touched.

**Always read immediately before writing.** Never write from a body carried over
from earlier in a conversation.

**Report the diff in chat** after every write — added, removed, changed. Dan
sees what moved without opening knag.

**On 409, re-read and re-apply the intent** — do not retry with the stale body.

---

## 11. Brain sync — deferred

Explicitly out of MVP. The original motivation (knag content flowing into
`daily/` notes) still stands, but it's a separate decision and knag works
without it.

If built later: a launchd job on the Mac, every 15 minutes, one direction only
(knag → brain), writing into a `## knag` section that nothing else touches. The
Worker never touches `danjamk/brain`. knag is the write-ahead log, brain is the
durable store, content flows one way. Anything bidirectional is a sync engine
and is not worth it.

---

## 12. Scope

**In:** one live document · optimistic concurrency · polled sync · passphrase
auth · one typing-first editor with live checkbox rows · `--` shorthand · raw
view as an escape hatch · per-row copy · linkify · fenced block grouping ·
reorder mode with delete · clear completed · coalesced revision log · history
diff · 4 MCP tools · PWA manifest · light/dark/system theme

**Out:** search · tags · multiple documents · attachments · offline editing ·
WebSockets · Electron · native apps · email auth · multi-user · sharing ·
brain reads or writes · rollover · day boundaries · rich formatting

If a weekend turns into two, something from the second list came back.

Two entries have since been argued properly rather than merely listed:

- **rich formatting** — [ADR-004](adr/ADR-004-display-matches-the-bytes.md). The
  rule is that the display never diverges from the bytes; no rendered bold,
  italic or headings. Indentation was never covered by this and already works.
- **offline editing** — still out, but the *state* is in (§9). Failing silently
  while offline is a bug; refusing to edit and saying so is the decision.

---

## 13. Build order

0. **Scaffold.** Repo wiring, `wrangler.jsonc`, migrations, Makefile, CI,
   `pnpm check` green. *(Done.)*
1. **Worker + D1 + `GET`/`PUT /api/doc` with version checking.** Curl it. The
   concurrency semantics are the foundation; get them right before any UI.
   Includes first-boot seeding (§14.5) and `store.ts` as the only SQL.
2. **Auth.** Passphrase → cookie, `authenticate()` per §4.1, hardening per §4.2.
   Verify the cookie survives a week of iOS inactivity before building on it.
   Its tests live in the `test:security` script.
3. **Raw view PWA.** A textarea and a save. At this point it's already useful
   and already replaces Keep for the transfer use case.
4. **Polling + dirty-guard.** Adaptive interval and ETag per §14.4. Test
   explicitly: two devices, one left open overnight, confirm the 409 path.
5. **Revisions + coalescing.** Backfill from step 1 onward.
6. **Block parser (§14.1) with round-trip test passing before any UI uses it.**
7. **List view.** Rows, checkboxes (§14.2), tap-to-edit, copy buttons, linkify.
8. **Clear completed + `cleared_items`.**
9. **Drag reorder.** Operates on blocks, not lines.
10. **MCP server.** Four tools, bearer auth, streamable HTTP (§14.6).
11. **`/api/history` + diff.** Timezone-aware per §14.3.

Steps 1–4 are the weekend. Everything after is incremental and independently
useful.

---

## 14. Resolved details

These were open questions. They are decided here so Claude Code doesn't guess.
The first two cause silent data corruption if implemented naively.

### 14.1 Block model — rows are not lines

**Rows in list view map to *blocks*, not to lines.** A fenced code block is one
row spanning many lines. Any implementation that indexes rows directly into the
line array will scramble the document on the first reorder involving a code
block.

Lives in `worker/src/blocks.ts`. **One implementation, imported by both sides**
(§2). Parse `body` into an array of blocks:

```ts
{ kind: 'checkbox' | 'text' | 'fence' | 'blank',
  raw: string,        // exact source lines, joined with \n, unmodified
  startLine: number,
  endLine: number,
  indent: string,     // leading whitespace, checkbox blocks only
  marker: string,     // '-' or '*', checkbox blocks only
  checked: boolean,   // checkbox blocks only
  text: string }      // content after the marker, checkbox blocks only
```

Rules:

- A fence opens at a line whose first non-whitespace is ` ``` ` or `~~~` and
  closes at the next matching fence, **or at end of document** if unclosed. An
  unclosed fence must not swallow the rest of the document into an unreorderable
  blob — treat EOF as a close and mark the block `unterminated: true`.
- Serialization is `blocks.map(b => b.raw).join('\n')`. Never reconstruct a
  block from its parsed fields except the one block being edited.
- Reorder, copy, and drag operate on blocks. Blank lines are blocks too, so
  spacing survives a reorder.
- Round-trip test, run on every parse change: `serialize(parse(x)) === x` for
  arbitrary `x`, including trailing newlines, CRLF, and unclosed fences.
  Property-based over generated inputs, not a handful of examples.

### 14.2 Checkbox grammar

A block is a checkbox if and only if it matches:

```
/^(\s*)([-*])\s\[([ xX])\]\s(.*)$/
```

Consequences, all deliberate:

- **Leading whitespace is captured and preserved verbatim.** Nested items keep
  their indentation through toggle, edit, and reorder. This is required by
  principle 3 in §1.
- Both `-` and `*` are accepted; the original marker is preserved on write.
  Never normalize `*` to `-`.
- `-[ ]` (no space after marker) is **not** a checkbox. Renders as plain text.
- `[x]` and `[X]` both mean checked; preserve the original case on write.
- Toggling rewrites **only** the bracket character. Rebuild the line as
  `indent + marker + ' [' + char + '] ' + text` — do not regex-replace across
  the whole document.
- Trailing whitespace after the text is preserved.

`knag_clear` removes blocks where `kind === 'checkbox' && checked === true`.
Nothing else, regardless of indentation level.

**🔴 Strip the trailing `\r` before applying this grammar, and before the fence
grammar.** `.` does not match `\r` in JavaScript — `\r` is a line terminator — so
`(.*)$` cannot reach past one and **a raw CRLF line fails both grammars
outright**. Every checkbox in a CRLF document parses as `text`, every fence
dissolves into unrelated lines, nothing renders as a checkbox, and
`clear-completed` silently removes nothing.

The round-trip test cannot catch this. `raw` is a verbatim slice whatever the
block's `kind` turns out to be, so serialization stays byte-perfect while
classification is entirely wrong. `blocks.ts` carries the stripped `\r` on the
block as `eol` and `toggle()` puts it back.

### 14.3 Timezone

D1 stores UTC. Dan is America/Chicago. Every history boundary is a local-time
question ("what did I finish Tuesday") and will file items to the wrong day
after ~7pm local if handled in UTC.

- Store `created_at` as ISO8601 UTC with `Z`. Never store local time.
- `KNAG_TZ` var in `wrangler.jsonc`, default `America/Chicago`.
- `knag_history` and `/api/history` accept bare dates (`2026-08-14`) and resolve
  them to local-midnight boundaries in `KNAG_TZ`, converting to UTC for the
  query. Use `Intl.DateTimeFormat` with `timeZone` — it handles DST, manual
  offset arithmetic does not.
- Day grouping in results is by local date, not UTC date.

**`Intl.DateTimeFormat` is not enough on its own**, and this is the part that got
found by writing the tests. It converts an instant *into* a zone; the boundary
question is the other direction — which instant does this zone's clock read as
midnight — and there is no API for that. Subtracting "the" offset requires
knowing the offset, which requires knowing the instant, which is what is being
computed.

So `zonedInstant` in `worker/src/history.ts` is a **fixed point**: probe, guess,
re-probe, settle. Luxon's `fixOffset`, followed rather than reinvented. A single
probe is right for every local midnight in Chicago and wrong by an hour for
03:30 on a spring-forward morning — which is exactly the kind of thing that
ships.

**Where a wall time does not exist, knag takes the later instant; Luxon takes the
earlier.** Chicago transitions at 02:00 so its midnights never hit this, but
America/Santiago springs forward *at* midnight and `KNAG_TZ` is a var. The later
instant is the first moment that exists on the requested date; the earlier one
sits before the date begins and would file the closing hour of the previous day
under this one — this section's own failure, reintroduced at the one boundary a
year nobody would look at.

### 14.4 Polling budget

Workers free tier is 100k requests/day. A 4s poll on one tab left open all day
is ~21.6k. Three devices exceeds the ceiling on polling alone. The free tier is
a design input, not an afterthought.

Adaptive interval:

| Condition | Interval |
|---|---|
| Local edit within last 2 min | 4s |
| Visible, idle 2–15 min | 15s |
| Visible, idle > 15 min | 60s |
| Hidden | stopped |

Always poll immediately on `visibilitychange` → visible and on `window.focus`,
regardless of tier — that's what makes device-switching feel live.

Additionally: `GET /api/doc` returns `ETag: "<version>"` and honours
`If-None-Match` with a **304** and empty body. Unchanged polls stay cheap and
the client skips the dirty-guard path entirely.

Worst realistic case with backoff: ~4k requests/day across all devices. D1's
free tier (5GB, 5M row reads/day) is not the binding constraint; Workers
requests are.

### 14.5 First boot

Nothing seeds `documents`, so every read fails on a fresh deploy.

- Migration inserts `(1, '', 1, <now>, 'system')`.
- `GET /api/doc` treats a missing row as empty body at version 0 rather than
  erroring — defensive, in case the migration is skipped.
- `PUT` with `base_version: 0` against a missing or empty row succeeds and
  initialises it.
- Empty body is a valid state. It is not an error and must not be confused with
  a failed read anywhere in the client.

### 14.6 MCP transport

Full doctrine in
[claude-shared/docs/standards/mcp.md](../../claude-shared/docs/standards/mcp.md).
knag-specific points:

- **Streamable HTTP** at `POST /mcp`. Not SSE. Same pattern as PageVault.
- **A new server instance per request**, never module-scoped. Sharing a server
  or transport across requests can leak one caller's response to another.
- **Do not enforce `Origin` validation as a block.** claude.ai's web app POSTs
  from the browser with `Origin: https://claude.ai`; a 403 there kills the
  tool-list refresh and reads as "server unavailable." pagevault shipped that
  block and reverted it within the hour. Log it if you want telemetry; let token
  verification do the work. (mcp.md §8.)
- Bearer auth via `Authorization` header; return **401** with
  `WWW-Authenticate: Bearer` on failure so the client surfaces a clear error
  rather than a silent empty tool list.
- Tool errors return structured MCP errors, not HTTP 500s. A 409 from the write
  path must reach the agent as a usable message — including the current version
  and body — so it can re-read and re-apply rather than retrying blind.
- Connector config for Claude:

```json
{
  "name": "knag",
  "url": "https://knag.danjamkuhn.com/mcp",
  "headers": { "Authorization": "Bearer ${KNAG_BEARER_TOKEN}" }
}
```

- Health check is the shared `GET /health` (§5), not a separate `/mcp/health`.
  One endpoint, one answer, and `make health` already asserts against it.

---

## 15. Operations, testing, CI

Not in the original draft. Required by
[claude-shared](../../claude-shared/docs/standards/README.md).

### Testing

`@cloudflare/vitest-pool-workers` against Miniflare with a **real D1** and the
real migrations applied. Mocking a binding tests the mock.

| Suite | Covers |
|---|---|
| `worker/test/blocks.test.ts` | Round-trip property test, CRLF, unclosed fences, trailing newlines, checkbox grammar edge cases |
| `worker/test/api.test.ts` | 409 conflict path, no-op writes, first boot, ETag/304 |
| `worker/test/auth.test.ts` | Passphrase, bearer, cookie attributes, timing-safe compare, expired sessions |
| `worker/test/mcp.test.ts` | Tool list, bearer 401, 409 surfaced as a structured error |

`pnpm test:security` runs `auth.test.ts` alone so it can be run in isolation.

### Browser tests

`pnpm test:browser` — Playwright against **WebKit**, in `browser/`. Separate from
`pnpm check` because the browser download is ~80MB; its own CI job.

🔴 **WebKit specifically.** iOS mandates it, so Safari's engine is the one that
has to be right. Chromium would report on a browser knag never runs on.

It covers what the vitest suite structurally cannot reach — rendering, geometry,
visibility, focus, caret — and deliberately **not** logic. The parser, the typing
model and the sync policy are pure functions with their own tests; routing them
through a browser would be slower and no more true.

It exists because three bugs shipped that 263 green unit tests could not see: a
CSS specificity conflict that collapsed every checkbox row's text, a toolbar
control that changed shape after first use, and rows clipped to zero height
because the first paint happened into a hidden container. All three were found by
a human on an iPhone.

The suite runs against `wrangler dev` on `http://localhost`, which also exercises
the one branch no deployment can: the session cookie drops `Secure` on loopback
(§5), and until now nothing tested it.

**`worker/test/setup.ts` resets the bindings and re-applies the migrations before
every test, and that is load-bearing.** vitest-pool-workers dropped the automatic
per-test storage stack in 0.18, so without it each test inherits the previous
one's document — which in a suite about version numbers produces failures that
all look like logic bugs. Any new suite gets this for free; nothing gets to opt
out of it.

### Make targets

`make help` is enough to work the project.

```
make setup      # install, create .env from example, report what's missing
make dev        # wrangler dev against local D1
make build      # esbuild the client bundle
make check      # typecheck + test — the pre-PR gate, and what CI runs
make migrate    # apply D1 migrations. Additive only — see below.
make deploy     # build, bake version, deploy the Worker
make verify     # smoke-test the live deployment
make health     # assert live /health matches this checkout's <version>+<sha>
make logs       # wrangler tail
make backup     # dump D1 to backups/
make destroy    # tear it down (confirms)
```

`ENV` is a variable, never a target suffix: `make deploy ENV=prod`. It defaults
to `dev`, so a forgotten flag is boring rather than expensive.

`make backup` matters more here than in most projects: D1 holds the only copy of
the document, Time Travel is 30 days, and a restore gives you a database back —
not the knowledge that the document was wrong three deploys ago.

### CI

`.github/workflows/ci.yml` runs `pnpm check` on PR, on push to `main`, and on
`workflow_dispatch` with a `ref` input. The manual hatch is not optional — GitHub
webhooks have been throttled to the point where a PR and its merge both landed
with no run and no way to ask for one.

### Deploy credential — two accounts

Per [cloudflare.md](../../claude-shared/docs/standards/cloudflare.md) and
[ADR-002](adr/ADR-002-two-accounts-and-migrations.md):

| | Credential lives in | Who can deploy |
|---|---|---|
| **dev** | `.env.local` in this clone | you, locally — every `make deploy` |
| **prod** | a GitHub Environment secret on `production` | only `deploy-prod.yml` |

**The prod token is never on the laptop.** That placement is the mechanism; the
`env.prod` block in `wrangler.jsonc` names resources and grants nothing. The top
level of that file is dev, so every command that forgets a flag does the safe
thing.

Secrets are never in `wrangler.jsonc` — `wrangler secret put --env <env>`, and
**different values per environment**:

| Secret | Purpose |
|---|---|
| `KNAG_PASSPHRASE` | PWA login. Dev's must differ from prod's — dev is reachable at a `*.workers.dev` host the WAF rule does not cover. |
| `KNAG_BEARER_TOKEN` | Agent / MCP / native |

### Upgrade — the order is not negotiable

```
make check                    # green
make backup ENV=prod          # D1 → artifact, before anything
make migrate ENV=prod         # additive only
make deploy ENV=prod          # bakes <version>+<sha>
make health ENV=prod          # assert live == checkout
```

`deploy-prod.yml` runs exactly this, in this order, on manual dispatch only.

**Between `migrate` and `deploy`, the currently deployed Worker runs against the
new schema.** So: every migration must be backward-compatible with the deployed
Worker. Additive changes satisfy this for free; anything destructive takes two
releases (expand, then contract). This is the one rule whose violation does not
produce a failed deploy — it produces a Worker writing to a column that no longer
exists, against the only copy of the document. Full reasoning in ADR-002 §3.

This is where knag diverges from `pagevault`, which is otherwise the closest
analog: KV is schemaless, so its upgrade is a deploy and nothing else. That does
not transfer to D1.

### No CLI, no npm package

`pagevault` ships both because it is an **installed product** — a stranger
provisions Access apps, a KV namespace and a viewer group in their own account,
and the CLI is that provisioning surface. knag's install story is one
`wrangler d1 create`, two secrets, and a DNS record. That is a README section.

The rule, which belongs in the shared standards rather than here: *a Worker
project earns a CLI and an npm package when a stranger must provision
infrastructure in their own account.* The trigger to revisit is §17's
self-hosted branch — the same trigger as everything else in that section.

---

## 16. Deltas from the original draft

For the record, so the reasoning isn't lost.

| Draft | Now | Why |
|---|---|---|
| `wrangler.toml` | `wrangler.jsonc` | House standard — comments on every binding |
| Vanilla JS, no build step | TypeScript + esbuild | One block parser instead of two (§2) |
| No test plan | 4 vitest suites vs real D1 | House standard; the parser is the risk |
| No CI | `ci.yml` + `workflow_dispatch` | House standard |
| No Makefile | 11 targets | House standard — Make is the entry point |
| `current`, `sealed`, `event`, `line` | `documents`, `is_sealed`, `event_type`, `line_text` | House DB naming |
| SortableJS via CDN | Vendored, pinned | The SW "caches the shell" promise is otherwise false |
| `/mcp/health` | `GET /health` with version+sha | Feeds `make health` |
| — | Timing-safe compare, login rate limit, session sweep | Draft had no brute-force answer |
| — | `authenticate() → Principal` | §17 |
| — | All SQL in `store.ts` | §17 |
| Cookie auth, bearer for agents | Bearer first-class on all `/api/*` | §17 |
| `index.html` served from the Worker | Workers Static Assets | Real files, not template literals |
| Kept as-is | Passphrase auth over Cloudflare Access | [ADR-001](adr/ADR-001-passphrase-auth.md) |

Draft §8 carried an aside about "artifact storage restrictions" — an artifact of
where it was written. Removed.

---

## 17. If this becomes more than a legal pad

Not scope. Recorded so today's decisions don't foreclose it, and so the review
that decides has something to start from.

Plausible futures: hosted for other people; wrapped for the App Store; open
sourced as a self-hosted thing.

**What would actually break:**

| Future | Breaks | Insurance taken today |
|---|---|---|
| Multi-user | Schema (`CHECK (id = 1)`), every query | All SQL in `store.ts`, `DOC_ID` constant. Adding `owner_id` is one file plus a migration. |
| A few pages | Same `CHECK (id = 1)`, and every route assuming a singleton | Same chokepoint. `page_id INTEGER NOT NULL DEFAULT 1` is additive and the backfill is one `UPDATE`. |
| Any real auth | Passphrase is a shared secret — no revocation, no accounts | `authenticate() → Principal`; handlers key off `principal.id` |
| Native / App Store | Cookies don't fit a Keychain-token client | Bearer is first-class on every `/api/*` route |
| Public / self-hosted | Config assumes one owner | Vars in `wrangler.jsonc`, secrets via `wrangler secret put`, MIT already |

**What is not insured, deliberately:** no `owner_id` columns, no accounts table,
no billing hooks, no CORS. Each is a future that may never come, and each is
cheap *because* of the chokepoints above.

**The one to watch.** Auth is the only decision here that gets expensive with
age. A shared passphrase does not survive multiple users and would not pass App
Store review. The trigger to revisit is a second human, not a feature count.

### Multi-tenant, re-examined 2026-08-15

Hosting knag for other people — a small free group first, possibly a
subscription later — was raised as a real direction rather than a hypothetical.
It is **not being engineered for**, and the finding is that it does not need to
be:

| Decision | Influenced by multi-tenant? |
|---|---|
| Schema | **No.** Everything stored today is implicitly one owner's one page. Both keys are additive columns with a trivial backfill. |
| A few pages | **No.** Same answer, and it can ship long before tenancy does. |
| MCP tool signatures | **No.** An optional `page` parameter added later is backward-compatible; adding one now would be a parameter with one legal value. |
| Brand, offline, wipe | **No.** |
| **Auth** | **Yes, and only this.** |

A shared passphrase means everyone shares one page, which fails on the *first*
friendly tester rather than at scale. So the trigger stated above is exact, and
the first move when it fires is **a spike on the auth model, not a schema
change** — the answer is unlikely to be hand-rolled accounts.

The cost that is easy to miss is not in the code: holding other people's data
turns `make backup` from a personal habit into an obligation, multiplies the
polling budget of §14.4 by the tenant count, and gives the login rate-limit rule
a different threat model.
