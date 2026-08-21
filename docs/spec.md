# knag — Build Spec

*Single live document, multi-device, agent-readable/writable.*

**Name:** *knag* — archaic, a peg driven into a wall to hang things on. Also
reads as "nag." Both meanings are the product. Repo `danjamk/knag`.

> **Status.** Functional intent is settled. The technical choices in §2 and §§13–15
> were revised against the house standards — a private, personal set — see
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

TypeScript throughout is the house standard, and `pnpm check`
(typecheck + test) is the pre-PR gate and exactly what CI runs.

---

## 3. Data model

Naming follows the house database conventions:
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

Cloudflare Access is the house default for a Worker, and is
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
{ "base_version": 42, "scope": "completed" }
```
`scope` is `completed` (the default, and what an older PWA sends by omitting it) or
`all`. An unrecognised value is a 400 rather than a fallback — a typo that quietly
wiped only the checked items would look like it worked.

Order of operations matters:
1. Seal the newest revision (`is_sealed = 1`) so the pre-wipe state can't be
   swallowed by the coalescing window.
2. Insert a revision holding the pre-wipe body, with `event_type = 'clear_completed'`
   or `'wipe_all'`.
3. Write the **finished** lines into `cleared_items` — see below.
4. Remove the blocks the scope names and update the page. `completed` removes
   `kind === 'checkbox' && checked === true`; `all` empties the page — **or resets it to
   its template, when the page has one**.

Returns `{ version, cleared_count, wiped_count }`.

#### 🔴 A template is a page's reset state (#165)

`pages.template` holds a saved body. Edit a page to the baseline you want, save it, and a
whole-page wipe returns the page there instead of emptying it:

> Groceries. Twenty things I always buy — then I add to that list as I do meal planning.
> Then I go shopping. When done, I wipe the page and it resets back to my standard twenty
> items with no items checked off.

**This is what makes the wipe worth doing on a page you use repeatedly**, and it is the
whole feature. It shipped in 1.1.0 as a seed for *new* pages — a description of one
consequence mistaken for the thing itself — which made the wipe *less* useful on exactly
the pages that need it most. A new page starts empty, always.

Three rules that follow:

- **The daily sweep never resets.** `completed` means "clear what is done" and runs several
  times a day; making it restore lines would mean a page you swept at noon grew back by
  itself. Only `all` resets.
- **`wiped_count` counts what left, not what remains.** A page that resets to a template
  still reports every line that went — a count of the remainder would report a reset as
  having done nothing.
- **A template is still just a saved body.** No template language, no variables, no
  placeholders; the reset is a byte-for-byte write of what was saved (ADR-004).

Nothing in the schema changed for this. `pages.template` was already the right shape; what
was wrong was what read it.

Steps 1–4 run in a single D1 batch. A partial wipe that seals a revision but
loses the `cleared_items` write is worse than no wipe.

#### 🔴 `cleared_items` records what was *finished*, not what was removed

A wipe-all takes lines that were never done. Those are deliberately **not** written to
`cleared_items`, because that table is what `/api/history` reports as authoritative for
"what did I get done" — precisely because a line-set diff cannot be trusted for that
question. Writing unfinished lines there would corrupt the one record that has to stay
honest, and inflate every summary built on it.

So the two counts differ, and both are returned:

| | Means |
|---|---|
| `wiped_count` | Rows removed from the page |
| `cleared_count` | Rows written to `cleared_items` — the finished ones |

They are equal for `completed`.

**Two event types, not one**, for the same reason. Without the distinction a wipe-all
would appear in history as an entry claiming two items were cleared, followed by four
more lines disappearing on the next ordinary save with nothing to explain them.
`revisions.event_type` is free text with no `CHECK`, so this needed no migration.

**Recovery does not use `cleared_items`.** Step 2's snapshot is the whole pre-wipe
document and is sealed, so every removed line is derivable from it and the body step 4
wrote — for both scopes. That is what [#59](https://github.com/danjamk/knag/issues/59)
restores from; reading `cleared_items` instead would silently drop the unfinished lines.

#### Undoing a wipe

The client keeps the pre- and post-wipe bodies and offers `wiped N · bring back` until
that device's next local midnight. **The undo is client-side and needs no route and no
schema change** — the app already holds both sides, and the server's sealed snapshot is
the durable copy behind it.

🔴 **Restore re-inserts into the page as it is now; it never writes the snapshot back.**
Writing it back discards every edit made since the wipe, which is a worse data-loss path
than the one the undo exists to prevent. Each removed block goes back after the surviving
block it used to follow, so it lands correctly even though every index has shifted; a
block whose anchor is gone is appended rather than dropped, because the wrong position
costs far less than the wrong content. Restoring is idempotent by **count**, not by
presence — a page may legitimately hold the same line twice.

The restore itself is an ordinary `PUT` with a `base_version`. Undo does not get a
special path and does not skip the concurrency rules; a 409 reloads and leaves the offer
standing.

The offer is deliberately **per-device**. The regret belongs to the device the wipe
happened on, and an undo offered on the laptop for something wiped on the phone invites
undoing work someone already moved on from. Its lifetime uses the *device's* local
midnight rather than `KNAG_TZ`: §14.3's zone exists to file past edits onto the right
day, and this asks whether the person holding the phone still thinks of the wipe as
something they just did.

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
- **A wipe entry has an empty diff by construction** — it snapshots the
  *pre*-wipe body, identical to the revision before it (§14.2), so the event's own
  diff is necessarily empty. `cleared_count` and the day's `cleared` rows are the
  record of what was *finished*; the diff is not, and §5 already says so.
- 🔴 **The row immediately after a wipe entry carries what it took** (#91). The
  wipe records the state it left as a second sealed revision with no `event_type`,
  sharing the event's timestamp, and *that* row's `disappeared` is the lines the
  wipe removed. It is the only place a note or an undone task taken by a
  whole-page wipe can be found, because `cleared_items` deliberately holds
  finished lines only. Before #91 the post-wipe state entered the log on the next
  ordinary save, so those lines surfaced on an unrelated later revision.

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

**Never apply a remote update while the editor is dirty.** Queue it, apply once
the pending save resolves. A cursor that jumps mid-keystroke is how an app gets
abandoned.

**Narrowed 2026-08-16 (#62).** This originally read "dirty *or* focused", and the
focused half caused the bug it was written to prevent. A browser restores focus
to the last-focused element when you return to a window, so `focused` was true
again before the first poll after picking a device back up — the update went into
a queue with no expiry and no visible signal, and the page went stale *precisely
when you came back to it*, staying stale until you happened to click elsewhere.
Reported from real use after 344 green tests.

The reasoning was right and the remedy was wrong. Assigning a textarea's value
does reset the selection, so the caret has to be protected — by **putting it
back**, which `focusRow` already does after every structural edit, not by
withholding someone's own data. Focus is a rendering concern; only unsaved
keystrokes are a correctness one.

`dispositionFor` in `client/src/sync.ts` returns one of three things — `apply`,
`restore-caret`, `hold` — and `hold` happens for exactly one reason.

**A held update is announced, never silent.** `pendingRemote` having no signal is
what turned a caret-protection rule into a page that lied about being live.

**Always send `base_version`.** The failure mode this prevents: an iPad left
open for three days, typed into, saving a stale body over a week of work. This
is the one catastrophic data-loss path and it costs ten lines to close.

### Save triggers
- 800ms debounce after typing stops
- Immediately on blur
- Immediately on checkbox toggle, reorder, or clear

🔴 **Writes are serialised on the client** (#83). While one `PUT` is in flight the next
is queued rather than sent, and at most one is queued — the follow-up reads `body` and
`baseVersion` when it runs, so it already carries the newest of both.

Without this, two immediate saves overlap and the second carries the `base_version` the
first has not yet updated, so the server rejects it as conflicting. With one operator
and one device, the "other writer" is your own previous keystroke — and because a 409
is resolved by loading the server's copy over the local one, **the losing write's
keystrokes are discarded** while the status line calls it a reload. Six rapid `Enter`
presses reproduced it.

A genuine cross-device 409 still reloads and still says so. Serialising removes the
self-inflicted conflicts only; nothing swallows a real one. Any request carrying
`base_version` — a wipe, an undo — must **await** the flush before it sends, or it is
stale by construction.

---

## 7. Client — the editing surface

> 🔴 **The row list is gone (#113).** It shipped *beside* the CodeMirror surface rather
> than instead of it, because every defect this project has shipped was found by a person
> on a phone rather than by the suite — so the replacement got used against the real page
> first. It earned it, and a transition that does not end is two things to maintain plus a
> mode question in Settings, which is what ADR-003 removed on evidence.
>
> What went with it: `client/src/caret.ts` in full, the four arrow-key rules, `neighbor`,
> `splitAt`, `mergeBackward`, the per-row `<textarea>` rendering, and the offline
> exemption that kept one row live. All of it existed to make a **row boundary** behave
> like a **line boundary**, and on one document those *are* line boundaries — the platform
> owns them. #84 and #88 were both bugs in that code.
>
> What survives is stated once in `client/src/edit.ts` and called by the surface: `Enter`
> continuing a checkbox or a bullet, the `--` shorthand, and its undo. Those are knag's
> rules rather than a text editor's, which is why no platform knows them.
>
> **Arrange still renders rows** and is the only thing that does — a separate mode built
> from the block array, read-only, never sharing an element with the surface
> ([ADR-007](adr/ADR-007-one-editing-surface.md) §4). Raw view survives as the escape
> hatch for a bulk paste; ADR-007 argues it should go too, as its own change.
>
> The section below describes what the surface renders. It was written for the row list
> and the block-by-kind table still holds — the difference is that a fence is now three
> lines rather than one row.

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
   every row bought density and nothing else. On a **picked** row it copies the
   whole selection instead — see *Picking several rows* below.
4. **Delete control** — reorder mode only, and likewise acts on the selection when
   the row it sits on is picked.

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
| `Enter` on a checkbox or bullet | continue the list with the same marker |
| `Enter` on an *empty* checkbox or bullet | drop the marker and leave the list |
| `Backspace` at position 0 | merge into the previous row, caret at the join |
| `←` at the start of a row | previous row, caret at its **end** |
| `→` at the end of a row | next row, caret at 0 |
| `↑` on the row's first visual line | previous row, **same column** |
| `↓` on the row's last visual line | next row, **same column** |

🔴 A boundary key crosses a row only with **nothing selected** — a live selection is not
a caret, every editor collapses it on an arrow, and a boundary jump would eat the
gesture.

🔴 **"At a boundary" means two different things for the two pairs, and conflating them
was #88.** For `←`/`→` it is an **offset**: the first or last character. For `↑`/`↓` it
is a **visual line**, which an offset cannot express — a row is a textarea that can be
several visual lines tall, and intercepting inside one makes a long wrapped line
unnavigable. Requiring the exact offset instead meant a `↓` from mid-row was never
intercepted, so the browser handled it and moved the caret to the end of the text:
changing rows cost two presses, and the first went somewhere nobody asked for.

🔴 **The preserved column is a pixel x, not a character offset.** A character count is
not a column in a proportional face — `iiii` and `WWWW` put offset 4 nowhere near each
other on screen. Measuring both the visual line and the column is what
`client/src/caret.ts` exists for, and it is the only place in the client that reads
layout.

`↑` on the first row and `↓` on the last do **nothing**. Handing the keystroke back
would let a one-line textarea slam the caret to the start or end of its text, which is
the same unasked-for jump, just at the ends of the document.

Nothing is skipped. A blank row is a place you can type, and stepping over one would
make the arrows disagree with what is on screen.

The horizontal pair was missing until #84 — the caret hit the end of a row and stopped
dead, so moving through the page by keyboard meant reaching for `↓` and then `Home`.
That same change gave `↑` the *end* of the row above rather than its column, reading it
as "back one line"; #88 corrected it, and the horizontal pair kept the behaviour, where
it is right.

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

🔴 **`Enter` continuing a bullet is not the same thing** (#85). Continuing inserts two
literal characters — the file really does gain `- `, it is visible in raw view, and
backspace removes it like any other text. Nothing is *displayed* that the bytes do not
say, which is the whole of the rule above. It is what checkbox continuation has always
done.

The marker is **copied, never normalised**: a `*` continues as `*` and indentation
carries across verbatim. Ordered lists are out — continuing `1. ` means renumbering,
which would be the first edit knag makes to a line the user did not touch.

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

#### Picking several rows

**Tapping a row's body picks it**; tapping again puts it back. The gesture is free
because drag is grip-only and the row's input is `pointer-events: none` in the mode, so
nothing else wanted the tap. Picked rows take `--press-tint` — ink at 10%, one step above
the row under the finger, so the two stay distinguishable mid-drag. No new colour: amber
is still the only one, and this is a ground rather than a voice.

**Copy and delete then act on the selection** when the control belongs to a picked row,
and on that row alone when it does not. Nothing new appears on screen to announce it —
the picked rows are already tinted, which is what makes the size of the action readable
before it is taken, the same argument as the count inside `wipe 3`.

- **Copy** joins the picked rows in document order with `\n`, stripping `- [ ] ` prefixes
  exactly as single-row copy does. Copying what the row *displays* is the rule already
  set above, and a bulk copy that suddenly carried the markers would make the two
  controls disagree.
- **Delete** is one edit for the whole set, so it is one save and one revision entry —
  and it does not confirm, at any count, for the same reason single-row delete does not.
- The selection is **UI state**: cleared entering and leaving the mode, and on any edit
  that moves indices. Never persisted, the same as the mode itself.

🔴 This is the answer to cross-row selection, and it is deliberately *not* the same
thing. It works on whole rows, so it cannot select half of one line through half of
another. [ADR-006](adr/ADR-006-cross-row-selection.md) records why that gap is accepted
rather than closed in the editor.

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

### Wipe
Single control, footer, and it is a **labelled word with the count inside it** —
`wipe 3` — never a glyph. `⌫` was the wrong promise: a backspace glyph says the
bytes are gone, and the whole argument of the product is that they are not. At
zero it renders nothing at all; an empty right edge of the bar is the page saying
there is nothing to release.

**No confirm, at any count** (amended in #71). There used to be one above ~10
blocks. Two things retired it: the count now sits *inside* the control, so the
size of the action is in front of you before you tap it, and the recovery line
makes taking it back one tap. A browser `confirm()` also moved the decision to a
grey OS dialog with a title bar, which is the loudest surface in an app whose
whole voice is quiet.

The **whole-page** wipe still confirms, because it takes work that was never
finished — but by repetition rather than by dialog. The label swaps to
`again to confirm` on the first tap, and it disarms itself after a few seconds
and whenever the ledge closes. An armed control left armed is a trap for the next
person who reaches for the ledge for an unrelated reason.

**The wipe has a sound, added in #121, and it is off by default.** One per wipe, never
one per line, synthesised rather than shipped as a file. Its length is derived from the
motion — `knockAt = duration + stagger × (n − 1) + collapse` — so the noise band closes on
the frame the last gap does, and a two-line sweep and a nine-line page wipe are the same
event at two lengths. `prefers-reduced-motion` silences it without a special case: the
tokens collapse to 1ms, the formula yields a few milliseconds, and a sound that short is
not played. The iOS silent switch mutes it outright and is not worked around — the motion
carries the moment and the sound is a bonus.

**Amended in #139: it lives on the ledge, not in Settings.** Both whole-page verbs
left the sheet, and what keeps this one away from `wipe N` is now the tier rather
than the depth — it is a rung out and past a hairline, alone at the far end. The
confirmation stayed a repetition rather than becoming a dialog: a dialog was the
right answer for a control being promoted to tier 1, and the ledge is not tier 1.
It is a rung you reach for on purpose, which is the deliberateness that being
three taps deep used to buy.

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

🔴 **Its remaining purpose evaporates under [ADR-007](adr/ADR-007-one-editing-surface.md).**
The editing surface *is* the bytes with decorations over them, and multi-row selection —
the thing this section assigns to raw view — works there. It stays through the transition
because it is exactly the escape hatch it was designed to be, and is removed once the new
surface has survived a month of real use. Its absence is what finally pays ADR-003 off.

---

## 9. PWA shell

Served from **Workers Static Assets** (`assets` binding in `wrangler.jsonc`),
with `run_worker_first` for `/api/*` and `/mcp`. The shell is real files in
`public/`, not template literals inside a TypeScript module.

`public/fonts/` holds the two subset faces plus `OFL.txt`. They are **committed
output, not a build step** — `scripts/subset-fonts.sh` exists so the committed
files are reproducible and their provenance checkable, not so it runs on every
deploy. Fonts change roughly never, and a build step that reaches for a Python
toolchain to reproduce a file that did not change is a build step that will one
day fail for no reason. Both faces are SIL OFL 1.1; the licence travels in each
file's own name table (`--name-IDs+=13,14`, which pyftsubset drops by default)
and in full alongside them.

`public/manifest.json`:
- `"display": "standalone"`
- `"theme_color"` matching the app background so iOS status bar doesn't clash
- 192px and 512px icons, plus a **separate** 512 for `purpose: "maskable"` — Android
  crops maskable icons to a circle, so the same file cannot serve both without losing
  the mark's corners. The `apple-touch-icon` is the *non*-maskable one; iOS applies its
  own mask and pre-padded art arrives double-padded.

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

Offline **state** is in, and the distinction matters. The app used to fail
silently when the network went: the poll errored into nothing and a save errored
into nothing, so the page looked live and was not — the worst of the three
possible behaviours. It now says `offline` in the machine voice, holds rows
read-only, and resumes on reconnect without a reload.

Refusing to edit is a stated decision, not a limitation being hidden.

#### 🔴 Connectivity is decided by requests, not by `navigator.onLine`

`onLine` is trusted in exactly one direction. `false` is reliable — the OS knows
there is no interface — so it is acted on immediately. `true` only means an
interface exists, which is *also* what a captive portal and a dead uplink report,
and those are precisely the situations this feature exists for. So `true` is
ignored until a real request settles it.

**An HTTP response of any status means the network is fine.** A 401, a 409 and a
500 all travelled; treating them as disconnection would freeze the page for
someone whose session merely expired, on a working connection. Only a thrown
`fetch` is evidence of absence.

Reconnection is checked against **`/health`**, not `/api/doc` — it is
unauthenticated, so a flaky connection cannot bounce someone to the login screen
while they wait.

#### The row being typed into keeps working

Every row goes read-only except the one that had focus when the drop was noticed.

Freezing mid-keystroke eats the rest of the sentence someone is part-way through
writing. That is lost text they already typed, which is the failure this feature
exists to prevent, arriving as the cure.

Letting that row finish leaves exactly one unsaved row, and that is not a new
risk: knag already holds unsaved keystrokes for the length of the save debounce,
and the dirty guard exists to protect them. Offline makes the window longer and,
crucially, **visible** — the footer reads `offline · 1 unsaved` when there is
pending work, because hiding that behind a single word is how someone closes a
tab on a row that never landed.

On reconnect the pending save goes as an **ordinary versioned write**. If the
document moved it conflicts and reloads, exactly like any other save. One
in-flight edit resolving through compare-and-swap is not an offline queue, and
nothing is ever replayed against a document that has moved on — §12 is intact.

Rows use `readOnly`, never `disabled`: a disabled textarea cannot be focused or
selected, so going offline would make the document unreadable as well as
uneditable, and a line could not even be copied out to somewhere that works.
Checkboxes are `disabled`, which is the only thing they honour.

### Board

**Slate, Whiteboard, or system**, persisted per device in `localStorage` alongside
the raw-view preference — UI state, not document state.

🔴 **They are boards, not themes** (#70). Slate is chalk on a blackboard and the
default; Whiteboard is marker on dry-erase, cool rather than warm. The metaphor is
the product: a board is a thing you wipe, and the difference from a real one — the
whole point — is that a real board has no memory. **There is no third board.** A
lined-paper skin was considered and cut: it is the least readable surface for a
document you live in for hours, and a third option turns a preference into a
decision.

`prefers-color-scheme` is the default. The MVP hard-coded dark, which is the
right default and the wrong only option: knag gets opened outdoors and in
meetings, and a fixed dark surface is unreadable in the first and conspicuous in
the second.

The stored values were `light` and `dark` before the boards were named;
`readTheme` migrates them, or everyone who had ever chosen one is silently reset
to `system` on the release that renames them.

### Type, and the two voices

Two typefaces, self-hosted, subset to the Google `latin` range and served as
woff2 from `public/fonts/` (~49 kB for three faces — §14.4's budget covers it,
and the service worker precaches them or a cold offline start comes up in the
fallback stack).

| Voice | Face | Colour | Covers |
|---|---|---|---|
| Human | Familjen Grotesk | chalk / ink | everything you wrote — the page, the rows |
| Machine | DM Mono | amber | save status, counts, the wordmark, build info, raw view |

🔴 **Amber is the only colour in the interface.** Everything else is chalk, ink or
a hairline. A third colour means something went wrong — which is why `offline`,
`not saved` and the delete control are amber and dim rather than red.

Every line of the page is one setting: 16px, whatever the line says. No second
format for code, no styled headers. That is [ADR-004](adr/ADR-004-display-matches-the-bytes.md)
visible on screen — nothing on the page may look like a thing the bytes do not say
it is.

**Dark-mode text treatment is required, not cosmetic.** Familjen Grotesk's weight
axis starts at 400, so Slate cannot run a lighter row weight to counter optical
bloom. All three corrections are therefore load-bearing: chalk softened to
`#D8D6CD`, `letter-spacing: 0.012em`, and grayscale smoothing — all scoped to
Slate only, and **never inside a fence or raw view**, where tracking would
undermine the column alignment that makes monospace read as code.

---

## 10. MCP tools

Built against the house MCP standard — read it before step 10, not after. No Resources. The rules that apply in full
are §2 request isolation, §3 tool design, §4 annotations, §5 server instructions,
§6 structured output, §8 auth, and §9 security.

> 🔴 **This section said bearer auth was enough, and it was wrong.** The claim was
> that knag "sits at the simple end of that standard: bearer rather than OAuth 2.1
> (single operator, no third-party client, no consent screen)."
>
> claude.ai, Claude Desktop and mobile drive an **OAuth 2.1 handshake** and offer
> no field for a raw header. A static bearer reaches Claude Code and nothing else.
> The bearer-vs-OAuth choice is not about *who connects*, it is about *which client
> you need to reach* — and knag is a phone, iPad and laptop product.
>
> [ADR-005](adr/ADR-005-mcp-oauth.md) and [#64](https://github.com/danjamk/knag/issues/64).
> **Shipped.** OAuth 2.1 is a second, independent way in; the static bearer stays.

Mounted at `/mcp`, **bearer-authenticated and bearer-only** — see below.

### Two ways to hold a bearer

| | Credential | Reaches | Validated by |
|---|---|---|---|
| Static | `KNAG_BEARER_TOKEN` | Claude Code, CI, curl | `authenticate()`, a local compare |
| OAuth 2.1 | An access token knag issued | claude.ai, Desktop, mobile | the provider, which alone can |

Both arrive as `Authorization: Bearer`, both resolve to `source: "bearer"`, and
both land in the revision log as `agent`. Neither is a cookie, so §10's
bearer-only property below is untouched by having two of them.

The static path is checked **first, ahead of the provider**, because
`KNAG_BEARER_TOKEN` is not a token the provider minted and it would reject it —
taking out the only surface that worked, in the release that added the others.

Discovery lives at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`, with `/oauth/authorize`,
`/oauth/token` and `/oauth/register` (DCR — without it a connector cannot
self-register, which is the exact error that opened #64).

**The audience is derived from the request origin**, not from a var. A
`*.workers.dev` host and a custom domain each advertise themselves correctly,
and there is no value to add to both wrangler env blocks and forget in one.

### 🔴 Consent is the mirror image of `/mcp`

`/oauth/authorize` accepts **the session cookie and refuses the bearer**. A grant
minted from a header is a grant nobody agreed to; consent is a thing a person
does in a browser.

A visitor without a session is redirected to the ordinary login with a `next`
parameter, and returned afterwards — so **the passphrase is never typed into the
consent page**. That also settles rate limiting: `/oauth/authorize` accepts no
credential, so the only thing worth guessing is still behind `/api/login`, which
the WAF rule already covers (§4.2). No new limiter, because no new surface.

`next` is matched against a one-entry allowlist rather than a same-origin test.
`//evil.example` and `/\evil.example` both pass a naive "starts with `/`" check
and are read as *hosts* by browsers — an open redirect on the page that hosts
the login form is worth more to a phisher than a plain one.

| Tool | Signature | Notes |
|---|---|---|
| `knag_read` | `(page?) → { body, version, updated_at, page }` | |
| `knag_write` | `(body, base_version, page?) → { version, updated_at, changed, page }` | Full replacement. Conflict on mismatch. |
| `knag_wipe` | `(base_version, scope?, page?) → { version, wiped_count, cleared_count, page }` | Same path as the wipe control. `scope` is `completed` (default) or `all`; `all` resets to the page's template when it has one (§5). |
| `knag_history` | `(since?, until?, page?) → History & { page }` | `History` is the identical shape to `GET /api/history`. |

### `page` is optional, by name, and never falls back (#153)

**Optional is load-bearing, not polite.** §17 is explicit that a parameter added later is
backward-compatible only while it is optional; a required one breaks every deployed
Claude Code config the moment it ships, and those configs are on machines nobody is going
to edit. Omitted means **the default page**.

**By name, case-insensitively** — `page: "shopping"`, not `page: 3`. This is the one
identifier in the product a *person* writes down, into a saved prompt or a project
instruction, and a name survives being read back where an id does not. The browser holds
ids because it never has to explain them to anybody, which is why `/api/doc?page=` takes
an integer and this does not. The cost is that a rename breaks whatever was written down,
and that cost is paid deliberately:

> 🔴 **An unrecognised name is an error listing the pages that exist. It never falls back
> to the default.** Whole-document write is the only write here, so an agent told to write
> to `shopping` after that page was renamed would otherwise replace today's page instead —
> byte-preserving every line it was handed, into the wrong document. The error is also the
> only way to learn the names, because **knag has no index and no tool that lists pages**
> (§12). A wrong name is usually a nearly-right one, so getting it wrong once is the
> intended discovery path.

Absent likewise never means "the page you were last looking at". The Worker has no current
page — that is a per-device idea in a browser's localStorage, and a bearer token carries no
device.

One write tool, not three. The document is small enough that read-modify-write
is cheaper than inventing append/patch/delete semantics, and it covers every
case — add, check off, surgical delete, total sweep — identically.

**`knag_wipe`, not `knag_clear`.** The product's word is *wipe*; a tool named
`clear` makes the agent say "cleared" while the app says "wipe", and that seam
shows up in every conversation. The HTTP route is still
`/api/doc/clear-completed` and the table is still `cleared_items` — renaming an
API field breaks the PWA and renaming a table is a destructive migration, so
both wait for the brand pass. A new surface gets the new word; the old ones get
it when they are being changed anyway.

### 🔴 Bearer only, unlike every other route

`/mcp` refuses the session cookie even though `authenticate()` resolves it.

This is not tidiness. mcp.md §8's argument for *logging* a foreign `Origin`
rather than blocking it rests on one claim: a `/mcp` that never accepts a cookie
grants no ambient authority, so a rebound page can only make unauthenticated
requests that 401 anyway. Accept the cookie and that sentence is false and the
`Origin` decision loses its foundation.

The cookie is `SameSite=Lax` and this route is POST-only, so a cross-site POST
would not carry it today regardless — but that makes the property depend on a
cookie attribute rather than on construction, and mcp.md §9 is explicit that
by-construction is stronger. No MCP client sends cookies, so it costs nothing.
Pinned in `pnpm test:security`.

### Server instructions carry the voice, not just the contract

The agent contract below is stated once in the server's `instructions` string
(mcp.md §5) rather than repeated per tool — with the security-critical rules
also *named* in the tools that enforce them, so trimming a description cannot
silently drop a guardrail.

The same string carries the product voice. An agent writing to the page is a
second author, and `wiped 6` versus "Successfully cleared 6 completed items!" is
the difference between the product's voice and a generic one. One string, and
every agent conversation is on-brand.

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
reorder mode with delete · wipe, in two scopes, with a one-tap recovery line ·
coalesced revision log · history diff · 4 MCP tools · PWA manifest · two boards
and system · two self-hosted typefaces · **cross-line selection, on one editing
surface** ([ADR-007](adr/ADR-007-one-editing-surface.md))

**Out:** search · tags · attachments · offline editing · WebSockets · Electron ·
native apps · email auth · multi-user · sharing · brain reads or writes ·
rollover · day boundaries · rich formatting · **a page index of any kind**

`multiple documents` left this list in 1.1 and is argued below; what replaced it is
the narrower thing, because the guard is what keeps the door from opening the rest of
the way.

If a weekend turns into two, something from the second list came back.

Two entries have since been argued properly rather than merely listed:

- **rich formatting** — [ADR-004](adr/ADR-004-display-matches-the-bytes.md). The
  rule is that the display never diverges from the bytes; no rendered bold,
  italic or headings. Indentation was never covered by this and already works.
- **offline editing** — still out, but the *state* is in (§9). Failing silently
  while offline is a bug; refusing to edit and saying so is the decision.
- **cross-line selection** — was never on the Out list, but was declined by
  [ADR-006](adr/ADR-006-cross-row-selection.md) and is now in, via
  [ADR-007](adr/ADR-007-one-editing-surface.md). What made it possible was not new
  ambition: it was measuring a maintained editor library instead of hand-rolling the
  input layer, and scoping a carve-out of the no-framework rule to the editing surface
  alone.
- **multiple documents** — comes off the Out list in 1.1 as **a handful of pages**
  (#123), and the distance between those two phrasings is the whole decision. What is
  in is a small, fixed number of pages you switch between. What stays out is everything
  a *document manager* implies, and §17's guard below is now a rule rather than a
  prediction.

  🔴 **knag has no index.** There is no screen that lists your pages — only a control
  that switches between them, and it is never what you land on. **Launch opens the last
  page you were on.** The switcher is capped at **nine and never scrolls**: a tripwire,
  not a limit.

  The cap is what keeps the rest of the Out list unnecessary rather than merely
  forbidden. Search arrives the moment the list stops fitting; folders arrive because
  search implies a namespace; a home screen arrives because a namespace needs a root.
  All three are still out, and the honest way to keep them out is to notice the day the
  ninth page is not enough — and treat that as a question about the product rather than
  as a number to raise.

  Designed in [design/holistic-response.md](design/holistic-response.md) §7: the
  selector is a drop-up from tier 1, current page in amber, the rest in chalk, one last
  row for the rare verbs. **No icons, no counts, no last-modified times — anything else
  you add is a column, and a column is a file manager.**

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

🔴 **All eleven steps are done, and this section is history.** It ordered the
build phase and nothing since — the editing surface (ADR-007), the design system,
the wipe and the deploy pipeline are all past its end. **The live sequence is
[roadmap.md](roadmap.md)**, which is where a question about what comes next is
answered. The plan that ran this order is
[implementation/completed/MVP_PLAN.md](implementation/completed/MVP_PLAN.md).

---

## 14. Resolved details

These were open questions. They are decided here so Claude Code doesn't guess.
The first two cause silent data corruption if implemented naively.

### 14.1 Block model — rows are not lines

**Blocks are not lines.** A fenced code block is one block spanning many lines. Any
implementation that indexes blocks directly into the line array will scramble the
document on the first reorder involving a code block.

🔴 **Still true, and it now applies to Arrange and the wipe rather than to a row list**
(#113). Arrange builds its rows from the block array — one row per block, a fence as
one — while the editing surface renders one line per line. That is exactly why
`leavingLines` exists: the wipe animates *lines*, and animating by block index faded the
opening ` ``` ` and left the rest of the fence behind (#119).

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

`knag_wipe` removes blocks where `kind === 'checkbox' && checked === true`.
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

The **shell** is the other half of the same budget and it is bounded differently:
requests, not bytes, are what is metered, and the service worker's precache makes
the shell three-or-so requests per *shell version* rather than per visit. The
typefaces (#70) cost 49 kB across three files and nothing per day — which is why
they are precached rather than left to `font-display: swap` to fetch on demand,
and why DM Mono 500 is not shipped when nothing asks for it.

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

Full doctrine in the house MCP standard.
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
  rather than a silent empty tool list. Since [ADR-005](adr/ADR-005-mcp-oauth.md)
  the same 401 also carries `resource_metadata`, pointing at the RFC 9728
  document a connector needs to start the OAuth flow.
- **Unmatched paths must not fall through to the PWA shell.**
  `not_found_handling: "single-page-application"` serves `index.html` with a
  **200** for anything unrouted. A connector probing for OAuth metadata would
  therefore receive HTML and a success status, which reads as corrupt metadata
  rather than as absent metadata — a strictly worse failure to diagnose. Each
  such path needs a `run_worker_first` entry in **both** wrangler env blocks;
  `/.well-known/*` and `/oauth/*` are there for exactly this reason.

  🔴 **The unit suite cannot see this.** Miniflare does not serve the `assets`
  binding, so every path reaches the Worker in tests whether or not it is routed.
  It is checked against a real deployment in `scripts/verify.sh`, and nowhere
  else.
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

🔴 **That shape is a Claude Code config, not a connector.** claude.ai and Desktop
add a connector by URL and negotiate auth themselves; there is nowhere to put a
header. From Claude Code the equivalent is:

```bash
claude mcp add --transport http knag https://knag.danjamkuhn.com/mcp \
  --header "Authorization: Bearer ${KNAG_BEARER_TOKEN}"
```

- Health check is the shared `GET /health` (§5), not a separate `/mcp/health`.
  One endpoint, one answer, and `make health` already asserts against it.

---

## 15. Operations, testing, CI

Not in the original draft. Required by the house standards.

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

The **browser suite is a second job, and it does not run on `push`.** It is roughly three
minutes against `check`'s fifty seconds, and the pull request already ran it against the
same tree, so running it again on the squash commit paid twice for one answer.

🔴 The consequence, stated rather than discovered: **"CI is green on `main`" means
typecheck and unit tests.** Nothing browser-tests `main`'s actual tree. The PR run covers
the same content unless another PR landed in between, and two things stand behind that
gap — a production deploy runs the suite itself before touching the account, and
`workflow_dispatch` takes a `ref`, so a full run against `main` before a release is one
click. That is the moment to want one.

CI also cancels superseded runs on the same ref (`cancel-in-progress: true`), which is the
**opposite** of both deploy workflows and correct for the same reason they are: losing a
test run costs nothing, and losing a deploy mid-flight can leave a half-applied migration.

`.github/workflows/deploy-dev.yml` deploys dev on every merge to `main`, running
the full five-step upgrade sequence below rather than a bare `wrangler deploy` —
because a workflow that only deployed would ship a Worker against an un-migrated
D1 the first time a PR added a migration. It is also the rehearsal for
`deploy-prod.yml`, which is manual and, as of this writing, has never run. The two
files mirror each other deliberately; the divergences are enumerated in
[docs/deployment.md](deployment.md), which is the operational runbook for all of
this.

### Deploy credential — two accounts, three locations

Per the house Cloudflare standard and
[ADR-002](adr/ADR-002-two-accounts-and-migrations.md) §1, §1b:

| | Credential lives in | Who can deploy |
|---|---|---|
| **dev** | `.env.local` in this clone | you, locally — every `make deploy` |
| **dev** | a GitHub Environment secret on `development` | only `deploy-dev.yml` |
| **prod** | a GitHub Environment secret on `production` | only `deploy-prod.yml` |

**The prod token is never on the laptop.** That placement is the mechanism; the
`env.prod` block in `wrangler.jsonc` names resources and grants nothing. The top
level of that file is dev, so every command that forgets a flag does the safe
thing.

What keeps three credentials from weakening the two-account split is that each one
is readable only by the job that names it: **every deployment credential lives on
a GitHub Environment or in `.env.local`, never as a repo-level secret.** `ci.yml`
declares no environment and can read none of them.

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
`deploy-dev.yml` runs the same five steps against dev on every merge to `main`,
plus `make verify`'s smoke test at the end.

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
| Multi-user | Schema (`CHECK (id = 1)`), every query | All SQL in `store.ts`, `DEFAULT_PAGE_ID` constant. Adding `owner_id` is one file plus a migration. |
| A few pages | Same `CHECK (id = 1)`, and every route assuming a singleton | Same chokepoint. `page_id` on `revisions` is additive; `documents` is not — see the correction below. |
| Any real auth | Passphrase is a shared secret — no revocation, no accounts | `authenticate() → Principal`; handlers key off `principal.id` |
| Native / App Store | Cookies don't fit a Keychain-token client | Bearer is first-class on every `/api/*` route |
| Public / self-hosted | Config assumes one owner | Vars in `wrangler.jsonc`, secrets via `wrangler secret put`, MIT already |

🔴 **Corrected 2026-08-19: the "a few pages" insurance is half a release short.**
The row above used to claim `page_id INTEGER NOT NULL DEFAULT 1` covers it. That is
true of `revisions`, whose rows carry no document reference at all today. It is not
true of `documents`, which is `id INTEGER PRIMARY KEY CHECK (id = 1)` — and SQLite
has no `ALTER TABLE ... DROP CONSTRAINT`. Removing that `CHECK` is a full table
rebuild, which is destructive, and `make migrate` runs *before* `make deploy`, so the
deployed Worker runs against the new schema in the gap (ADR-002 §3).

So a few pages is **expand/contract across more than one release**, not one additive
column: a new `pages` table backfilled from `documents` and read going forward, then
`documents` dropped in a later release. Still one file of SQL and still cheap — the
chokepoint holds — but it is not one release, and a plan that budgeted one would have
found out at migration time.

🔴 **It is three, not the two written here.** Finding 4 below, added 2026-08-21.

✅ **Run, 2026-08-20 (#152).** Migration 0004 is the expand half and it went exactly as
described above: `pages` created and backfilled, `page_id INTEGER NOT NULL DEFAULT 1`
added to `revisions`, `documents` left standing.

✅ **Contracted 2026-08-21 (#155).** Migration 0006 dropped `documents`. It took two
further releases rather than one — see finding 4 — and `revisions` and `cleared_items`
were untouched by the drop, which is asserted rather than assumed.

Three things the plan did not have, all found by writing it:

1. **The expand release dual-writes `documents`.** `pages` is the authority; the old
   table is kept in step so the *previous* Worker still serves a current document if this
   one is rolled back. Without that, expand and contract collapse into one irreversible
   step against the only copy of the document, and the two-release split buys nothing.
2. **`page_id` cannot carry a `REFERENCES` clause.** SQLite allows a foreign key on a
   column added by `ALTER TABLE` only when its default is `NULL`, and this one has to be
   `NOT NULL DEFAULT 1` to backfill. The integrity lives in `store.ts` instead.
3. 🔴 **Two queries were correct only because there was one page.**
   `newestUnsealedRevision` asked for the newest unsealed revision full stop, so a save
   to one page inside the coalescing window would have been folded into another page's
   revision; and the wipe's `(SELECT max(id) FROM revisions)` would have sealed the wrong
   page's newest revision. Neither raises an error. Both were found by writing a test
   with a second page in it — which is the argument for building the schema half on its
   own, before anything can create one.
4. 🔴 **The dual write in finding 1 is what makes this three releases rather than two**
   (#155, 2026-08-21). `make migrate` runs before `make deploy`, so the Worker live when
   `documents` is dropped is the *previous* one — and the previous one still mirrors to
   `documents`. Expand and contract cannot be adjacent: the write has to stop, and be
   deployed, in a release of its own between them. That middle release carries no
   migration, which is precisely why it reads as skippable. ADR-002 §3 now says three and
   carries the worked example.

The chokepoint did hold: every one of those is in `store.ts`.

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

#### Decided 2026-08-21: it is friends and family, invite-only, and free

The two sections below are the reasoning; this is the ruling that came out of them, and it
**replaces "not being engineered for"** above. Multi-user is being built. What it is not is
a product.

| | |
|---|---|
| **Who** | A small group of friends and family, invited by the operator |
| **Cost to them** | Free. There is no billing, no plan, no tier |
| **Cost to the operator** | The free tier, or close to it — a hard constraint, not a preference |
| **How you get in** | **Invite only.** There is no sign-up page, and that is a feature |
| **What the operator gets** | A simple admin view: who is here, what is being used. For one person |

🔴 **The scale model is why, and it is worth reading before this is re-opened.** Selling
this was modelled and rejected on the numbers: infrastructure is not what kills it, price
is, paid acquisition can never pay back, and the honest ceiling is beer money. So the thing
that survives is the part that was always the point — a few people the operator knows,
using it for free.

🔴 **The binding constraint is §14.4, and it bites sooner than it looks.** Workers' free
tier is 100k requests/day and this product's meter is polling, not storage:

| | Requests/day | People inside 100k/day |
|---|---|---|
| Realistic, with the adaptive backoff | ~4k per user across their devices | **~25** |
| One tab left open all day at the 4s interval | ~21.6k per device | **~4 devices** |

So "a small group" has an actual number attached, and it is around **twenty-five people at
realistic use** — not a hundred. Three desktops left open on the page all day exceed the
ceiling on polling alone, which §14.4 already says in as many words.

Two things follow, and they are the design work rather than the auth work:

1. **The invite count wants to be a cap in the code**, the way the nine-page limit is — a
   tripwire that makes the promise structural instead of something the operator has to
   remember. A cap nobody enforces is a hope.
2. 🔴 **The admin view and the free-tier constraint are the same requirement.** "Who is
   here and what are they using" is not a nice-to-have next to "stay free" — it is the only
   way to know the second is still true. That is the argument for building it, and it is a
   better one than convenience.

**The open question is which constraint is literal**, because the two answers give very
different caps. Workers Paid is $5/month and includes 10M requests, which covers roughly
eighty people on the same profile and makes D1 writes the next meter instead. If "very
little" means five dollars rather than zero, the group can be three times the size. That is
the operator's call and nothing else in this section depends on it.

#### The economic half, modelled 2026-08-21

The section above answers *what would tenancy break*. It never answered *what would
tenancy be worth*, and that turns out to be the binding question.
[docs/planning/scale-model.html](planning/scale-model.html) is a freemium simulator on the
target Cloudflare architecture — Bass diffusion into a finite niche, downloads aged through
a retention curve rather than a flat churn rate. Three findings survive the sliders:

- **Price decides viability, infrastructure does not.** The bill is ~$0.10–0.15 per user
  per year and flat with scale. $9.99/yr breaks even below the measured median conversion;
  $1.99/yr needs triple it. **The Workers bill is never what kills this.**
- **Paid acquisition can never pay back.** Net lifetime revenue per *download* is well
  under $1 against consumer CPIs of $1–5. The gap is structural rather than a tuning
  problem, so growth would have to be operator hours — which the model prices, and that
  price is the actual finding.
- **The ceiling is honest and low.** At benchmark assumptions the upside is beer money,
  lessons and optionality — not an income.

🔴 **This changes nothing in the table above, and that is the point.** Every "No" stays
No; auth stays the only Yes. What it changes is the *reason* the trigger is a second human
rather than a business case: there is no business case, so the only thing that would ever
move this is somebody wanting to use it.

One piece of it is engineering rather than economics and outlives the question entirely:
the scaling ladder — prune sealed revisions, then hash-shard D1, then more shards, then
Durable Objects only if the product changes. Step 2 is one binding lookup in `store.ts`
**because all SQL already lives there**, which is this section's own insurance paying off a
second time (the first was #152, §17 above).
