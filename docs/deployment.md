# Deployment

How knag ships, what each environment is allowed to touch, and how to provision the
pipeline from nothing.

The decisions behind all of this live in
[ADR-002](adr/ADR-002-two-accounts-and-migrations.md). This document is the operational
half: the commands, the credentials, and what a failure at each step actually means.

## The shape of it

Two Cloudflare accounts, and **which one you reach is decided by which credential is
active** — never by anything in `worker/wrangler.jsonc`, which names resources and grants
nothing.

| Environment | Ships on | Credential lives in | Reaches |
|---|---|---|---|
| **dev** | every merge to `main`, automatically | `development` GitHub Environment | dev account |
| **dev** | `make deploy`, on demand | `.env.local` in your clone | dev account |
| **prod** | manual click, Actions → Deploy to production | `production` GitHub Environment | prod account |

Three credential locations, two accounts. **The prod token is never on a laptop** — that
placement is the guarantee, not a policy: a stray `make deploy ENV=prod` from a scratch
clone fails closed because the machine does not hold the credential.

The split survives the addition of CI deploys only because each token is scoped to a
GitHub **Environment** rather than added as a repo-level secret. `deploy-dev.yml`
declares `development`, `deploy-prod.yml` declares `production`, and `ci.yml` declares
neither. No workflow can read a credential it did not name.

## The sequence, and why the order is not negotiable

Every path — local, dev CI, prod CI — runs the same five steps:

```
backup → migrate → deploy → health → verify
```

🔴 **Migrations run before the deploy.** Between those two steps the *currently
deployed* Worker is running against the *new* schema. That window is the reason
migrations are additive-only and destructive changes take three releases (expand, stop
writing the old thing, then contract). Getting it wrong does not produce a failed deploy — it produces a live Worker
writing to a column that no longer exists, against the only copy of the page.

Locally that is:

```bash
make check
make backup ENV=dev
make migrate ENV=dev
make deploy ENV=dev
make health ENV=dev
make verify ENV=dev
```

In CI it is the step list in `deploy-dev.yml` and `deploy-prod.yml`, which mirror each
other deliberately — the most visible difference being the browser suite that gates prod
and not dev. **A change to one belongs in both unless it is a deliberate divergence** —
every divergence is enumerated at the end of this document, and an unlisted difference is
indistinguishable from drift.

## Provisioning the dev pipeline

Four things, in order. Steps 1–3 are dashboard work that no script can do for you;
step 4 is the merge.

### 1. Mint a dev-scoped Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**.

**Permissions** — all three are *Account*-scoped:

| Permission | Level | Needed by |
|---|---|---|
| **Workers Scripts** | Edit | `wrangler deploy` — the script, the `--var` values, and the static asset upload (assets ride the script-upload API, not a separate one) |
| **D1** | Edit | `d1 migrations apply --remote` **and** `d1 export --remote`. Export is a `POST` that creates a job, so `Read` is not sufficient for either step |
| **Account Settings** | Read | How wrangler identifies the account it is talking to |

**Account Resources: include the dev account only.** This is the line that keeps
ADR-002 intact. A token that can see both accounts makes the environment split
cosmetic — the file boundary would still be there, and it would no longer mean anything.

**Zone Resources: none.** Dev is a `*.workers.dev` hostname; there is no zone.

No client-IP restriction — GitHub-hosted runners have no stable egress addresses. A TTL
is optional and worth setting if you will remember to rotate.

Not needed, despite the binding: **Workers KV Storage**. `OAUTH_KV` is deployed by id in
the script metadata and is not validated against KV permissions at deploy time. If a
deploy ever fails referencing the KV binding, add `Workers KV Storage: Edit`.

#### What this token can do if it leaks

Worth stating plainly, since minting it is a real expansion of blast radius over "no
token exists anywhere":

- Overwrite or delete the dev Worker.
- Read, write, or delete the dev D1 database. D1 Time Travel reaches back **7 days** on
  the free plan — see *What actually protects the data* below; 30 is the paid number and
  this deployment is not on it.
- Overwrite the dev Worker's secrets (`KNAG_OPERATOR_EMAIL`, `RESEND_API_KEY`,
  `KNAG_BEARER_TOKEN`). It **cannot
  read** them — Cloudflare never returns a secret value.
- Nothing on the prod account. Not the Worker, not the database, not the zone.

The bound on all of it is that **dev holds test content only** and sits on a
`*.workers.dev` hostname behind no WAF rate-limit rule. Both of those were already
mandatory (ADR-002 consequences); this token is why they stay mandatory.

### 2. Create the `development` GitHub Environment

Repo **Settings → Environments → New environment**, named `development`.

- **No required reviewers.** Prod keeps its gate; dev is not a decision.
- **No deployment branch rule needed** — the workflow only triggers on `main`.

### 3. Add one secret and two variables to it

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | the dev account id |
| Variable | `DEV_HOST` | the dev `*.workers.dev` hostname |

Both of the last two are **variables, not secrets**, and both are load-bearing for
reasons that are easy to miss:

🔴 **`CLOUDFLARE_ACCOUNT_ID`.** With no account id in the environment, wrangler resolves
the account by calling `GET /accounts` — a lookup that a token scoped tightly to one
account can fail. Setting it explicitly skips the lookup entirely. This was missing from
`deploy-prod.yml` until `deploy-dev.yml` was written, and because that workflow had
never executed, it would have surfaced for the first time on the first step of a first
production deploy.

🔴 **`DEV_HOST`.** The dev hostname is **not** in any tracked file, on purpose. It is a
live login form on a hostname the WAF rate-limit rule cannot cover — that rule attaches
to a custom domain only (spec §4.2) — and this repo is public. It came out of
`MVP_PLAN.md` when the repo went public and `.env.example` ships it as a placeholder for
the same reason. `deploy-prod.yml` hard codes `knag.danjamkuhn.com` instead, which is
fine: it is already in the README, and hard coding it fails more legibly than an unset
variable would.

Verify what you created, rather than trusting the form:

```bash
ghw api repos/danjamk/knag/environments --jq '.environments[].name'
ghw api repos/danjamk/knag/environments/development/variables --jq '.variables[].name'
ghw api repos/danjamk/knag/environments/development/secrets --jq '.secrets[].name'
```

Secret *names* are readable through the API; values are not.

### 4. Merge

`deploy-dev.yml` triggers on `push` to `main`. A pull request does not trigger it — only
the merge does. `workflow_dispatch` is there as the recovery hatch for a dropped webhook,
the same reasoning as `ci.yml`, and takes no inputs: it deploys whatever `main` is.

## Provisioning the prod pipeline

**Done — prod has been live since 2026-08-19** and `deploy-prod.yml` has executed many
times since. This section is kept as the recipe, because it is what a fork needs and what
a rebuild would need; the checkboxes below describe steps that are complete here.

What it needs, mirroring the above:

- [x] A prod-scoped Cloudflare API token — **prod account only**, and see the permissions
      note below, which is where this differs from dev
- [x] The `production` GitHub Environment. 🔴 **No required reviewer** — see the warning
      under the scheduled backup: one would queue every nightly backup forever
- [x] `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable on it
- [x] The prod D1 database and OAuth KV namespace created, and their ids pasted into the
      `env.prod` block of `worker/wrangler.jsonc`
- [x] `KNAG_OPERATOR_EMAIL`, `RESEND_API_KEY` and `KNAG_BEARER_TOKEN` set as prod Worker
      secrets — the bearer **different** from dev's; the Resend key may be shared
- [x] DNS for the custom domain — `custom_domain: true` in the `routes` entry means
      wrangler creates the domain and its DNS record during the deploy, so there is no
      separate DNS step
- [x] A WAF rate-limiting rule on `POST /api/login` in the zone

🔴 **The prod token needs two permissions the dev token does not, and copying dev's
recipe fails after the migrations have already run.** The custom domain is created by the
deploy itself, which is a zone operation:

| Permission | Level | Scope | dev | prod |
|---|---|---|---|---|
| Workers Scripts | Edit | Account | ✅ | ✅ |
| D1 | Edit | Account | ✅ | ✅ |
| Account Settings | Read | Account | ✅ | ✅ |
| **Workers Routes** | **Edit** | **Zone** | — | ✅ |
| **Zone** | **Read** | **Zone** | — | ✅ |
| **Workers R2 Storage** | **Edit** | Account | — | ✅ |

`Workers R2 Storage: Edit` is what writes the backup to the `knag-backups` bucket, in both
`backup-prod.yml` and `deploy-prod.yml`. The deploy's backup runs *before* its migration,
so a token without it does not merely skip a backup — it stops the deploy, which is the
correct order of events.

**Zone Resources: none** is correct for dev, which is a `*.workers.dev` hostname with no
zone. For prod it is wrong, and wrong in the worst place in the sequence: `migrate` runs
before `deploy`, so a token that cannot create the route fails *after* the schema has
already changed.

🔴 **The prod token never lands on this machine.** If you find yourself pasting it into
`.env.local` to test something, that is the moment the guarantee stops holding. Deploy
from Actions instead.

## Email login: provisioning, and retiring the passphrase (1.8.0, #231)

Once, before the first deploy of 1.8.0 to an environment:

1. In Resend, add and verify the sending domain (three DNS records on the Cloudflare
   zone). One Resend account serves both environments, but **the sender differs and is
   declared per environment** in `worker/wrangler.jsonc`'s `KNAG_MAIL_FROM`: prod sends
   from the verified domain, dev from Resend's `onboarding@resend.dev`, which delivers
   **only to the Resend account's own address** — enough to test the flow, useless for
   inviting anyone. Dev's subjects also carry `[dev]`.
2. `wrangler secret put RESEND_API_KEY` and `wrangler secret put KNAG_OPERATOR_EMAIL`
   (`--env prod` for prod, from Actions' point of view: the prod token is not on this
   machine, so set prod's from the Cloudflare dashboard).
3. Deploy. Existing sessions carry over — no device re-logins. The first login request
   naming the operator's address claims the seed row (migration 0009 left its email NULL).
4. **After** `make health` is green: `wrangler secret delete KNAG_PASSPHRASE` (both
   environments). Nothing reads it any more; leaving it is a secret with no reader.

If mail is misconfigured on day one the bearer token still reaches every `/api/*`
route, and a live session is unaffected — the passphrase's retirement cannot lock the
operator out of a device that is already in.

## When a step fails

The steps are ordered so that the earlier ones are the cheap ones. Where the run stops
tells you most of what you need.

| Fails at | Means | Do |
|---|---|---|
| **browser** (prod only) | The Playwright suite is red on this commit. Nothing has touched the prod account — the gate runs before the deploy job and holds no credential | Read the uploaded trace artifact. This job existing is the point: `pnpm check` cannot see rendering, geometry, visibility or focus |
| `pnpm check` | Something merged red, or a flake. CI runs the same gate on the same commit | Look at the `ci.yml` run for the same SHA. Nothing has touched the account yet |
| **Back up D1** | Almost always the credential: missing, wrong account, or missing `D1: Edit` | Check the token's permissions and account scope. Nothing has changed yet — this is the safe place to fail |
| **Apply migrations** | A migration is bad, or partially applied | 🔴 The backup artifact from this run is your restore point. Do not retry blindly: read the migration, and check `d1_migrations` for what actually applied |
| **Deploy** | 🔴 **The dangerous one.** Migrations are in and the old Worker is now running against the new schema | If the migration was additive, the old Worker is fine and you can fix forward calmly. If it was not, that is the two-release rule being broken — restore from the artifact |
| **health** | The deploy did not take, or `KNAG_ENV` is declared in only one wrangler env block | Compare `/health` against `<version>+<shortsha>` for the merge commit. A build-id match with an environment mismatch is always the missing `KNAG_ENV` |
| **health**, reporting the *previous* build | Propagation. A deploy returns before the rollout finishes | **Handled** — both workflows pass a 90s budget to `scripts/health.sh`, which retries until the build id matches. A match returns immediately, so a healthy deploy pays nothing. If this fails now, 90s was genuinely not enough or the deploy did not take |
| **verify** | The Worker is live but something around it is not — an asset that did not upload, a route not in `run_worker_first`, auth not switched on | Read which check failed. Font and icon checks assert **content type**, because a missing static file is answered with the PWA shell and a `200`, not a `404` |
| **verify**, failing on a mixture of assets and routes | Propagation, not configuration. Both workflows pass a 90s budget and re-run the **whole** set until it is clean | 🔴 The tell is **inconsistency** — one font fine and another `text/plain`, `/` at 500 while `/manifest.json` is fine. No configuration error produces per-file inconsistency; a rollout mid-flight does. If it still fails after 90s, it is real |

The two that need saying out loud:

**A failure between backup and migrate is the good case.** Nothing has been written.

**A failure between migrate and deploy is the case the additive-only rule exists for.**
The window is real and a workflow cannot close it. What makes it survivable is that
every migration is backward-compatible with the Worker that is already running.

## Local deploys still work

`make deploy` has not gone anywhere, and dev CI does not replace it. Use the local path
when you want a deploy from a branch, or a fast loop that skips `pnpm check`.

The local path has one protection CI does not need: `scripts/preflight.sh` reads
`wrangler whoami` and refuses if the active credential does not resolve to the account id
`.env` says this environment is allowed to touch. That guard exists because wrangler also
honours a machine-global `wrangler login` stored outside the repo, which no project
setting overrides — see [ADR-002 §1a](adr/ADR-002-two-accounts-and-migrations.md). In CI
there is no ambient session and the account id is set explicitly, so there is nothing to
assert.

## Where dev deliberately differs from prod

Kept as a list because the default is that the two files match, and every entry here is a
decision rather than drift.

| | dev | prod | Why |
|---|---|---|---|
| **Browser suite gates the deploy** | no | **yes** | `pnpm check` is a typecheck and a unit suite. Three bugs are on record that the unit suite could not see, all three found by a human on an iPhone. Dev is the rehearsal and self-corrects on the next merge; a bad prod deploy is what this pipeline exists to prevent, and prod is manual so you can wait ten minutes |
| Browser suite runs **serial** in the prod gate, **sharded** in `ci.yml` | — | serial | `ci.yml` runs on every pull request and shards four ways to land near three minutes (#202). The prod gate runs a few times a week and is the last thing before the only copy of the document: one runner, every file, in order, is the strongest form of the check |
| Trigger | `push` to `main` | `workflow_dispatch` | Dev tracking `main` is the point. A release names code; deploying prod is a decision to adopt it |
| Required reviewer | none | yes (optional but intended) | Dev is not a decision |
| `skip_migrations` input | **absent** | present | Dev is where the migration path gets exercised. An input that lets you skip it defeats the rehearsal |
| Backup retention | 7 days | 30 days | Dev is test content. A dev restore point older than a week has never been the thing anyone wanted |
| Host | `vars.DEV_HOST` | hard coded | The dev hostname stays out of tracked files (see step 3) |
| `--env` flag | none | `--env prod` | The top level of `wrangler.jsonc` **is** dev, so every command that forgets a flag does the safe thing |
| `concurrency` | `cancel-in-progress: false` | `cancel-in-progress: false` | **Not** a difference, and must not become one. A half-applied migration is worse than a queued deploy |
| **Scheduled backup** (`backup-prod.yml`) | none | daily, 09:00 UTC | The one workflow with no dev counterpart (#233). Dev is redeployed — and so backed up — on every merge to `main`, and holds test content anyway. Prod deploys are manual and weeks apart, and since [ADR-008](adr/ADR-008-email-login.md) §12 the prod D1 holds other people's pages: a backup that only happens when someone deploys is not a backup policy |

## What actually protects the data

Three layers, and they cover different things. Knowing which is which is the difference
between a five-second recovery and a panic.

| | Covers | Window | Costs |
|---|---|---|---|
| **D1 Time Travel** | a bad migration, an unqualified `DELETE`, a wipe that should not have happened | **7 days** (free plan; 30 on paid) | nothing — always on, no configuration |
| **The nightly R2 backup** | everything older than the Time Travel window, and a readable copy | as long as the bucket keeps it | pennies |
| **`make backup-pull`** | losing the Cloudflare account itself | whatever you have pulled | one read-only token |

🔴 **Time Travel is the first thing to reach for and it is not a file.** It restores the
database in place, to any *minute*, with no snapshot to choose:

```bash
pnpm exec wrangler d1 time-travel restore knag --env prod --timestamp <unix>
```

It is destructive — it overwrites in place — and it cannot recover something that was
already wrong before the point you restore to. **Seven days is the free-plan window**, and
this deployment is on the free plan by design (spec §14.4). That is the single most
important number on this page, because everything older than a week depends entirely on
the layer below.

### The scheduled prod backup

`backup-prod.yml` exports the prod D1 every morning at 09:00 UTC and writes it to the
**`knag-backups` R2 bucket** in the production account, under
`prod/knag-prod-YYYY-MM-DD.sql`. It is **in addition to** the export inside
`deploy-prod.yml`, which writes to `prod/pre-deploy/` and is the restore point for the
deploy about to happen; this one is the restore point for an ordinary day. Both stay.

🔴 **Never a GitHub artifact, and this is not a preference.** The first version of this
job uploaded the dump as a workflow artifact, and so had `deploy-prod.yml` since
2026-08-18. This repository is **public**: the artifact list is readable with no
authentication at all, and downloading needs only read access to a repo that grants it to
everyone. Twenty-eight cleartext dumps of every page belonging to every person using this
deployment were sitting in the open before anyone asked where the backups went. They were
pulled to `backups/` and deleted on 2026-08-31.

R2 is the right destination for a reason beyond privacy: **it is what lets a laptop hold a
copy without holding a dangerous credential.** `wrangler d1 export` is a POST that creates
a job, so pulling a backup straight out of D1 needs **D1: Edit** on production — the exact
token [ADR-002](adr/ADR-002-two-accounts-and-migrations.md) §1b keeps off this machine.
Reading an object out of a bucket needs **Workers R2 Storage: Read**, which can do nothing
but read what somebody else wrote. So the job writes, and `make backup-pull` reads:

```bash
make backup-pull                 # today's
make backup-pull DAY=2026-08-29  # any day
```

The keys are dated rather than listed, because `wrangler r2 object` has `get`, `put` and
`delete` and no `list` — the date is the index.

🔴 **Two one-time steps, and both block a run rather than degrading it.**

1. **Add `Workers R2 Storage: Edit` to the production API token.** Without it the nightly
   job fails at the last step and — more urgently — `deploy-prod.yml` fails at its
   *backup* step, which is before the migration and therefore blocks every prod deploy.
   That ordering is deliberate: no backup, no deploy.
2. **Set a lifecycle rule on `knag-backups`** so objects expire. Thirty days matches what
   the artifacts did, and it is what makes ADR-008 §12's promise honest — *delete removes
   every row they own* is not true if a backup keeps them forever:

       wrangler r2 bucket lifecycle add knag-backups expire-30d prod/ --expire-days 30

   Run it with a token that can edit the bucket, or set it in the dashboard under
   R2 → knag-backups → Settings → Object lifecycle rules.

It runs on `workflow_dispatch` too — do that before anything destructive, rather than
trusting that last night's run happened.

Two failure modes it is built against:

- **An empty export that goes green.** `wrangler d1 export` exits 0 having written a file
  with a schema and no rows, which looks exactly like a good backup every day until
  someone needs one. The job fails if the dump is under 1 kB or contains no `INSERT`.
- **The schedule being switched off.** 🔴 **GitHub disables scheduled workflows in a
  repository with no pushes for 60 days, silently** — and a quiet month is precisely when
  nobody is looking. Nothing in the repo can prevent it, so the check is manual and it is
  one command:

      gh run list --workflow backup-prod.yml --limit 5

  If the newest run is older than yesterday, the schedule is off. Any push re-enables it.

🔴 **Do not add a required reviewer to the `production` environment while this exists.**
The job needs that environment because the prod token lives there and nowhere else — so a
reviewer requirement would put every nightly backup into "waiting for approval" and leave
it there. The backups would stop, the run list would fill with pending runs rather than
failures, and nothing would look broken. The table above lists a reviewer as *intended*
for deploys; if that ever happens, this workflow needs its own environment holding a
read-only D1 token first.
