/**
 * Where the app is allowed to send you after login.
 *
 * Its own module, small as it is, because it is the one piece of client code that
 * turns untrusted input into a navigation — and because a function that reads
 * `location` directly cannot be tested without a DOM, which is how a guard like this
 * ends up shipped unverified. Pure in, pure out; `app.ts` supplies the query string.
 */

/**
 * The `?next=` hand-off from the OAuth consent screen, when it is safe to follow.
 *
 * `/oauth/authorize` sends a visitor without a session to the app so the passphrase is
 * only ever typed into the real login form (ADR-005 §2), and this is what sends them
 * back afterwards.
 *
 * 🔴 An allowlist of exactly one path prefix, not a same-origin check and not a
 * "starts with /" test. `next` arrives in a query string anyone can write, and a login
 * form that will forward you anywhere afterwards is worth more to a phisher than a
 * plain one, because the address bar genuinely is knag.
 *
 * The literal `/oauth/authorize?` prefix is doing three jobs at once:
 *
 *   - `https://evil.com` — rejected, no leading slash.
 *   - `//evil.com` and `/\evil.com` — rejected. Both look like paths to a naive check
 *     and are read as *hosts* by browsers, which is the classic way this is got wrong.
 *   - `/oauth/authorizeevil` — rejected, because the `?` is required.
 */
export function safeNext(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  return next?.startsWith("/oauth/authorize?") ? next : null;
}
