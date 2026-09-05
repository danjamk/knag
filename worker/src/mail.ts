import { type Env, envName } from "./env.js";

/**
 * Mail, behind one function (ADR-008 §9).
 *
 * Resend, by one `fetch`, with one secret (`RESEND_API_KEY`) and one var for the sender
 * (`KNAG_MAIL_FROM`). Chosen over Cloudflare's own Email Service because that is Workers
 * Paid only (public beta since 2026-04) and this deployment is meant to stay on the free
 * tier; revisit when that changes.
 *
 * 🔴 **Without the key nothing is sent, and where the text goes depends on where this is
 * running.** Locally and under test it lands in `outbox` and the local log, which is how
 * `wrangler dev` on a phone shows you your own code and how the unit suite reads it. On
 * a deployed environment a missing key is a configuration error and is logged as one —
 * a login code must never reach the observability log of a real deployment.
 *
 * 🔴 "Deployed" is **anything that is not explicitly `local` or `test`**, a blank
 * `KNAG_ENV` included. It reads blank as `unknown` through `envName()` rather than as
 * `local` (#248), because the var is baked by a `--var` flag that a plain `wrangler
 * deploy` does not pass — and the branch below is the one place where guessing wrong
 * writes the code into a real log.
 */
export type Mail = { to: string; subject: string; text: string };

/**
 * What would have been sent, when there is no key. Local and test only; capped so a
 * long-lived local isolate does not grow without bound.
 */
export const outbox: Mail[] = [];
const OUTBOX_MAX = 50;

const RESEND = "https://api.resend.com/emails";

export async function sendMail(env: Env, mail: Mail): Promise<void> {
  const key = env.RESEND_API_KEY;
  if (!key) {
    const environment = envName(env);
    if (environment === "local" || environment === "test") {
      outbox.push(mail);
      if (outbox.length > OUTBOX_MAX) outbox.shift();
      console.log(`mail to ${mail.to} — ${mail.subject}\n\n${mail.text}`);
    } else {
      console.error(`mail to ${mail.to} not sent: RESEND_API_KEY is not set on ${environment}`);
    }
    return;
  }

  const res = await fetch(RESEND, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.KNAG_MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
  });
  if (!res.ok) {
    // Logged, not thrown: the login endpoint answers the same 200 whatever happened, and
    // the person's remedy — ask again in a minute — is the same as for a slow inbox.
    console.error(`mail to ${mail.to} failed: resend ${res.status} ${await res.text()}`);
  }
}

/**
 * The login mail (ADR-008 §2, §3). Plain text, one link, one code, and the one line of
 * onboarding the product has: on iPhone, add knag to your home screen first, then enter
 * your email *there* — the link opens in Safari, which is a different cookie jar from the
 * home-screen app, so the code is what logs the app itself in.
 */
/**
 * The subject prefix, shared by both mails below.
 *
 * The tag exists so a link from one environment cannot be mistaken for a link from
 * another, which is only possible where there are two. `prod`, `local` and a self-hosted
 * install each have one, so none of them is tagged. `dev` is — and so is `unknown`, so
 * that a deploy which shipped without `--var KNAG_ENV` says so in every subject line it
 * sends rather than only in `/health` (#248).
 */
const UNTAGGED = new Set(["prod", "local", "selfhost"]);

function subjectTag(environment: string): string {
  return UNTAGGED.has(environment) ? "" : `[${environment}] `;
}

export function loginMail(input: {
  to: string;
  origin: string;
  linkToken: string;
  code: string;
  minutes: number;
  environment: string;
}): Mail {
  const tag = subjectTag(input.environment);
  const link = `${input.origin}/login/${input.linkToken}`;
  return {
    to: input.to,
    subject: `${tag}Your knag link`,
    text: [
      "Here is your link to knag:",
      "",
      `  ${link}`,
      "",
      "Or type this code on the screen that sent you here:",
      "",
      `  ${input.code.slice(0, 3)} ${input.code.slice(3)}`,
      "",
      "On iPhone: add knag to your home screen first, then enter your email there and",
      "type the code. The link logs Safari in; the code logs the app in.",
      "",
      `The link and the code are good for ${input.minutes} minutes and work once.`,
      "",
      "If you did not ask for this, ignore it — nothing happens without the code.",
    ].join("\n"),
  };
}

/**
 * The invite (#232, ADR-008 §3): the first login mail, with invite framing and a
 * seven-day link. 🔴 **Link only, no code.** A code is bound to the browser that asked
 * for it, and the browser that asked was the operator's — a code here would be six
 * digits nobody can type anywhere. The person's own code login comes on day one, from
 * the home-screen app, after the link has shown them the page.
 *
 * This is the only onboarding text the product has, so the one thing worth saying is
 * said here and nowhere in the app: on iPhone, add it to your home screen first.
 */
export function inviteMail(input: {
  to: string;
  from: string | null;
  origin: string;
  linkToken: string;
  days: number;
  environment: string;
}): Mail {
  const tag = subjectTag(input.environment);
  const link = `${input.origin}/login/${input.linkToken}`;
  const who = input.from ? `${input.from} has` : "You have been";
  return {
    to: input.to,
    subject: `${tag}You're invited to knag`,
    text: [
      `${who} invited you to knag — one plain-text page, always live, edited from any`,
      "device and by your agent. Here is your link:",
      "",
      `  ${link}`,
      "",
      `It is good for ${input.days} days and works once. After that, type your email on the`,
      "login screen and a fresh link comes back — that is the whole login, every time.",
      "",
      "On iPhone: open the link in Safari, then add knag to your home screen. The app has",
      "its own login: enter your email there and type the six-digit code it mails you.",
      "",
      "If you were not expecting this, ignore it — nothing happens unless you open the link.",
    ].join("\n"),
  };
}
