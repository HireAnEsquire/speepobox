// `RepoSlug`'s parse (T39): a pure question over the shapes a `git remote`
// URL takes, distinct from `RepoUrl`'s userinfo rule (`repo-url.test.ts`) —
// see the module header for why the two do not share one brand.
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { parseRepoSlug, repoSlugArg } from "../src/git/repo-slug.ts";

describe("parseRepoSlug", () => {
  it("reads owner and name off an https remote, .git or not", () => {
    expect(parseRepoSlug("https://github.com/acme/hae.git")).toEqual(
      Option.some({ owner: "acme", name: "hae" }),
    );
    expect(parseRepoSlug("https://github.com/acme/hae")).toEqual(
      Option.some({ owner: "acme", name: "hae" }),
    );
  });

  it("reads owner and name off an ssh:// remote", () => {
    expect(parseRepoSlug("ssh://git@github.com/acme/hae.git")).toEqual(
      Option.some({ owner: "acme", name: "hae" }),
    );
  });

  it("reads owner and name off the scp-like syntax", () => {
    expect(parseRepoSlug("git@github.com:acme/hae.git")).toEqual(
      Option.some({ owner: "acme", name: "hae" }),
    );
  });

  // Measured during the probe this ticket carries (T39): two directories on
  // one host answered two different owners.
  it("reads the probe's own example", () => {
    expect(parseRepoSlug("git@github.com:HireAnEsquire/speepobox.git")).toEqual(
      Option.some({ owner: "HireAnEsquire", name: "speepobox" }),
    );
  });

  it("takes the last two segments off a nested path", () => {
    expect(parseRepoSlug("https://gitlab.example.com/group/subgroup/hae.git")).toEqual(
      Option.some({ owner: "subgroup", name: "hae" }),
    );
  });

  it("trims surrounding whitespace, the shape a `git remote get-url` line arrives in", () => {
    expect(parseRepoSlug("  https://github.com/acme/hae.git\n")).toEqual(
      Option.some({ owner: "acme", name: "hae" }),
    );
  });

  // Userinfo is orthogonal to which repo a URL names — `RepoUrl` strips it,
  // this parse ignores it either way.
  it("is unbothered by userinfo on the URL", () => {
    expect(parseRepoSlug("https://user:token@github.com/acme/hae.git")).toEqual(
      Option.some({ owner: "acme", name: "hae" }),
    );
  });

  // A local path is a real clone source (T18) and names no forge — the same
  // reading `RepoUrl` gives it.
  it("answers None for a local path", () => {
    expect(parseRepoSlug("/srv/hae")).toEqual(Option.none());
  });

  it("answers None for a bare hostname with nothing to name", () => {
    expect(parseRepoSlug("https://github.com/")).toEqual(Option.none());
    expect(parseRepoSlug("https://github.com")).toEqual(Option.none());
  });

  it("answers None for a blank string", () => {
    expect(parseRepoSlug("")).toEqual(Option.none());
    expect(parseRepoSlug("   ")).toEqual(Option.none());
  });
});

describe("repoSlugArg", () => {
  it("renders owner/name, the shape gh's --repo takes", () => {
    expect(repoSlugArg({ owner: "acme", name: "hae" })).toBe("acme/hae");
  });
});
