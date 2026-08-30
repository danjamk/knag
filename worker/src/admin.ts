import { type Principal, authenticate, unauthorized } from "./auth.js";
import type { Env } from "./env.js";
import { normaliseEmail, sendInvite } from "./login.js";
import {
  MAX_USERS,
  type UserRow,
  countLiveUsers,
  createUser,
  deleteUserHard,
  findUser,
  findUserAny,
  findUserByEmailAny,
  listUserStats,
  revokeUser,
  updateUserEmail,
} from "./store.js";

/**
 * The operator's view of everyone (#232, ADR-008 §3, §4, §8, §11, §12).
 *
 *   GET    /api/me                     who am I — id, role, address
 *   GET    /api/users                  the table: counts and dates per person, totals
 *   POST   /api/users      { email }   invite — create the row, send the first login mail
 *   PATCH  /api/users/<id> { email }   change email — the only recovery lever — and re-invite
 *   DELETE /api/users/<id>             revoke: out, pages kept
 *   DELETE /api/users/<id>?hard        delete: every row they own, gone
 *
 * 🔴 **The gate is one comparison and the refusal is a 404.** `role !== "operator"`
 * gets the same body and status as a path that does not exist, so a member probing for
 * an admin surface learns nothing about whether there is one. Session or bearer: the
 * static bearer *is* the operator (ADR-008 §6), and an OAuth token never reaches `/api/*`.
 *
 * 🔴 **Nothing here reads a page body**, and nothing here ever will. The view exists to
 * answer "is this still free?" — devices, pages, sittings, wipes — and a count is the
 * most it says about what anyone wrote.
 */

/** The window every per-person count is taken over. Said once, here. */
const WINDOW_DAYS = 30;

const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404 });

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const principal = await authenticate(request, env);
  if (!principal) return unauthorized();
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
  }
  const user = await findUser(env, principal.id);
  return Response.json({ id: principal.id, role: principal.role, email: user?.email ?? null });
}

export async function handleUsers(request: Request, env: Env, url: URL): Promise<Response> {
  const principal = await authenticate(request, env);
  if (!principal) return unauthorized();
  if (principal.role !== "operator") return NOT_FOUND();

  const tail = url.pathname.slice("/api/users".length);

  if (tail === "" || tail === "/") {
    if (request.method === "GET") return listUsers(env);
    if (request.method === "POST") return invite(request, env, principal);
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
  }

  const id = Number(tail.slice(1));
  if (!Number.isInteger(id) || id < 1) {
    return Response.json({ error: "user must be a positive integer" }, { status: 400 });
  }

  if (request.method === "PATCH") return changeEmail(request, env, principal, id);
  if (request.method === "DELETE") return remove(env, principal, id, url.searchParams.has("hard"));
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "PATCH, DELETE" } });
}

async function listUsers(env: Env): Promise<Response> {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const users = await listUserStats(env, since, now);
  return Response.json({ users, since: since.toISOString(), window_days: WINDOW_DAYS, max: MAX_USERS });
}

/**
 * Invite. The cap is checked here, in the route, the way the nine-page cap is: a
 * tripwire rather than a constraint, counted over live people so a revoked one frees
 * their place. An address already here — live or revoked — is a 409 naming which,
 * because the operator is the one caller this endpoint may speak plainly to.
 */
async function invite(request: Request, env: Env, principal: Principal): Promise<Response> {
  const email = await emailFrom(request);
  if (!email) return Response.json({ error: "email must be an address" }, { status: 400 });

  const existing = await findUserByEmailAny(env, email);
  if (existing) {
    return Response.json(
      { error: existing.revoked_at ? "That address was revoked — delete them to invite again" : "Already here" },
      { status: 409 },
    );
  }
  if ((await countLiveUsers(env)) >= MAX_USERS) {
    return Response.json({ error: `This deployment holds ${MAX_USERS} people`, max: MAX_USERS }, { status: 409 });
  }

  const user = await createUser(env, { email });
  await sendInvite(env, { origin: new URL(request.url).origin, user, invitedBy: await addressOf(env, principal) });
  console.log(`user ${user.id} invited by ${principal.id}`);
  return Response.json({ user: publicUser(user) }, { status: 201 });
}

/**
 * Change email — recovery, from the operator's side (ADR-008 §4). The person lost the
 * address, not the account; the row keeps its id and so its pages, and a fresh invite
 * goes to the new address. A revoked person is refused: "out" is not undone by a typo
 * in a form, and delete-then-invite is the honest path back.
 */
async function changeEmail(request: Request, env: Env, principal: Principal, id: number): Promise<Response> {
  const user = await findUserAny(env, id);
  if (!user) return NOT_FOUND();
  if (user.revoked_at) return Response.json({ error: "Revoked" }, { status: 409 });

  const email = await emailFrom(request);
  if (!email) return Response.json({ error: "email must be an address" }, { status: 400 });
  if (email === user.email?.toLowerCase()) return Response.json({ user: publicUser(user) });

  if (!(await updateUserEmail(env, id, email))) {
    return Response.json({ error: "Already here" }, { status: 409 });
  }
  const updated = { ...user, email };
  await sendInvite(env, {
    origin: new URL(request.url).origin,
    user: updated,
    invitedBy: await addressOf(env, principal),
  });
  console.log(`user ${id} re-invited at a new address by ${principal.id}`);
  return Response.json({ user: publicUser(updated) });
}

/**
 * Revoke, or delete. Never the operator: the route that could lock everyone out is the
 * one that refuses to, and a 400 says why rather than a 404 pretending the row is not
 * there. Grants go in both cases — a revoked person's tokens already die at `findUser`
 * on their next request, but the provider's store should not keep offering refreshes
 * for a person who is out.
 */
async function remove(env: Env, principal: Principal, id: number, hard: boolean): Promise<Response> {
  const user = await findUserAny(env, id);
  if (!user) return NOT_FOUND();
  if (user.role === "operator" || id === principal.id) {
    return Response.json({ error: "The operator cannot be removed" }, { status: 400 });
  }

  await revokeGrants(env, id);
  if (hard) {
    await deleteUserHard(env, id);
    console.log(`user ${id} deleted by ${principal.id}`);
  } else {
    await revokeUser(env, id);
    console.log(`user ${id} revoked by ${principal.id}`);
  }
  return new Response(null, { status: 204 });
}

/**
 * Tear down every OAuth grant a person holds. The provider keeps them in KV, under the
 * `userId` the consent screen wrote (`String(principal.id)`, oauth.ts), and this is the
 * one place knag asks it to list anything. Best effort: the token dies at `findUser`
 * regardless, so a KV hiccup here is logged rather than turned into a failed revoke.
 */
async function revokeGrants(env: Env, id: number): Promise<void> {
  const provider = env.OAUTH_PROVIDER;
  if (!provider) return;
  try {
    let cursor: string | undefined;
    do {
      const page = await provider.listUserGrants(String(id), cursor ? { cursor } : undefined);
      for (const grant of page.items) await provider.revokeGrant(grant.id, String(id));
      cursor = page.cursor;
    } while (cursor);
  } catch (error) {
    console.error(`could not revoke grants for user ${id}: ${String(error)}`);
  }
}

async function emailFrom(request: Request): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }
  return normaliseEmail((payload as { email?: unknown } | null)?.email);
}

async function addressOf(env: Env, principal: Principal): Promise<string | null> {
  return (await findUser(env, principal.id))?.email ?? null;
}

/** What a user looks like in a response body. The same fields the table carries; no more. */
function publicUser(user: UserRow): Pick<UserRow, "id" | "email" | "role" | "created_at" | "revoked_at"> {
  return { id: user.id, email: user.email, role: user.role, created_at: user.created_at, revoked_at: user.revoked_at };
}
