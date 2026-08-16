import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The OAuth 2.1 surface (ADR-005, #64) — the thing that makes `/mcp` reachable from
 * claude.ai, Claude Desktop and mobile, none of which offer a field for a raw header.
 *
 * What these tests can and cannot prove is worth stating. They exercise discovery,
 * registration, the consent gate and the audience pinning against the real provider.
 * They cannot prove a connector actually completes the dance — that is a real client
 * against a real deployment, and it is the last task on #64.
 */

const ORIGIN = "https://knag.test";

async function login(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: "test-passphrase-do-not-use-in-production" }),
  });
  const cookie = res.headers.get("Set-Cookie");
  if (!cookie) throw new Error("login did not set a cookie");
  return cookie.split(";")[0] as string;
}

/** Register a client the way a connector does, so tests have a real client_id. */
async function register(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Connector",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBeLessThan(300);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

function authorizeUrl(clientId: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    state: "opaque-state",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  });
  return `${ORIGIN}/oauth/authorize?${params}`;
}

describe("discovery", () => {
  it("serves protected-resource metadata pinned to this deployment", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    // 🔴 The audience. `resource` is derived from the request origin rather than a var,
    // so a *.workers.dev host and a custom domain each advertise themselves correctly
    // and there is no value to forget in one of the two wrangler env blocks (RFC 8707).
    expect(await res.json()).toMatchObject({ resource: `${ORIGIN}/mcp` });
  });

  it("serves authorization-server metadata naming knag's endpoints", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      // Without DCR a connector cannot self-register, which is the exact failure that
      // opened #64: "Couldn't register with Knag-Dev's sign-in service."
      registration_endpoint: `${ORIGIN}/oauth/register`,
    });
  });
});

describe("dynamic client registration", () => {
  it("accepts a connector registering itself", async () => {
    const clientId = await register();
    expect(clientId).toBeTruthy();
  });
});

describe("consent", () => {
  it("sends an unauthenticated visitor to the real login, carrying a return path", async () => {
    const clientId = await register();
    const res = await SELF.fetch(authorizeUrl(clientId), { redirect: "manual" });

    expect(res.status).toBe(302);

    // 🔴 The passphrase is never typed into the consent page (ADR-005 §2). This is also
    // why /oauth/authorize needs no rate limit of its own: it accepts no credential.
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("next")).toContain("/oauth/authorize");
  });

  it("refuses the bearer token, which is a header and not a person", async () => {
    const clientId = await register();
    const res = await SELF.fetch(authorizeUrl(clientId), {
      headers: { Authorization: "Bearer test-bearer-do-not-use-in-production" },
      redirect: "manual",
    });

    // Not a 403 — it falls through to the same login redirect, because the bearer is a
    // valid credential for everything else and simply is not consent.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/?next=");
  });

  it("shows the consent page to a logged-in operator", async () => {
    const cookie = await login();
    const clientId = await register();
    const res = await SELF.fetch(authorizeUrl(clientId), { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Test Connector");
    expect(html).toContain("allow");

    // 🔴 `form-action` must never appear here. Browsers enforce it against the redirect
    // a submission follows, so `form-action 'self'` would silently kill the 303 to the
    // connector's callback and freeze the flow on this page with no error. pagevault #22.
    expect(res.headers.get("Content-Security-Policy")).not.toContain("form-action");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("escapes the client name rather than rendering it", async () => {
    const cookie = await login();
    const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: '<script>alert("xss")</script>',
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id: clientId } = (await res.json()) as { client_id: string };

    const page = await SELF.fetch(authorizeUrl(clientId), { headers: { Cookie: cookie } });
    const html = await page.text();

    // The client name is attacker-controlled: anyone who can reach /oauth/register picks
    // it, and it is rendered on a page the operator is about to click "allow" on.
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("completes the grant and 303s back to the connector", async () => {
    const cookie = await login();
    const clientId = await register();
    const res = await SELF.fetch(authorizeUrl(clientId), {
      method: "POST",
      headers: { Cookie: cookie },
      redirect: "manual",
    });

    // 🔴 303, not 302. This follows a form POST and the callback expects a GET; 302
    // leaves the method ambiguous and some browsers re-POST, where the token exchange
    // never completes and the flow dies with no error. pagevault #22.
    expect(res.status).toBe(303);

    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://claude.ai");
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("opaque-state");
  });

  it("refuses a malformed authorization request before asking anyone to log in", async () => {
    const res = await SELF.fetch(`${ORIGIN}/oauth/authorize`, { redirect: "manual" });

    // Sending the visitor through a login that ends in the same error is worse than
    // saying so immediately.
    expect(res.status).toBe(400);
  });
});
