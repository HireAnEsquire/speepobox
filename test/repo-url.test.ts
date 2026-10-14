// `RepoUrl`'s userinfo rule is an ordinary Schema-decode test, not a shape pin
// (SPEC §9): the pins assert something stays *impossible* to write, and this
// asserts what the constructor does with what it is handed. The shape half —
// that a plain string cannot reach a clone or a sandbox — is carried by the
// brand itself, and its pin arrives with the first consumer (T18/T6).
import { describe, expect, it } from "@effect/vitest";
import { Either, Schema } from "effect";
import { RepoUrl, urlEmbedsUserinfo } from "../src/git/repo-url.ts";

const decode = Schema.decodeEither(RepoUrl);

const decoded = (input: string): string => {
  const outcome = decode(input);
  if (Either.isLeft(outcome)) {
    throw new Error(`expected '${input}' to decode: ${outcome.left.message}`);
  }
  return outcome.right;
};

describe("RepoUrl", () => {
  it("flags userinfo only on http(s)-family URLs", () => {
    expect(urlEmbedsUserinfo("https://user:token@github.com/acme/hae.git")).toBe(true);
    expect(urlEmbedsUserinfo("git+https://user@github.com/acme/hae.git")).toBe(true);
    expect(urlEmbedsUserinfo("https://github.com/acme/hae.git")).toBe(false);
    expect(urlEmbedsUserinfo("ssh://git@github.com/acme/hae.git")).toBe(false);
    expect(urlEmbedsUserinfo("git@github.com:acme/hae.git")).toBe(false);
  });

  it("strips userinfo from an http(s)-family URL", () => {
    expect(decoded("https://user:token@github.com/acme/hae.git")).toBe(
      "https://github.com/acme/hae.git",
    );
    expect(decoded("git+https://user@github.com/acme/hae.git")).toBe(
      "git+https://github.com/acme/hae.git",
    );
  });

  // ssh usernames are not secrets, and a local path is what the checkout
  // clones from (T18) — round-tripping either through `URL` would mangle it.
  it("passes everything without userinfo through verbatim", () => {
    for (const url of [
      "https://github.com/acme/hae.git",
      "ssh://git@github.com/acme/hae.git",
      "git@github.com:acme/hae.git",
      "/srv/hae",
    ]) {
      expect(decoded(url)).toBe(url);
    }
    // Trimmed, because a config value or a `git remote get-url` line arrives
    // with the newline still on it.
    expect(decoded("  https://github.com/acme/hae.git\n")).toBe("https://github.com/acme/hae.git");
  });

  it("refuses a credential-bearing URL it cannot prove it stripped", () => {
    const outcome = decode("https://user:token@");
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left.message).toContain("cannot be stripped");
    }
  });

  it("refuses a blank URL", () => {
    expect(Either.isLeft(decode("   "))).toBe(true);
  });

  // The whole point of the brand: whatever comes out, the rule holds of it.
  it("never brands a value that still embeds userinfo", () => {
    for (const url of [
      "https://user:token@github.com/acme/hae.git",
      "http://token@example.test/hae.git",
      "git+https://user@github.com/acme/hae.git",
      "https://github.com/acme/hae.git",
      "git@github.com:acme/hae.git",
    ]) {
      expect(urlEmbedsUserinfo(decoded(url))).toBe(false);
    }
  });
});
