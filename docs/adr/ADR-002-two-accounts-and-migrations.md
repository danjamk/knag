# ADR-002: Two Cloudflare accounts, and the migration window

**Status:** Accepted
**Date:** 2026-08-14
**Supersedes:** the single-environment decision in an earlier draft of spec §15

## Context

Two things arrived together and interact.

**First**, there are two Cloudflare accounts — dev and prod. An earlier draft of
this spec chose a single environment on the reasoning that a staging copy of a
personal scratchpad is pointless. That reasoning was about *usefulness* and
missed what the house standard's split is actually for: not testing, but keeping
the production credential off the laptop.

**Second**, knag stores in D1, and D1 has migrations. `pagevault` — the closest
analog in every other respect — stores in KV, which is schemaless, so its
upgrade story is "deploy the Worker" and nothing else. That does not transfer.
An upgrade here is two operations against two systems, and there is a window
between them.

## Decision

### 1. Two accounts, split by credential

| | Credential lives in | Who can deploy |
|---|---|---|
| **dev** | `CLOUDFLARE_API_TOKEN` in this clone's `.env.local` | you, locally — every `make deploy` |
| **prod** | a GitHub Environment secret on `production` | only `.github/workflows/deploy-prod.yml` |

**The prod token is never on this machine.** `worker/wrangler.jsonc`'s `env.prod`
block grants nothing — it names resources. A laptop holding the dev token that
runs `--env prod` fails closed, because the dev token cannot see prod's D1.

**The top level of `wrangler.jsonc` is dev.** Every command that forgets a flag
does the safe thing; production requires saying `--env prod` out loud.

#### 1a. Credential placement is necessary but not sufficient — assert the account

An earlier draft of this ADR called the placement of the token "the entire
mechanism." That was wrong, and the gap is worth stating plainly because it is
invisible until it bites.

`CLOUDFLARE_API_TOKEN` is not wrangler's only credential source. It also honours
a **machine-global OAuth login** from `wrangler login`, stored outside the repo:

```
~/Library/Preferences/.wrangler/config/default.toml
```

**Nothing in this project controls that file.** With no `.env.local` present,
wrangler falls back to it silently. So a developer who ran `wrangler login`
against some account months ago has a machine that will deploy there — and
`ENV=dev` offers no protection, because the default selects a *config block*, not
an *account*. This was live in this repo on 2026-08-14: an ambient OAuth session
with `workers:write`, and no `.env.local` at all.

The fix is an assertion, not a policy. `.env` carries the account id each
environment is allowed to touch, and `scripts/preflight.sh` reads
`wrangler whoami` and fails closed on a mismatch:

```
CF_ACCOUNT_ID_DEV=…
CF_ACCOUNT_ID_PROD=…
```

`make deploy`, `make migrate` and `make backup` all depend on `preflight`. An
unset id **refuses rather than guesses** — the failure mode this closes is
"deployed to the right-looking place," and defaulting would reopen it.

The general lesson, which belongs upstream in the standards: *a credential model
is only as good as its assertion. If the answer to "which account will this
reach" requires reasoning about fallback precedence, it will be wrong eventually.*

### 2. What knag deliberately does *not* copy from pagevault

pagevault reconstructs a `.pagevault.json` intent file from a base64'd GitHub
secret and deploys through `cli/lib/provision/deploy.mjs`. That machinery exists
because a **forker** provisions Access applications, a KV namespace, and a viewer
group in their own account, and the config cannot be committed.

knag provisions one D1 database and two secrets. Its per-account config is a
database id, which is not a secret and is committed. Wrangler's own environments
are enough, and they are the boring tool. Importing the provisioning layer would
be importing an answer to a question knag does not have.

### 3. Migrations are additive-only, and run before the deploy

The upgrade sequence, in this order:

```
make check                    # green
make backup ENV=prod          # D1 → artifact, before anything
make migrate ENV=prod         # additive only
make deploy ENV=prod          # bakes <version>+<sha>
make health ENV=prod          # assert live == checkout
```

**Between `migrate` and `deploy`, the old Worker is running against the new
schema.** So the binding rule:

> Every migration must be backward-compatible with the currently deployed Worker.

Additive changes — a new table, a new nullable column, a new index — satisfy this
for free. Anything destructive does not, and takes two releases:

| Release | Does |
|---|---|
| N | Add the new column/table. Deploy code that writes both and reads the new one, falling back to the old. |
| N+1 | Backfill, then drop the old column. |

This is expand/contract, and it is not optional here. Getting it wrong does not
produce a failed deploy — it produces a Worker writing to a column that no longer
exists, against the only copy of the document.

### 4. Deploy is manual, and versioned separately from release

`deploy-prod.yml` triggers on `workflow_dispatch` only. Tagging a release does
not ship production. The version names the code; deploying is choosing to adopt
it. Same reasoning as pagevault's ADR-010, and the `<version>+<sha>` in `/health`
is what makes "am I running what I think I am running" answerable.

`concurrency: deploy-prod` with `cancel-in-progress: false` — never let two prod
deploys overlap, and never cancel one mid-flight. A half-applied deploy is worse
than a queued one.

## Consequences

**Dev is reachable at a `*.workers.dev` hostname**, and the WAF rate-limit rule
protecting `POST /api/login` is scoped to the `danjamkuhn.com` zone, which lives
on the prod account. Two rules follow, both mandatory:

1. The dev `KNAG_PASSPHRASE` must be **different** from prod's.
2. Dev holds test content only.

**Bindings are declared twice.** Named wrangler environments do not inherit
`d1_databases`, `vars`, `assets`, or `routes`. A binding added to the top level
and not to `env.prod` produces a Worker that works in dev and fails in
production — the same shape of failure `cloudflare.md` warns about for
`nodejs_compat`, where only running it for real surfaces the gap. The config
carries a comment saying so at the point of edit.

**`make backup` is now load-bearing, not hygiene.** It runs before every prod
migration and uploads the dump as a CI artifact. D1 Time Travel covers 30 days,
but Time Travel restores a database — it does not tell you the document was
wrong three deploys ago.

## Alternatives considered

**A generated `wrangler.jsonc` from a secret, as pagevault does.** Rejected: it
solves the forker's problem, which knag does not have. It also puts prod's
configuration somewhere unreviewable.

**One account, two Workers.** Rejected: it puts the credential that can destroy
production on the laptop, which is the one thing the split exists to prevent.

**Deploying prod on a tag push.** Rejected per ADR-010's reasoning — a release is
a statement about code, a deploy is a decision about infrastructure, and coupling
them means every version bump is a production event.

## Revisit when

**A migration genuinely cannot be expressed additively.** The two-release
expand/contract path is the answer, and if it ever becomes routine rather than
rare, the schema is being changed too casually for a store that holds the only
copy of the document.
