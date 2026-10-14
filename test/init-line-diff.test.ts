// The in-process unified diff `init --diff` prints (T116), asserted as a pure
// function against hunks written out by hand in `diff -u`'s shape.
import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/init/line-diff.ts";

const lines = (count: number, from = 1): string =>
  Array.from({ length: count }, (_, index) => `line ${index + from}`).join("\n") + "\n";

describe("unifiedDiff", () => {
  it("is empty when the lines agree", () => {
    expect(unifiedDiff("a", "b", "x\ny\n", "x\ny\n")).toBe("");
    expect(unifiedDiff("a", "b", "", "")).toBe("");
  });

  it("shows a changed line with three lines of context each side", () => {
    const from = lines(10);
    const to = from.replace("line 5\n", "line five\n");
    expect(unifiedDiff("theirs", "template", from, to).split("\n")).toEqual([
      "--- theirs",
      "+++ template",
      "@@ -2,7 +2,7 @@",
      " line 2",
      " line 3",
      " line 4",
      "-line 5",
      "+line five",
      " line 6",
      " line 7",
      " line 8",
    ]);
  });

  it("splits changes far apart into two hunks and joins close ones", () => {
    const from = lines(20);
    const far = from.replace("line 2\n", "").replace("line 18\n", "line 18\nnew\n");
    expect(unifiedDiff("a", "b", from, far).split("\n")).toEqual([
      "--- a",
      "+++ b",
      "@@ -1,5 +1,4 @@",
      " line 1",
      "-line 2",
      " line 3",
      " line 4",
      " line 5",
      "@@ -16,5 +15,6 @@",
      " line 16",
      " line 17",
      " line 18",
      "+new",
      " line 19",
      " line 20",
    ]);
    const close = from.replace("line 5\n", "").replace("line 10\n", "ten\n");
    const hunks = unifiedDiff("a", "b", from, close)
      .split("\n")
      .filter((line) => line.startsWith("@@"));
    expect(hunks).toEqual(["@@ -2,12 +2,11 @@"]);
    // Six unchanged lines between two changes: the contexts meet, one hunk.
    const meeting = from.replace("line 5\n", "five\n").replace("line 12\n", "twelve\n");
    expect(
      unifiedDiff("a", "b", from, meeting)
        .split("\n")
        .filter((line) => line.startsWith("@@")),
    ).toEqual(["@@ -2,14 +2,14 @@"]);
  });

  it("writes an empty side's range as git does", () => {
    expect(unifiedDiff("a", "b", "", "x\n").split("\n")).toEqual([
      "--- a",
      "+++ b",
      "@@ -0,0 +1 @@",
      "+x",
    ]);
  });
});
