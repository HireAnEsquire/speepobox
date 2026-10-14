// A fake `AgentCli` for the files whose subject is something else — the lock's
// row, the checkout's derived release, the sandbox's argv — where a real
// `AgentCliLive` over a scripted docker would only add a pass nobody is
// asserting. It **narrates** nothing on purpose: the event stream those files
// assert on is the resources', and a fake that said what an agent was doing
// would rewrite every one of their expectations.
//
// The events it does emit are the pass's two closes (T55), because that is
// what a pass's cost travels on and the ledger row T53 writes is derived from
// it: `AgentPassFinished` for a pass that worked and `PassFailed` for one the
// caller scripted into failing. A zero `PassUsage` and a zero `elapsed` by
// default — a pass that never ran spent nothing — and a caller that wants a
// figure scripts one.
//
// `test/agent-cli.test.ts` is where the real layer runs — against a scripted
// docker, with the prompt, the stdin, and matrix rows 8-10 as the assertions.
// The review *policy* is `test/review.test.ts`, and it is the one file that
// scripts the verdicts below: a loop is only observable against rounds that
// answer differently.
import { Deferred, Duration, Effect, Layer, Option, Ref } from "effect";
import { AgentCli, type AgentPassFailed } from "../../src/agent/agent-cli.ts";
import type { CurrentIssue } from "../../src/agent/prompt.ts";
import type { PassUsage } from "../../src/agent/stream.ts";
import type { ReviewRound, ReviewVerdict } from "../../src/agent/verdict.ts";
import { type AgentPass, Reporter } from "../../src/reporter.ts";
import type { SandboxHandle } from "../../src/sandbox/sandbox.ts";

// What a pass that never ran cost. The same shape the recording `Sandbox`
// answers a rehearsal with (`src/dry-run/agent-cli.ts`), and for the same
// reason: nothing was asked of any model, so no model is named.
export const ZERO_PASS_USAGE: PassUsage = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  turns: 0,
  costUsd: Option.none(),
  models: [],
};

// What one issue's passes do inside a feature loop (T76). Every field
// overrides the run-wide one below for the issue it is keyed by, because a
// loop is only observable against issues that answer differently: "issue 1
// approved and issue 2 did not" is unscriptable from a flat list of verdicts,
// whose rounds start again at 1 for every issue.
export interface FakeIssueScript {
  readonly verdicts?: ReadonlyArray<ReviewVerdict>;
  readonly implementFails?: AgentPassFailed;
  readonly reviewFails?: AgentPassFailed;
  // The implement pass that never answers, for the case that interrupts a run
  // with this issue in flight: the latch it opens before it hangs.
  readonly implementHangs?: Deferred.Deferred<void>;
}

export interface FakeAgentCliOptions {
  // Every handle a pass ran against, for the file that wants to see the pass
  // happen at all without asserting anything about what it said.
  readonly passes?: Ref.Ref<ReadonlyArray<SandboxHandle>>;
  // Which issue each pass was told it was for (T75), in the order the passes
  // ran: what a caller asserts a feature loop against is the sequence that
  // crossed this seam, and the prompt itself is `test/agent-prompt.test.ts`'s.
  readonly current?: Ref.Ref<ReadonlyArray<Option.Option<CurrentIssue>>>;
  // The pass failing, for a caller that wants the run to stop at `implement`
  // without scripting a docker to do it.
  readonly implementFails?: AgentPassFailed;
  // One verdict per round, in order. A loop that asks for more rounds than
  // this scripts gets the last one again — the shape a reviewer that keeps
  // finding the same problem has, and what the cap is asserted against.
  // Absent is `needs-work` forever.
  readonly verdicts?: ReadonlyArray<ReviewVerdict>;
  // Every round the loop actually asked for, which is how "stopped on the
  // approval" and "stopped at the cap" become value assertions.
  readonly rounds?: Ref.Ref<ReadonlyArray<ReviewRound>>;
  // A review round breaking our own invariants instead of failing (matrix row
  // 11): the message the defect dies with, on the round of that index.
  readonly reviewDiesOnRound?: { readonly index: number; readonly message: string };
  // A round failing rather than answering — the typed half of the same pair,
  // for the caller that wants the run staged `review` without a scripted
  // docker exiting nonzero to do it.
  readonly reviewFails?: AgentPassFailed;
  // What the description pass writes. It has a default because most callers
  // only care that a body reached the forge; `test/pr.test.ts` is where the
  // body itself is the assertion.
  readonly description?: string;
  // The description pass failing, which is the one pass failure that does not
  // end the run: the caller degrades to the static body (`dispatch/pr.ts`).
  readonly describePrFails?: AgentPassFailed;
  // What each pass reports it cost, for the caller that asserts on the figure
  // rather than on the pass happening. Absent is zero, per pass.
  readonly usage?: Partial<Record<AgentPass, PassUsage>>;
  // And what a feature loop's issues do, keyed by id (T76): the run-wide
  // answers above are a spec run's, and these are what a sequence that stops
  // partway through is scripted from.
  readonly perIssue?: Readonly<Record<string, FakeIssueScript>>;
}

export const FAKE_DESCRIPTION = "## Overview\n\nWhat the fake agent says it did.";

// The close of a pass that worked, said with the figures a pass that never
// ran has. One terminal event per pass, as the stream promises: a pass the
// caller scripted into failing says `PassFailed` below instead.
const finished = (
  options: FakeAgentCliOptions,
  pass: AgentPass,
  // Which issue the pass was for (T76), as the live layer reads it off the
  // `CurrentIssue` it was handed: the id alone, and `None` wherever the caller
  // passed none.
  issue: Option.Option<string>,
): Effect.Effect<void, never, Reporter> =>
  Effect.flatMap(Reporter, (reporter) =>
    reporter.emit({
      _tag: "AgentPassFinished",
      pass,
      issue,
      elapsed: Duration.zero,
      usage: options.usage?.[pass] ?? ZERO_PASS_USAGE,
    }),
  );

// The other terminal event (T55), and why a scripted figure decides whether
// it carries one: `usage` is some on a failed pass **only** where a result
// arrived, which is the error-result case. A kill, a lost sandbox and a
// stream that ended with no result report none — so a caller that scripts a
// failure without a figure gets the killed pass, and one that scripts both
// gets the expensive failure bash reports the cost of.
const failed = (
  options: FakeAgentCliOptions,
  pass: AgentPass,
  issue: Option.Option<string>,
  error: AgentPassFailed,
): Effect.Effect<never, AgentPassFailed, Reporter> =>
  Effect.flatMap(Reporter, (reporter) =>
    reporter.emit({
      _tag: "PassFailed",
      pass,
      issue,
      reason: error.reason,
      detail: error.detail,
      elapsed: Duration.zero,
      usage: Option.fromNullable(options.usage?.[pass]),
    }),
  ).pipe(Effect.zipRight(Effect.fail(error)));

// What each pass was told it was for, recorded when the caller asked for it.
const recordCurrent = (
  options: FakeAgentCliOptions,
  current: Option.Option<CurrentIssue>,
): Effect.Effect<void> =>
  Effect.suspend(() =>
    options.current === undefined
      ? Effect.void
      : Ref.update(options.current, (seen) => [...seen, current]),
  );

// The id the two terminal events carry (T76), which is what the live layer
// puts on them: the `CurrentIssue`'s id, and nothing on a run that has none.
const idOf = (current: Option.Option<CurrentIssue>): Option.Option<string> =>
  Option.map(current, ({ issue }) => issue.id);

// What *this* issue's passes do, where the caller scripted it: the run-wide
// options are what a spec run needs, and a feature loop is only observable
// against issues that answer differently (T76).
const scriptFor = (
  options: FakeAgentCliOptions,
  current: Option.Option<CurrentIssue>,
): FakeIssueScript =>
  Option.match(current, {
    onNone: () => ({}),
    onSome: ({ issue }) => options.perIssue?.[issue.id] ?? {},
  });

export const fakeAgentCli = (options: FakeAgentCliOptions = {}): Layer.Layer<AgentCli> =>
  Layer.succeed(AgentCli, {
    implement: (handle, _plan, current) =>
      Effect.suspend(() =>
        options.passes === undefined
          ? Effect.void
          : Ref.update(options.passes, (seen) => [...seen, handle]),
      ).pipe(
        Effect.zipRight(recordCurrent(options, current)),
        Effect.zipRight(
          Effect.suspend(() => {
            const script = scriptFor(options, current);
            // The pass that never answers, so a case can interrupt a run with
            // this issue in flight (matrix row 16): the latch opens first, so
            // the test knows the run is really in there.
            if (script.implementHangs !== undefined) {
              return Deferred.succeed(script.implementHangs, undefined).pipe(
                Effect.zipRight(Effect.never),
              );
            }
            const fails = script.implementFails ?? options.implementFails;
            return fails === undefined
              ? finished(options, "implement", idOf(current))
              : failed(options, "implement", idOf(current), fails);
          }),
        ),
      ),
    review: (_handle, _plan, current, round) =>
      Effect.suspend(() =>
        options.rounds === undefined
          ? Effect.void
          : Ref.update(options.rounds, (seen) => [...seen, round]),
      ).pipe(
        Effect.zipRight(recordCurrent(options, current)),
        Effect.zipRight(
          Effect.suspend(() => {
            const script = scriptFor(options, current);
            const fails = script.reviewFails ?? options.reviewFails;
            return options.reviewDiesOnRound !== undefined &&
              options.reviewDiesOnRound.index === round.index
              ? Effect.dieMessage(options.reviewDiesOnRound.message)
              : fails === undefined
                ? Effect.as(
                    finished(options, "review", idOf(current)),
                    verdictForRound(script.verdicts ?? options.verdicts, round.index),
                  )
                : failed(options, "review", idOf(current), fails);
          }),
        ),
      ),
    describePr: (_handle, _plan, current) =>
      recordCurrent(options, current).pipe(
        Effect.zipRight(
          Effect.suspend(() =>
            options.describePrFails === undefined
              ? Effect.as(
                  finished(options, "describe-pr", idOf(current)),
                  options.description ?? FAKE_DESCRIPTION,
                )
              : failed(options, "describe-pr", idOf(current), options.describePrFails),
          ),
        ),
      ),
  });

const verdictForRound = (
  verdicts: ReadonlyArray<ReviewVerdict> | undefined,
  index: number,
): ReviewVerdict => {
  if (verdicts === undefined || verdicts.length === 0) {
    return "needs-work";
  }
  return verdicts[Math.min(index, verdicts.length) - 1] ?? "needs-work";
};
