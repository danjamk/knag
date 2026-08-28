# knag

One plain-text document, always live, edited from any device and by the agent.
Read [docs/spec.md](docs/spec.md) before changing behavior — the non-obvious
decisions are all in §14 and they are decided, not open.

## Stack

Cloudflare Worker + D1, TypeScript, no framework. `pnpm check` is the gate and
exactly what CI runs. `make help` lists the operational verbs.

Two things a newcomer gets wrong:

- **The client is TypeScript and gets bundled** in a project that otherwise wants
  no build step. The reason is `worker/src/blocks.ts` — the block parser, needed
  by the Worker for clear-completed and by the client for rendering. It exists
  once. Do not add a second parser; do not inline a "quick" version anywhere.
- **The editing surface is CodeMirror and `app.ts` does not know that.** Everything
  is behind `EditorHandle` in `client/src/editor.ts`, which speaks only in document
  bytes ([ADR-007](docs/adr/ADR-007-one-editing-surface.md)). The row model leaked
  into `app.ts` through `editorIn`, `focusRow`, `captureCaret` and four arrow-key
  branches, and that leak is why replacing it was a project rather than a change —
  all of it is gone now (#113), and the leak is the reason it took a release to remove.
  **No CodeMirror import belongs outside `editor.ts`.**
- **CodeMirror never sees a `\r`.** `client/src/eol.ts` splits the document into
  LF-only text plus the CRLF line set and rejoins on the way out, because a lone
  carriage return inside the editor is a character the caret can sit past — which
  strands it mid-line, renders perfectly, and corrupts on save.
- **There is one editing surface.** The row list was deleted in #113 after it had a
  release beside the replacement — every defect this project has shipped was found by a
  person on a phone rather than by the suite, so the surface got used against the real
  page before the old one went.

  🔴 **`[data-rows]` still exists and holds only Arrange**, which builds its own rows
  from the block array and is the reason replacing the editing surface did not cost the
  sort mode ([ADR-007](docs/adr/ADR-007-one-editing-surface.md) §4). The two renderings
  must never be live at once: Arrange **destroys** the editor rather than hiding it,
  because hidden is not the same as not editing. A test that reads `[data-rows] li`
  outside Arrange is reading an empty list and asserting nothing.
- **`assets.run_worker_first` in `worker/wrangler.jsonc` lists the only paths
  that reach the Worker.** Everything else is static. A new route needs adding in
  both places, and forgetting the config half produces a 404 that looks like a
  routing bug in `index.ts`.

## Layout

```
worker/src/         Worker: routes, auth, store, blocks, MCP, OAuth
worker/migrations/  D1 schema. Additive only — the document lives here.
worker/test/        vitest against real D1, not mocks
client/src/         PWA source. Own tsconfig — it is the only place DOM exists.
public/             Static shell. app.js is built, not edited.
scripts/            Shell for anything past ~15 lines of Makefile recipe
docs/               spec.md, adr/
```

## Conventions

**Nothing is normalized.** Bytes in, bytes out. Indentation, blank lines,
trailing whitespace, CRLF, and `*` vs `-` markers all survive a round trip. Any
change touching the parser reruns the round-trip property test before anything
else. This is principle 3 of the product, not a code-style preference.

Its read-path half is [ADR-004](docs/adr/ADR-004-display-matches-the-bytes.md):
**the display never diverges from the bytes.** No rendered bold, no styled
headings, no bullet where the file says `-`. The test for a new rendering is
whether the file is reconstructable byte-for-byte from what is on screen —
checkboxes and linkified URLs pass, rendered markdown does not. Read it before
answering a formatting request; it has been asked three times.

**All SQL lives in `worker/src/store.ts`.** No exceptions, not even one query in
a handler. That chokepoint is what keeps a future schema change to one file — and it
held the first time it was tested (#152, spec §17).

**Every read and write takes a page.** `DEFAULT_PAGE_ID` is the page a request that
names none is about, never a literal `1` and — since #152 — **never an identity**. It
replaced `DOC_ID`, which meant "the only row there can be" because `documents` carried
`CHECK (id = 1)`; `pages` has no such CHECK.

🔴 **It is never the answer to "that page does not exist."** Whole-document write is the
only write this product has, so falling back to the default would let a caller overwrite
a page it never named. Missing is `null` from the store and a 404 from the route. The
same rule is why MCP resolves to the *default* page rather than "the current page" —
the Worker has no current page, that lives in a browser's localStorage, and a bearer
token carries no device.

Two queries in `store.ts` were correct only because there was one page:
`newestUnsealedRevision` would coalesce one page's save into another's revision, and the
wipe's `(SELECT max(id) FROM revisions)` would seal the wrong page's newest one. Neither
raises an error. **A query here that reaches for "the newest revision" without naming a
page is a bug that will not show up until there are two.**

**Every colour is a token, and amber is the only one.** The palette lives in the
`:root` blocks at the top of `public/index.html` and nowhere else — pinned by a
test that greps the stylesheet for a hex outside them. Two boards, one set of
names: **Slate** (chalk on a blackboard, the default) and **Whiteboard** (marker on
dry-erase). They are boards, not themes, and there is no third one.

`--amber` is the machine voice and it is the *only* colour in the interface —
everything else is chalk, ink or a hairline. `offline`, `not saved` and the delete
control are amber and dim rather than red on purpose. **If you find yourself adding
a third colour, something upstream has gone wrong.** Same for a second animation:
the wipe is the only one, and the cursor blink in the mark is the mark, not the
interface. The editing caret is that same block (#228), drawn by the editor because a
native caret cannot be made wide — it blinks because it is a caret, and it keeps
blinking under reduced motion because every other caret on the device does.

**One sound, too, and it is off by default.** The wipe is the only thing in the product
that makes a noise — one per wipe, never one per line — and its length is *computed from
the motion tokens* rather than written down, so retuning the motion retunes the audio and
`client/src/sound.ts` names no duration of its own. It is synthesised, never a file:
nothing in `public/`, nothing in `SHELL`. **The iOS silent switch mutes it and that is not
worked around** — the motion is the moment and the sound is a bonus, so if a wipe ever
needs the sound to feel like a release, the wipe is wrong.

The boundary that keeps that rule usable: **a state change is not an animation.**
Anything that runs on `--state-duration` — the press tint, the checked row, the
ledge opening — is a control arriving at its new state, and instant would read as
a bug on a 120Hz screen. Anything with a keyframe, a stagger or a travel is
motion, and there is one of those. Decided 2026-08-19 with the ledge
([holistic-response §4](docs/design/holistic-response.md)); before that the rule
said "one animation" flatly and the ledge would have had to snap.

Two faces, two speakers: Familjen Grotesk for everything the user wrote, DM Mono
for everything the app says about itself. `public/fonts/` is **committed output**,
regenerated by `scripts/subset-fonts.sh` only when the design bundle ships new
source TTFs — not a build step. Anything added there goes in `SHELL` in
`public/sw.js` too, or a cold offline start silently renders in the fallback stack.

Design decisions come from a **separate Claude Design session**, not from here. Do
not invent colours, type, motion or icons; ask for a bundle.

**Every route resolves a principal.** `authenticate(request, env)` returns
`Principal | null`; handlers key off `principal.id` and never ask whether the
passphrase matched. Bearer auth is first-class on every `/api/*` route, not an
agent afterthought — cookie-only must not creep into a route.

`/mcp` is the one route that goes further: it resolves a principal and then
**refuses anything that is not bearer.** That is deliberate and load-bearing —
it is what keeps `/mcp` free of ambient authority, which is the premise of
logging a foreign `Origin` rather than blocking it (spec §10). Do not "fix" it
by letting the cookie through.

Since [ADR-005](docs/adr/ADR-005-mcp-oauth.md) there are **two** bearer
credentials and the rule is unchanged by both. `KNAG_BEARER_TOKEN` is compared
locally and reaches Claude Code; an OAuth access token can only be validated by
the provider, which is why `handleMcp` takes a resolved `Principal` rather than
deriving one. Both arrive as `Authorization: Bearer`; neither is a cookie.

The cookie appears at **`/oauth/authorize`** and nowhere else — a browser, once,
to establish consent. That endpoint is the mirror image of `/mcp`: it accepts the
session and **refuses the bearer**, because a grant minted from a header is a
grant nobody agreed to.

**Secrets never enter `worker/wrangler.jsonc`.** It is committed.
`wrangler secret put`.

**Migrations are additive-only.** `make migrate` runs *before* `make deploy`, so
between the two the **currently deployed Worker is running against the new
schema**. A new table, a new nullable column, a new index — fine.

Anything destructive takes **three** releases, not two: expand (add, write both, read
new), then **stop writing the old one**, then contract (drop). 🔴 The middle release
carries no migration at all, which is exactly what makes it look skippable — and it is
the one that does the work. Without it, the Worker live during the contract migration is
still the one that writes both, so the drop lands underneath a live writer. #155 is the
worked example.

Violating this does not produce a failed deploy. It produces a live Worker
writing to a column that no longer exists, against the only copy of the document.
`make backup` first, always. Full reasoning:
[ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md) §3.

**Deploying is CI's job, and the two workflows mirror each other.** Dev ships on
every merge to `main` (`deploy-dev.yml`); prod ships from Actions → Deploy to
production, manually (`deploy-prod.yml`). Tagging a release deploys nothing. The
prod Cloudflare token is not on this machine by design, and `ENV=dev` is the
default for every Make target.

Both workflows run the same five steps — `backup → migrate → deploy → health →
verify` — and that is deliberate: dev is the rehearsal for a prod deploy, which is
why **a change to one belongs in both unless it is a deliberate divergence.** The
divergences are enumerated in [docs/deployment.md](docs/deployment.md), which is
also where the API token permissions and the provisioning steps live. An unlisted
difference between the two files is indistinguishable from drift.

**knag is in release mode**, as of `v0.1.11` — the cap on the build phase. That
means the version bump **and** a `CHANGELOG.md` entry land *in the feature PR*, not
at release time when the reason for the change has been forgotten. After merge:
a `vX.Y.Z` tag and a GitHub Release with curated notes, never a raw commit dump.

Next feature starts `0.2.0`. Full doctrine lives in the house versioning guide.

🔴 **The second half is the half that gets skipped.** The bump lands in the PR because it
is part of the diff; the tag only happens if someone remembers, and twice it has not —
`v0.4.0` through `v0.6.0` shipped untagged and were backfilled, then `v0.7.0` did the same
three days later. Nothing fails when this happens: `git describe` quietly disagrees with
`package.json` and every CHANGELOG compare link points at a tag that does not exist.
`make info` now prints that disagreement, so the answer to "did I actually release that"
is one command rather than an archaeology exercise.

Every deployment reports `<version>+<shortsha>`, when it was deployed, and **which
environment** — the last being the one people skip and then need, because a deploy
that looks right and went to the wrong place is indistinguishable from one that
failed. `KNAG_ENV` is declared in *both* wrangler env blocks and baked by the
Makefile and *both* deploy workflows; a var set in only one of those reports the
wrong environment in the other.

## Agent contract

When writing to knag through MCP:

- **Byte-preserve every line not explicitly targeted.** Whole-document write is
  the only write tool; surgical edits only, nothing else touched.
- **Always read immediately before writing.** Never write from a body carried
  over from earlier in a conversation.
- **Report the diff in chat** after every write — added, removed, changed, **and which
  page**. Once there are several, "the page" stops being an answer.
- **On 409, re-read and re-apply the intent.** Never retry with the stale body.
- **Name the page you read, and write to that one.** Every tool takes an optional `page`
  by name; `knag_read` echoes back the name it answered with. An unrecognised name is an
  error listing what exists — it **never** falls back to the default, because a
  whole-page write to the wrong page destroys a document while preserving every byte of
  it (#153). Omitting `page` means the default page and never "the one you were last
  looking at": the Worker has no current page.

## Testing

Real D1 through `@cloudflare/vitest-pool-workers`, with the real migrations
applied. Mocking a binding tests the mock. `pnpm test:security` runs the auth
suite alone.

**One runtime, and `wrangler` is pinned exact to keep it that way** (#74). miniflare
is the local Workers runtime, and it arrives twice — once via the test pool and once
via wrangler. When those resolve to different versions the unit suite and the browser
suite execute on **different runtimes**, and a bug that reproduces in one and not the
other costs an afternoon before anyone suspects the tooling. `^4.110.0` did exactly
that: a caret on a tool that ships a runtime is looser than it looks, and 4.117.0
swapped it silently.

There is no stable miniflare 5 — every 5.x release is an alpha and Cloudflare points
`latest` at one — so this is not a choice between alpha and stable. It is a choice
between one runtime and two, and `package.json` carries the reason in `//pins`.

## Scope

The **Out** list in [docs/spec.md](docs/spec.md) §12 is load-bearing: search,
tags, multiple documents, offline editing, WebSockets, multi-user, rich
formatting. If a weekend turns into two, something from that list came back.

§17 records what a larger future would break and what was done about it — read it
before making an architectural decision, not after.

**What is being built next, and why in that order, is
[docs/roadmap.md](docs/roadmap.md).** The board holds the cards and their status;
the roadmap holds the sequence and the reasoning. Spec §13's build order is
history — it ran the build phase and stops well before the present.
