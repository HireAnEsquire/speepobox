// Pulling the PR body out of what the description pass printed
// (`src/agent/description.ts`). Pure, so it is asserted as values — the pass
// that produces the text is `test/agent-cli.test.ts`'s subject and what the
// caller does with an empty answer is `test/pr.test.ts`'s.
//
// The case this exists for is the one that happened: the prompt forbade
// preamble, in its own section, and the first live run opened its body with
// "Good, that's all the context I need." T24 ruled where that guarantee lives.
import { describe, expect, it } from "@effect/vitest";
import { DESCRIPTION_CLOSE, DESCRIPTION_OPEN, prDescriptionIn } from "../src/agent/description.ts";

const wrapped = (body: string): string => `${DESCRIPTION_OPEN}\n${body}\n${DESCRIPTION_CLOSE}`;

const BODY = "## Overview\n\nThe forge seam and the description that goes through it.";

describe("reading the PR description out of a pass's output", () => {
  it("takes what is between the markers", () => {
    expect(prDescriptionIn(wrapped(BODY))).toBe(BODY);
  });

  // The whole point: both are outside the block, so neither reaches the forge.
  it("drops preamble before the block and sign-off after it", () => {
    const output = [
      "Good, that's all the context I need. Now writing the PR description.",
      "",
      wrapped(BODY),
      "",
      "Let me know if you'd like anything expanded.",
    ].join("\n");
    expect(prDescriptionIn(output)).toBe(BODY);
  });

  // The deliberate divergence from `reviewVerdictIn`'s last-marker rule (T24):
  // a verdict is a token and a body is a span. Taking the *last* opening tag
  // would truncate this body at the sentence that explains the markers — which
  // the PR describing this very change has to do.
  it("keeps markers quoted inside the body, by taking the first open and the last close", () => {
    const explaining = [
      "## Overview",
      "",
      `The pass now wraps its answer in \`${DESCRIPTION_OPEN}\` and \`${DESCRIPTION_CLOSE}\`.`,
      "Anything outside that block is discarded.",
    ].join("\n");
    expect(prDescriptionIn(wrapped(explaining))).toBe(explaining);
  });

  it("trims the whitespace the markers' own lines leave behind", () => {
    expect(prDescriptionIn(`${DESCRIPTION_OPEN}\n\n  ${BODY}  \n\n${DESCRIPTION_CLOSE}`)).toBe(
      BODY,
    );
  });

  // Every one of these is the static body and a warning, never a guess: the
  // run log holds each line the pass printed, so nothing is lost by refusing.
  it("answers empty for anything that is not a well-formed block", () => {
    expect(prDescriptionIn(BODY)).toBe("");
    expect(prDescriptionIn("")).toBe("");
    expect(prDescriptionIn(`${DESCRIPTION_OPEN}\n${BODY}`)).toBe("");
    expect(prDescriptionIn(`${BODY}\n${DESCRIPTION_CLOSE}`)).toBe("");
    // Closed before it opened.
    expect(prDescriptionIn(`${DESCRIPTION_CLOSE}\n${BODY}\n${DESCRIPTION_OPEN}`)).toBe("");
    // Well-formed and holding nothing.
    expect(prDescriptionIn(wrapped("   \n  "))).toBe("");
  });
});
