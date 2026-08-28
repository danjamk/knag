# ADR-008: Email login, superseding the shared passphrase

**Status:** Accepted
**Date:** 2026-08-28
**Supersedes:** [ADR-001](ADR-001-passphrase-auth.md)'s decision — the passphrase. Its
case against Cloudflare Access stands unchanged and this ADR inherits it.
**Amends:** spec §4 (auth), §12 (multi-user leaves the Out list), §17 (what is insured)

## Context

ADR-001 named its own trigger: *a second human, not a feature count*. It fired on
2026-08-21, when multi-user was decided as friends and family, invite-only, hosted free
by the operator inside the free tier, with a simple admin view (spec §17). A shared
passphrase means everyone shares one page, so it fails on the first invited person —
which is why #122 was scoped as a spike on the auth model rather than a schema change.

The spike's field was priced before it ran (#122, 2026-08-21). Cloudflare Access is out
on the constraint ADR-001 already recorded — it cannot front `/mcp`, caps sessions at a
month, and its login redirect authenticates the wrong iOS cookie jar — and at $7 a seat
past fifty it is also the only option whose cost matters. Cognito is a second cloud
with nothing bought for it. That left **an email link on the rails knag already has**
against **Clerk**, and Clerk displaces the OAuth provider ADR-005 built, puts a bundle
in a no-framework client, and would need its own iOS session test.

The design session had already argued for the email link in
[holistic-response §7](../design/holistic-response.md): one field, an identifier nobody
can lose, recovery *is* the login flow, one added state, and no other company's logo on
the only screen that is not the page.

### What any answer has to satisfy

From #122 and ADR-001, in order:

1. Front the PWA **and** leave `/mcp` bearer-only and free of ambient authority — that
   property is what makes logging a foreign `Origin` acceptable (spec §10).
2. A year-long, server-set session that survives Safari ITP (#4 measured it).
3. Work inside the home-screen PWA's own cookie jar on iOS. ADR-001 §3 rejected magic
   links on exactly this: the link opens in Safari and authenticates the wrong jar.
4. An identifier the person already knows; **no recovery flow** — losing it has to be
   self-service and unattended.
5. Invite-only. No sign-up page.
6. Free, at the operator's end too.

### The reconciliation

ADR-001 rejected magic links and §7 recommends one. Both are right, and the version that
satisfies both is the decision below: **the email carries a link and a code.** The link
is the desktop affordance. The code is typed into the PWA, inside its own cookie jar, and
mints the same server-set cookie the passphrase did. ADR-001's objection is answered,
not overruled.

## Decision

### 1. Identity is an email address

A `users` table: `email` (unique, case-insensitive), `role` (`operator` | `member`),
`created_at`, `revoked_at`, `last_seen_at`. No display name, no avatar — nobody else can
see it, so it is data with no reader (§7).

🔴 **The operator is a `role`, never `id = 1`.** `DEFAULT_PAGE_ID` was "the only row there
can be" before it was "the page a request that names none is about," and the second
meaning cost a release to untangle (#152). Identity is not a row number.

### 2. One mechanism: type your email, get a mail

The login screen keeps its shape — one field, one optional device label, one button. The
field now takes an email address. Submitting it sends one mail carrying **a link and a
six-digit code**, both bound to one `login_codes` row: `user_id`, hashed link token,
hashed code, `expires_at` (ten minutes), `consumed_at`, attempt count.

- **Desktop:** tap the link. It lands on *the page*, session minted. Never on a "logged
  in" screen — that was the spike's first question.
- **iOS PWA:** the screen's second state is a code field. The code is bound to the
  browser that asked for it by a short-lived request cookie set when the email was
  submitted, so six digits is safe with a five-attempt limit: a code without the cookie
  that requested it is worth nothing.
- **Same device, live session already:** the request that consumes the link or code
  carries the existing cookie, and the existing session is reused rather than a new row
  minted. That was the spike's second question — it must hold or every re-login costs a
  device row — and it is answered by construction rather than by measurement.
- An unknown or revoked address gets the same response and no mail. The endpoint says
  nothing about who exists.

The `Set-Cookie` is unchanged: `HttpOnly`, `Secure`, `SameSite=Lax`, a year, server-set.
Everything #4 measured still applies, because the cookie is the same cookie.

### 3. An invite is the first login mail

The admin view takes an email address. The Worker creates the `users` row and sends the
same mail with invite framing and a **seven-day** link. There is no accept step and no
invite status column: "has logged in" is a session existing.

🔴 **The invite mail is the only onboarding text the product has.** §7 says the app
carries none, and it is right — so the one thing that needs saying is said in the mail:
*on iPhone, add knag to your home screen first, then enter your email.* The invite link
opens in Safari, which is a different cookie jar from the home-screen PWA, so an iPhone
user logs in twice on day one — once in Safari from the link, once in the PWA with a
code. That is the same for everyone and it is said once, in the mail, not worked around.

### 4. Recovery: there is nothing to lose

No credential exists to forget or reset. The cases, and who acts:

| Case | Who | What happens |
|---|---|---|
| Logged out, new device, cookie expired | them | type the email, get a code — the login flow *is* recovery |
| Lost a phone with a live session | them | Devices revokes it (#125, exists) |
| **Lost access to the email address itself** | **operator** | edits the address in the admin view; a fresh invite mail goes to the new one. Their pages stay — identity is `users.id`, not the address |
| A household sharing one account | them | one address; whoever has the inbox logs the other's device in once |

The operator's whole support surface is *change email* and *revoke*. No reset templates,
no "forgot your…" screen, no support path beyond a message from a friend.

### 5. Ownership is additive, and every query names an owner

- `pages.owner_id INTEGER NOT NULL DEFAULT 1` and `sessions.user_id INTEGER NOT NULL
  DEFAULT 1` — the `revisions.page_id` pattern from migration 0004, backfilled to the
  operator so every existing row, session and page carries over untouched.
- `settings` **cannot** take an owner column, despite what migration 0007's comment
  promised: `key` is its primary key. It becomes `user_settings (user_id, key)` by the
  three-release expand/contract, and #155 is the worked example.
- The nine-page cap becomes per user. `DEFAULT_PAGE_ID` becomes `defaultPageFor(user)` —
  the user's first page — which is what "never an identity" was always going to mean.
- `Principal.id` is the user's id. `OWNER` goes. Handlers already key off `principal.id`
  and nothing else, which is the insurance §17 took paying off a third time.

🔴 **A query in `store.ts` that reaches for a page without naming its owner is the
two-page bug again** (CLAUDE.md, `newestUnsealedRevision`). It will not show up until
there are two people, and then it shows up as one person reading another's page.

### 6. MCP: OAuth grants carry the person; the static bearer stays the operator's

`/oauth/authorize` already gates consent on the session (ADR-005 §2), so the grant's
`userId` and `props.id` become the session's user rather than `OWNER`, and `/mcp` resolves
to *that* user's default page. A friend connecting Claude.ai lands on their own pages
with no new code path. `KNAG_BEARER_TOKEN` keeps meaning the operator: it is the Claude
Code credential and there is one operator. Per-user static tokens are not built.

`/mcp` still refuses the cookie; `/oauth/authorize` still refuses the bearer. Neither
rule moves.

### 7. Sharing a page is not built, and it is named

One owner per page. The household case — two people, one shopping list — is real and is
served today by sharing an account. When it is built it is a `page_members` table beside
`owner_id`, not a change to it. Recorded in §17 so the assumption is visible rather than
buried in a column.

### 8. A cap in the code: `MAX_USERS = 25`

The §14.4 arithmetic: ~4k requests/day per person at realistic use against a 100k/day
free tier. The nine-page cap is the precedent — a number the operator has to remember is
a hope. Workers Paid ($5/month, 10M requests) would move it to roughly eighty by changing
one constant; that is recorded, not chosen.

### 9. Mail is sent through Resend, behind an interface, and tests never see a mailbox

One `fetch` from the Worker, one secret (`RESEND_API_KEY`), one var for the sender
(`KNAG_MAIL_FROM`). The sending domain is `danjamkuhn.com`, whose zone is already on
Cloudflare, so the DNS records are three lines in a dashboard. Dev sends from the same
domain with `[dev]` in the subject. Free tier: 3,000 mails a month, which at twenty-five
people logging in once a year per device is two orders of magnitude of headroom.

Sending sits behind a function that takes an address and a body. The unit suite reads
the code out of D1; the browser suite seeds a session row directly. Nothing polls an
inbox. **Check Cloudflare Email Service at build time** — it was in beta when this was
written — and prefer it if it is generally available, because it removes the vendor.

### 10. The passphrase retires in the same release

Two credential schemes on one login screen is the drift ADR-001 exists to prevent.
Existing sessions carry over (`sessions.user_id` backfills to the operator), so the
operator's devices never re-login; the bearer token still reaches every `/api/*` route if
mail is broken on day one. `KNAG_PASSPHRASE` is deleted from both environments after the
deploy is healthy. The WAF rule on `/api/login` stays where it is — it now guards a
request-a-mail endpoint, and the threat it meets has changed shape (§Consequences).

### 11. The admin view answers one question: is this still free?

Operator only. A table of users with a totals row — joined, last seen, devices, pages,
editing sessions (30d), agent share, wipes (30d) — and four actions: invite, revoke,
change email, delete. **No page content, ever.** Nearly all of it is already in the data:
sessions are devices, `revisions` rows are sittings (coalescing makes them so), `source`
is the agent share, `event_type` is the wipe count. The one addition is
`sessions.last_seen_at`, written only when more than an hour stale, so polling never
becomes a D1 write per request. Request counts per user are deliberately **not** stored:
the Cloudflare dashboard has the total, and device count is the multiplier §14.4 uses.

### 12. Obligations, named

Holding other people's data (§17): a scheduled prod backup, because today `make backup`
runs only when a deploy does; **delete** in the admin view is a hard delete of every row
the person owns — pages, revisions, cleared items, sessions, grants — which is "deletion
on request"; and the end of the pilot needs no export, because a page is plain text and
always was.

## Consequences

**Accepted:**

- The Worker makes its first outbound third-party call. Mail can be slow, bounce or land
  in spam, and none of that is knag's to fix — the sender domain's reputation is.
- `/api/login` becomes a send-mail-to-this-address endpoint, and anyone can type an
  address. A per-address throttle in D1 (one mail a minute, five an hour) is the answer,
  and the response is identical for known, unknown and revoked addresses.
- Every `store.ts` read and write gains an owner predicate, and every one of them is a
  place the two-page bug can return. The test that catches it is two users, one page each,
  and every route asked to cross.
- `settings` goes through the three-release dance, which means one release in the middle
  that carries no migration and looks skippable (ADR-002 §3).
- An iPhone user logs in twice on day one. Said in the mail; not worked around.

**Contained:**

- Everything a route sees is still `authenticate() → Principal`; the shape does not
  change, only what `id` holds.
- All SQL is still in `store.ts`. The owner predicate is one file.
- The cookie, its TTL, and its ITP behaviour are the ones #4 measured.
- `/mcp` and `/oauth/authorize` keep their mirror-image rules untouched.

## Alternatives considered

**Clerk.** Would work — the Worker validates JWTs via JWKS. Rejected: it displaces the
OAuth provider ADR-005 already built, ships a large bundle into a no-framework client,
puts a vendor's name on the login screen, and its session refresh needs its client
awake, which is unproven in a home-screen PWA and would need its own #4.

**Cloudflare Access.** ADR-001's three reasons, unchanged, plus the price shape.

**Cognito.** A second cloud; the hosted UI is the same wrong-jar redirect; the custom UI
is SRP plumbing. "AWS needs a reason" and there is none here.

**Per-user passphrases.** Keeps today's screen and inherits today's problem: something to
invent, remember and lose, with recovery landing on the operator every time.

**Passkeys.** No mail infrastructure, phishing-proof, and home-screen PWAs support them.
Rejected on recovery: a lost device with the only passkey is an operator re-invite, so a
recovery path is needed anyway and it would be email. Better as a *second* way in later
than as the first.

**A tap-to-auth link only.** ADR-001 §3. The link opens in Safari and the PWA stays
logged out; the code is the fix and it costs one screen state.

## Revisit when

- A second person wants to edit **the same** page. That is `page_members` (§7 above), and
  it is the first thing multi-user has not yet decided.
- The group approaches `MAX_USERS`. The answer is one constant and five dollars a month.
- Cloudflare Email Service is generally available. One vendor fewer.
- Anyone asks for a second way in. Passkeys, as an addition.

## References

- #122 — the spike issue, its cost table and the 2026-08-21 ruling
- [ADR-001](ADR-001-passphrase-auth.md) — the case against Access, still standing
- [ADR-005](ADR-005-mcp-oauth.md) — consent gated on the session; `/mcp` bearer-only
- [holistic-response §7](../design/holistic-response.md) — the login surface
- spec §4, §10, §14.4, §17
