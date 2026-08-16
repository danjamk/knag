# ADR-005: `/mcp` needs OAuth 2.1 to reach the surfaces that justify it

**Status:** Accepted
**Date:** 2026-08-16
**Supersedes:** spec §10's "knag sits at the simple end of that standard: bearer
auth rather than OAuth 2.1 (single operator, no third-party client, no consent
screen)"
**Amends:** the house MCP standard, §1 — see *What the standard got
wrong*

## Context

v0.2.0 shipped `/mcp` with static bearer auth, four tools, and 33 tests. Then it
was connected to Claude Desktop for the first time:

> Couldn't register with Knag-Dev's sign-in service. You can try again, or add an
> OAuth Client ID in the connector settings.

That is **Dynamic Client Registration failing against a sign-in service knag does
not have.** claude.ai, Claude Desktop and mobile drive an OAuth 2.1 handshake when
you add a custom connector. They offer no field for a raw `Authorization` header.

The static bearer works — from **Claude Code**, which reads a config file and can
carry arbitrary headers. That is the one surface knag is least about.

### What the standard got wrong, and what it cost

The house MCP standard's §1 offers this table:

| Use | When |
|---|---|
| **Static bearer** | Single operator, no third-party clients, no consent screen. The floor. |
| **OAuth 2.1 resource server** | Anything a stranger connects, or where per-client consent and revocation matter. |

knag read that, matched "single operator, no third-party clients", and chose
bearer. Spec §10 wrote the reasoning down and PR #60 repeated it. Every step was
faithful to the standard.

**The table frames the choice as being about *who connects*. It is actually about
*which client you need to reach*.** A single operator with no third-party clients
still needs OAuth the moment they want the connector on their phone.

The same page says, two paragraphs earlier, that only a remote server reaches
"Claude Desktop, claude.ai web, mobile, Cowork, *and* Claude Code" and that "if
the point of the server is reach, it is remote." It never closes the loop: reach
also requires OAuth. Being remote is necessary and not sufficient.

The evidence was already in the house, in `pagevault/docs/adr/ADR-012`, first
line:

> #22 added OAuth 2.1 to the remote MCP server **so the hosted Claude surfaces
> (claude.ai, Desktop, mobile) can connect.**

pagevault hit this, solved it, and wrote it down. The standard harvested from
pagevault kept the solution and lost the reason.

### Why this matters more here than it did there

pagevault is a desktop-and-terminal product; its MCP server being reachable from
Claude Code was already most of the value. **knag is a phone, iPad and laptop
product.** An `/mcp` that only works from a terminal reaches the surface knag is
least about, and misses the two it exists for.

### A smaller defect found while diagnosing

Every discovery path returns the PWA shell:

```
/.well-known/oauth-protected-resource   → 200 text/html
/.well-known/oauth-authorization-server → 200 text/html
/register                               → 200 text/html
```

`not_found_handling: "single-page-application"` serves the app for any unmatched
path. A connector probing for metadata gets HTML **with a success status**, which
turns "this server has no OAuth" into "this server's metadata is corrupt." That
is a strictly worse failure, and it is worth fixing whatever else is decided.

## Decision

**Add OAuth 2.1 as a second, independent auth surface on `/mcp`, and keep the
static bearer.**

### 1. Both paths, not a replacement

The bearer stays. `mcp.md` §1 is right that it is the fallback when a connector's
OAuth dance fails, and it is what Claude Code uses today. Two independent ways in,
neither depending on the other.

### 2. Consent is gated by the existing passphrase session — not Cloudflare Access

pagevault reached for Cloudflare Access as its consent IdP because it already had
one. **knag deliberately does not** (ADR-001), and nothing here reopens that:
Access still cannot front `/mcp`, and the reasons ADR-001 rejected it — sessions
capped at a month, a login redirect that authenticates the wrong iOS cookie jar —
are unchanged.

knag already has a browser login. `/authorize` is reached by **the operator's own
browser** during the OAuth redirect, which is exactly the context a session cookie
works in. So the consent step reuses the login that already exists, and a
passphrase is never typed into anything but the real login form.

### 3. `/mcp` still refuses the session cookie

This looks like a contradiction with the above and is not. The OAuth access token
is a **bearer token**, so `/mcp` continues to accept only `Authorization: Bearer`
and continues to refuse the cookie.

The cookie appears at `/authorize`, in a browser, once, to establish consent. It
never authenticates a tool call. So the property #14 established survives exactly
as written: **`/mcp` grants no ambient authority**, which is what makes logging a
foreign `Origin` rather than blocking it the honest read of the spec (mcp.md §8)
rather than a hole.

### 4. Discovery metadata is served by the Worker, and unmatched `.well-known` 404s

RFC 9728 protected-resource metadata, authorization-server metadata, and DCR. The
`401` on `/mcp` gains `resource_metadata` alongside its `realm`. Every one of
these needs a `run_worker_first` entry in **both** wrangler env blocks, or it
works in dev and serves HTML in prod.

## Consequences

**The passphrase is now protecting more.** It gates the document, and it gates the
authority to mint an OAuth grant. `/authorize` needs the same rate-limit treatment
`/api/login` gets (spec §4.2), and it is a second reason the WAF rule is not
optional in prod.

**A new binding.** `@cloudflare/workers-oauth-provider` wants KV for token
storage. knag has had exactly one binding — D1 — and named environments do not
inherit, so this is the trap `CLAUDE.md` warns about, twice over.

**Token lifecycle becomes real.** Static bearers have no expiry and nothing
renews them. OAuth grants can be revoked, which is a genuine improvement — and
they can also expire, which is a new way for a connector to stop working that
knag has never had to reason about.

**`/mcp` gets a second full auth path, and `test:security` has to cover both.**
Two ways in is two ways to get wrong.

**v0.2.0's release notes are accurate and incomplete.** They said the MCP server
had not been exercised against a real client. It has now, and it does not work on
the surfaces that matter. That is what the note was for.

## Alternatives considered

**Bearer only, Claude Code only.** Rejected. It abandons the phone and the iPad,
which is the product. A note-taking app whose agent access requires a terminal has
the integration backwards.

**Cloudflare Access in front of `/mcp`.** Impossible, not merely undesirable —
Anthropic's connectors call from their cloud with no browser and no way to
complete a login. ADR-001 and pagevault's ADR-006 both say so.

**Paste a manual OAuth Client ID**, which the error message offers. Rejected: it
still requires knag to be an OAuth authorization server. It removes DCR, not the
work.

**Wait for connector UIs to accept static bearers.** Not a plan.

## Revisit when

**A second human appears.** ADR-001's trigger is unchanged, and this decision
moves knag closer to being ready for it rather than further: a real grant model
with revocation is most of what multi-tenant needs from an auth system, and spec
§17's re-examination already names auth as the only thing multi-tenant actually
influences.

**The MCP spec makes static bearers first-class in connector UIs.** It would make
this ADR's cost unnecessary rather than wrong. Nothing suggests it is coming.
