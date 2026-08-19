<p align="center">
  <img src="docs/assets/knag-wordmark.svg" alt="knag" width="440">
</p>

<p align="center">
  <em>One plain-text page. Always live. Edited from any device, and by your agent.</em>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#agent-access">Agent access</a> ·
  <a href="#deploying">Deploying</a> ·
  <a href="docs/spec.md">Spec</a> ·
  <a href="docs/roadmap.md">Roadmap</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

**knag makes throwing things away feel good.**

That is the whole product, and every part of it serves that:

- **The nag** is the tension. A list nags by *existing*, not by notifying. You open it
  and it is still there, in your own words, from three weeks ago.
- **The wipe** is the release. A clean board every morning.
- **The record** is what makes the release free. Without it, throwing away a
  half-finished list is a small act of anxiety and you hesitate over every line. With
  it, you wipe without thinking about it.

> Wipe it. It's in the history.
> No notifications. It nags anyway.

*knag* — archaic, a peg driven into a wall to hang things on. It also reads as "nag."
Both meanings are the product.

It is **not** a note system, not a task manager, not a second brain. There is one page,
it is always the same page, and there is no search, no tags, no folders, no due dates
and no notifications. There never will be — [the *Out* list](docs/spec.md#12-scope) is
load-bearing.

## What it is

A **board you wipe.** Not paper, not a legal pad. The difference from a real board —
and the whole point — is that a real board has no memory. knag wipes and keeps the
receipt.

| | |
|---|---|
| **One page** | Plain text. Bytes in, bytes out — indentation, blank lines, trailing whitespace and CRLF all survive a round trip. |
| **Always live** | Polled sync across every device, with optimistic concurrency. Open it on the phone, keep typing on the laptop. |
| **Checkboxes** | `- [ ] milk` is a checkbox at any indentation. Checked rows dim and strike **and stay** — that is the nag working. |
| **Ordinary editing** | Select, copy, cut and delete across lines, the way you can everywhere else. One document rather than one field per line — [ADR-007](docs/adr/ADR-007-one-editing-surface.md). |
| **Wipe** | Clears the finished rows, or the whole page. One tap, and `wiped 6 · bring back` sits above the footer until the next one. |
| **Two boards** | **Slate** — chalk on a blackboard, the default. **Whiteboard** — marker on dry-erase. No third board. |
| **Your agent** | Claude reads and writes the same page you do, over MCP. Not a feature bolted on: it is why the page is one plain-text document. |

**The display never diverges from the bytes.** No rendered bold, no styled headings, no
bullet where the file says `-`. The test for any new rendering is whether the file can
be reconstructed byte-for-byte from what is on screen — checkboxes and linkified URLs
pass, rendered markdown does not. That is
[ADR-004](docs/adr/ADR-004-display-matches-the-bytes.md), and it is decided.

## Stack

Cloudflare Worker + D1, TypeScript throughout, no framework.

- **Worker** — API, auth, and an MCP server at `/mcp`, all in one entry point
- **D1** — the live page, a coalesced revision log, and a record of wiped items
- **PWA** — served from Workers Static Assets; add to home screen on iOS, dock on macOS
- **`esbuild`** — one command, bundles `client/src/app.ts` → `public/app.js`

The one thing that would be surprising: **the block parser is shared.** The Worker needs
it to wipe completed items, the client needs it to render rows, and it exists exactly
once in `worker/src/blocks.ts`. That single fact is why there is a TypeScript build step
in a project that otherwise wants none — two parsers enforcing a byte-preservation
contract by hand is the most likely way this corrupts a page. See
[docs/spec.md](docs/spec.md) §2.

**Two typefaces, two voices.** Familjen Grotesk is the human voice — the page, the rows,
the words you wrote. DM Mono is the machine voice — save status, counts, the wordmark,
build info. Amber is the only colour in the interface; a third colour means something
went wrong. Both faces are SIL OFL and self-hosted from `public/fonts/`, subset by
[`scripts/subset-fonts.sh`](scripts/subset-fonts.sh) — committed output, not a build
step.

## Quick start

```bash
make setup            # install, create .env, report what's missing
make migrate ENV=local
make dev
```

The dev D1 id is committed in `worker/wrangler.jsonc` — a database id is not a secret.
`make migrate ENV=local` targets a **local** SQLite file, so `make dev` needs no
Cloudflare credential at all. That is the whole of what this repo can give you.

Reaching a real deployment needs three things it cannot: a Cloudflare account, a
`CLOUDFLARE_API_TOKEN` in `.env.local`, and the `KNAG_PASSPHRASE` / `KNAG_BEARER_TOKEN`
secrets set on the Worker. Copy `.env.example` to `.env` and fill in your own account id
and hosts; `make preflight` then tells you whether the credential you have points where
you think it does.

`make help` lists everything. `ENV` is a variable, never a target suffix —
`make deploy ENV=prod` — and it defaults to `dev`.

```bash
make check           # typecheck + unit tests — the gate, and exactly what CI runs
make test-browser    # Playwright against WebKit, one dev server per spec file
```

WebKit only. iOS mandates it, so Safari's engine is the one that has to be right;
testing Chromium would report on a browser knag never runs on.

## Deploying

Two Cloudflare accounts, separated by **which credential is active**, not by anything in
the config:

| | Ships on | Credential lives in |
|---|---|---|
| **dev** | every merge to `main`, automatically | a `development` GitHub Environment secret |
| **dev** | `make deploy`, on demand | `.env.local` in your clone |
| **prod** | a manual click | a `production` GitHub Environment secret |

The prod token is never on the laptop, which is what makes a stray deploy from a scratch
clone unable to reach production. Ship prod from **Actions → Deploy to production**,
manually. Tagging a release deploys nothing — the version names the code; deploying is
the decision to adopt it.

Dev is the opposite: it tracks `main` with no reviewer and no way to skip migrations,
because dev tracking `main` is not a decision. The point of automating it was never the
saved command — it is that the five steps below now run on every merge, so the first
production deploy is a rehearsed sequence rather than a first attempt. Setting the
pipeline up from nothing, including the exact API token permissions, is in
[docs/deployment.md](docs/deployment.md).

The upgrade order is not negotiable:

```bash
make check                 # the gate
make backup ENV=prod       # D1 → backups/, before anything
make migrate ENV=prod      # additive only
make deploy ENV=prod       # bakes <version>+<sha> into /health
make health ENV=prod       # asserts the live deployment is this checkout
make verify ENV=prod       # smoke-tests routes, fonts and icons
```

**Between `migrate` and `deploy`, the deployed Worker is running against the new
schema.** Every migration must be backward-compatible with it. Additive changes are
free; anything destructive takes two releases — expand, then contract. This is the one
rule whose violation does not produce a failed deploy: it produces a Worker writing to a
column that no longer exists, against the only copy of the page. See
[ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md).

Secrets are never in `wrangler.jsonc`, and differ per environment:

```bash
pnpm exec wrangler --config worker/wrangler.jsonc secret put KNAG_PASSPHRASE
pnpm exec wrangler --config worker/wrangler.jsonc --env prod secret put KNAG_PASSPHRASE
```

**One manual step Cloudflare cannot infer:** add a WAF rate-limiting rule on
`POST /api/login` in the zone dashboard. A single passphrase field on a public URL is
brute-forceable, and the free tier includes one rule. It covers a **custom domain only**
— which is why a `*.workers.dev` dev host needs a different passphrase and holds test
content only. See [docs/spec.md](docs/spec.md) §4.2.

## Agent access

The MCP server lives at `/mcp`, with four tools: `knag_read`, `knag_write`, `knag_wipe`,
`knag_history`. One write tool, not three — the page is small enough that
read-modify-write beats inventing append/patch/delete semantics.

**Bearer only**, unlike the rest of the API: the session cookie is refused here even
though it is valid everywhere else. That is what keeps `/mcp` free of ambient authority,
which is in turn why a foreign `Origin` is logged rather than blocked — see
[docs/spec.md](docs/spec.md) §10.

There are two ways to hold a bearer, and which one you want depends only on the client
([ADR-005](docs/adr/ADR-005-mcp-oauth.md)).

**From claude.ai, Claude Desktop or mobile** — add your deployment's URL as a custom
connector and approve it in the browser. Nothing to paste:

```
https://<your-knag-host>/mcp
```

The connector registers itself, sends you to knag's consent screen, and the screen sends
you to the ordinary login if you are not already signed in — so the passphrase is only
ever typed into the real login form.

**From Claude Code**, which can carry a header and does not need the handshake:

```bash
claude mcp add --transport http --scope user knag https://<your-knag-host>/mcp \
  --header "Authorization: Bearer ${KNAG_BEARER_TOKEN}"
```

Use `--scope user` rather than the default, so the connector is available in every
project. **Never `--scope project`:** that writes the token into `.mcp.json` in the repo.

There is no history screen in the app, so `knag_history` is currently how history gets
read.

## Docs

| | |
|---|---|
| [docs/spec.md](docs/spec.md) | The build spec — data model, API, sync rules, block grammar. §12 is the scope boundary; §17 is what a larger future would break. |
| [docs/roadmap.md](docs/roadmap.md) | What is being built next and why in that order. The board holds the cards; this holds the sequence. |
| [docs/philosophy.md](docs/philosophy.md) | Why throwing things away is the product, and where that sits in a long argument about lists. §5 answers feature requests before they arrive. |
| [docs/deployment.md](docs/deployment.md) | The runbook — what ships where, provisioning a pipeline from nothing, and what a failure at each step means. |
| [CHANGELOG.md](CHANGELOG.md) | What changed and why, per release. |
| [ADR-001](docs/adr/ADR-001-passphrase-auth.md) | Why this rolls its own sessions instead of using Cloudflare Access. |
| [ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md) | Two Cloudflare accounts, and why migrations are additive-only. |
| [ADR-003](docs/adr/ADR-003-single-mode-editor.md) | Why there is one editing mode, reversing the spec's original two-view design. Its mechanism is amended by ADR-007. |
| [ADR-004](docs/adr/ADR-004-display-matches-the-bytes.md) | The display never diverges from the bytes. Read before answering a formatting request. |
| [ADR-005](docs/adr/ADR-005-mcp-oauth.md) | Why `/mcp` needs OAuth as well as a static bearer. |
| [ADR-006](docs/adr/ADR-006-cross-row-selection.md) | What a hand-rolled `contenteditable` did to the document. Decision 1 is superseded by ADR-007; the measurement is why. |
| [ADR-007](docs/adr/ADR-007-one-editing-surface.md) | One editing surface, owned by CodeMirror. Amends ADR-003's mechanism while upholding its intent. |
| [docs/reviews/](docs/reviews/) | The brief written for outside review of the editing surface, and the review that came back. ADR-007 is the decision; these are the argument. |

The spec refers to a set of house standards — a private, personal collection covering
Node, Cloudflare, MCP and release practice. Where one of its rules matters here it is
quoted inline, so nothing in this repo depends on reading it.

## Status

Personal software, run by one person, in the open because there is no reason not to be.
It works and it is used daily, but it assumes a Cloudflare account, one operator and a
shared passphrase — see [ADR-001](docs/adr/ADR-001-passphrase-auth.md) for exactly when
that stops being reasonable. No support, no roadmap promises, and issues are for my own
tracking.

## License

MIT.
