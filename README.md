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

It is **not** a note system, not a task manager, not a second brain. There are up to nine
pages, they are always the same nine pages, and there is no search, no tags, no folders,
no due dates and no notifications. There never will be — [the *Out*
list](docs/spec.md#12-scope) is load-bearing.

## What it is

A **board you wipe.** Not paper, not a legal pad. The difference from a real board —
and the whole point — is that a real board has no memory. knag wipes and keeps the
receipt.

| | |
|---|---|
| **A handful of pages** | Plain text, up to nine of them. Bytes in, bytes out — indentation, blank lines, trailing whitespace and CRLF all survive a round trip. The cap is in the code, because a number you have to remember is a hope. |
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

Then open the printed URL, type **`you@example.com`**, and read the six-digit code out of
the terminal — locally there is no mail service, so the login mail is printed to the log
instead. That address is what `pnpm dev` passes as `KNAG_OPERATOR_EMAIL`; any other
address is a stranger and gets nothing, which is the same thing the deployed app does.

The dev D1 id is committed in `worker/wrangler.jsonc` — a database id is not a secret.
`make migrate ENV=local` targets a **local** SQLite file, so `make dev` needs no
Cloudflare credential at all. That is the whole of what this repo can give you.

To use it from a phone on the same wifi, `bash scripts/dev-lan.sh` serves the same local
database over https with a self-signed certificate, and prints the code the same way.

Reaching a real deployment needs three things it cannot: a Cloudflare account, a
`CLOUDFLARE_API_TOKEN` in `.env.local`, and the `KNAG_OPERATOR_EMAIL`, `RESEND_API_KEY`
and `KNAG_BEARER_TOKEN` secrets set on the Worker. Copy `.env.example` to `.env` and fill in your own account id
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
free; anything destructive takes three — expand, stop writing the old thing, then
contract. This is the one
rule whose violation does not produce a failed deploy: it produces a Worker writing to a
column that no longer exists, against the only copy of the page. See
[ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md).

Secrets are never in `wrangler.jsonc`. Three of them, per environment
([ADR-008](docs/adr/ADR-008-email-login.md)):

```bash
pnpm exec wrangler --config worker/wrangler.jsonc secret put KNAG_OPERATOR_EMAIL   # your address
pnpm exec wrangler --config worker/wrangler.jsonc secret put RESEND_API_KEY        # the login mail
pnpm exec wrangler --config worker/wrangler.jsonc secret put KNAG_BEARER_TOKEN     # agents
# and the same three with --env prod
```

**Logging in is your email address.** Type it, get a mail carrying a link and a
six-digit code; tap the link on a desktop, type the code on a phone. The first request
that names `KNAG_OPERATOR_EMAIL` claims the operator row — after that the address lives
in the database, not the secret. Mail goes out through [Resend](https://resend.com):
verify the sending domain there (three DNS records) and set `KNAG_MAIL_FROM` in
`worker/wrangler.jsonc` to an address on it. Without `RESEND_API_KEY`, a local
`wrangler dev` prints the code in the terminal instead of sending anything.

**One manual step Cloudflare cannot infer:** add a WAF rate-limiting rule on
`POST /api/login` in the zone dashboard — it is a send-mail-to-this-address endpoint on
a public URL, and the free tier includes one rule. The Worker also throttles each
address to one mail a minute and five an hour. The WAF rule covers a **custom domain
only** — which is why a `*.workers.dev` dev host tags its mails `[dev]` and holds test
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
you to the ordinary login if you are not already signed in — so you only ever log in
through the real login form.

**From Claude Code**, which can carry a header and does not need the handshake:

```bash
claude mcp add --transport http --scope user knag https://<your-knag-host>/mcp \
  --header "Authorization: Bearer ${KNAG_BEARER_TOKEN}"
```

Use `--scope user` rather than the default, so the connector is available in every
project. **Never `--scope project`:** that writes the token into `.mcp.json` in the repo.

The app has had its own history pane since 1.2.0, reading the same route; `knag_history`
is how an *agent* reaches it, and it is the only way to reach further back than the pane
shows.

## Docs

| | |
|---|---|
| [docs/spec.md](docs/spec.md) | The build spec — data model, API, sync rules, block grammar. §12 is the scope boundary; §17 is what a larger future would break. |
| [docs/roadmap.md](docs/roadmap.md) | What is being built next and why in that order. The board holds the cards; this holds the sequence. |
| [docs/philosophy.md](docs/philosophy.md) | Why throwing things away is the product, and where that sits in a long argument about lists. §5 answers feature requests before they arrive. |
| [docs/deployment.md](docs/deployment.md) | The runbook — what ships where, provisioning a pipeline from nothing, and what a failure at each step means. |
| [CHANGELOG.md](CHANGELOG.md) | What changed and why, per release. |
| [ADR-001](docs/adr/ADR-001-passphrase-auth.md) | Why this rolls its own sessions instead of using Cloudflare Access. The passphrase half is superseded by ADR-008; the case against Access is not. |
| [ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md) | Two Cloudflare accounts, and why migrations are additive-only. |
| [ADR-003](docs/adr/ADR-003-single-mode-editor.md) | Why there is one editing mode, reversing the spec's original two-view design. Its mechanism is amended by ADR-007. |
| [ADR-004](docs/adr/ADR-004-display-matches-the-bytes.md) | The display never diverges from the bytes. Read before answering a formatting request. |
| [ADR-005](docs/adr/ADR-005-mcp-oauth.md) | Why `/mcp` needs OAuth as well as a static bearer. |
| [ADR-006](docs/adr/ADR-006-cross-row-selection.md) | What a hand-rolled `contenteditable` did to the document. Decision 1 is superseded by ADR-007; the measurement is why. |
| [ADR-007](docs/adr/ADR-007-one-editing-surface.md) | One editing surface, owned by CodeMirror. Amends ADR-003's mechanism while upholding its intent. |
| [ADR-008](docs/adr/ADR-008-email-login.md) | Email login for a few invited people — a link and a code — superseding ADR-001's passphrase while keeping its case against Access. |
| [docs/reviews/](docs/reviews/) | The brief written for outside review of the editing surface, and the review that came back. ADR-007 is the decision; these are the argument. |
| [docs/design/](docs/design/) | Briefs and rulings. Every visual decision — colour, type, motion, icons — is made in a separate Claude Design session and arrives as a written response; a brief is the question, a response is the answer. [holistic-response.md](docs/design/holistic-response.md) is the most cited. |

The spec refers to a set of house standards — a private, personal collection covering
Node, Cloudflare, MCP and release practice. Where one of its rules matters here it is
quoted inline, so nothing in this repo depends on reading it.

## Hosting knag for other people

knag is invite-only and has no sign-up page. One person — the **operator** — deploys it
and invites everyone else by address, from a `people` pane the app shows to nobody else.
That is the whole model, and the numbers behind it are small on purpose: **25 people**
(`MAX_USERS`), nine pages each, on Cloudflare's free tier. The arithmetic is in
[spec §14.4](docs/spec.md): a device polling all day is ~4k requests, and the free tier is
100k a day, so the cap is about leaving room rather than about capacity. Moving it is one
constant and $5 a month.

**What a fork has to replace.** Everything in `worker/wrangler.jsonc` names *this*
deployment's resources. None of it is a secret and all of it is wrong for you:

| In `worker/wrangler.jsonc` | Replace with |
|---|---|
| `d1_databases[].database_id` — **twice**, top level and `env.prod` | your own D1 databases (`wrangler d1 create`) |
| `kv_namespaces[].id` — **twice** | your own KV namespaces (`wrangler kv namespace create`). This one is easy to miss and fails on the *first OAuth handshake in production*, long after the deploy looked fine |
| `name` — twice | your Worker names |
| `env.prod.routes` | your domain, or delete it and use a `*.workers.dev` hostname |
| `KNAG_MAIL_FROM` — twice | an address on a domain **you** have verified in Resend |
| `KNAG_TZ` — twice | your zone. It sets the day boundary for history and the wipe, and it is **one value for the whole deployment** — everyone you invite gets your midnight |

**Three secrets**, per environment, via `wrangler secret put`:
`KNAG_OPERATOR_EMAIL` (yours — the first login that names it claims the operator row),
`RESEND_API_KEY`, and `KNAG_BEARER_TOKEN` (the agent credential; make it different in each
environment).

**Mail** goes through [Resend](https://resend.com) — free tier, 3,000 a month, which at
twenty-five people logging in once a device is two orders of magnitude of headroom. Verify
a sending domain (three DNS records), set the key, done. Without it nothing sends and the
Worker logs a configuration error; there is no other way in, because the login link exists
only in the mail.

**The two-account split is a choice, not a requirement.** This deployment keeps dev and
prod on separate Cloudflare accounts so a stray credential cannot reach production
([ADR-002](docs/adr/ADR-002-two-accounts-and-migrations.md)). One account works fine —
use the top-level config and ignore `env.prod`. Full provisioning, including the exact
API token permissions, is in [docs/deployment.md](docs/deployment.md).

## What the operator can see

If someone invites you to their knag, this is the honest answer.

**The admin view shows counts and dates, never content.** Per person: the address, when
they joined, when a device was last seen, how many devices and pages they have, and — over
thirty days — how many editing sessions, how many of those were their agent, how many
wipes, and how many items they finished. **No page text, ever**, and that is enforced in
the query rather than in the interface ([ADR-008](docs/adr/ADR-008-email-login.md) §11).
The view exists to answer one question: *is this still inside the free tier?*

**But the operator holds the database.** They can read any page directly through
Cloudflare, and the nightly backup is a plain dump of everyone's pages. No design decision
changes that, and no claim in this repo should be read as if it did. **Host with people
you would tell your shopping list to, and do not put anything in knag you would not.**

**What the operator can do:** invite, change your address — the only recovery lever there
is, since losing the address is the one thing you cannot fix yourself — revoke you, which
keeps your pages and ends every session, or delete you, which removes every row you own.

**What nobody can do:** read your page in the app. Pages have exactly one owner and there
is no sharing — not withheld, not built ([ADR-008](docs/adr/ADR-008-email-login.md) §7).
Two people who want one list share an account.

## Status

Personal software, run by one person, in the open because there is no reason not to be.
It works and it is used daily, but it assumes a Cloudflare account and one operator
hosting a few people they know — see [ADR-008](docs/adr/ADR-008-email-login.md) for the
shape of that, and [ADR-001](docs/adr/ADR-001-passphrase-auth.md) for why it is not
Cloudflare Access. No support, no roadmap promises, and issues are for my own
tracking.

## License

MIT.
