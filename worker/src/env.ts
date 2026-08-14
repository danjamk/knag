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

  /** `<semver>+<shortsha>`, baked at deploy. Blank in dev and in tests. */
  KNAG_VERSION: string;

  /** ISO 8601, baked at deploy. Blank in dev and in tests. */
  KNAG_DEPLOYED_AT: string;

  /** IANA zone for history boundaries. Defaults to America/Chicago. See spec §14.3. */
  KNAG_TZ: string;

  /** Secret. PWA login. Absent until `wrangler secret put`. */
  KNAG_PASSPHRASE?: string;

  /** Secret. Agent / MCP / any non-browser client. Absent until `wrangler secret put`. */
  KNAG_BEARER_TOKEN?: string;
}

/** What `/health` reports, so `make health` can compare it to the checkout. */
export function buildInfo(env: Env): { ok: true; version: string; deployed_at: string } {
  return {
    ok: true,
    version: env.KNAG_VERSION || "dev",
    deployed_at: env.KNAG_DEPLOYED_AT || "",
  };
}
