import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Principal, authenticate } from "./auth.js";
import { type Env, envName } from "./env.js";

/**
 * `/oauth/authorize` — the consent screen (ADR-005, #64).
 *
 * `authorizeEndpoint` is app-implemented: the OAuthProvider routes the request here
 * rather than serving it. We prove the visitor is the operator, then complete the
 * grant, after which the provider mints the code and redirects back to the client.
 *
 * 🔴 No credential is ever typed into this page. ADR-005 §2 gates consent on the
 * session knag already has, and a visitor without one is sent to the real login form
 * and returned here. That is not only about phishing-resistance: it is also why
 * `/oauth/authorize` needs no rate limit of its own. It accepts no credential, so the
 * only thing worth guessing is still behind `/api/login`, which the WAF rule already
 * covers (spec §4.2).
 *
 * This endpoint is reached by a **top-level browser navigation** from the connector,
 * which is why the session cookie arrives at all — `SameSite=Lax` sends cookies on
 * top-level GETs and withholds them from the cross-site POSTs and subresource loads
 * that make CSRF interesting. The consent POST is same-origin, so it carries the
 * cookie too.
 */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const provider = env.OAUTH_PROVIDER;
  if (!provider) {
    // Only the OAuthProvider routes here, so its absence is a deployment error rather
    // than anything the visitor did — most likely OAUTH_KV missing from one env block.
    console.error("/oauth/authorize reached without the OAuth provider in front of it");
    return new Response("OAuth is not configured on this deployment.", { status: 500 });
  }

  // Parse before authenticating. A malformed authorization request should say so
  // rather than sending the visitor through a login that ends in the same error.
  let oauthReq: AuthRequest;
  try {
    oauthReq = await provider.parseAuthRequest(request);
  } catch {
    return new Response("Invalid authorization request.", { status: 400 });
  }

  const principal = await authenticate(request, env);

  // 🔴 Session only, mirroring the way `/mcp` is bearer only. The bearer token would
  // also authenticate here and it is deliberately refused: consent is a thing a person
  // does in a browser, and a grant minted from a header is a grant nobody agreed to.
  if (principal?.source !== "session") {
    return redirectToLogin(request);
  }

  if (request.method === "POST") {
    return completeGrant(provider, oauthReq, env, principal);
  }

  return consentPage(request, oauthReq, await lookupClient(provider, oauthReq.clientId));
}

/** A client that has not registered is not an error worth a 500 — the page just says less. */
async function lookupClient(provider: OAuthHelpers, clientId: string): Promise<ClientInfo | null> {
  try {
    return await provider.lookupClient(clientId);
  } catch {
    return null;
  }
}

/**
 * Send the visitor to the app's login, and back here afterwards.
 *
 * `next` carries a **path and query only**, never an absolute URL — see `readNext` in
 * client/src/app.ts, which refuses anything that is not a `/oauth/` path. An
 * authorization endpoint that will redirect anywhere on request is an open redirect
 * with a login bolted to the front of it.
 */
function redirectToLogin(request: Request): Response {
  const here = new URL(request.url);
  const next = `${here.pathname}${here.search}`;
  return Response.redirect(new URL(`/?next=${encodeURIComponent(next)}`, here).toString(), 302);
}

/**
 * Complete the grant and send the operator back to the connector's callback.
 *
 * 🔴 303, not 302. This redirect follows a form POST, and the client's callback expects
 * a GET. 302 leaves the method ambiguous and some browsers re-POST to the callback,
 * where the token exchange never completes and the flow dies with no error. Learned in
 * pagevault #22; see worker/src/oauth.ts there.
 */
async function completeGrant(
  provider: OAuthHelpers,
  oauthReq: AuthRequest,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const { redirectTo } = await provider.completeAuthorization({
    request: oauthReq,
    // 🔴 The person whose session consented, and so the person every token from this
    // grant will act as (ADR-008 §6). This was the constant `OWNER` while there was one
    // human; the shape around it did not change when the value did.
    userId: String(principal.id),
    metadata: { label: `user ${principal.id}` },
    scope: oauthReq.scope,
    // Reaches the MCP handler as `ctx.props`. Deliberately minimal: knag's tools read
    // the document, not the caller, and a prop nobody reads is a prop that leaks. The
    // handler looks the user up on every request rather than trusting the role here,
    // so a revoked person's token dies with the row (#232).
    props: { id: principal.id },
  });

  console.log(`oauth grant completed for client ${oauthReq.clientId} on ${envName(env)}`);
  return Response.redirect(redirectTo, 303);
}

/**
 * The consent form, posting back to the same URL so the pending authorization request
 * — which lives in the query string — survives the round trip.
 */
function consentPage(request: Request, oauthReq: AuthRequest, client: ClientInfo | null): Response {
  const clientName = esc(client?.clientName || oauthReq.clientId);
  const scopes = oauthReq.scope.length ? esc(oauthReq.scope.join(", ")) : "everything knag can do";
  const action = esc(request.url);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>authorize — knag</title>
<style>
/* A deliberately small subset of the app's tokens rather than an import of all forty.
   This page has one job and is about to be restyled by the brand pass; duplicating six
   values is cheaper than wiring a shared stylesheet into the build for one screen. */
:root { color-scheme: dark;
  --bg:#111; --surface:#191919; --fg:#e8e8e8; --dim:#888; --line:#333; --accent:#6b8f6b; }
@media (prefers-color-scheme: light) { :root { color-scheme: light;
  --bg:#faf9f7; --surface:#f0eee9; --fg:#23211e; --dim:#6b6862; --line:#d8d5cd; --accent:#4a7a4a; } }
body { margin:0; padding:3rem 1.25rem; background:var(--bg); color:var(--fg);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
.wrap { max-width:26rem; margin:0 auto; }
h1 { font-size:1.35rem; margin:0 0 .5rem; font-weight:600; }
p { margin:0 0 1rem; color:var(--dim); font-size:.9375rem; }
.name { color:var(--fg); font-weight:600; }
.box { border:1px solid var(--line); background:var(--surface); border-radius:6px;
  padding:.75rem 1rem; margin:1.25rem 0; font-size:.875rem; color:var(--dim); }
button { width:100%; padding:.7rem; border:0; border-radius:6px; background:var(--accent);
  color:#fff; font:inherit; font-weight:600; cursor:pointer; }
.note { font-size:.8125rem; margin-top:1.25rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>authorize knag</h1>
  <p><span class="name">${clientName}</span> is asking to read and write your page.</p>
  <div class="box">it will be able to read the whole page, replace it, wipe completed
    items and read your history — the same things you can do.</div>
  <form method="POST" action="${action}">
    <button type="submit">allow</button>
  </form>
  <p class="note">close this tab to refuse. scopes requested: ${scopes}</p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      // 🔴 Deliberately NO `form-action`. Browsers enforce it against the *redirect a
      // submission follows*, not just the form's action — and this form posts here,
      // then 303s to the connector's callback on another origin. `form-action 'self'`
      // silently blocks that navigation and the flow dies frozen on this page with no
      // error anywhere. Do not add it back. The redirect target is already constrained:
      // the provider only ever redirects to a registered redirect_uri. pagevault #22.
      "Content-Security-Policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    },
  });
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
