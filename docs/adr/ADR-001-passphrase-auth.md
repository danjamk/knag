# ADR-001: Passphrase auth, not Cloudflare Access

**Status:** Accepted
**Date:** 2026-08-14

## Context

The house Cloudflare standard says:

> Cloudflare Access (Zero Trust) in front of a Worker or Pages project, rather
> than rolling session handling.

knag rolls its own session handling. This records why, because "we rolled our
own auth" should never be an undocumented drift.

knag has two clients that both need to authenticate:

1. A **home-screen PWA** on iPhone, iPad, and macOS, which must stay logged in
   effectively forever — knag replaces a legal pad, and a notepad that asks for
   credentials is a notepad you stop opening.
2. An **MCP server** at `/mcp`, called by Anthropic's connector infrastructure.

## Decision

A shared passphrase (`KNAG_PASSPHRASE`) minting a long-lived server-set session
cookie for the PWA, and a separate bearer token (`KNAG_BEARER_TOKEN`) for the
agent path. No Cloudflare Access.

## Why Access does not work here

**1. Access cannot front `/mcp`.** Anthropic's connectors call the endpoint from
their cloud — no browser, no cookie, no way to complete an interactive login.
Access would hard-block it. This is not knag-specific; `pagevault` hit the same
wall and its `mcp.ts` carries the same warning. Even if Access covered the PWA,
`/mcp` would need a second, Worker-level scheme — so the Worker authenticates
either way, and having two systems is worse than having one.

**2. Access sessions are capped at 1 month.** knag wants a year. Re-auth is not
a minor annoyance here; it is the thing that decides whether the app gets used
at 11pm on a phone.

**3. The iOS PWA cookie jar.** A home-screen PWA has its own cookie jar,
separate from Safari's. Access redirects to `<team>.cloudflareaccess.com` to
log in — a cross-origin navigation iOS may hand to Safari, which authenticates
the wrong jar and returns to a PWA that is still logged out. This is the same
failure that ruled out magic links.

**4. Safari ITP.** Client-set cookies expire after 7 days of inactivity;
server-set `Set-Cookie` is exempt. The session cookie must be server-set. That
is a property of our own login endpoint, and we need to control it.

## Consequences

**Accepted:**

- One shared secret, so there is no per-device revocation. Revoking means
  rotating the passphrase and logging every device back in. Acceptable at one
  user; it is the first thing that breaks at two (spec §17).
- We own the brute-force surface. Mitigated in spec §4.2: constant-time compare,
  a WAF rate-limit rule on `/api/login`, expired-session sweep, opaque 401s.
- Auth code needs its own tests. `pnpm test:security` runs `auth.test.ts` alone.

**Contained:**

All of it sits behind one function — `authenticate(request, env) → Principal |
null` (spec §4.1). No handler asks whether the passphrase matched; handlers key
off `principal.id`. Replacing this scheme with Access, OAuth, or Sign in with
Apple is a one-file change.

## Revisit when

**A second human needs access.** Not a feature count, not traffic — a second
person. A shared passphrase has no accounts, no revocation, and would not pass
App Store review.

## Standards change

`cloudflare.md` should be amended: Access is the default, and a **home-screen
PWA or an MCP endpoint is the documented exception**. The rule as written has no
answer for either, and this is the second project to hit the `/mcp` half of it.
