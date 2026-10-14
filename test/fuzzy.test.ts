// The picker's ranking (T80), asserted as values: the scorer is pure, so
// nothing here needs a layer and every case is a query, a list, and an order.
//
// The three queries at the top are 13's acceptance bar — the ones a human
// verified by hand against the real branch list, twice: once when the scorer
// was written, and again after the wrapper's substring default was found
// re-filtering its output. They are here because they are the queries that
// tell fuzzy ranking apart from clack's default, not because they are the
// interesting inputs: `tsf` finds `tseff` in fzf and finds nothing under a
// substring filter.
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { fuzzyScore, rankFuzzy } from "../src/prompt/fuzzy.ts";

// A branch list in the shape the branch step sees it (13's closing note):
// recency-sorted, newest first, so input order *is* the at-rest order the ties
// below fall back to. It carries the names 13 ranked against, and beside each
// of them the candidates that compete — including, for `tsf` and `hard`, the
// names a plain substring filter would return.
const BRANCHES = [
  "bessemer-t80",
  "bessemer-t76",
  "agentbox-hardening",
  "proto/clack-picker",
  "tseff",
  "resume-feedback",
  "spike/tsfmt-vs-oxfmt",
  "harness-adr-draft",
  "test-suite-fixes",
  "docs/spec-and-the-forge-boundary",
  "agentbox-v2",
  "main",
  "master",
];

const ranked = (query: string, branches: ReadonlyArray<string> = BRANCHES): ReadonlyArray<string> =>
  rankFuzzy(query, branches, (name) => name);

describe("the queries 13 ranked by hand", () => {
  // The query that made the case: `tsf` is not a substring of `tseff` at all,
  // and the one name in the list it *is* a substring of loses to it — the
  // whole difference between ranking a subsequence and filtering a substring.
  it("ranks `tseff` first for `tsf`, above the name that contains `tsf`", () => {
    expect(BRANCHES.filter((name) => name.includes("tsf"))).toEqual(["spike/tsfmt-vs-oxfmt"]);
    expect(ranked("tsf")).toEqual(["tseff", "spike/tsfmt-vs-oxfmt", "test-suite-fixes"]);
  });

  // A substring match, and still ranked rather than merely found: the run
  // `hard` after the `-` boundary beats the scattered h-a-r-d in `harness-adr-draft`.
  it("ranks `agentbox-hardening` first for `hard`", () => {
    expect(ranked("hard")).toEqual(["agentbox-hardening", "harness-adr-draft"]);
  });

  // The second query the post-fix pass checked. Nothing in the list contains
  // `sfb`, so a substring filter answers with nothing at all.
  it("ranks `resume-feedback` first for `sfb`", () => {
    expect(BRANCHES.filter((name) => name.includes("sfb"))).toEqual([]);
    expect(ranked("sfb")).toEqual(["resume-feedback", "docs/spec-and-the-forge-boundary"]);
  });
});

describe("what ranks at all", () => {
  // In order is the whole rule: the same four characters shuffled name a
  // different candidate, and `tseff` — which has every one of them — is gone.
  it("drops a candidate whose characters are not all there in order", () => {
    expect(ranked("tsef")).toContain("tseff");
    expect(ranked("tesf")).not.toContain("tseff");
    expect(fuzzyScore("tesf", "tseff")).toEqual(Option.none());
  });

  it("drops every candidate when nothing is a subsequence", () => {
    expect(ranked("zzz")).toEqual([]);
  });

  // Typing is case-free on both sides — the query as it was typed and the name
  // as the ref spells it.
  it("ignores case", () => {
    expect(ranked("TsF")).toEqual(ranked("tsf"));
    // Folded on both sides at once, and the fold has to land on a match: a
    // scorer that folded nothing answers `none()` to a mixed-case query as
    // well, and two `none()`s agreeing would assert nothing.
    const mixed = fuzzyScore("HaRd", "AGENTBOX-HARDENING");
    expect(Option.isSome(mixed)).toBe(true);
    expect(mixed).toEqual(fuzzyScore("hard", "agentbox-hardening"));
  });
});

describe("what breaks a tie", () => {
  // Two branches of the same shape and length score the same, so the order
  // they arrived in stands — which is recency, and is why the caller sorts
  // before it ranks rather than after.
  it("keeps equally-scored candidates in input order", () => {
    expect(fuzzyScore("bess", "bessemer-t80")).toEqual(fuzzyScore("bess", "bessemer-t76"));
    expect(ranked("bess")).toEqual(["bessemer-t80", "bessemer-t76"]);
    expect(ranked("bess", BRANCHES.toReversed())).toEqual(["bessemer-t76", "bessemer-t80"]);
  });

  // At rest there is no query, so there is nothing to rank by and the list is
  // the caller's own — every candidate, untouched.
  it("returns every candidate in input order for the empty query", () => {
    expect(ranked("")).toEqual(BRANCHES);
    expect(fuzzyScore("", "agentbox-hardening")).toEqual(Option.some(0));
  });
});

// The accessor is why a branch row and an issue row rank without being copied
// into a list of strings first: the row goes in and the row comes back.
describe("the text a row ranks on", () => {
  it("ranks rows on what the accessor names and returns the rows themselves", () => {
    const rows = [
      { name: "agentbox-hardening", age: "2 days ago" },
      { name: "tseff", age: "3 weeks ago" },
      { name: "main", age: "5 minutes ago" },
    ];
    const picked = rankFuzzy("tsf", rows, (row) => row.name);
    expect(picked).toEqual([rows[1]]);
    // Identity, not shape: ranking a row without copying it is the whole
    // reason the accessor exists, and a structural match holds for a copy too.
    expect(picked[0]).toBe(rows[1]);
  });
});
