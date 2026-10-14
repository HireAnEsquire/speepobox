// `AgentCli` (SPEC §2): the seam an agent pass runs behind. **Single-shot** —
// `implement` runs the CLI once and answers; the dispatch core calls it once
// (`dispatch/run.ts`). **No `Schedule` wraps it, anywhere, ever** (05 Q16R):
// every failure here is systematic rather than flaky — credentials exhausted,
// config wrong, container gone — so a second attempt buys a cold session
// against an unchanged condition. What makes that affordable is checkpointing:
// the prompt asks the agent to commit each coherent piece as it works, so a
// failed pass keeps what it finished and a human reads the log.
//
// Named for its role, not its vendor: the tag is the future provider seam and
// **no provider abstraction is built behind it** (05 Q22). The one CLI it
// knows about is named once, below.
//
// `review` (T10) joins it with its caller — the loop in `dispatch/review.ts` —
// and shares every mechanic below rather than repeating it: one round is a
// single-shot pass exactly as `implement` is, and what differs is which prompt
// it is handed and that its output is read for a verdict. `describePr` (T12)
// is the third and last, and it arrived the same way: beside the step that
// writes a PR body (`dispatch/pr.ts`), never ahead of it.
import { Clock, Context, Data, Duration, Effect, Layer, Option, Ref } from "effect";
import { BessemerConfig } from "../config/config.ts";
import { logPathOrNote, type DispatchPlan } from "../dispatch/plan.ts";
import { Sandbox, type SandboxError, type SandboxHandle } from "../sandbox/sandbox.ts";
import { type AgentPass, Reporter, type ReporterEvent } from "../reporter.ts";
import {
  type CurrentIssue,
  DESCRIBE_PR_PROMPT,
  describePrPromptFor,
  IMPLEMENT_PROMPT,
  implementPromptFor,
  type PassRun,
  type PrContext,
  REVIEW_PROMPT,
  reviewPromptFor,
  withProjectContext,
} from "./prompt.ts";
import { type PromptRoot, PromptSource, type PromptUnusable } from "./prompt-source.ts";
import { DESCRIPTION_CLOSE, DESCRIPTION_OPEN, prDescriptionIn } from "./description.ts";
import { dueAt, isWrite, WATCH_TICK } from "./pass-watch.ts";
import { feed, finish, initialStreamState, type NarrationLine } from "./stream.ts";
import { type ReviewRound, type ReviewVerdict, reviewVerdictIn } from "./verdict.ts";

// The agent CLI, and the whole of what this package knows about it. `-p` is
// its non-interactive mode: the prompt arrives on stdin and the pass's answer
// is printed. Permissions are skipped because the sandbox *is* the boundary —
// the container drops every capability, mounts one writable directory, and
// publishes no ports (SPEC §9), which is the isolation a prompt-level
// permission check is a poor substitute for.
//
// Bash pipes the same flags through `stream-filter.py` for live narration
// (`run.sh:1466`); that filter is hae's and does not travel — the image ships
// no python — so the fold is this package's own (`stream.ts`), and SPEC §12
// records ticket 20's ruling rather than a divergence. The lines the CLI
// prints are the events.
const AGENT_CLI_BINARY = "claude";

// How far past the budget the backstop fires. It exists so that on a live run
// the dispatcher's own timeout always fires first and the backstop is never
// what ended a pass: exit 124 reaching the dispatcher is a defect of this
// arrangement, not an outcome, and so has no `AgentPassReason` of its own.
const PASS_BACKSTOP_GRACE_SECONDS = 60;

// How long `timeout` waits after its `TERM` before it sends `KILL`, for a CLI
// that ignores the first signal.
const PASS_BACKSTOP_KILL_AFTER_SECONDS = 30;

// One argv for every pass: which pass this is lives in the prompt on stdin,
// never in the command, so a second pass is a second prompt rather than a
// second invocation to keep in step with this one.
//
// `--output-format stream-json` is what makes a pass narrate at all (ticket
// 20): plain `-p` prints one blob when the pass ends, so a run killed at the
// wall left a log with nothing the agent said in it. `--verbose` is not a
// preference — the CLI refuses `stream-json` under `-p` without it.
//
// **And it runs under an in-container `timeout`, which is a backstop and never
// the budget** (T139). The budget is `Effect.timeoutFail` below; it caps the
// daemon and the CLI as well as the agent, and it decides every live run's
// outcome. But it lives in the dispatcher, so a dispatcher killed with
// `kill -9` leaves the agent working unsupervised, with the run's credential,
// until a later reclaim removes the container — and a live timeout that kills
// only the `docker exec` client leaves the process inside running too. The
// prefix stops the CLI in both cases, from inside the container.
export const agentPassCommand = (passTimeoutSeconds: number): ReadonlyArray<string> => [
  "timeout",
  "-k",
  `${PASS_BACKSTOP_KILL_AFTER_SECONDS}`,
  `${passTimeoutSeconds + PASS_BACKSTOP_GRACE_SECONDS}`,
  AGENT_CLI_BINARY,
  "--dangerously-skip-permissions",
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
];

// Which of matrix rows 8-10 this failure is. The distinction survives as a
// **cause on the failure**, not as an abort condition on a schedule that does
// not exist (05 Q16R) — all three end the run identically, and what differs is
// what a human is told to do next.
export type AgentPassReason = "exited" | "timed-out" | "sandbox-gone";

// Typed, by the outcome-row test (SPEC §3): the run started, so it owes a
// `failed` row at stage `implement` and a human-readable line.
//
// The field is `reason` and not `cause` on purpose: `cause` is `Error`'s own
// slot, which `Data.TaggedError` forwards to the native constructor, and a
// domain enum does not belong in it.
export class AgentPassFailed extends Data.TaggedError("AgentPassFailed")<{
  readonly reason: AgentPassReason;
  readonly detail: string;
}> {}

// Which of rows 8 and 10 a failed pass is, off the answer `Sandbox` put on the
// error rather than off the English it printed (T22). The predicate this
// replaces matched docker's own refusal, which only ever exists when the
// container was *already* dead: a container killed mid-exec makes docker
// report the child's SIGKILL code and say nothing about a container at all, so
// there is no message to widen the pattern with. The daemon is asked instead,
// about an id that is never reused — and asking it is docker vocabulary, which
// is `Sandbox`'s and not this tag's (`sandbox/sandbox.ts`).
export const agentPassReason = (sandboxGone: boolean): AgentPassReason =>
  sandboxGone ? "sandbox-gone" : "exited";

export interface AgentCliShape {
  // `Reporter` stays in the requirements rather than being captured by the
  // layer, exactly as `Sandbox.run` keeps it (`sandbox/sandbox.ts`): a pass
  // runs inside the run log's bracket, so its prompt and its output must reach
  // the log and not only the console.
  //
  // `PromptUnusable` joins `AgentPassFailed` in every method's error channel
  // from T14: the prompt a pass is handed comes through `PromptSource`, and a
  // client override that cannot be used stops the pass before it runs. It is
  // its own error rather than a fourth `AgentPassReason` because no pass
  // happened — the container was never asked anything, and a "the implement
  // pass failed" naming a file the client wrote is the wrong sentence for it.
  //
  // `current` rides beside the plan on all three methods (T75): which issue a
  // pass is for is a fact of the **pass** and not of the run — a feature run's
  // passes are for different issues, and the boundary moves under them — so it
  // cannot ride on the plan, which is resolved once before anything is
  // acquired. The loop that walks the selection is what knows it (T76); here it
  // is read straight into the message the pass is handed. `Option.none()` on a
  // spec run and an inline one, which have no issue to name.
  //
  // The argument after it is what the dispatch **gathered** for this pass before
  // it ran (T17): on a resume, what the branch's PR says today. It arrives as
  // a parameter rather than being fetched here for the reason the
  // description pass degrades at its caller (`dispatch/pr.ts`) — asking the
  // forge is the dispatch step's job, and a `Forge` in this tag's requirements
  // would put "the view failed, carry on" policy inside the seam that runs a
  // CLI in a container. It is `Option.none()` on every fresh dispatch, which
  // never asks (T66).
  readonly implement: (
    handle: SandboxHandle,
    plan: DispatchPlan,
    current: Option.Option<CurrentIssue>,
    pr: Option.Option<PrContext>,
  ) => Effect.Effect<void, AgentPassFailed | PromptUnusable, Reporter>;
  // One review round, single-shot exactly as `implement` is: the round is the
  // caller's to repeat (`dispatch/review.ts`), and nothing here loops. It
  // answers with the verdict rather than with the output it read, because the
  // marker is this pass's own protocol and a caller re-parsing text would be
  // the second derivation `--dry-run` exists to delete.
  //
  // `round` arrives rather than being read from config: the loop owns the
  // budget, and the reviewer is told where it stands out of the same number
  // the loop stops on.
  readonly review: (
    handle: SandboxHandle,
    plan: DispatchPlan,
    current: Option.Option<CurrentIssue>,
    round: ReviewRound,
  ) => Effect.Effect<ReviewVerdict, AgentPassFailed | PromptUnusable, Reporter>;
  // The PR description (T12), the third and last pass and the only one whose
  // output *is* the answer: a review round's output is read for a marker and
  // an implement pass's is read by a human, but this text becomes the PR body.
  // It is read for markers all the same (`description.ts`) — not to decide
  // anything, but because "everything it printed" and "the description it
  // wrote" turned out to be different strings the first time this pass ran for
  // real.
  //
  // It fails like the other two — a typed `AgentPassFailed` — and its caller
  // is the one that degrades: a failed description must not cost the run its
  // PR (`dispatch/pr.ts`), because by the time this runs the commits are
  // already pushed. Degrading *here* would make "the pass failed" and "the
  // agent wrote a body that looks like an apology" the same value. An empty
  // answer travels the same road for the same reason: it is what an output
  // with no well-formed markers comes back as, and the caller already turns
  // one into the static body.
  // It takes `current` like the other two and names no issue with it: what this
  // pass describes is the branch, whose commits span every issue the run
  // reached, so its message names the whole set off the plan's own task (T75).
  // The parameter is here so the seam has one shape — a caller reads a pass's
  // three arguments the same way whichever pass it is running.
  readonly describePr: (
    handle: SandboxHandle,
    plan: DispatchPlan,
    current: Option.Option<CurrentIssue>,
  ) => Effect.Effect<string, AgentPassFailed | PromptUnusable, Reporter>;
}

/**
 * `Reporter` is in every method's requirements deliberately — the same
 * pass-through `Sandbox.run` makes, and for the same reason: a pass runs
 * inside the run log's bracket, so capturing the layer's reporter here would
 * send its prompt and its output to the console alone. The language service
 * flags that as leakage once *every* method does it, which is true from the
 * round T10 adds; the annotation answers it rather than leaving a suggestion
 * to print on each typecheck.
 *
 * @effect-expect-leaking Reporter
 */
export class AgentCli extends Context.Tag("AgentCli")<AgentCli, AgentCliShape>() {}

export const AgentCliLive: Layer.Layer<AgentCli, never, Sandbox | BessemerConfig | PromptSource> =
  Layer.effect(
    AgentCli,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const config = yield* BessemerConfig;
      // The prompts arrive through the tag rather than off a package path (T14):
      // which root won is the client's answer to give, and this layer stopped
      // being able to read one directly the moment there were two.
      const prompts = yield* PromptSource;

      // The mechanics both passes share, spelled once (T10): the template read,
      // the verbatim log line, the prompt on stdin, the fold over what the CLI
      // prints, and the caller's timeout over the whole thing. What a pass *is*
      // — which default it starts from, what it does with the answer — stays
      // above.
      //
      // **Narration and answer are two different things** (ticket 20): every
      // line the CLI prints goes through `feed`, and each `NarrationLine` it
      // yields is one `AgentOutput` event and nothing else. The answer is the
      // `result` event's text, read once at the end through `finish` — what
      // plain `-p` used to print, and the only thing a verdict or a PR body may
      // be taken from. Joining the narration back into a string would hand a
      // reviewer's thinking-aloud to `reviewVerdictIn`.
      const runPass = (
        pass: AgentPass,
        handle: SandboxHandle,
        plan: DispatchPlan,
        prompt: string,
        // Which root the template came from, carried down here so the one event
        // that logs the prompt says where it came from as well as what it said
        // (T14). It rides beside the text rather than inside it: the log holds
        // the prompt verbatim, and a line about its provenance inside those
        // bytes would be a line the agent reads as instructions.
        root: PromptRoot,
        // And which issue the pass was for, beside the root and for the same
        // reason (T75): the id, not the `CurrentIssue` — what a reader of the
        // log needs is which issue this prompt belongs to, and the file and the
        // boundary are already verbatim in the prompt above it.
        issue: Option.Option<string>,
      ): Effect.Effect<string, AgentPassFailed, Reporter> =>
        Effect.gen(function* () {
          const reporter = yield* Reporter;
          // The fold's memory, and the only place it lives: `feed` is pure, so
          // the state travels through this `Ref` from one line to the next and
          // `finish` reads it after the child is gone.
          const state = yield* Ref.make(initialStreamState);
          // What the child said on stderr, kept for the one failure it is the
          // clue to (below) and never rendered: on a pass that answered it is
          // noise, and on a killed one it is lost with the child.
          const stderr = yield* Ref.make("");
          // The watch's two facts (T52), and the only state it keeps: whether
          // this pass has written anything yet, and whether it has already
          // said that it had not. They are `Ref`s because the two fibers that
          // read and write them are different ones — the exec's `onOutput`
          // sets the first, and the watch below reads both.
          const wrote = yield* Ref.make(false);
          const warned = yield* Ref.make(false);
          // Verbatim, and *before* the pass: a run that dies mid-pass still
          // says what it asked for — and which issue it asked it for, on the
          // arm where a pass is for one (T75).
          yield* reporter.emit({ _tag: "PromptAssembled", pass, prompt, root, issue });

          // What the pass took, measured from here — just before the exec —
          // so a pass that was killed at the wall is measured the same way as
          // one that answered (T55). `Clock` and not `Date.now`, because a
          // test owns the clock and every other reading in this package comes
          // through the service.
          const startedAt = yield* Clock.currentTimeMillis;
          const elapsed = Effect.map(Clock.currentTimeMillis, (now) =>
            Duration.millis(now - startedAt),
          );
          // What a failed pass cost, which is whatever the CLI had already
          // reported: `finish` answers some only once a `result` event has
          // arrived, so an error result carries its usage and a kill, a lost
          // sandbox, and a stream that stopped early each carry none.
          const usageSoFar = Effect.map(Ref.get(state), (current) =>
            Option.map(finish(current), (result) => result.usage),
          );
          // The pass budget, from the `BessemerConfig` tag (05 Q7), and one
          // value for the two things that read it: the cap below, and the
          // watch's `cap 30m`. A second reading here would let the line a
          // dispatcher watches disagree with the kill they are waiting for.
          const budget = Duration.seconds(config.passTimeoutSeconds);

          // bash's `while kill -0` loop (`run.sh:1470-1506`), as a fiber (T52):
          // every 30 seconds it asks the pure `dueAt` what this tick owes and
          // emits it. The arithmetic is all in `pass-watch.ts`, so what is
          // asserted about the timing is asserted at plain values; this is the
          // loop, and it holds nothing but the two `Ref`s.
          const watch = Effect.gen(function* () {
            yield* Effect.sleep(WATCH_TICK);
            const at = yield* elapsed;
            const due = dueAt({
              pass,
              elapsed: at,
              budget,
              wrote: yield* Ref.get(wrote),
              warned: yield* Ref.get(warned),
            });
            if (due.stillRunning) {
              yield* reporter.emit({ _tag: "PassStillRunning", pass, elapsed: at, budget });
            }
            if (due.noWritesYet) {
              yield* reporter.emit({ _tag: "NoWritesYet", pass, elapsed: at, budget });
              // Once per pass, as bash's `warned=1` is: the advisory is about
              // the ticket, and a ticket does not get larger while it runs.
              yield* Ref.set(warned, true);
            }
          }).pipe(Effect.forever);

          const answer = Effect.gen(function* () {
            // **The scope holds the exec and nothing else**, so the watch is
            // interrupted the moment the exec returns, fails, or is killed at
            // the budget — before `finish` reads the stream, before
            // `AgentPassFinished`, and before the `tapError` below emits
            // `PassFailed`. That ordering is the whole of why the fork is
            // scoped here rather than around the pass: a heartbeat after a
            // pass has said it finished is a run that reads as still going.
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* Effect.forkScoped(watch);
                yield* sandbox
                  .exec(handle, agentPassCommand(config.passTimeoutSeconds), {
                    stdin: prompt,
                    onOutput: (line) =>
                      Ref.modify(state, (current) => {
                        const [next, narration] = feed(current, line);
                        return [narration, next];
                      }).pipe(
                        Effect.flatMap(
                          Effect.forEach(
                            (narrated) =>
                              // What the watch reads to stay quiet: the
                              // writing tools, and the shell commands that
                              // write without one of their names on them
                              // (`pass-watch.ts`). **Set before the line is
                              // emitted**, because the watch ticks on its own
                              // fiber: emitting first leaves a window — one log
                              // line and one console line wide — in which a
                              // tick reads `false` for a write that has already
                              // arrived, and warns. There is one writer and the
                              // flag only ever goes true, so ordering the two
                              // effects is the whole fix (T64).
                              (isWrite(narrated) ? Ref.set(wrote, true) : Effect.void).pipe(
                                Effect.zipRight(reporter.emit(narrationEvent(pass, narrated))),
                              ),
                            { discard: true },
                          ),
                        ),
                      ),
                    onStderr: (said) => Ref.set(stderr, said),
                  })
                  .pipe(
                    Effect.mapError((error: SandboxError) => passFailed(pass, error, plan)),
                    // **This is the budget.** It caps the pass wherever it
                    // hung — the CLI, the daemon, or the agent itself — where
                    // an in-container `timeout` only caps the third. The
                    // interrupt closes the exec's own scope, so the docker
                    // child is killed, and the container goes with the run's
                    // scope a moment later. The `timeout` prefix on
                    // `agentPassCommand` sits a grace past this one, so it
                    // never decides a live pass: it is the backstop for a
                    // dispatcher that is no longer here to fire this (T139).
                    // Each round gets the whole budget, as bash's per-pass
                    // `timeout` does; the cap on the rounds is the loop's.
                    Effect.timeoutFail({
                      duration: budget,
                      onTimeout: () => timedOut(pass, config.passTimeoutSeconds, plan),
                    }),
                  );
              }),
            );

            // The answer, and the two ways there is not one. A pass that timed
            // out or lost its sandbox never arrives here: both leave through
            // the error channel above, so this reads only a stream that ended
            // on its own terms.
            const result = finish(yield* Ref.get(state));
            if (Option.isNone(result)) {
              return yield* noResultEvent(pass, plan, yield* Ref.get(stderr));
            }
            if (result.value.isError) {
              return yield* errorResult(pass, result.value.text, plan);
            }

            // After the exec, after the timeout, and after the answer came back
            // whole, so it is only ever said of a pass that really finished.
            yield* reporter.emit({
              _tag: "AgentPassFinished",
              pass,
              // The same id the prompt line above it carries (T76), so the
              // two ends of one pass's bracket name the same issue.
              issue,
              elapsed: yield* elapsed,
              usage: result.value.usage,
            });

            return result.value.text;
          });

          // **One `tapError` for all four ways a pass fails** (T55), and it is
          // applied out here rather than inside: a kill reaches the error
          // channel through `Effect.timeoutFail` above, so a tap on the exec
          // alone would miss the two failures read off the stream, and a tap
          // *under* the timeout would miss the kill. The event goes out before
          // the `AgentPassFailed` propagates, which is what puts the failure
          // inside the run log's bracket — `bin.ts` renders the error on
          // stderr at exit, long after this file has closed.
          return yield* answer.pipe(
            Effect.tapError((failure) =>
              Effect.gen(function* () {
                yield* reporter.emit({
                  _tag: "PassFailed",
                  pass,
                  // And the other terminal event says it too (T76): on a
                  // feature run this is the line that says which issue the
                  // sequence stopped on.
                  issue,
                  reason: failure.reason,
                  // The error's own string, so the log and the exit line say
                  // the same thing rather than two wordings of it.
                  detail: failure.detail,
                  elapsed: yield* elapsed,
                  usage: yield* usageSoFar,
                });
              }),
            ),
          );
        });

      // The template a pass starts from: whichever root won, with the client's
      // `project-context.md` interpolated into it. **The only way to a template
      // in this file**, so a fourth pass cannot resolve one and quietly drop the
      // fragment — the assembly the three passes share is a function of the name
      // and nothing else. Which root won comes back beside the text because the
      // pass has to log it.
      //
      // A prompt the package itself is missing dies inside the tag, where the
      // invariant is (SPEC §3); a client's own file that cannot be used arrives
      // here as the typed `PromptUnusable` this passes through.
      const templateFor = (
        name: string,
      ): Effect.Effect<{ readonly template: string; readonly root: PromptRoot }, PromptUnusable> =>
        Effect.gen(function* () {
          const resolved = yield* prompts.get(name);
          const fragment = yield* prompts.projectContext;
          return {
            template: withProjectContext(
              resolved.text,
              Option.map(fragment, (context) => context.text),
            ),
            root: resolved.root,
          };
        });

      return {
        implement: (handle, plan, current, pr) =>
          Effect.gen(function* () {
            const { template, root } = yield* templateFor(IMPLEMENT_PROMPT);
            // Which message the pass is handed is the *plan's* answer, off the
            // task it resolved before anything was acquired (T17, T66): a run
            // whose task is text is handed the text, a spec run is sent to the
            // file, a feature run's pass to the issue it is for (T75), and all
            // of them get the dispatcher's feedback, if there was any, appended
            // under it.
            yield* runPass(
              "implement",
              handle,
              plan,
              implementPromptFor(template, passRun(plan, current), pr),
              root,
              issueId(current),
            );
          }),
        review: (handle, plan, current, round) =>
          Effect.gen(function* () {
            const { template, root } = yield* templateFor(REVIEW_PROMPT);
            // The diff boundary the round reads against is the merge-base T3
            // already resolved and recorded on the plan (SPEC §7) — consumed
            // here, never re-derived: a second `git merge-base` would answer for
            // wherever the base ref points *now*, which is a different review
            // than the one the ledger row names.
            const output = yield* runPass(
              "review",
              handle,
              plan,
              reviewPromptFor(template, passRun(plan, current), round),
              root,
              issueId(current),
            );
            return reviewVerdictIn(output);
          }),
        describePr: (handle, plan, current) =>
          Effect.gen(function* () {
            const reporter = yield* Reporter;
            const { template, root } = yield* templateFor(DESCRIBE_PR_PROMPT);
            // The same boundary the review round read the diff against, off the
            // plan: "the work on this branch" is the same set of commits at
            // every stage of one run, and re-deriving it here would let the PR
            // describe a range the review never saw.
            const output = yield* runPass(
              "describe-pr",
              handle,
              plan,
              describePrPromptFor(template, passRun(plan, current)),
              root,
              issueId(current),
            );
            const description = prDescriptionIn(output);
            // Loud, because the alternative to the static body is text nobody
            // has to retype: every line the pass printed is verbatim in the run
            // log, so the warning names it rather than the body it could not
            // find.
            if (description === "") {
              yield* reporter.emit({
                _tag: "Warned",
                detail: `the describe-pr pass wrote no ${DESCRIPTION_OPEN}…${DESCRIPTION_CLOSE} block, so the PR opens with the static body — its full output is in ${logPathOrNote(plan.logPath)}`,
              });
            }
            return description;
          }),
      };
    }),
  );

// The plan plus the one fact that is a pass's rather than a run's (T75): what
// the three pure assemblies read (`agent/prompt.ts`). Spelled once here, so the
// three passes cannot join the two halves three different ways.
const passRun = (plan: DispatchPlan, current: Option.Option<CurrentIssue>): PassRun => ({
  ...plan,
  current,
});

// What the prompt event carries of it: the id alone.
const issueId = (current: Option.Option<CurrentIssue>): Option.Option<string> =>
  Option.map(current, ({ issue }) => issue.id);

// One narration line, one event. The fold's vocabulary and the event's are the
// same two shapes on purpose: the renderers read `kind` and nothing else, so
// neither of them parses prose to decide what it is looking at.
const narrationEvent = (pass: AgentPass, line: NarrationLine): ReporterEvent =>
  line.kind === "text"
    ? { _tag: "AgentOutput", pass, kind: "text", text: line.text }
    : { _tag: "AgentOutput", pass, kind: "tool-use", tool: line.tool, brief: line.brief };

// Every detail is one line, whatever the agent or the CLI wrapped: these land
// in the run log, which is a record of single lines (`run-log.ts`), and on the
// exit line a dispatcher reads.
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// Named in full, because naming them *is* the remedy: there is no doctor probe
// for the stream format — a probe would need a container — so the parser's
// tolerance and this sentence are the whole guard against the CLI refusing the
// flags one day (ticket 20 §9).
const STREAM_FLAGS = "--output-format stream-json --verbose";

// How much of the child's stderr the detail above carries: the last line, cut
// to the width bash cuts its own failure tail to (`run.sh:1519`'s
// `tail -1 | cut -c1-140`, which reads the pass's output where this reads its
// stderr — ticket 20 §8 keeps the width and moves the stream).
const STDERR_TAIL_KEPT = 140;

const stderrTail = (stderr: string): string => {
  const last = stderr
    .split("\n")
    .map(oneLine)
    .findLast((line) => line !== "");
  return last === undefined ? "" : `; its last stderr line was: ${last.slice(0, STDERR_TAIL_KEPT)}`;
};

// The stream ended and no `result` event ever arrived, so there is no answer
// to read. `exited` rather than a fourth reason: the child came back, and what
// a human does next — read the log — is row 8's move exactly. Whatever it said
// on stderr rides along, because this is the one failure where that is the
// clue and not noise: a CLI that refused the flags said so there.
//
// The branch clause the other three details end on is in this one too (T55),
// in the middle rather than at the end so the stderr tail stays last. bash
// says it after every failed pass (`run.sh:1521`), and this is the failure it
// matters most in: an implement pass can commit the whole of its work and then
// have its stream end without a result, so the sentence that says where that
// work is has to be the sentence a dispatcher reads.
const noResultEvent = (pass: AgentPass, plan: DispatchPlan, stderr: string): AgentPassFailed =>
  new AgentPassFailed({
    reason: "exited",
    detail: `the ${pass} pass ended without a result event, so it has no answer — read ${logPathOrNote(plan.logPath)}; anything it committed is kept on '${plan.branch}'; if the CLI in the image refuses '${STREAM_FLAGS}', this is what it looks like${stderrTail(stderr)}`,
  });

// How much of the error result a detail carries. Enough for the sentence the
// CLI failed with — "Credit balance is too low", "Not logged in" — and not the
// paragraph under it, which is in the log with everything else.
const ERROR_RESULT_KEPT = 300;

// The pass answered, and its answer is the CLI saying it failed. That text is
// the whole of what is known about why, so it travels in the detail rather
// than being summarized into a sentence of our own.
const errorResult = (pass: AgentPass, text: string, plan: DispatchPlan): AgentPassFailed =>
  new AgentPassFailed({
    reason: "exited",
    detail: `the ${pass} pass ended with an error result: ${oneLine(text.slice(0, ERROR_RESULT_KEPT))} — read ${logPathOrNote(plan.logPath)}; anything it committed is kept on '${plan.branch}'`,
  });

const passFailed = (pass: AgentPass, error: SandboxError, plan: DispatchPlan): AgentPassFailed => {
  const reason = agentPassReason(error.sandboxGone);
  return new AgentPassFailed({
    reason,
    detail:
      reason === "sandbox-gone"
        ? `the ${pass} pass lost its sandbox: ${error.detail} — read ${logPathOrNote(plan.logPath)}; anything the pass committed is kept on '${plan.branch}'`
        : `the ${pass} pass failed: ${error.detail} — read ${logPathOrNote(plan.logPath)} for the cause; anything the pass committed is kept on '${plan.branch}'`,
  });
};

// The sizing sentence is the implement pass's alone, as it is in bash (the
// `watch_writes` arm of `run.sh:1516-1517`): a review round that finds nothing
// wrong writes nothing and is the good case, so "you needed the whole budget"
// says something about the ticket only when the pass was there to write code.
//
// It sends the reader to the branch before it sends them to the ticket. Bash
// says re-slice outright, and this said the same until 2026-09-08, when a
// dispatch was killed at 900s having committed the whole of its scope, green,
// four seconds earlier — advice that would have re-sliced a ticket that was
// already the right size. What the pass committed is the evidence; the
// timeout on its own is not.
const timedOut = (pass: AgentPass, seconds: number, plan: DispatchPlan): AgentPassFailed =>
  new AgentPassFailed({
    reason: "timed-out",
    detail: `the ${pass} pass timed out at ${seconds}s — ${
      pass === "implement"
        ? "read what it committed before you re-slice, since a pass can run out with its work complete; "
        : ""
    }anything it committed is kept on '${plan.branch}'`,
  });
