import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * The Worker's bindings, vars and secrets.
 *
 * Vars are declared in `worker/wrangler.jsonc` and ship blank where they are baked
 * at deploy. Secrets are never in that file — `wrangler secret put`.
 */
export interface Env {
  /** D1. The only copy of the live document. Reached only through store.ts. */
  DB: D1Database;

  /** The PWA shell in `public/`, served by Workers Static Assets. */
  ASSETS: Fetcher;

  /**
   * OAuth 2.1 grants, authorization codes and access tokens (ADR-005).
   *
   * The name is fixed by `@cloudflare/workers-oauth-provider`, which looks up this
   * exact binding. Nothing else reads it — no knag code touches KV directly, and the
   * document never goes here.
   *
   * 🔴 Declared in **both** wrangler env blocks. Named environments do not inherit
   * bindings, and a missing one here does not fail a deploy — it fails the first
   * OAuth handshake in production, long after the deploy looked fine.
   */
  OAUTH_KV: KVNamespace;

  /**
   * Injected into `env` by the OAuthProvider before it calls a handler — not a
   * binding, and absent from wrangler.jsonc for that reason. Optional because the
   * only thing that guarantees it is the provider being in front of the request,
   * which `handleAuthorize` checks rather than assumes.
   */
  OAUTH_PROVIDER?: OAuthHelpers;

  /** `<semver>+<shortsha>`, baked at deploy. Blank in dev and in tests. */
  KNAG_VERSION: string;

  /** ISO 8601, baked at deploy. Blank in dev and in tests. */
  KNAG_DEPLOYED_AT: string;

  /**
   * `dev` or `prod`, baked at deploy. Read it through `envName()`, never directly —
   * a blank value must not read as `local`.
   *
   * 🔴 Declared in **both** wrangler env blocks. Named environments do not inherit
   * vars, so one added only at the top level works in dev and reports the wrong
   * thing in prod — which is exactly the failure this variable exists to catch.
   */
  KNAG_ENV: string;

  /** IANA zone for history boundaries. Defaults to America/Chicago. See spec §14.3. */
  KNAG_TZ: string;

  /**
   * Secret. The operator's address (#231, ADR-008). Migration 0009 seeded the operator
   * with no email because a migration cannot read a secret; the first login request that
   * names this address claims the row. After that it is a fact in `users`, not here.
   */
  KNAG_OPERATOR_EMAIL?: string;

  /**
   * Secret. Resend. Absent locally and under test, where mail lands in `mail.ts`'s
   * outbox instead — and absent on a deployed environment is a configuration error that
   * is logged as one, never worked around.
   */
  RESEND_API_KEY?: string;

  /**
   * The sender, `name <address>`. Declared in **both** wrangler env blocks; the address
   * is on a domain Resend has verified.
   */
  KNAG_MAIL_FROM: string;

  /** Secret. Agent / MCP / any non-browser client. Absent until `wrangler secret put`. */
  KNAG_BEARER_TOKEN?: string;
}

/**
 * Which environment this is, from the one var that says so.
 *
 * 🔴 **Blank is `unknown`, never `local`** (#248). `KNAG_ENV` is baked at deploy by
 * `--var`, which only the Makefile and the two deploy workflows pass — a `wrangler
 * deploy` that skips them ships the config's default, and that default used to be
 * `""`. Every reader spelled the fallback `env.KNAG_ENV || "local"`, so a deployed
 * Worker with a blank var believed it was running on a laptop. That is not a
 * cosmetic error: `sendMail` prints the login code to the log when it thinks it is
 * local, which is the one thing that file says must never reach a real deployment.
 *
 * Blank now fails closed. `local` is a value the local entry points pass explicitly
 * (`pnpm dev`, `scripts/dev-lan.sh`) and the test config binds as `test`, so nothing
 * legitimate arrives here empty.
 */
export function envName(env: Env): string {
  return env.KNAG_ENV || "unknown";
}

/**
 * What `/health` reports, so `make health` can compare it to the checkout — and so a
 * human can answer "is my change live, and on which environment" without a curl.
 *
 * `environment` is the field people skip and then need: **a deploy that looks right
 * and went to the wrong environment is indistinguishable from one that failed**,
 * until someone checks.
 */
export function buildInfo(env: Env): {
  ok: true;
  version: string;
  deployed_at: string;
  environment: string;
} {
  return {
    ok: true,
    version: env.KNAG_VERSION || "dev",
    deployed_at: env.KNAG_DEPLOYED_AT || "",
    environment: envName(env),
  };
}
