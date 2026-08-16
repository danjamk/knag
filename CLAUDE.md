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
- **`assets.run_worker_first` in `worker/wrangler.jsonc` lists the only paths
  that reach the Worker.** Everything else is static. A new route needs adding in
  both places, and forgetting the config half produces a 404 that looks like a
  routing bug in `index.ts`.

## Layout

```
worker/src/         Worker: routes, auth, store, blocks, MCP
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
a handler. That chokepoint is what keeps a future schema change to one file.
The single-row id is the `DOC_ID` constant there, never a literal `1`.

**Every route resolves a principal.** `authenticate(request, env)` returns
`Principal | null`; handlers key off `principal.id` and never ask whether the
passphrase matched. Bearer auth is first-class on every `/api/*` route, not an
agent afterthought — cookie-only must not creep into a route.

`/mcp` is the one route that goes further: it resolves a principal and then
**refuses anything that is not bearer.** That is deliberate and load-bearing —
it is what keeps `/mcp` free of ambient authority, which is the premise of
logging a foreign `Origin` rather than blocking it (spec §10). Do not "fix" it
by letting the cookie through.

**Secrets never enter `worker/wrangler.jsonc`.** It is committed.
`wrangler secret put`.

**Migrations are additive-only.** `make migrate` runs *before* `make deploy`, so
between the two the **currently deployed Worker is running against the new
schema**. A new table, a new nullable column, a new index — fine. Anything
destructive takes two releases: expand (add, write both, read new), then contract
(backfill, drop) in a later release.

Violating this does not produce a failed deploy. It produces a live Worker
writing to a column that no longer exists, against the only copy of the document.
`make backup` first, always. Full reasoning:
[ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md) §3.

**Prod is CI's job.** The prod Cloudflare token is not on this machine by design;
`ENV=dev` is the default for every target. Production ships from Actions →
Deploy to production, manually. Tagging a release does not deploy anything.

**knag is in release mode**, as of `v0.1.11` — the cap on the build phase. That
means the version bump **and** a `CHANGELOG.md` entry land *in the feature PR*, not
at release time when the reason for the change has been forgotten. After merge:
a `vX.Y.Z` tag and a GitHub Release with curated notes, never a raw commit dump.

Next feature starts `0.2.0`. Full doctrine:
`~/yukon/claude-shared/docs/guides/versioning-and-releases.md`.

Every deployment reports `<version>+<shortsha>`, when it was deployed, and **which
environment** — the last being the one people skip and then need, because a deploy
that looks right and went to the wrong place is indistinguishable from one that
failed. `KNAG_ENV` is declared in *both* wrangler env blocks and baked by both the
Makefile and `deploy-prod.yml`; a var set in only one of those reports the wrong
environment in the other.

## Agent contract

When writing to knag through MCP:

- **Byte-preserve every line not explicitly targeted.** Whole-document write is
  the only write tool; surgical edits only, nothing else touched.
- **Always read immediately before writing.** Never write from a body carried
  over from earlier in a conversation.
- **Report the diff in chat** after every write — added, removed, changed.
- **On 409, re-read and re-apply the intent.** Never retry with the stale body.

## Testing

Real D1 through `@cloudflare/vitest-pool-workers`, with the real migrations
applied. Mocking a binding tests the mock. `pnpm test:security` runs the auth
suite alone.

## Scope

The **Out** list in [docs/spec.md](docs/spec.md) §12 is load-bearing: search,
tags, multiple documents, offline editing, WebSockets, multi-user, rich
formatting. If a weekend turns into two, something from that list came back.

§17 records what a larger future would break and what was done about it — read it
before making an architectural decision, not after.
