import { describe, expect, it } from "vitest";
import { safeNext } from "../src/nav.js";

/**
 * The open-redirect guard on the OAuth consent hand-off (ADR-005 §2).
 *
 * This is the only place client code turns a query parameter into a navigation, and it
 * sits on the page that hosts the login form — so a permissive version does not merely
 * redirect, it lends knag's address bar to whatever comes next.
 */

describe("safeNext", () => {
  it("follows the consent hand-off", () => {
    const next = "/oauth/authorize?client_id=abc&state=xyz";
    expect(safeNext(`?next=${encodeURIComponent(next)}`)).toBe(next);
  });

  it("is absent when nothing was handed off", () => {
    expect(safeNext("")).toBeNull();
    expect(safeNext("?view=list")).toBeNull();
  });

  it.each([
    // Absolute URLs, the obvious attempt.
    ["https://evil.example/pwn", "an absolute https URL"],
    ["http://evil.example", "an absolute http URL"],
    ["javascript:alert(1)", "a javascript: URL"],
    // 🔴 The two that a "starts with /" check waves through. Browsers read both as a
    // HOST, not a path — `//evil.example` is protocol-relative, and Chrome and Safari
    // normalise the backslash to a slash before resolving.
    ["//evil.example", "a protocol-relative URL"],
    ["/\\evil.example", "a backslash-smuggled host"],
    // Prefix-matching without the `?` boundary.
    ["/oauth/authorizeevil", "a path that merely starts the same way"],
    ["/oauth/authorize.evil.example", "a lookalike path"],
    // Same-origin but not consent — a redirect target is not a general navigation.
    ["/api/doc", "an unrelated same-origin path"],
    ["/", "the app root"],
  ])("refuses %s (%s)", (candidate) => {
    expect(safeNext(`?next=${encodeURIComponent(candidate)}`)).toBeNull();
  });

  it("refuses an empty next", () => {
    expect(safeNext("?next=")).toBeNull();
  });
});
