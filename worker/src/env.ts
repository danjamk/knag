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
   * `dev` or `prod`, baked at deploy.
   *
   * 🔴 Declared in **both** wrangler env blocks. Named environments do not inherit
   * vars, so one added only at the top level works in dev and reports the wrong
   * thing in prod — which is exactly the failure this variable exists to catch.
   */
  KNAG_ENV: string;

  /** IANA zone for history boundaries. Defaults to America/Chicago. See spec §14.3. */
  KNAG_TZ: string;

  /** Secret. PWA login. Absent until `wrangler secret put`. */
  KNAG_PASSPHRASE?: string;

  /** Secret. Agent / MCP / any non-browser client. Absent until `wrangler secret put`. */
  KNAG_BEARER_TOKEN?: string;
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
    environment: env.KNAG_ENV || "local",
  };
}
