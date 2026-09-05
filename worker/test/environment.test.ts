import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildInfo, envName } from "../src/env.js";
import { wearsDevMark } from "../src/index.js";
import { loginMail, outbox, sendMail } from "../src/mail.js";

/**
 * Which environment the Worker thinks it is on (#248).
 *
 * `KNAG_ENV` is baked at deploy by a `--var` flag that only the Makefile and the two
 * deploy workflows pass. A `wrangler deploy` that skips them ships the config's default,
 * and that default used to be `""` — which every reader spelled `KNAG_ENV || "local"`.
 * A deployed Worker therefore believed it was on a laptop, and `sendMail`'s local branch
 * writes the login code to the log. Nothing failed; the code was simply in an
 * observability log that a real deployment keeps.
 *
 * 🔴 The property is that **blank fails closed**. The first test here is the one that
 * matters; the rest pin the values that follow from it.
 */

/** The suite's env, on a named environment and with no Resend key — the branch under test. */
function keyless(environment: string) {
  const { RESEND_API_KEY: _absent, ...rest } = env;
  return { ...rest, KNAG_ENV: environment };
}

const A_MAIL = { to: "someone@example.com", subject: "Your knag link", text: "code 123456" };

describe("a blank KNAG_ENV", () => {
  it("🔴 does not read as local, so a login code cannot reach a real log", async () => {
    const blank = keyless("");
    const before = outbox.length;

    await sendMail(blank, A_MAIL);

    // Not on the outbox, therefore not on the console either — they are the same branch.
    expect(outbox.length).toBe(before);
    expect(envName(blank)).toBe("unknown");
  });

  it("says so at /health rather than claiming to be a laptop", () => {
    expect(buildInfo({ ...env, KNAG_ENV: "" }).environment).toBe("unknown");
  });

  it("says so in every subject line it sends", () => {
    const mail = loginMail({
      to: "someone@example.com",
      origin: "https://knag.test",
      linkToken: "t",
      code: "123456",
      minutes: 15,
      environment: "unknown",
    });
    expect(mail.subject).toBe("[unknown] Your knag link");
  });
});

describe("local and test still reach the outbox", () => {
  it.each(["local", "test"])("%s keeps the code in the isolate", async (environment) => {
    const before = outbox.length;

    await sendMail(keyless(environment), A_MAIL);

    expect(outbox.length).toBe(before + 1);
  });
});

/**
 * `selfhost` is the top-level config's default — the value true of a deploy that passed
 * no `--var`, which is what the Deploy to Cloudflare button produces (#247). It is
 * somebody's only install, and both of the marks that exist to separate two installs
 * from each other are therefore off.
 */
describe("selfhost is somebody's only install", () => {
  it("wears no subject tag, because there is no other environment to confuse it with", () => {
    const mail = loginMail({
      to: "someone@example.com",
      origin: "https://knag.test",
      linkToken: "t",
      code: "123456",
      minutes: 15,
      environment: "selfhost",
    });
    expect(mail.subject).toBe("Your knag link");
  });

  it("is not local: without a key the code is a configuration error, not an outbox entry", async () => {
    const before = outbox.length;

    await sendMail(keyless("selfhost"), A_MAIL);

    expect(outbox.length).toBe(before);
  });

  it("🔴 keeps the prod tile — the dev mark would name their only knag the spare", () => {
    expect(wearsDevMark("selfhost")).toBe(false);
    expect(wearsDevMark("prod")).toBe(false);
    // Everything that has a second install beside it keeps the mark, and so does a
    // deploy that shipped without the var — that one should look wrong.
    for (const environment of ["dev", "local", "test", "unknown"]) {
      expect(wearsDevMark(environment), environment).toBe(true);
    }
  });
});
