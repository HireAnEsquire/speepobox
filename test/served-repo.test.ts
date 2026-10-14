// The `--repo-root` peel (T60): the one argv read that precedes parsing, and
// the reason it is a module rather than four lines in `bin.ts` — importing the
// entrypoint runs the CLI, so nothing that owes an assertion lives there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Either, Option } from "effect";
import { packageRoot } from "../src/config/paths.ts";
import { peelRepoRoot, VALUE_OPTION_NAMES } from "../src/config/served-repo.ts";

const peeled = (argv: ReadonlyArray<string>) => {
  const outcome = peelRepoRoot(argv);
  if (Either.isLeft(outcome)) {
    throw new Error(`expected a peel, got a refusal: ${outcome.left.detail}`);
  }
  return outcome.right;
};

const refusal = (argv: ReadonlyArray<string>) => {
  const outcome = peelRepoRoot(argv);
  if (Either.isRight(outcome)) {
    throw new Error("expected a refusal, got a peel");
  }
  return outcome.left;
};

describe("peelRepoRoot", () => {
  it("takes the separate spelling and hands back the argv without it", () => {
    expect(peeled(["--repo-root", "/x", "doctor"])).toEqual({
      repoRoot: Option.some("/x"),
      argv: ["doctor"],
    });
  });

  it("takes the `=` spelling the same way", () => {
    expect(peeled(["--repo-root=/x", "doctor"])).toEqual({
      repoRoot: Option.some("/x"),
      argv: ["doctor"],
    });
  });

  // The flag may sit anywhere the shim puts it, and what is left is what the
  // `argv[0]` switch and `@effect/cli` see — a flag left in would reach a
  // parser that does not declare it.
  it("peels the flag from wherever it sits, leaving everything else in order", () => {
    expect(peeled(["spec.md", "--branch", "b", "--repo-root", "/srv/hae", "--dry-run"])).toEqual({
      repoRoot: Option.some("/srv/hae"),
      argv: ["spec.md", "--branch", "b", "--dry-run"],
    });
  });

  it("leaves the argv untouched and the value None with no flag", () => {
    expect(peeled(["status"])).toEqual({ repoRoot: Option.none(), argv: ["status"] });
    expect(peeled([])).toEqual({ repoRoot: Option.none(), argv: [] });
  });

  it("takes the last spelling and peels every one of them", () => {
    expect(peeled(["--repo-root", "/a", "--repo-root=/b", "status"])).toEqual({
      repoRoot: Option.some("/b"),
      argv: ["status"],
    });
  });

  // 19 §1: resolving a relative value would read the working directory, which
  // is the input this whole flag exists to retire.
  it("refuses a relative value with one line", () => {
    const line = refusal(["--repo-root", "../hae", "status"]).detail;
    expect(line).toContain("--repo-root must be an absolute path");
    expect(line).toContain("../hae");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("refuses an empty value, which is relative like any other non-path", () => {
    expect(refusal(["--repo-root=", "status"]).detail).toContain("absolute");
  });

  it("refuses the flag with no directory after it", () => {
    expect(refusal(["status", "--repo-root"]).detail).toContain("needs a directory");
  });

  // The value is taken as given: nothing walks up from it, and nothing
  // normalizes it either — `path.resolve` is the composition root's, where the
  // self-hosted predicate compares two spellings of one directory.
  it("takes an absolute value exactly as written", () => {
    expect(peeled(["--repo-root", "/srv/hae/", "status"]).repoRoot).toEqual(
      Option.some("/srv/hae/"),
    );
  });
});

// A value-taking option's value may say anything, this flag's own spelling
// included. The shell strips the quotes long before an argv reaches this
// process, so `--feedback "--repo-root=/x"` arrives as two ordinary elements
// that no shape test can tell apart — what tells them apart is position.
describe("a --repo-root that is another option's value", () => {
  it("is left alone in the `=` spelling", () => {
    expect(peeled(["spec.md", "--feedback", "--repo-root=/x"])).toEqual({
      repoRoot: Option.none(),
      argv: ["spec.md", "--feedback", "--repo-root=/x"],
    });
  });

  // The worse half: peeled bare, it would swallow the *next* token as the
  // served repo and dispatch against a repo nobody named.
  it("is left alone in the bare spelling, and takes no token with it", () => {
    expect(peeled(["spec.md", "--feedback", "--repo-root", "--branch", "b"])).toEqual({
      repoRoot: Option.none(),
      argv: ["spec.md", "--feedback", "--repo-root", "--branch", "b"],
    });
  });

  // And the flag still peels when it is genuinely a flag: the skip is one
  // token, not a licence to stop scanning.
  it("still peels a real flag that follows an option's value", () => {
    expect(peeled(["spec.md", "--feedback", "ship it", "--repo-root", "/srv/hae"])).toEqual({
      repoRoot: Option.some("/srv/hae"),
      argv: ["spec.md", "--feedback", "ship it"],
    });
  });

  it("needs no skip for the `=` spelling of the option carrying it", () => {
    expect(peeled(["spec.md", "--feedback=ship it", "--repo-root", "/srv/hae"])).toEqual({
      repoRoot: Option.some("/srv/hae"),
      argv: ["spec.md", "--feedback=ship it"],
    });
  });
});

// The table above is the parser's knowledge copied into a module that runs
// before the parser, so the copy is kept honest here rather than by review: an
// option added to `command.ts` with a value, and not added there, reopens the
// hole above silently. This fails instead.
describe("the value-taking option table", () => {
  it("names every option the parser declares with a value, and no other", () => {
    const source = readFileSync(join(packageRoot, "src", "dispatch", "command.ts"), "utf8");
    const declared = [...source.matchAll(/Options\.(\w+)\("([a-z-]+)"\)/g)];
    // A regex that matched nothing would make every assertion below vacuous.
    expect(declared.length).toBeGreaterThan(0);
    const takesValue = declared
      .filter((match) => match[1] !== "boolean")
      .map((match) => match[2] ?? "")
      .toSorted();
    expect(takesValue).toEqual(VALUE_OPTION_NAMES.toSorted());
  });
});
