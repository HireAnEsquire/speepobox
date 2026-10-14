// What the PR description pass actually wrote, pulled out of everything it
// printed. Pure and tagless like `verdict.ts`, and for the same reason: the
// answer is read out of text a pass produced, so a fake buys nothing.
//
// **The prompt asked and the agent narrated anyway.** `prompts/describe-pr.md`
// has said "no preamble, no process narration, no closing remarks" since T12
// was written, in the imperative, in its own section — and the first live run
// opened its body with "Good, that's all the context I need. Now writing the
// PR description." Because `describePr`'s output *is* the PR body, that
// sentence went to the forge. Sharpening the wording is asking a second time,
// and T24 already ruled on the shape of that: the parser is where a guarantee
// can live and the prompt is where a request lives. So the markers are the
// guarantee, and the prompt now gives the agent somewhere legal to narrate
// instead of only telling it not to.
export const DESCRIPTION_OPEN = "<pr-description>";
export const DESCRIPTION_CLOSE = "</pr-description>";

/**
 * **The first opening tag to the last closing one**, which is the deliberate
 * divergence from `reviewVerdictIn`'s "last well-formed marker" (T24). A
 * verdict is a token and a body is a span, and the two rules fail in opposite
 * directions: taking the *last* opening tag would truncate a description that
 * quotes the markers while explaining them — which the PR describing this very
 * change has to do — while taking the first and the last keeps quoted markers
 * as the body text they are. Preamble lands before the first tag and closing
 * remarks after the last, so both are discarded by construction.
 *
 * Anything else is `""`: no tags at all, tags in the wrong order, or a body
 * that is only whitespace. The caller degrades on the empty string exactly as
 * it degrades on a failed pass (`dispatch/pr.ts`), so a run still opens its PR
 * and the log still holds every line the agent printed.
 */
export const prDescriptionIn = (output: string): string => {
  const opened = output.indexOf(DESCRIPTION_OPEN);
  const closed = output.lastIndexOf(DESCRIPTION_CLOSE);
  if (opened === -1 || closed === -1 || closed < opened + DESCRIPTION_OPEN.length) {
    return "";
  }
  return output.slice(opened + DESCRIPTION_OPEN.length, closed).trim();
};
