// The review loop (T10): the policy over T9's seam. Rounds run until the
// verdict is approval or the count reaches `maxReviewRounds` from the config
// tag — `run.sh:1349-1372`'s break-on-verdict, cap-the-rounds shape, with
// nothing else added.
//
// **Hitting the cap is not a failure** (matrix row 12). The loop answers with
// whatever the last round said and the run proceeds to land; the unapproved
// state is recorded as the row's `outcome`, which is a different question from
// `terminalReason`'s "why did it stop" (`ledger/record.ts`). Nothing here
// retries: a round that *fails* leaves as a typed `AgentPassFailed` (05 Q16R),
// and only a verdict loops. What that failure *means* is the caller's — the
// run's error on a spec run, and the issue's `review-failed` outcome inside a
// feature loop (T76) — which is why it is still raised here either way.
import { Effect, Option } from "effect";
import { AgentCli, type AgentPassFailed } from "../agent/agent-cli.ts";
import type { CurrentIssue } from "../agent/prompt.ts";
import type { PromptUnusable } from "../agent/prompt-source.ts";
import type { ReviewVerdict } from "../agent/verdict.ts";
import { SpeepoboxConfig } from "../config/config.ts";
import { Reporter } from "../reporter.ts";
import type { SandboxHandle } from "../sandbox/sandbox.ts";
import type { DispatchPlan } from "./plan.ts";

export const reviewRounds = (
  handle: SandboxHandle,
  plan: DispatchPlan,
  // Which issue these rounds are about (T75, handed in by T76's loop): the
  // rounds of a feature run judge one issue's commits, so the value rides
  // through to each round's message and onto each verdict event. `None` on a
  // spec run and an inline one, where the verdict is the run's own.
  current: Option.Option<CurrentIssue>,
): Effect.Effect<
  ReviewVerdict,
  AgentPassFailed | PromptUnusable,
  AgentCli | SpeepoboxConfig | Reporter
> =>
  Effect.gen(function* () {
    const config = yield* SpeepoboxConfig;
    const agent = yield* AgentCli;
    const reporter = yield* Reporter;
    const of = config.maxReviewRounds;

    const from = (
      index: number,
    ): Effect.Effect<ReviewVerdict, AgentPassFailed | PromptUnusable, Reporter> =>
      Effect.gen(function* () {
        const round = { index, of };
        // The budget travels *into* the round as well as bounding the loop:
        // rounds share no memory, so the reviewer is told where it stands out
        // of the same number this stops on (`prompt.ts`).
        const verdict = yield* agent.review(handle, plan, current, round);
        yield* reporter.emit({
          _tag: "ReviewVerdictReached",
          // The id alone, as every renderer of this event wants (T76) — the
          // file and the boundary are already in the prompt the round was
          // handed.
          issue: Option.map(current, ({ issue }) => issue.id),
          round,
          verdict,
        });
        return verdict === "approved" || index >= of ? verdict : yield* from(index + 1);
      });

    // A budget of zero rounds is a review that never ran, and bash's `for`
    // loop says the same thing by not executing: the recorded outcome is
    // `needs-work`, because nothing looked at the diff. It is not a failure —
    // the same reason the cap is not one.
    return of < 1 ? "needs-work" : yield* from(1);
  });
