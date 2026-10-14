// The image name `init` works out from the served repo's directory (T115):
// a pure function, asserted as values, each checked against docker's own
// grammar for a repository path component so "legal" is a pattern and not a
// reading by eye.
import { describe, expect, it } from "@effect/vitest";
import { imageNameFor } from "../src/init/values.ts";

// docker's path-component grammar: alphanumerics joined by `.`, `_`, `__`, or
// runs of `-`.
const LEGAL = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

describe("imageNameFor", () => {
  it.each([
    ["My App", "my-app-bessemer"],
    ["acme.web", "acme.web-bessemer"],
    ["_x", "x-bessemer"],
    ["API--v2", "api-v2-bessemer"],
    ["hae", "hae-bessemer"],
    ["trailing.", "trailing-bessemer"],
    ["Ünïcode repo!", "n-code-repo-bessemer"],
    ["___", "bessemer"],
  ])("maps %j to %j, a legal lowercase name", (directoryName, expected) => {
    const name = imageNameFor(directoryName);
    expect(name).toBe(expected);
    expect(name).toMatch(LEGAL);
    expect(name.endsWith("bessemer")).toBe(true);
  });
});
