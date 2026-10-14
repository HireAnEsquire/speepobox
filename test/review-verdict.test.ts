// The verdict a review round decided, read out of the text the pass printed,
// and the ledger token it becomes (T10). Pure, so this file needs no layer:
// the loop's policy is asserted in `test/review.test.ts`, and what is asserted
// here is the marker bash reads (`run.sh:1349-1372`).
import { describe, expect, it } from "@effect/vitest";
import {
  APPROVED_MARKER,
  CAPPED_UNREVIEWED_FIX,
  FIXED_MARKER,
  outcomeFor,
  reviewVerdictIn,
} from "../src/agent/verdict.ts";

describe("the review verdict", () => {
  it("reads the three tags the reviewer is asked to end on", () => {
    expect(reviewVerdictIn(`all good\n${APPROVED_MARKER}\n`)).toBe("approved");
    expect(reviewVerdictIn(`fixed two things\n${FIXED_MARKER}\n`)).toBe("fixed");
    expect(reviewVerdictIn("still broken\n<verdict>needs-work</verdict>\n")).toBe("needs-work");
  });

  // A pass that printed nothing, crashed its own narration, or invented a
  // token is not an approval. `needs-work` is the answer that keeps a human
  // reading the diff, which is the only safe default here.
  it("answers needs-work for output carrying no verdict it recognizes", () => {
    expect(reviewVerdictIn("")).toBe("needs-work");
    expect(reviewVerdictIn("I approve of this change entirely")).toBe("needs-work");
    expect(reviewVerdictIn("<verdict>lgtm</verdict>")).toBe("needs-work");
  });

  // A token we do not know is not a fall-through to the last one we do: the
  // reviewer ended on a word this port has no meaning for, and reading the
  // approval it quoted earlier would be reading a sentence rather than a
  // decision.
  it("does not fall back to an earlier marker when the last tag is unrecognized", () => {
    expect(reviewVerdictIn(`${APPROVED_MARKER}\nsecond thoughts\n<verdict>lgtm</verdict>`)).toBe(
      "needs-work",
    );
  });

  // The verdict is the *last* marker, not any marker (T24). A reviewer writing
  // about a review loop quotes the tags it is describing, and one of those
  // quotes is not what the round decided: T10's own round 2 wrote
  // "break on `<verdict>approved</verdict>`" in a sentence about the loop, and
  // the whole-output scan it replaced read that as approval — the round that
  // then stops early and stamps a ticket `Done` over unreviewed code.
  it("reads the last marker in the output, not the first one it finds", () => {
    expect(
      reviewVerdictIn(
        `rounds 1..maxReviewRounds, break on ${APPROVED_MARKER}, fixed loops like needs-work\n` +
          "<verdict>needs-work</verdict>\n",
      ),
    ).toBe("needs-work");
    expect(
      reviewVerdictIn(
        `the round before this one ended <verdict>needs-work</verdict>; this one does not\n${APPROVED_MARKER}\n`,
      ),
    ).toBe("approved");
    expect(reviewVerdictIn(`${FIXED_MARKER}\nand then\n${APPROVED_MARKER}`)).toBe("approved");
    expect(reviewVerdictIn(`${APPROVED_MARKER}\nand then\n${FIXED_MARKER}`)).toBe("fixed");
  });

  // The tag ends the reviewer's final *message*, and `execStreamed` hands this
  // function the collected lines: nothing promises the marker sits alone on a
  // line of its own, so the scan is over the whole output rather than its last
  // line.
  it("reads a marker that shares its line with prose", () => {
    expect(reviewVerdictIn(`one nit, fixed in this round. ${FIXED_MARKER}`)).toBe("fixed");
  });

  // The rename that only matters at the cap: a capped `fixed` round says one
  // round's commits went unreviewed, which is a different thing to tell a
  // human than "problems remain" (`run.sh:1358-1362`).
  it("records a capped fixing round as its own outcome token", () => {
    expect(outcomeFor("approved")).toBe("approved");
    expect(outcomeFor("needs-work")).toBe("needs-work");
    expect(outcomeFor("fixed")).toBe(CAPPED_UNREVIEWED_FIX);
  });
});
