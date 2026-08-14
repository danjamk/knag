# knag

One plain-text document. Always live. Edited from any device, and by the agent.

*knag* — archaic, a peg driven into a wall to hang things on. Also reads as
"nag." Both meanings are the product.

It replaces the legal pad when you are away from your desk. It is not a note
system, not a task manager, and not a second brain. There is one document, it is
always the same document, and deleting from it is not losing it — a coalesced
revision log keeps everything.

## Stack

Cloudflare Worker + D1, TypeScript throughout, no framework.

- **Worker** — API, auth, and an MCP server at `/mcp`, all in one entry point
- **D1** — the live document, a coalesced revision log, and a record of swept items
- **PWA** — served from Workers Static Assets; add to home screen on iOS, dock on macOS
- **`esbuild`** — one command, bundles `client/src/app.ts` → `public/app.js`

The one thing that would be surprising: **the block parser is shared.** The
Worker needs it to clear completed items, the client needs it to render rows, and
it exists exactly once in `worker/src/blocks.ts`. That single fact is why there
is a TypeScript build step in a project that otherwise wants none — two parsers
enforcing a byte-preservation contract by hand is the most likely way this
corrupts a document. See [docs/spec.md](docs/spec.md) §2.

## Quick start

```bash
make setup                                 # install, create .env, report what's missing
pnpm exec wrangler d1 create knag-dev      # paste the id into worker/wrangler.jsonc
make migrate ENV=local
make dev
```

`make help` lists everything. `ENV` is a variable, never a target suffix —
`make deploy ENV=prod` — and it defaults to `dev`.

## Deploying

Two Cloudflare accounts, separated by **which credential is active**, not by
anything in the config:

| | Credential lives in | Who can deploy |
|---|---|---|
| **dev** | `.env.local` in your clone | you, locally — every `make deploy` |
| **prod** | a GitHub Environment secret | only `deploy-prod.yml` |

The prod token is never on the laptop, which is what makes a stray deploy from a
scratch clone unable to reach production. Ship prod from **Actions → Deploy to
production**, manually. Tagging a release deploys nothing — the version names the
code; deploying is the decision to adopt it.

The upgrade order is not negotiable:

```bash
make check                 # typecheck + test — the gate, and exactly what CI runs
make backup ENV=prod       # D1 → backups/, before anything
make migrate ENV=prod      # additive only
make deploy ENV=prod       # bakes <version>+<sha> into /health
make health ENV=prod       # asserts the live deployment is this checkout
```

**Between `migrate` and `deploy`, the deployed Worker is running against the new
schema.** Every migration must be backward-compatible with it. Additive changes
are free; anything destructive takes two releases — expand, then contract. This
is the one rule whose violation does not produce a failed deploy, it produces a
Worker writing to a column that no longer exists, against the only copy of the
document. See [ADR-0002](docs/adr/0002-two-accounts-and-migrations.md).

Secrets are never in `wrangler.jsonc`, and differ per environment:

```bash
pnpm exec wrangler --config worker/wrangler.jsonc secret put KNAG_PASSPHRASE
pnpm exec wrangler --config worker/wrangler.jsonc --env prod secret put KNAG_PASSPHRASE
```

**One manual step Cloudflare cannot infer:** add a WAF rate-limiting rule on
`POST /api/login` in the zone dashboard. A single passphrase field on a public
URL is brute-forceable, and the free tier includes one rule. It covers the
custom domain only — which is why dev, on a `*.workers.dev` host, needs a
different passphrase and holds test content only. See
[docs/spec.md](docs/spec.md) §4.2.

## Agent access

The MCP server lives at `/mcp`, bearer-authenticated, with four tools:
`knag_read`, `knag_write`, `knag_clear`, `knag_history`. One write tool, not
three — the document is small enough that read-modify-write beats inventing
append/patch/delete semantics.

```json
{
  "name": "knag",
  "url": "https://knag.danjamkuhn.com/mcp",
  "headers": { "Authorization": "Bearer ${KNAG_BEARER_TOKEN}" }
}
```

## Docs

- [docs/spec.md](docs/spec.md) — the build spec: data model, API, sync rules,
  block grammar, build order
- [docs/adr/0001-passphrase-auth.md](docs/adr/0001-passphrase-auth.md) — why this
  rolls its own sessions instead of using Cloudflare Access

## License

MIT.
